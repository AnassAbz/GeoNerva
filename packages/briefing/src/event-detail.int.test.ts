/**
 * `buildEventDetail` against real PostGIS.
 *
 * The detail view is the audit trail, so its failures are the quiet kind: a revision shown before
 * it was ingested, a correlation shown as withdrawn in a replay from before the withdrawal, a
 * merged id answered with an empty event. Each test below is one of those, and every found
 * response is parsed with the frozen schema, whose refinements hold I9, the location pairing and
 * the newest-first timeline.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createCanonicalEvent,
  createDb,
  linkRecord,
  mergeCanonicalEvents,
  unlinkRecord,
  type DB,
} from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { contentHash, seedObservation } from '@geonerva/db/testing/factories';
import { eventDetailSchema, type EventDetail, type LocationRef } from '@geonerva/domain';

import { buildEventDetail } from './event-detail.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const T0 = new Date('2026-09-19T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

const EPICENTRE = { lat: 31.1, lon: -8.4 };
const MARRAKECH: LocationRef = {
  key: 'c:31.63,-8.00',
  label: '31.63, -8.00',
  lat: 31.63,
  lon: -8.0,
  timezone: 'Africa/Casablanca',
  countryCode: null,
  admin1: null,
};

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

/** A detail that must be found; parsed with the frozen schema on the way out. */
async function detailOf(
  publicId: string,
  asOf: Date,
  location: LocationRef | null = null,
): Promise<EventDetail> {
  const result = await buildEventDetail({ db, publicId, asOf, location });
  if (result.kind !== 'found') throw new Error(`expected a detail, got ${result.kind}`);
  return eventDetailSchema.parse(result.detail);
}

async function event(createdAt = T0): Promise<{ id: string; publicId: string }> {
  return await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt });
}

async function member(options: {
  readonly eventId: string;
  readonly primaryKey: string;
  readonly sourceId?: string;
  readonly magnitude?: number;
  readonly magnitudeType?: string;
  readonly providerStatus?: string;
  readonly at?: Date;
  readonly relation?: 'PRIMARY' | 'SAME_EVENT' | 'DERIVED_COPY';
  readonly aliases?: readonly string[];
  readonly lifecycleStatus?: 'ACTIVE' | 'DELETED';
}): Promise<{ sourceRecordId: string; versionId: string; linkId: string }> {
  const at = options.at ?? T0;
  const record = await seedObservation(db, {
    primaryKey: options.primaryKey,
    sourceId: options.sourceId ?? 'usgs',
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    ingestedAt: at,
    observedAt: T0,
    centroid: EPICENTRE,
    magnitude: options.magnitude ?? 5.4,
    magnitudeType: options.magnitudeType ?? 'mww',
    depthKm: 10,
    providerStatus: options.providerStatus ?? 'reviewed',
    lifecycleStatus: options.lifecycleStatus ?? 'ACTIVE',
  });
  const { linkId } = await db.transaction().execute((trx) =>
    linkRecord(trx, {
      canonicalEventId: options.eventId,
      sourceRecordId: record.sourceRecordId,
      relation: options.relation ?? 'PRIMARY',
      matchKind: 'SPATIOTEMPORAL',
      algorithmVersion: 'eq-corr-1',
      linkedAt: at,
      reasons: [{ code: 'DISTANCE_OK', text: 'Epicentres are 4 km apart.', params: { km: 4 } }],
    }),
  );
  return { sourceRecordId: record.sourceRecordId, versionId: record.versionId, linkId };
}

