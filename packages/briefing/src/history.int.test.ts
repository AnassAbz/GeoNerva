/**
 * `buildHistory` against a real database.
 *
 * The statistics have their own tests in `@geonerva/baselines`. What is tested here is what only
 * the read side can get wrong: that the catalog is read **as of** the knowledge time (a record, a
 * revision or a correlation run that arrived later changes nothing), that records are counted as
 * canonical events rather than as rows, that the reference period never starts before the catalog
 * GeoNerva holds, that a metric with no inputs is refused rather than computed from nothing, and
 * that the whole response satisfies its contract — every citation resolved (I9).
 *
 * `FIRE_TREND` adds one more, and it is the sharpest of them: a day GeoNerva did not read every
 * hour of is **excluded** from the comparison rather than counted as a quiet one (ADR-040). A
 * missing overpass presented as zero detections is the availability lie arriving through an
 * average, so the tests for it compare the same detections read two ways.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AFTERSHOCK_CAVEAT, EARTHQUAKE_ELEVATED_CAVEAT } from '@geonerva/baselines';
import {
  createCanonicalEvent,
  createDb,
  linkRecord,
  recordIntervalCoverage,
  recordLiveCoverage,
  type DB,
  type FireDayState,
} from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation, seedRun } from '@geonerva/db/testing/factories';
import { historyResponseSchema, type HazardType, type LocationRef } from '@geonerva/domain';
import { THERMAL_DETECTION_CAVEAT } from '@geonerva/relevance';

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

/**
 * A completed historical backfill of `[from, to)` for a source, checkpointed at `completedAt`.
 * Coverage is what the baseline trusts (P8 review H1), so every fixture states it explicitly.
 */
async function backfilled(
  sourceId: string,
  from: Date,
  to: Date,
  options: { readonly completedAt?: Date; readonly minMagnitude?: number | null } = {},
): Promise<void> {
  // A window is read by the time its interval completes, and not before: default to its end.
  const completedAt = options.completedAt ?? to;
  const plan = await sql<{ id: string }>`
    WITH plan AS (
      INSERT INTO geonerva.backfill_plans
        (id, source_id, mode, range_from, range_to, min_magnitude, window_ms, min_window_ms,
         status, finished_at)
      VALUES (gen_random_uuid(), ${sourceId}, 'HISTORICAL', ${from}, ${to},
              ${options.minMagnitude ?? null}, ${DAY}, ${DAY}, 'COMPLETED', ${completedAt})
      RETURNING id
    ), interval AS (
      INSERT INTO geonerva.backfill_intervals (plan_id, interval_from, interval_to, status, completed_at)
      SELECT id, ${from}, ${to}, 'DONE', ${completedAt} FROM plan
    )
    SELECT id::text AS id FROM plan
  `.execute(db);
  // The ledger, as `markIntervalDone` writes it in production (ADR-041).
  await db
    .transaction()
    .execute((trx) => recordIntervalCoverage(trx, { planId: plan.rows[0]?.id ?? '', from, to }));
}

