/**
 * `buildHistory` against a real database.
 *
 * The statistics have their own tests in `@geonerva/baselines`. What is tested here is what only
 * the read side can get wrong: that the catalog is read **as of** the knowledge time (a record, a
 * revision or a correlation run that arrived later changes nothing), that records are counted as
 * canonical events rather than as rows, that the reference period never starts before the catalog
 * GeoNerva holds, that a metric with no inputs is refused rather than computed from nothing, and
 * that the whole response satisfies its contract — every citation resolved (I9).
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AFTERSHOCK_CAVEAT, EARTHQUAKE_ELEVATED_CAVEAT } from '@geonerva/baselines';
import { createCanonicalEvent, createDb, linkRecord, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation, seedRun } from '@geonerva/db/testing/factories';
import { historyResponseSchema, type HazardType, type LocationRef } from '@geonerva/domain';

import { buildHistory, type BuildHistoryOptions } from './history.ts';
import { isLexiconClean } from './lexicon.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
});

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const AS_OF = new Date('2026-09-21T00:00:00.000Z');
const CURRENT_START = new Date(AS_OF.getTime() - WEEK);
const daysAgo = (days: number): Date => new Date(AS_OF.getTime() - days * DAY);

const PLACE: LocationRef = {
  key: 'p:2542997',
  label: 'Marrakech',
  lat: 31.63,
  lon: -7.98,
  timezone: 'Africa/Casablanca',
  countryCode: 'MA',
  admin1: 'Marrakech-Safi',
};

function north(km: number): { lat: number; lon: number } {
  return { lat: PLACE.lat + km / 110.574, lon: PLACE.lon };
}

/**
 * §8.1's two mandated sentences, which the lexicon may excuse only verbatim: the first *denies* a
 * prediction ("does not by itself indicate that a larger earthquake will occur") and trips the
 * `PREDICTION` class on its own words. The exemption reaches only that class and only inside the
 * quoted span, so any other prediction phrase in the same text still fails.
 */
const MANDATED_CAVEATS = [EARTHQUAKE_ELEVATED_CAVEAT, AFTERSHOCK_CAVEAT];

async function history(overrides: Partial<BuildHistoryOptions> = {}) {
  const response = await buildHistory({
    db,
    location: PLACE,
    family: 'EARTHQUAKES',
    metric: 'EQ_COUNT_7D',
    radiusKm: 150,
    asOf: AS_OF,
    ...overrides,
  });
  // The contract's refinements — I9 coverage, status ⇔ reference — hold for every answer.
  const parsed = historyResponseSchema.parse(response);
  // And every sentence it carries is one the terminology rules allow (ARCHITECTURE §8.5).
  for (const text of [
    parsed.metric.label,
    parsed.metric.interpretation,
    ...parsed.metric.caveats,
    ...parsed.caveats,
    parsed.completenessStatement,
    parsed.rarity?.text,
    parsed.largestRecent?.text,
    parsed.sequenceContext?.text,
    parsed.sequenceContext?.caveat,
  ]) {
    if (text !== null && text !== undefined) {
      expect(isLexiconClean(text, { verbatimQuotes: MANDATED_CAVEATS }), text).toBe(true);
    }
  }
  return parsed;
}

async function committedRun(sourceId: string, at: Date): Promise<void> {
  await seedRun(db, { sourceId, status: 'SUCCEEDED', startedAt: at, newestObservedAt: at });
}

async function correlationRun(at: Date): Promise<void> {
  await sql`
    INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
    VALUES (gen_random_uuid(), 'CORRELATION', 'history-test-1', ${at}, ${at}, 'SUCCEEDED')
  `.execute(db);
}

async function earthquakesRead(): Promise<void> {
  await committedRun('usgs', daysAgo(0.01));
  await correlationRun(daysAgo(0.01));
}

let sequence = 0;