describe('buildEventDetail: one event, explained', () => {
  it('shows the headline, each source, the timeline and the correlation', async () => {
    const created = await event();
    const usgs = await member({ eventId: created.id, primaryKey: 'us7000abcd' });
    const detail = await detailOf(created.publicId, minutes(5));

    expect(detail.publicId).toBe(created.publicId);
    expect(detail.subjectRef).toBe(`CE:${created.publicId}`);
    expect(detail.headline.title).toBe('M5.4 earthquake');
    expect(detail.headline.preferredSourceId).toBe('usgs');
    expect(detail.headline.preferenceReason.code).toBe('HEADLINE_PRECEDENCE');
    expect(detail.headline.isActive).toBe(true);
    expect(detail.observations).toHaveLength(1);
    expect(detail.observations[0]?.evidenceId).toBe(`EV:OBS:${usgs.versionId}`);
    expect(detail.timeline).toHaveLength(1);
    expect(detail.timeline[0]?.summary).toContain('first reported it as M5.4');
    expect(detail.correlation.decisions).toHaveLength(1);
    expect(detail.correlation.decisions[0]?.reasons[0]?.code).toBe('DISTANCE_OK');
    expect(detail.correlation.decisions[0]?.reasons[0]?.evidenceIds).toStrictEqual([
      `EV:COR:${usgs.linkId}`,
    ]);
    // No location, so no relevance and no distance — together, as the contract pairs them.
    expect(detail.relevance).toBeNull();
    expect(detail.distanceKm).toBeNull();
    expect(detail.attribution.map((entry) => entry.sourceId)).toStrictEqual(['usgs']);
  });

  it('assesses relevance and distance only when given a location', async () => {
    const created = await event();
    await member({ eventId: created.id, primaryKey: 'us7000reld' });
    const detail = await detailOf(created.publicId, minutes(5), MARRAKECH);
    expect(detail.relevance).not.toBeNull();
    // ~60 km from Marrakech to (31.10, -8.40).
    expect(detail.distanceKm).toBeGreaterThan(55);
    expect(detail.distanceKm).toBeLessThan(75);
    expect(detail.hypocentralDistanceKm).toBeGreaterThanOrEqual(detail.distanceKm ?? 0);
  });

  it('prefers a reviewed USGS solution even when EMSC was linked first', async () => {
    const created = await event();
    await member({
      eventId: created.id,
      primaryKey: 'emsc-first',
      sourceId: 'emsc',
      magnitude: 5.1,
      magnitudeType: 'mb',
    });
    await member({
      eventId: created.id,
      primaryKey: 'us-second',
      magnitude: 5.6,
      relation: 'SAME_EVENT',
    });
    const detail = await detailOf(created.publicId, minutes(5));
    expect(detail.headline.preferredSourceId).toBe('usgs');
    expect(detail.headline.title).toBe('M5.6 earthquake');
    expect(detail.observations.map((view) => view.sourceId).sort()).toStrictEqual(['emsc', 'usgs']);
    expect(detail.agreement.nIndependentSources).toBe(2);
  });

  it('does not make a withdrawn record the headline, but still shows it', async () => {
    const created = await event();
    await member({ eventId: created.id, primaryKey: 'us-deleted', lifecycleStatus: 'DELETED' });
    await member({
      eventId: created.id,
      primaryKey: 'emsc-live',
      sourceId: 'emsc',
      magnitude: 5.2,
      magnitudeType: 'mb',
      relation: 'SAME_EVENT',
    });
    const detail = await detailOf(created.publicId, minutes(5));
    expect(detail.headline.preferredSourceId).toBe('emsc');
    expect(detail.observations.find((view) => view.sourceId === 'usgs')?.lifecycleStatus).toBe(
      'DELETED',
    );
  });

  it('lists an alias only from the poll that reported it', async () => {
    // Control: "an alias seen after T is listed".
    const created = await event();
    await member({ eventId: created.id, primaryKey: 'us-grow', aliases: ['us-grow'] });
    await seedObservation(db, {
      primaryKey: 'us-grow',
      aliases: ['us-grow', 'nc-grow'],
      ingestedAt: minutes(40),
      observedAt: T0,
      centroid: EPICENTRE,
      magnitude: 5.4,
      magnitudeType: 'mww',
      depthKm: 10,
      providerStatus: 'reviewed',
    });
    expect((await detailOf(created.publicId, minutes(10))).observations[0]?.aliases).toStrictEqual(
      [],
    );
    expect((await detailOf(created.publicId, minutes(50))).observations[0]?.aliases).toStrictEqual([
      'nc-grow',
    ]);
  });

  it('lists a provider alias but not the primary key twice', async () => {
    const created = await event();
    await member({
      eventId: created.id,
      primaryKey: 'us7000main',
      aliases: ['us7000main', 'ci4000x'],
    });
    const detail = await detailOf(created.publicId, minutes(5));
    expect(detail.observations[0]?.aliases).toStrictEqual(['ci4000x']);
  });
});