/** One scheduled poll of a feed at `at`, reading `lookbackHours` back, recorded at its commit. */
async function livePoll(source: string, code: string, at: Date, lookbackHours = 24): Promise<void> {
  const product = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = ${source} AND code = ${code}
  `.execute(db);
  await db.transaction().execute((trx) =>
    recordLiveCoverage(trx, {
      productId: product.rows[0]?.id ?? 0,
      window: { from: new Date(at.getTime() - lookbackHours * 3_600_000), to: at },
      recordedAt: at,
    }),
  );
}

/** The catalog GeoNerva had read: backfilled from `coveredFrom`, then polled live up to T. */
async function earthquakesRead(
  coveredFrom: Date = new Date(CURRENT_START.getTime() - 59.5 * WEEK),
): Promise<void> {
  await backfilled('usgs', coveredFrom, daysAgo(0.01));
  await committedRun('usgs', daysAgo(0.01));
  await correlationRun(daysAgo(0.01));
}

async function seedRan(at: Date): Promise<void> {
  await sql`
    INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
    VALUES (gen_random_uuid(), 'SEED', 'history-test-1', ${at}, ${at}, 'SUCCEEDED')
  `.execute(db);
}

async function gdacsRead(coveredFrom: Date = daysAgo(6 * 365)): Promise<void> {
  await backfilled('gdacs', coveredFrom, daysAgo(0.01));
  await committedRun('gdacs', daysAgo(0.01));
  await seedRan(daysAgo(0.01));
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

/**
 * ADR-041's second condition, in a test: **historical baselines must keep working after detailed
 * run history is pruned.**
 *
 * Coverage used to be derived from `ingestion_runs` and backfill checkpoints, so ADR-033's 90-day
 * sweep would have silently turned a read catalog into an unread one — a baseline that answered
 * yesterday refusing today, for no reason on the ground. The ledger exists to break that
 * dependency, and the only way to show it did is to delete the run history and ask again.
 *
 * The owner's instruction was that the sweep must not be enabled until this is verified. This is
 * that verification; it is referenced from the handoff.
 */
describe('a baseline after its run history is pruned (ADR-041)', () => {
  /*
   * Coverage is per feed, so each span must say which source *its* feed belongs to. Reading the
   * source from anywhere else — the first product of the query, say — credits one provider with
   * another's data: an answer built entirely from EMSC, attributed to USGS.
   */
  it('credits the source whose feed was actually read', async () => {
    const from = new Date(CURRENT_START.getTime() - 59.5 * WEEK);
    await backfilled('emsc', from, daysAgo(0.01));
    await committedRun('emsc', daysAgo(0.01));
    await correlationRun(daysAgo(0.01));
    // The whole catalog is EMSC's, so nothing in the answer came from USGS at all.
    for (let k = 0; k < 60; k += 1) {
      await quake({
        observedAt: new Date(CURRENT_START.getTime() - (k + 0.5) * WEEK),
        sourceId: 'emsc',
      });
    }
    for (const days of [1, 2]) await quake({ observedAt: daysAgo(days), sourceId: 'emsc' });

    const response = await history();
    expect(response.metric.status).toBe('OK');
    expect(response.attribution.map((entry) => entry.sourceId)).toEqual(['emsc']);
  });

  it('answers identically when every ingestion run and backfill record is gone', async () => {
    await earthquakesRead();
    await referenceCatalog(60);
    for (const days of [1, 2, 3]) await quake({ observedAt: daysAgo(days) });

    const before = await history();
    expect(before.metric.status).toBe('OK');
    expect(before.metric.reference?.nWindows).toBe(59);

    /*
     * What ADR-033's sweep does, at its most brutal: every run row, every plan and every interval.
     * The ledger rows are deliberately left, because they are what is meant to survive — they are
     * a few hundred bytes a feed a day, which is why keeping them is affordable.
     */
    await sql`DELETE FROM geonerva.backfill_intervals`.execute(db);
    await sql`DELETE FROM geonerva.backfill_plans`.execute(db);
    await sql`DELETE FROM geonerva.ingestion_runs`.execute(db);
    const remaining = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.feed_coverage_hours
    `.execute(db);
    expect(Number(remaining.rows[0]?.n)).toBeGreaterThan(0);

    const after = await history();
    // The same answer, not merely a non-refusal: the count, the reference and the band all hold.
    expect(after.metric.status).toBe(before.metric.status);
    expect(after.metric.observedValue).toEqual(before.metric.observedValue);
    expect(after.metric.reference).toEqual(before.metric.reference);
    expect(after.metric.band).toBe(before.metric.band);
    expect(after.metric.percentile).toBe(before.metric.percentile);
    expect(after.series[0]?.points).toEqual(before.series[0]?.points);
    expect(after.completenessStatement).toBe(before.completenessStatement);
  });
});

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

    // Still polling two hours on, as a live deployment would be; USGS is stale after one hour.
    for (let minutes = 30; minutes <= 114; minutes += 28) {
      const at = new Date(AS_OF.getTime() + minutes * 60_000);
      await committedRun('usgs', at);
      await livePoll('usgs', 'comcat', at);
    }
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

  it('does not reach back before the catalog GeoNerva read', async () => {
    /*
     * Thirty weeks of catalog. Over a ten-year reference this would be 521 windows and 30 events —
     * `OK`, with the empty years before the backfill counted as quiet ones. Clamped to the
     * coverage's start it is 29 windows, which is not enough history to say anything.
     */
    await earthquakesRead(new Date(CURRENT_START.getTime() - 29.5 * WEEK));
    await referenceCatalog(30);
    await quake({ observedAt: daysAgo(1) });

    const response = await history();
    expect(response.metric.status).toBe('INSUFFICIENT_HISTORY');
    expect(response.metric.reference).toBeNull();
    expect(response.metric.percentile).toBeNull();
    expect(response.metric.interpretation).toBe('Not enough history to establish a baseline.');
  });

  it('is rare activity, stated as a count, when the windows exist but the events do not', async () => {
    await earthquakesRead(new Date(CURRENT_START.getTime() - 60 * WEEK));
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
    // Read — the ledger says so (ADR-041) — but not yet grouped: the second refusal, not the first.
    await backfilled('usgs', new Date(CURRENT_START.getTime() - 59.5 * WEEK), daysAgo(0.01));
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
    await gdacsRead();
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

  it('counts only from where the GDACS record begins, and says so (P8 review H2)', async () => {
    // A hundred days of GDACS read, not five years: an older flood is outside what was looked at.
    await gdacsRead(daysAgo(100));
    await quake({
      observedAt: daysAgo(400),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
      km: 100,
    });
    await quake({
      observedAt: daysAgo(40),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
      km: 100,
    });

    const response = await history({ family: 'FLOODS', metric: 'GDACS_CONTEXT', radiusKm: 300 });
    expect(response.metric.observedValue).toEqual({ kind: 'count', value: 1 });
    expect(response.metric.interpretation).toBe(
      "1 GDACS flood event within 300 km since 13 June 2026, when GeoNerva's GDACS record begins.",
    );
  });

  it('refuses when no events had been opened for the GDACS records', async () => {
    await backfilled('gdacs', daysAgo(6 * 365), daysAgo(0.01));
    await committedRun('gdacs', daysAgo(0.01));
    const response = await history({ family: 'FLOODS', metric: 'GDACS_CONTEXT', radiusKm: 300 });
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(response.metric.interpretation).toContain('opened events');
  });

  it('refuses when GDACS had not been read', async () => {
    const response = await history({ family: 'CYCLONES', metric: 'GDACS_CONTEXT', radiusKm: 300 });
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
  });
});