/** A record linked to a new canonical event, or to `event` when given. */
async function quake(options: {
  readonly observedAt: Date;
  readonly magnitude?: number | null;
  readonly km?: number;
  readonly ingestedAt?: Date;
  readonly sourceId?: string;
  readonly primaryKey?: string;
  readonly hazardType?: HazardType;
  readonly event?: { readonly id: string; readonly publicId: string };
  readonly linked?: boolean;
  readonly linkedAt?: Date;
  readonly magnitudeType?: string;
  readonly providerStatus?: string;
}): Promise<{ id: string; publicId: string }> {
  sequence += 1;
  const ingestedAt = options.ingestedAt ?? new Date(options.observedAt.getTime() + 60_000);
  const hazardType = options.hazardType ?? 'EARTHQUAKE';
  const seeded = await seedObservation(db, {
    sourceId: options.sourceId ?? 'usgs',
    hazardType,
    primaryKey: options.primaryKey ?? `q${String(sequence)}`,
    ingestedAt,
    observedAt: options.observedAt,
    centroid: north(options.km ?? 20),
    magnitude: options.magnitude === undefined ? 5.0 : options.magnitude,
    depthKm: hazardType === 'EARTHQUAKE' ? 10 : null,
    ...(options.magnitudeType === undefined ? {} : { magnitudeType: options.magnitudeType }),
    ...(options.providerStatus === undefined ? {} : { providerStatus: options.providerStatus }),
  });
  const event: { readonly id: string; readonly publicId: string } =
    options.event ?? (await createCanonicalEvent(db, { hazardType, createdAt: ingestedAt }));
  if (options.linked !== false) {
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: seeded.sourceRecordId,
        relation: options.event === undefined ? 'PRIMARY' : 'SAME_EVENT',
        matchKind: options.event === undefined ? 'SEED' : 'SPATIOTEMPORAL',
        algorithmVersion: 'test-1',
        linkedAt: options.linkedAt ?? ingestedAt,
      }),
    );
  }
  return { id: event.id, publicId: event.publicId };
}

/** One M5.0 event 20 km away in the middle of each of the `weeks` windows before the current. */
async function referenceCatalog(
  weeks: number,
  options: { readonly magnitude?: number; readonly km?: number; readonly offset?: number } = {},
): Promise<void> {
  for (let k = 0; k < weeks; k += 1) {
    await quake({
      observedAt: new Date(CURRENT_START.getTime() - (k + (options.offset ?? 0.5)) * WEEK),
      magnitude: options.magnitude ?? 5.0,
      km: options.km ?? 20,
    });
  }
}