describe('buildEventDetail: replay never sees the future (I2)', () => {
  it('shows the magnitude, the timeline and the headline as they stood at T', async () => {
    const created = await event();
    await member({ eventId: created.id, primaryKey: 'us-rev', magnitude: 5.1 });
    await seedObservation(db, {
      primaryKey: 'us-rev',
      ingestedAt: minutes(30),
      observedAt: T0,
      centroid: EPICENTRE,
      magnitude: 5.3,
      magnitudeType: 'mww',
      depthKm: 10,
      providerStatus: 'reviewed',
      contentSha256: contentHash('us-rev', 5.3),
    });

    const before = await detailOf(created.publicId, minutes(10));
    expect(before.headline.title).toBe('M5.1 earthquake');
    expect(before.timeline).toHaveLength(1);

    const after = await detailOf(created.publicId, minutes(40));
    expect(after.headline.title).toBe('M5.3 earthquake');
    expect(after.timeline.map((entry) => entry.versionSeq)).toStrictEqual([2, 1]);
    expect(after.timeline[0]?.summary).toContain('revised the magnitude from M5.1 to M5.3');
    expect(after.timeline[0]?.changedFields).toStrictEqual(['magnitude']);
  });

  it('shows a correlation as open in a replay from before it was withdrawn', async () => {
    const created = await event();
    await member({ eventId: created.id, primaryKey: 'us-keep' });
    const withdrawn = await member({
      eventId: created.id,
      primaryKey: 'emsc-gone',
      sourceId: 'emsc',
      magnitude: 5.2,
      magnitudeType: 'mb',
      relation: 'SAME_EVENT',
    });
    await unlinkRecord(db, withdrawn.sourceRecordId, minutes(50), 'SPLIT');

    const before = await detailOf(created.publicId, minutes(40));
    const early = before.correlation.decisions.find(
      (decision) => decision.linkId === withdrawn.linkId,
    );
    expect(early?.unlinkedAt).toBeNull();
    expect(early?.unlinkReason).toBeNull();
    expect(before.observations).toHaveLength(2);

    const after = await detailOf(created.publicId, minutes(60));
    const late = after.correlation.decisions.find(
      (decision) => decision.linkId === withdrawn.linkId,
    );
    expect(late?.unlinkedAt).toBe(minutes(50).toISOString());
    expect(late?.unlinkReason).toBe('SPLIT');
    expect(after.observations.map((view) => view.sourceId)).toStrictEqual(['usgs']);
  });

  it('does not exist before it was created', async () => {
    const created = await event(minutes(30));
    await member({ eventId: created.id, primaryKey: 'us-late', at: minutes(30) });
    expect(
      await buildEventDetail({ db, publicId: created.publicId, asOf: minutes(10), location: null }),
    ).toStrictEqual({ kind: 'not_found', reason: 'UNKNOWN' });
  });

  it('answers an unknown id as unknown', async () => {
    expect(
      await buildEventDetail({ db, publicId: 'EQ-26-7K3F9Q', asOf: minutes(10), location: null }),
    ).toStrictEqual({ kind: 'not_found', reason: 'UNKNOWN' });
  });
});

describe('buildEventDetail: merges redirect', () => {
  it('is itself before the merge, and names its survivor after it', async () => {
    const survivor = await event();
    const absorbed = await event();
    await member({ eventId: survivor.id, primaryKey: 'us-a' });
    await member({ eventId: absorbed.id, primaryKey: 'us-b' });
    await db.transaction().execute((trx) =>
      mergeCanonicalEvents(trx, {
        survivorId: survivor.id,
        absorbedIds: [absorbed.id],
        mergedAt: minutes(60),
        algorithmVersion: 'eq-corr-1',
      }),
    );

    const before = await buildEventDetail({
      db,
      publicId: absorbed.publicId,
      asOf: minutes(30),
      location: null,
    });
    expect(before.kind).toBe('found');
    expect(
      await buildEventDetail({
        db,
        publicId: absorbed.publicId,
        asOf: minutes(90),
        location: null,
      }),
    ).toStrictEqual({ kind: 'merged', survivorPublicId: survivor.publicId });

    expect((await detailOf(survivor.publicId, minutes(30))).supersededPublicIds).toStrictEqual([]);
    expect((await detailOf(survivor.publicId, minutes(90))).supersededPublicIds).toStrictEqual([
      absorbed.publicId,
    ]);
  });
});