const FIRE = { family: 'FIRE_ACTIVITY', metric: 'FIRE_TREND', radiusKm: 100 } as const;

/**
 * The last day the trend may count at `AS_OF`.
 *
 * A UTC day stays inside the FIRMS `DAY_RANGE` fetch window for a day after it ends, so nothing
 * more recent than two days before the knowledge time is final (ADR-040). Stated here rather than
 * recomputed, so that a test reads as the days it is about.
 */
const FIRE_LAST_DAY = '2026-09-19';

/** The 35 UTC days of the window at `AS_OF`, oldest first: the 28 previous, then the 7 recent. */
const FIRE_WINDOW = Array.from({ length: 35 }, (_, index) =>
  new Date(Date.UTC(2026, 8, 19) - (34 - index) * DAY).toISOString().slice(0, 10),
);

/**
 * Two cells of the 0.25° grid of ADR-011,
 * `floor((lat + 90) / 0.25) * 1440 + floor((lon + 180) / 0.25)`.
 *
 * The read path places a cell at its centre, so `NEAR_CELL` sits about 10 km from Marrakech and
 * `FAR_CELL`, four degrees of longitude west, about 460 km from it — comfortably outside R.
 */
const NEAR_CELL = 486 * 1440 + 688;
const FAR_CELL = 486 * 1440 + 668;

/** One UTC day of the aggregate: what was read, and how much was detected. */
interface FireDaySeed {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  readonly detections: number;
  /** Defaults to `COVERED`; `NOT_COVERED` is a day GeoNerva did not read every hour of. */
  readonly state?: FireDayState;
}