describe('EQ_COUNT_7D', () => {
  it('compares the current week with every week since the catalog began', async () => {
    await earthquakesRead();
    await referenceCatalog(60);
    for (const days of [1, 2, 3]) await quake({ observedAt: daysAgo(days) });

    const response = await history();
    const metric = response.metric;
    expect(metric.status).toBe('OK');
    expect(metric.observedValue).toEqual({ kind: 'count', value: 3 });
    // The catalog starts half a week into the 60th window back, so 59 whole windows fit.
    expect(metric.reference?.nWindows).toBe(59);
    expect(metric.reference?.nEvents).toBe(59);
    expect(metric.reference?.median).toBe(1);
    expect(metric.reference?.mean).toBe(1);
    expect(metric.reference?.activityRatio).toBe(3);
    expect(metric.percentile).toBe(100);
    expect(metric.band).toBe('WELL_ABOVE_TYPICAL');
    expect(metric.caveats.length).toBe(1);
    expect(response.completenessStatement).toContain('M4.5+');
    expect(response.series[0]?.points.at(-1)).toEqual({
      t: CURRENT_START.toISOString(),
      value: 3,
      missingReason: null,
    });
    expect(response.series[0]?.points).toHaveLength(53);
    expect(response.evidenceManifest.map((item) => item.id)).toContain(metric.id);
    expect(response.attribution.map((entry) => entry.sourceId)).toEqual(['usgs']);
  });

  it('never counts a record, a revision or a correlation GeoNerva learned of after the knowledge time', async () => {
    await earthquakesRead();
    await referenceCatalog(60);
    await quake({ observedAt: daysAgo(1) });
    // Observed inside the window, but ingested after the knowledge time.
    await quake({ observedAt: daysAgo(2), ingestedAt: new Date(AS_OF.getTime() + 3_600_000) });
    // Below the threshold at the knowledge time; revised above it only afterwards.
    await quake({ observedAt: daysAgo(3), magnitude: 3.9, primaryKey: 'revised' });
    await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'revised',
      ingestedAt: new Date(AS_OF.getTime() + 3_600_000),
      observedAt: daysAgo(3),
      centroid: north(20),
      magnitude: 5.6,
      depthKm: 10,
    });

    const atAsOf = await history();
    expect(atAsOf.metric.observedValue).toEqual({ kind: 'count', value: 1 });

    const later = await history({ asOf: new Date(AS_OF.getTime() + 2 * 3_600_000) });
    expect(later.metric.observedValue).toEqual({ kind: 'count', value: 3 });
  });

  it('counts an event once however many sources reported it, and an unlinked record not at all', async () => {
    await earthquakesRead();
    await referenceCatalog(60);
    const event = await quake({ observedAt: daysAgo(1) });
    await quake({ observedAt: daysAgo(1), sourceId: 'emsc', event });
    await quake({ observedAt: daysAgo(2), linked: false });

    const response = await history();
    expect(response.metric.observedValue).toEqual({ kind: 'count', value: 1 });
  });

  it('counts only within the radius asked for', async () => {
    await earthquakesRead();
    await referenceCatalog(60);
    await quake({ observedAt: daysAgo(1) });
    await quake({ observedAt: daysAgo(2), km: 200 });

    expect((await history()).metric.observedValue).toEqual({ kind: 'count', value: 1 });
    expect((await history({ radiusKm: 300 })).metric.observedValue).toEqual({
      kind: 'count',
      value: 2,
    });
  });

  it('does not reach back before the catalog GeoNerva holds', async () => {
    /*
     * Thirty weeks of catalog. Over a ten-year reference this would be 521 windows and 30 events —
     * `OK`, with the empty years before the backfill counted as quiet ones. Clamped to the
     * catalog's start it is 29 windows, which is not enough history to say anything.
     */
    await earthquakesRead();
    await referenceCatalog(30);
    await quake({ observedAt: daysAgo(1) });

    const response = await history();
    expect(response.metric.status).toBe('INSUFFICIENT_HISTORY');
    expect(response.metric.reference).toBeNull();
    expect(response.metric.percentile).toBeNull();
    expect(response.metric.interpretation).toBe('Not enough history to establish a baseline.');
  });

  it('is rare activity, stated as a count, when the windows exist but the events do not', async () => {
    await earthquakesRead();
    // A catalog start 60 weeks back, far outside the radius, and only five events near.
    await quake({ observedAt: new Date(CURRENT_START.getTime() - 60 * WEEK), km: 280 });
    for (let k = 0; k < 5; k += 1) {
      await quake({ observedAt: new Date(CURRENT_START.getTime() - (k * 10 + 0.5) * WEEK) });
    }

    const response = await history();
    expect(response.metric.status).toBe('RARE_ACTIVITY');
    expect(response.rarity?.nEvents).toBe(5);
    expect(response.rarity?.radiusKm).toBe(150);
  });

  it('gives aftershock context for a large event in the last thirty days, and cites it', async () => {
    await earthquakesRead();
    await referenceCatalog(60);
    const large = await quake({ observedAt: daysAgo(12), magnitude: 6.1 });

    const response = await history();
    expect(response.sequenceContext?.triggerPublicId).toBe(large.publicId);
    expect(response.largestRecent?.subjectPublicId).toBe(large.publicId);
    const cited = new Set(response.evidenceManifest.map((item) => item.id));
    for (const id of response.sequenceContext?.evidenceIds ?? []) expect(cited.has(id)).toBe(true);
    expect(response.sequenceContext?.evidenceIds.length).toBeGreaterThan(0);
  });

  it('refuses to compute from a catalog GeoNerva had not read', async () => {
    await referenceCatalog(60);
    await correlationRun(daysAgo(0.01));

    const response = await history();
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(response.metric.observedValue).toEqual({
      kind: 'unavailable',
      reason: 'SOURCE_UNAVAILABLE',
    });
    expect(response.series).toEqual([]);
  });

  it('refuses when the records had not yet been grouped into events at the knowledge time', async () => {
    await referenceCatalog(60);
    await committedRun('usgs', daysAgo(0.01));
    await correlationRun(new Date(AS_OF.getTime() + 60_000));

    const response = await history();
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(response.metric.interpretation).toContain('grouped');
  });

  it('gives the same answer for the same knowledge time, and the same id', async () => {
    await earthquakesRead();
    await referenceCatalog(60);
    await quake({ observedAt: daysAgo(1) });

    const first = await history();
    await quake({ observedAt: daysAgo(2), ingestedAt: new Date(AS_OF.getTime() + 60_000) });
    const second = await history();
    expect(second).toEqual(first);
  });
});