describe('buildEventDetail: near-misses, relations and geometry', () => {
  it('shows a possible match current at T, and not one superseded by then', async () => {
    const created = await event();
    const mine = await member({ eventId: created.id, primaryKey: 'us-near' });
    const other = await event();
    const theirs = await member({ eventId: other.id, primaryKey: 'us-other' });
    const [a, b] = [mine.sourceRecordId, theirs.sourceRecordId].sort(
      (x, y) => Number(x) - Number(y),
    );
    await sql`
      INSERT INTO geonerva.correlation_candidates
        (record_a, record_b, decision, score, reasons, algorithm_version, evaluated_at, superseded_at)
      VALUES (${a}::bigint, ${b}::bigint, 'POSSIBLE_MATCH', 0.62,
              ${JSON.stringify([{ code: 'TIME_CLOSE', text: 'Origin times 40 s apart.', params: {} }])}::jsonb,
              'eq-corr-1', ${minutes(5)}, ${minutes(50)})
    `.execute(db);

    const open = await detailOf(created.publicId, minutes(20));
    expect(open.correlation.possibleMatches).toStrictEqual([
      {
        otherPublicId: other.publicId,
        sourceId: 'usgs',
        primaryKey: 'us-other',
        score: 0.62,
        reasons: [
          { code: 'TIME_CLOSE', text: 'Origin times 40 s apart.', params: {}, evidenceIds: [] },
        ],
        evaluatedAt: minutes(5).toISOString(),
      },
    ]);
    expect(
      (await detailOf(created.publicId, minutes(60))).correlation.possibleMatches,
    ).toStrictEqual([]);
    expect(
      (await detailOf(created.publicId, minutes(2))).correlation.possibleMatches,
    ).toStrictEqual([]);
  });

  it('does not call two of its own members a possible match', async () => {
    // Control: "a pair inside the event is shown as a near-miss". A pair scored close and then
    // linked into the same event is the event, not a near-miss.
    const created = await event();
    const first = await member({ eventId: created.id, primaryKey: 'us-in-a' });
    const second = await member({
      eventId: created.id,
      primaryKey: 'emsc-in-b',
      sourceId: 'emsc',
      magnitude: 5.2,
      magnitudeType: 'mb',
      relation: 'SAME_EVENT',
    });
    const [a, b] = [first.sourceRecordId, second.sourceRecordId].sort(
      (x, y) => Number(x) - Number(y),
    );
    await sql`
      INSERT INTO geonerva.correlation_candidates
        (record_a, record_b, decision, score, reasons, algorithm_version, evaluated_at)
      VALUES (${a}::bigint, ${b}::bigint, 'POSSIBLE_MATCH', 0.7, NULL, 'eq-corr-1', ${minutes(1)})
    `.execute(db);
    expect(
      (await detailOf(created.publicId, minutes(5))).correlation.possibleMatches,
    ).toStrictEqual([]);
  });

  it('shows a related subject only while the relation is open at T', async () => {
    const created = await event();
    await member({ eventId: created.id, primaryKey: 'us-rel' });
    const neighbour = await event();
    await member({ eventId: neighbour.id, primaryKey: 'us-neighbour' });
    await sql`
      INSERT INTO geonerva.event_relations (from_ref, to_ref, relation, reasons, established_at, ended_at)
      VALUES (${`CE:${created.publicId}`}, ${`CE:${neighbour.publicId}`}, 'AFTERSHOCK_OF', NULL,
              ${minutes(10)}, ${minutes(50)})
    `.execute(db);

    expect((await detailOf(created.publicId, minutes(5))).relatedEvents).toStrictEqual([]);
    expect((await detailOf(created.publicId, minutes(20))).relatedEvents).toStrictEqual([
      {
        subjectRef: `CE:${neighbour.publicId}`,
        publicId: neighbour.publicId,
        hazardType: 'EARTHQUAKE',
        relation: 'AFTERSHOCK_OF',
        label: 'Earthquake',
        href: `/events/${neighbour.publicId}`,
        reasons: [],
      },
    ]);
    expect((await detailOf(created.publicId, minutes(60))).relatedEvents).toStrictEqual([]);
  });

  it('carries a version geometry, citing the version it belongs to', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'gdacs-fl',
      sourceId: 'gdacs',
      hazardType: 'FLOOD',
      ingestedAt: T0,
      observedAt: T0,
      centroid: EPICENTRE,
      geometryKind: 'REGION_POLYGON',
      severityScheme: 'GDACS_ALERT',
      severityValue: 'Orange',
      geometries: [
        {
          role: 'affected_area',
          seq: 1,
          geoJson: {
            type: 'Polygon',
            coordinates: [
              [
                [-8.5, 31.0],
                [-8.3, 31.0],
                [-8.3, 31.2],
                [-8.5, 31.2],
                [-8.5, 31.0],
              ],
            ],
          },
        },
      ],
    });
    const flood = await createCanonicalEvent(db, { hazardType: 'FLOOD', createdAt: T0 });
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: flood.id,
        sourceRecordId: record.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        algorithmVersion: 'seed-1',
        linkedAt: T0,
      }),
    );
    const detail = await detailOf(flood.publicId, minutes(5));
    expect(detail.family).toBe('FLOODS');
    expect(detail.headline.providerSeverity).toStrictEqual({
      scheme: 'GDACS_ALERT',
      value: 'Orange',
    });
    expect(detail.geometries).toHaveLength(1);
    expect(detail.geometries[0]).toMatchObject({
      role: 'affected_area',
      kind: 'REGION_POLYGON',
      isForecast: false,
      evidenceIds: [`EV:OBS:${record.versionId}`],
    });
    expect(detail.geometries[0]?.geometry.type).toBe('Polygon');
  });
});