/** The FIRMS thermal feeds. Both are seeded active since long before any window in 2026. */
async function firmsProducts(): Promise<number[]> {
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products
    WHERE source_id = 'firms' AND hazard_types && ARRAY['THERMAL_ACTIVITY']::text[]
    ORDER BY id
  `.execute(db);
  return result.rows.map((row) => row.id);
}

/**
 * Detections in one grid cell, with no claim about coverage: the counts half of the aggregate.
 *
 * Written against the **first** feed alone, so that a day's total is the number the test asked for
 * rather than twice it. The read path sums every feed's cells for the day, which is right — two
 * sensors see different overpasses — but it makes a fixture that writes both hard to read.
 */
async function fireCounts(
  cellId: number,
  days: readonly FireDaySeed[],
  options: { readonly computedAt?: Date } = {},
): Promise<void> {
  const counted = days.filter((entry) => entry.detections > 0);
  if (counted.length === 0) return;
  const productIds = await firmsProducts();
  await sql`
    INSERT INTO geonerva.fire_daily_counts
      (cell_id, day, product_id, computed_at, n, n_high_conf, frp_sum)
    SELECT ${cellId}::int, d.day, ${productIds[0] ?? 0}::smallint,
           ${options.computedAt ?? daysAgo(0.01)}::timestamptz, d.n, 0, NULL::real
    FROM unnest(${sql.val(counted.map((entry) => entry.day))}::date[],
                ${sql.val(counted.map((entry) => entry.detections))}::int[]) AS d(day, n)
  `.execute(db);
}

/**
 * The aggregate `recordFireDailyAggregate` writes, stated a day at a time.
 *
 * Raw SQL rather than the aggregator itself, because these are read-side tests: saying "this day
 * was read and held twenty detections" through the writer would mean seeding 35 daily partitions
 * and 840 coverage hours per feed for every scenario below. The writer has its own tests, against
 * a real FIRMS batch, in `@geonerva/pipeline`.
 *
 * Coverage is written for **every** feed, because a day counts as read only when each feed the
 * trend uses read it: one sensor's missing day is not a quiet day for the group.
 */
async function fireAggregate(
  days: readonly FireDaySeed[],
  options: { readonly computedAt?: Date } = {},
): Promise<void> {
  const productIds = await firmsProducts();
  await sql`
    INSERT INTO geonerva.fire_daily_coverage (product_id, day, computed_at, state)
    SELECT p.id, d.day, ${options.computedAt ?? daysAgo(0.01)}::timestamptz, d.state
    FROM unnest(${sql.val(days.map((entry) => entry.day))}::date[],
                ${sql.val(days.map((entry) => entry.state ?? 'COVERED'))}::text[]) AS d(day, state)
    CROSS JOIN unnest(${sql.val(productIds)}::smallint[]) AS p(id)
  `.execute(db);
  await fireCounts(NEAR_CELL, days, options);
}

/** The detections-per-day a response states, or `null` when it states none. */
function meanPerDay(response: Awaited<ReturnType<typeof history>>): number | null {
  const value = response.metric.observedValue;
  return value.kind === 'number' ? value.value : null;
}

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

  it('compares the last 7 days with the 28 before them, per covered day', async () => {
    await committedRun('firms', daysAgo(0.01));
    /*
     * Two detections a day for four weeks, then a week of 148 across seven days. 21.1 is a mean
     * that no single day holds, so an assertion on it cannot be satisfied by a total or by any
     * one day's count.
     */
    const recent = [20, 20, 20, 20, 20, 20, 28];
    await fireAggregate(
      FIRE_WINDOW.map((day, index) => ({
        day,
        detections: index < 28 ? 2 : (recent[index - 28] ?? 0),
      })),
    );
    // A busy cell 460 km away on every day of the recent week: read, and outside R, so not counted.
    await fireCounts(
      FAR_CELL,
      FIRE_WINDOW.slice(28).map((day) => ({ day, detections: 500 })),
    );

    const response = await history(FIRE);
    const metric = response.metric;
    expect(metric.status).toBe('OK');
    expect(metric.trendBand).toBe('INCREASING');
    expect(metric.observedValue).toEqual({
      kind: 'number',
      value: 21.1,
      unit: 'detections/day',
      decimals: 1,
    });
    /*
     * A direction is not a place in a distribution. `FIRE_TREND` compares two periods with each
     * other rather than one value with a reference, so `band` and `percentile` — which mean "where
     * in the distribution" — must stay empty, and `trendBand` carries the answer (ADR-040).
     */
    expect(metric.band).toBeNull();
    expect(metric.percentile).toBeNull();
    expect(metric.params).toEqual({
      radiusKm: 100,
      recentDays: 7,
      previousDays: 28,
      sensors: 2,
      lastDay: FIRE_LAST_DAY,
    });
    // §9.2's mandatory sentence, on the metric and on the response that carries it.
    expect(metric.caveats).toEqual([THERMAL_DETECTION_CAVEAT]);
    expect(response.caveats).toEqual([THERMAL_DETECTION_CAVEAT]);
    expect(response.attribution.map((entry) => entry.sourceId)).toEqual(['firms']);
  });

  it('is STABLE for a change that is large in proportion and small in detections', async () => {
    /*
     * One detection a day becoming three is a trebling, and it is also two detections. The band
     * moves only when the two means differ by ≥ 50 % **and** by ≥ 10 detections a day, so that a
     * quiet place is never reported as fire activity trebling on the strength of two pixels.
     */
    await committedRun('firms', daysAgo(0.01));
    await fireAggregate(FIRE_WINDOW.map((day, index) => ({ day, detections: index < 28 ? 1 : 3 })));

    const metric = (await history(FIRE)).metric;
    expect(metric.status).toBe('OK');
    expect(metric.trendBand).toBe('STABLE');
    expect(metric.observedValue).toEqual({
      kind: 'number',
      value: 3,
      unit: 'detections/day',
      decimals: 1,
    });
  });

  it('refuses when the aggregate holds no covered day of one of the two periods', async () => {
    // Four weeks read, and not one day of the week they are to be compared with.
    await committedRun('firms', daysAgo(0.01));
    await fireAggregate(
      FIRE_WINDOW.map((day, index) => ({
        day,
        detections: index < 28 ? 5 : 0,
        state: index < 28 ? ('COVERED' as const) : ('NOT_COVERED' as const),
      })),
    );

    const metric = (await history(FIRE)).metric;
    expect(metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(metric.observedValue).toEqual({ kind: 'unavailable', reason: 'NOT_COVERED' });
    expect(metric.trendBand).toBeNull();
    expect(metric.band).toBeNull();
    expect(metric.interpretation).toContain('Not enough satellite coverage');
  });

  it('excludes an unread day from the mean instead of counting it as a quiet one', async () => {
    /*
     * The invariant ADR-040 exists for.
     *
     * Ninety detections over the three days that were read is thirty a day. The same ninety over
     * seven, four of which GeoNerva did not read every hour of, is thirteen — a number produced by
     * the reading and not by the fires, because a missing overpass is not a quiet day. Both means
     * are computed below from the *same* detections, so the difference between them cannot be
     * anything except how the unread days were treated.
     */
    await committedRun('firms', daysAgo(0.01));
    const unread = FIRE_WINDOW.slice(28, 32);
    await fireAggregate(
      FIRE_WINDOW.map((day, index) => ({
        day,
        detections: index < 28 ? 2 : unread.includes(day) ? 0 : 30,
        state: unread.includes(day) ? ('NOT_COVERED' as const) : ('COVERED' as const),
      })),
    );

    const excluded = await history(FIRE);
    expect(excluded.metric.observedValue).toEqual({
      kind: 'number',
      value: 30,
      unit: 'detections/day',
      decimals: 1,
    });

    /*
     * The same four days, later found to have been read after all and to hold nothing — a
     * correction, which ADR-040 makes a new row with a later knowledge time rather than an update.
     * Now they are genuine zeros, and 90 detections are spread over seven days instead of three.
     */
    await fireAggregate(
      unread.map((day) => ({ day, detections: 0, state: 'COVERED' as const })),
      { computedAt: new Date(AS_OF.getTime() + 3_600_000) },
    );
    const asZero = await history({ ...FIRE, asOf: new Date(AS_OF.getTime() + 2 * 3_600_000) });
    expect(asZero.metric.observedValue).toEqual({
      kind: 'number',
      value: 12.9,
      unit: 'detections/day',
      decimals: 1,
    });

    // Stated as the comparison rather than as two literals: excluding an unread day must not give
    // the answer that counting it as zero gives, and here it must give a higher one.
    expect(meanPerDay(excluded) ?? 0).toBeGreaterThan(meanPerDay(asZero) ?? 0);
  });

  it('gives one point per day of the window, in order, and says which days were not read', async () => {
    await committedRun('firms', daysAgo(0.01));
    const unread = FIRE_WINDOW[30] ?? '';
    await fireAggregate(
      FIRE_WINDOW.map((day) => ({
        day,
        detections: day === unread ? 0 : 4,
        state: day === unread ? ('NOT_COVERED' as const) : ('COVERED' as const),
      })),
    );

    const series = (await history(FIRE)).series[0];
    expect(series?.bucketDays).toBe(1);
    // One point per day, oldest first, and no day of the window missing from the chart.
    expect(series?.points.map((point) => point.t)).toEqual(
      FIRE_WINDOW.map((day) => `${day}T00:00:00.000Z`),
    );
    // A day not read is not a quiet day, and the chart has to be able to say which it was.
    expect(series?.points[30]).toEqual({
      t: `${unread}T00:00:00.000Z`,
      value: null,
      missingReason: 'NOT_COVERED',
    });
    expect(series?.points[29]).toEqual({
      t: `${FIRE_WINDOW[29] ?? ''}T00:00:00.000Z`,
      value: 4,
      missingReason: null,
    });
  });

  it('ends the window two days before the knowledge time, so yesterday cannot be in it', async () => {
    /*
     * A UTC day is still inside the FIRMS fetch window for a day after it ends, so the most recent
     * day the trend may count is two days old. Yesterday is seeded here as read and very busy —
     * which the aggregator would never write, precisely because the day is not final — so that
     * what keeps it out of the trend is the window rather than the absence of a row.
     */
    await committedRun('firms', daysAgo(0.01));
    await fireAggregate(FIRE_WINDOW.map((day) => ({ day, detections: 2 })));
    await fireAggregate([{ day: '2026-09-20', detections: 5000 }]);

    const response = await history(FIRE);
    expect(response.metric.params).toMatchObject({ lastDay: FIRE_LAST_DAY });
    expect(response.metric.trendBand).toBe('STABLE');
    expect(response.metric.observedValue).toEqual({
      kind: 'number',
      value: 2,
      unit: 'detections/day',
      decimals: 1,
    });
    expect(response.series[0]?.points.at(-1)?.t).toBe(`${FIRE_LAST_DAY}T00:00:00.000Z`);
    expect(response.series[0]?.points.map((point) => point.t)).not.toContain(
      '2026-09-20T00:00:00.000Z',
    );
  });

  it('does not see an aggregate row computed after the knowledge time', async () => {
    await committedRun('firms', daysAgo(0.01));
    // The whole window, aggregated an hour after the knowledge time the first request asks about.
    await fireAggregate(
      FIRE_WINDOW.map((day, index) => ({ day, detections: index < 28 ? 2 : 40 })),
      { computedAt: new Date(AS_OF.getTime() + 3_600_000) },
    );

    const atAsOf = await history(FIRE);
    expect(atAsOf.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(atAsOf.metric.observedValue).toEqual({ kind: 'unavailable', reason: 'NOT_COVERED' });

    // The same request once that computation had happened. Two hours on is the same UTC day, so
    // it is the same 35 days being asked about, and only the knowledge time has moved.
    const afterwards = await history({ ...FIRE, asOf: new Date(AS_OF.getTime() + 2 * 3_600_000) });
    expect(afterwards.metric.status).toBe('OK');
    expect(afterwards.metric.trendBand).toBe('INCREASING');
    expect(afterwards.metric.params).toMatchObject({ lastDay: FIRE_LAST_DAY });
  });

  describe('when no sensor spans the whole window (ADR-009)', () => {
    afterEach(async () => {
      /*
       * `source_products` is seeded reference data, which the harness deliberately does not
       * truncate — so a test that moves a sensor's lifetime has to put it back, or it has moved it
       * for every test that runs after it in this file.
       */
      await sql`
        UPDATE geonerva.source_products
        SET active_from = CASE code
              WHEN 'VIIRS_NOAA20_NRT' THEN DATE '2018-01-01'
              ELSE DATE '2023-01-01'
            END,
            active_to = NULL
        WHERE source_id = 'firms' AND hazard_types && ARRAY['THERMAL_ACTIVITY']::text[]
      `.execute(db);
    });

    it('refuses rather than comparing a week with four weeks a sensor was not there for', async () => {
      await committedRun('firms', daysAgo(0.01));
      // A complete, strongly increasing aggregate: the refusal below is about the instruments.
      await fireAggregate(
        FIRE_WINDOW.map((day, index) => ({ day, detections: index < 28 ? 2 : 40 })),
      );
      /*
       * Both feeds switched on in the middle of the window. A sensor added or retired inside the
       * period cannot be compared against itself: the step in the detection count would be the
       * change of instrument, reported as a change in fire activity.
       */
      await sql`
        UPDATE geonerva.source_products SET active_from = DATE '2026-09-01'
        WHERE source_id = 'firms' AND hazard_types && ARRAY['THERMAL_ACTIVITY']::text[]
      `.execute(db);

      const response = await history(FIRE);
      expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
      expect(response.metric.observedValue).toEqual({
        kind: 'unavailable',
        reason: 'SOURCE_UNAVAILABLE',
      });
      expect(response.metric.trendBand).toBeNull();
      expect(response.metric.interpretation).toContain(
        'No fire-detection sensor covered this whole period',
      );
      // The unavailable variant carries the radius alone, and has no series to draw.
      expect(response.metric.params).toEqual({ radiusKm: 100 });
      expect(response.series).toEqual([]);
    });
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

  it('trusts only coverage checkpointed by the knowledge time', async () => {
    // Thirty weeks covered at T; five more years backfilled only afterwards.
    await earthquakesRead(new Date(CURRENT_START.getTime() - 29.5 * WEEK));
    await backfilled('usgs', daysAgo(5 * 365), new Date(CURRENT_START.getTime() - 29.5 * WEEK), {
      completedAt: new Date(AS_OF.getTime() + 60_000),
    });
    await referenceCatalog(30);
    await quake({ observedAt: daysAgo(5 * 365), ingestedAt: daysAgo(4 * 365) });

    expect((await history()).metric.status).toBe('INSUFFICIENT_HISTORY');
    // Once that backfill is checkpointed the same catalog has a five-year reference.
    expect((await history({ asOf: new Date(AS_OF.getTime() + 120_000) })).metric.status).toBe('OK');
  });

  it('never reaches across a gap in the catalog GeoNerva read (P8 review H1)', async () => {
    /*
     * A backfill that finished 2016–2017 and stopped. The records it fetched are there, and so is
     * a busy recent year — but the eight years between were never read. Counting them as quiet
     * weeks is what made an ordinary week "above typical"; the reference must start after the gap.
     */
    await backfilled('usgs', daysAgo(10 * 365), daysAgo(9 * 365));
    // The last thirty days read, so the refusal below is about the gap, not the current window.
    await backfilled('usgs', daysAgo(30), daysAgo(0.01));
    await committedRun('usgs', daysAgo(0.01));
    await correlationRun(daysAgo(0.01));
    for (let k = 0; k < 30; k += 1) await quake({ observedAt: daysAgo(10 * 365 - k * 7) });
    await referenceCatalog(60);
    await quake({ observedAt: daysAgo(1) });
    await quake({ observedAt: daysAgo(2) });

    const response = await history();
    expect(response.metric.status).toBe('INSUFFICIENT_HISTORY');
    expect(response.metric.band).toBeNull();
  });

  it('counts only fetched historical windows as coverage', async () => {
    /*
     * Two things that look like coverage and are not: a window that was SPLIT (finished, but only
     * because its children carry the work, and they are still pending) and a deletion sweep
     * (planned like a backfill, but it asks which records disappeared, not what happened). Each is
     * handed to the ledger writer the way a checkpoint would, and the writer declines them.
     */
    await earthquakesRead(new Date(CURRENT_START.getTime() - 29.5 * WEEK));
    const older = new Date(CURRENT_START.getTime() - 29.5 * WEEK);
    for (const [mode, status] of [
      ['HISTORICAL', 'SPLIT'],
      ['DELETION_SWEEP', 'DONE'],
    ] as const) {
      const plan = await sql<{ id: string }>`
        WITH plan AS (
          INSERT INTO geonerva.backfill_plans
            (id, source_id, mode, range_from, range_to, window_ms, min_window_ms, status)
          VALUES (gen_random_uuid(), 'usgs', ${mode}, ${daysAgo(5 * 365)}, ${older},
                  ${DAY}, ${DAY}, 'RUNNING')
          RETURNING id
        ), interval AS (
          INSERT INTO geonerva.backfill_intervals
            (plan_id, interval_from, interval_to, status, completed_at)
          SELECT id, ${daysAgo(5 * 365)}::timestamptz, ${older}::timestamptz, ${status},
                 ${daysAgo(2)}::timestamptz
          FROM plan
        )
        SELECT id::text AS id FROM plan
      `.execute(db);
      await db.transaction().execute((trx) =>
        recordIntervalCoverage(trx, {
          planId: plan.rows[0]?.id ?? '',
          from: daysAgo(5 * 365),
          to: older,
        }),
      );
    }
    await referenceCatalog(30);
    for (let k = 0; k < 150; k += 1) await quake({ observedAt: daysAgo(3 * 365 - k * 7) });

    expect((await history()).metric.status).toBe('INSUFFICIENT_HISTORY');
  });

  it('does not count a backfill that fetched only above the magnitudes it counts', async () => {
    await backfilled('usgs', new Date(CURRENT_START.getTime() - 59.5 * WEEK), daysAgo(0.01), {
      minMagnitude: 5.5,
    });
    // A complete read of the last thirty days alongside it, so only the M5.5 plan is in question.
    await backfilled('usgs', daysAgo(30), daysAgo(0.01));
    await committedRun('usgs', daysAgo(0.01));
    await correlationRun(daysAgo(0.01));
    await referenceCatalog(60, { magnitude: 5.6 });

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
    await gdacsRead();
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

describe('live coverage comes from the ledger, by read window (ADR-041)', () => {
  async function usgsProduct(): Promise<number> {
    const result = await sql<{ id: number }>`
      SELECT id FROM geonerva.source_products WHERE source_id = 'usgs' AND code = 'comcat'
    `.execute(db);
    return result.rows[0]?.id ?? 0;
  }

  /** One scheduled poll at `at` that read `lookbackHours` back, recorded at its commit. */
  async function poll(at: Date, lookbackHours = 24): Promise<void> {
    const productId = await usgsProduct();
    await db.transaction().execute((trx) =>
      recordLiveCoverage(trx, {
        productId,
        window: { from: new Date(at.getTime() - lookbackHours * 3_600_000), to: at },
        recordedAt: at,
      }),
    );
  }

  /** Polls every 30 minutes over `[from, to]`. */
  /**
   * Polls from `from` to `to` at `stepMinutes`, which must stay inside `lookbackHours` or the
   * windows stop overlapping and the ledger gets the gaps these tests are about.
   *
   * The default cadence is the one the gap tests need. A test that only wants *unbroken* coverage
   * over a long span should widen the step: at half an hour, sixty days is some 2,880 sequential
   * round trips, which on this machine is twenty-five seconds and the reason a full-suite run
   * could trip the thirty-second timeout while the same file passed on its own.
   */
  async function polled(from: Date, to: Date, lookbackHours = 24, stepMinutes = 30): Promise<void> {
    if (stepMinutes > lookbackHours * 60) {
      throw new Error(`polled: a ${String(stepMinutes)}-minute step leaves a gap in the ledger`);
    }
    let at = from.getTime();
    for (; at <= to.getTime(); at += stepMinutes * 60_000) {
      await poll(new Date(at), lookbackHours);
    }
    /*
     * And one at `to` itself. Without it the last poll lands up to a step short of the range end,
     * and the earthquake baseline refuses because the *current* window was not read whole — which
     * is correct behaviour, and a fixture artefact rather than the thing under test.
     */
    if (at - stepMinutes * 60_000 < to.getTime()) await poll(to, lookbackHours);
  }

  const backfillEnd = daysAgo(60);

  beforeEach(async () => {
    // Sixty weeks backfilled up to sixty days ago, a catalog inside it, a live run, correlation.
    await backfilled('usgs', new Date(CURRENT_START.getTime() - 59.5 * WEEK), backfillEnd);
    await committedRun('usgs', daysAgo(0.01));
    await correlationRun(daysAgo(0.01));
    await referenceCatalog(60);
  });

  it('is OK when polling picks up where the backfill stopped and never lapses', async () => {
    await polled(backfillEnd, daysAgo(0.01));
    expect((await history()).metric.status).toBe('OK');
  });

  it('bridges a stop that the next poll read again, and nothing longer', async () => {
    // Two hours without a poll, forty days ago: the next 24-hour window reads them again.
    await polled(backfillEnd, daysAgo(40));
    await polled(new Date(daysAgo(40).getTime() + 2 * 3_600_000), daysAgo(0.01));
    expect((await history()).metric.status).toBe('OK');
  });

  it('breaks coverage where polling stopped for longer than a poll reads back', async () => {
    // Thirty hours without a poll: the next 24-hour window starts after the gap.
    await polled(backfillEnd, daysAgo(40));
    await polled(new Date(daysAgo(40).getTime() + 30 * 3_600_000), daysAgo(0.01));
    expect((await history()).metric.status).toBe('INSUFFICIENT_HISTORY');
  });

  it('does not bridge a forty-minute stop for a feed that reads fifteen minutes back', async () => {
    /*
     * Read in full up to half a day ago, then fifteen-minute windows every five minutes, as EMSC
     * polls. With a forty-minute stop first, the new windows never meet the old coverage, and the
     * current week is only half a day deep; without the stop they meet, and it is the whole week.
     */
    const resumeAt = daysAgo(0.5);
    await backfilled('usgs', backfillEnd, resumeAt);
    for (
      let at = resumeAt.getTime() + 40 * 60_000;
      at <= daysAgo(0.01).getTime();
      at += 5 * 60_000
    ) {
      await poll(new Date(at), 0.25);
    }
    expect((await history()).metric.status, 'across the stop').toBe('INSUFFICIENT_COVERAGE');

    // One window across the stop — what a poll that did not skip would have read.
    await poll(new Date(resumeAt.getTime() + 40 * 60_000), 45 / 60);
    expect((await history()).metric.status, 'with the stop read').toBe('OK');
  });

  it('does not reach the knowledge time from polling that stopped a day ago', async () => {
    await polled(backfillEnd, daysAgo(1));
    const response = await history();
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(response.metric.observedValue.kind).toBe('unavailable');
  });

  it('refuses a count over a current window it read only part of', async () => {
    // Polling began three days ago, long after the backfill stopped.
    await polled(daysAgo(3), daysAgo(0.01));
    const response = await history();
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(response.metric.interpretation).toContain('less than 7 days');
  });

  it('does not let a backfill claim time past the moment it finished', async () => {
    // A `--to` a week in the future, completed sixty days ago: read up to its completion only.
    await backfilled('usgs', backfillEnd, new Date(AS_OF.getTime() + 7 * DAY), {
      completedAt: backfillEnd,
    });
    await polled(daysAgo(1), daysAgo(0.01));
    expect((await history()).metric.status).toBe('INSUFFICIENT_COVERAGE');
  });

  it('reads only the coverage recorded by the knowledge time', async () => {
    // The whole stretch was read, but the ledger learned of the last 59 days only afterwards.
    const productId = await usgsProduct();
    await db.transaction().execute((trx) =>
      recordLiveCoverage(trx, {
        productId,
        window: { from: backfillEnd, to: daysAgo(0.01) },
        recordedAt: new Date(AS_OF.getTime() + 3_600_000),
      }),
    );
    expect((await history()).metric.status).toBe('INSUFFICIENT_COVERAGE');
  });

  it('keeps working after run history older than ninety days is pruned (ADR-033, ADR-041)', async () => {
    // Twelve-hour steps inside a 24-hour look-back: the same unbroken coverage, a twentieth of
    // the round trips. This test is about what survives pruning, not about polling cadence.
    await polled(backfillEnd, daysAgo(0.01), 24, 12 * 60);
    await sql`DELETE FROM geonerva.ingestion_runs WHERE started_at < ${daysAgo(90)}`.execute(db);
    await sql`DELETE FROM geonerva.backfill_intervals`.execute(db);
    await sql`DELETE FROM geonerva.backfill_plans`.execute(db);
    expect((await history()).metric.status).toBe('OK');
  });
});

describe('GDACS coverage is per feed (review round 3)', () => {
  async function gdacsProduct(code: string): Promise<number> {
    const result = await sql<{ id: number }>`
      SELECT id FROM geonerva.source_products WHERE source_id = 'gdacs' AND code = ${code}
    `.execute(db);
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error(`no gdacs product ${code}`);
    return id;
  }

  /** GDACS read for six years through one product's feed only, then polled through it. */
  async function readOnly(code: string): Promise<void> {
    const productId = await gdacsProduct(code);
    const plan = await sql<{ id: string }>`
      WITH plan AS (
        INSERT INTO geonerva.backfill_plans
          (id, source_id, product_id, mode, range_from, range_to, window_ms, min_window_ms,
           status, finished_at)
        VALUES (gen_random_uuid(), 'gdacs', ${productId}, 'HISTORICAL', ${daysAgo(6 * 365)},
                ${daysAgo(0.01)}, ${DAY}, ${DAY}, 'COMPLETED', ${daysAgo(0.01)})
        RETURNING id
      ), interval AS (
        INSERT INTO geonerva.backfill_intervals
          (plan_id, interval_from, interval_to, status, completed_at)
        SELECT id, ${daysAgo(6 * 365)}::timestamptz, ${daysAgo(0.01)}::timestamptz, 'DONE',
               ${daysAgo(0.01)}::timestamptz
        FROM plan
      )
      SELECT id::text AS id FROM plan
    `.execute(db);
    await db.transaction().execute((trx) =>
      recordIntervalCoverage(trx, {
        planId: plan.rows[0]?.id ?? '',
        from: daysAgo(6 * 365),
        to: daysAgo(0.01),
      }),
    );
    await seedRun(db, {
      sourceId: 'gdacs',
      productId,
      status: 'SUCCEEDED',
      startedAt: daysAgo(0.01),
    });
    await seedRan(daysAgo(0.01));
  }

  const floods = { family: 'FLOODS', metric: 'GDACS_CONTEXT', radiusKm: 300 } as const;

  it('does not take the earthquake feed as evidence that the flood feed was read', async () => {
    await readOnly('EQ');
    const response = await history(floods);
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(response.metric.observedValue.kind).toBe('unavailable');
  });

  it('counts floods once the flood feed itself was read', async () => {
    await readOnly('FL');
    await quake({
      observedAt: daysAgo(40),
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
      magnitude: null,
      km: 100,
    });
    expect((await history(floods)).metric.observedValue).toEqual({ kind: 'count', value: 1 });
  });

  it("does not take the earthquake feed's backfill as the flood feed's history", async () => {
    // Six years backfilled through EQ only; the flood feed polled live, and only just now.
    await readOnly('EQ');
    await seedRun(db, {
      sourceId: 'gdacs',
      productId: await gdacsProduct('FL'),
      status: 'SUCCEEDED',
      startedAt: daysAgo(0.01),
    });
    await livePoll('gdacs', 'FL', daysAgo(0.01));
    const response = await history(floods);
    expect(response.metric.interpretation).toBe(
      "0 GDACS flood events within 300 km since 20 September 2026, when GeoNerva's GDACS record begins.",
    );
  });

  it('needs every feed a family draws on: volcanoes read, droughts not, is not read', async () => {
    await readOnly('VO');
    const response = await history({ family: 'OTHER', metric: 'GDACS_CONTEXT', radiusKm: 300 });
    expect(response.metric.status).toBe('INSUFFICIENT_COVERAGE');
  });
});