describe('GDACS_CONTEXT', () => {
  it('counts the GDACS events within 300 km in the last five years, as known at the time', async () => {
    await committedRun('gdacs', daysAgo(0.01));
    const flood = await quake({
      observedAt: daysAgo(400),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
      km: 100,
    });
    await quake({
      observedAt: daysAgo(399),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
      km: 110,
      event: flood,
    });
    await quake({
      observedAt: daysAgo(30),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
      km: 250,
    });
    // Outside the radius, outside the five years, and learned of after the knowledge time.
    await quake({
      observedAt: daysAgo(30),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
      km: 400,
    });
    await quake({
      observedAt: daysAgo(6 * 365),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
    });
    await quake({
      observedAt: daysAgo(2),
      ingestedAt: new Date(AS_OF.getTime() + 60_000),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
    });

    const response = await history({ family: 'FLOODS', metric: 'GDACS_CONTEXT', radiusKm: 300 });
    expect(response.metric.status).toBe('NOT_APPLICABLE');
    expect(response.metric.observedValue).toEqual({ kind: 'count', value: 2 });
    expect(response.metric.interpretation).toBe('2 GDACS flood events within 300 km since 2021.');
    expect(response.attribution.map((entry) => entry.sourceId)).toEqual(['gdacs']);
  });

  it('refuses when GDACS had not been read', async () => {
    const response = await history({ family: 'CYCLONES', metric: 'GDACS_CONTEXT', radiusKm: 300 });
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
  });
});

describe('FIRE_TREND', () => {
  it('is unavailable until the daily aggregate exists (ADR-040)', async () => {
    await committedRun('firms', daysAgo(0.01));
    const response = await history({
      family: 'FIRE_ACTIVITY',
      metric: 'FIRE_TREND',
      radiusKm: 100,
    });
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(response.metric.percentile).toBeNull();
    expect(response.attribution.map((entry) => entry.sourceId)).toEqual(['firms']);
  });
});

describe('the reads each answer depends on', () => {
  it('does not count grouping by a correlation run that failed', async () => {
    await referenceCatalog(60);
    await committedRun('usgs', daysAgo(0.01));
    await sql`
      INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
      VALUES (gen_random_uuid(), 'CORRELATION', 'history-test-1', ${daysAgo(0.02)}, ${daysAgo(0.02)}, 'FAILED')
    `.execute(db);

    expect((await history()).metric.status).toBe('INSUFFICIENT_COVERAGE');
  });

  it('dates the catalog start from what was known at the time', async () => {
    // Thirty weeks known at the knowledge time; a five-year-old event backfilled only afterwards.
    await earthquakesRead();
    await referenceCatalog(30);
    await quake({ observedAt: daysAgo(5 * 365), ingestedAt: new Date(AS_OF.getTime() + 60_000) });

    expect((await history()).metric.status).toBe('INSUFFICIENT_HISTORY');
  });

  it('counts a record only once correlation had linked it', async () => {
    await earthquakesRead();
    await referenceCatalog(60);
    await quake({ observedAt: daysAgo(1) });
    await quake({ observedAt: daysAgo(2), linkedAt: new Date(AS_OF.getTime() + 60_000) });

    expect((await history()).metric.observedValue).toEqual({ kind: 'count', value: 1 });
    expect(
      (await history({ asOf: new Date(AS_OF.getTime() + 120_000) })).metric.observedValue,
    ).toEqual({ kind: 'count', value: 2 });
  });

  it('places an event at its headline member, not at whichever record sorts first', async () => {
    await earthquakesRead();
    // EMSC first, so it has the lower record id; USGS reviewed is the headline source.
    const event = await quake({
      observedAt: daysAgo(1),
      sourceId: 'emsc',
      km: 160,
      magnitudeType: 'mb',
    });
    await quake({
      observedAt: daysAgo(1),
      event,
      km: 140,
      magnitudeType: 'mww',
      providerStatus: 'reviewed',
    });
    await referenceCatalog(60);

    expect((await history()).metric.observedValue).toEqual({ kind: 'count', value: 1 });
  });

  it('estimates Mc over the 300 km region from the reference period alone', async () => {
    /*
     * Reference within 150 km: 60 × M5.0. Ring at 200 km: 100 × M4.8. Mode M4.8, so Mc = M5.0 by
     * maximum curvature, with 60 events above it. Current week: 150 × M5.3 at 250 km (a swarm
     * outside the radius), 2 × M4.7 and 1 × M5.1 inside it.
     *
     * Estimated within 150 km only, the mode is M5.0, nothing reaches M5.2, and the fallback M4.5
     * counts three. Estimated with the current week included, the swarm is the mode, nothing
     * reaches M5.5, and the fallback again counts three. The right answer is one.
     */
    await earthquakesRead();
    await referenceCatalog(60);
    for (let k = 0; k < 100; k += 1) {
      await quake({
        observedAt: new Date(CURRENT_START.getTime() - (k * 0.5 + 0.25) * WEEK),
        magnitude: 4.8,
        km: 200,
      });
    }
    for (let k = 0; k < 150; k += 1) {
      await quake({
        observedAt: new Date(AS_OF.getTime() - (k + 1) * 3_600_000),
        magnitude: 5.3,
        km: 250,
      });
    }
    await quake({ observedAt: daysAgo(1), magnitude: 4.7 });
    await quake({ observedAt: daysAgo(2), magnitude: 4.7 });
    await quake({ observedAt: daysAgo(3), magnitude: 5.1 });

    const response = await history();
    expect(response.metric.observedValue).toEqual({ kind: 'count', value: 1 });
    expect(response.metric.params).toMatchObject({
      magnitudeThreshold: 5,
      completenessMethod: 'MAXIMUM_CURVATURE',
    });
  });

  it('raises Mc to the retention floor when the reference reaches past thirty days', async () => {
    // Mode M3.0, 60 events at or above M3.2: Mc = M3.2 by maximum curvature, below the M4.5 floor.
    await earthquakesRead();
    await referenceCatalog(60, { magnitude: 3.0 });
    await referenceCatalog(60, { magnitude: 3.5, offset: 0.25 });
    await quake({ observedAt: daysAgo(1), magnitude: 3.8 });
    await quake({ observedAt: daysAgo(2), magnitude: 3.8 });

    const response = await history();
    expect(response.metric.observedValue).toEqual({ kind: 'count', value: 0 });
    expect(response.metric.params).toMatchObject({
      magnitudeThreshold: 4.5,
      completenessMethod: 'RETENTION_FLOOR',
    });
    expect(response.completenessStatement).toContain('30 days only');
  });

  it('refuses a catalog that reaches the safety bound rather than counting part of it', async () => {
    await earthquakesRead();
    for (let k = 0; k < 6; k += 1) await quake({ observedAt: daysAgo(k + 1) });

    await expect(history({ catalogLimit: 5 })).rejects.toThrow(/safety bound of 5/u);
    await expect(history({ catalogLimit: 7 })).resolves.toBeDefined();
  });

  it('reads GDACS as of the time: a later revision into the radius is not counted', async () => {
    await committedRun('gdacs', daysAgo(0.01));
    await quake({
      observedAt: daysAgo(30),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
      km: 400,
      primaryKey: 'moved',
    });
    await seedObservation(db, {
      sourceId: 'gdacs',
      hazardType: 'FLOOD',
      primaryKey: 'moved',
      ingestedAt: new Date(AS_OF.getTime() + 60_000),
      observedAt: daysAgo(30),
      centroid: north(250),
    });

    const flood = { family: 'FLOODS', metric: 'GDACS_CONTEXT', radiusKm: 300 } as const;
    expect((await history(flood)).metric.observedValue).toEqual({ kind: 'count', value: 0 });
    expect(
      (await history({ ...flood, asOf: new Date(AS_OF.getTime() + 120_000) })).metric.observedValue,
    ).toEqual({ kind: 'count', value: 1 });
  });
});
