/**
 * Property-based replay invariants (docs/TESTING.md §6: I2, I3, I6, I13).
 *
 * The example-based tests in `asof.int.test.ts` ask specific questions of a hand-built timeline.
 * This file does the opposite: it builds a randomised timeline once, then hammers **every**
 * exported read path with randomised knowledge times and asserts the properties that must hold
 * for any T. I2 is the one that matters most — a single read path that forgets its `as_of` filter
 * turns replay into fiction, and that is exactly the kind of bug an example test misses.
 *
 * Shape of the test: the dataset is generated from a fixed seed (so a failure reproduces), written
 * once, and then the properties run against it. Writing per property run would be correct too, but
 * it would trade minutes of CI time for no extra coverage.
 */

import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clusterVersionsAsOf,
  healthAsOf,
  linksAsOf,
  observationsAsOf,
  sourceCutoffsAsOf,
} from './asof.ts';
import { createDb } from './client.ts';
import type { DB } from './generated/database.ts';
import { createCanonicalEvent, linkRecord, unlinkRecord } from './repositories/canonical.ts';
import { createCluster, insertClusterVersionIfChanged } from './repositories/fire.ts';
import { setupTestDatabase, type TestDatabase } from './testing/test-database.ts';
import { PLACES, contentHash, newUuid, seedObservation, seedRun } from './testing/factories.ts';

const SEED = 20_260_919;
const T0 = new Date('2026-09-01T00:00:00.000Z');
const STEP_MS = 60 * 60 * 1000; // one hour per timeline step
const STEPS = 24;

const at = (step: number): Date => new Date(T0.getTime() + step * STEP_MS);

/** One randomised but reproducible timeline: what happened, and when GeoNerva learned it. */
interface TimelineEvent {
  readonly step: number;
  readonly recordIndex: number;
  readonly kind: 'version' | 'tombstone';
  readonly magnitude: number;
  readonly observedLagMinutes: number;
}

function generateTimeline(): TimelineEvent[] {
  const arbitrary = fc.array(
    fc.record({
      step: fc.integer({ min: 0, max: STEPS - 1 }),
      recordIndex: fc.integer({ min: 0, max: 5 }),
      kind: fc.constantFrom<'version' | 'tombstone'>('version', 'version', 'version', 'tombstone'),
      magnitude: fc.integer({ min: 25, max: 78 }).map((m) => m / 10),
      observedLagMinutes: fc.integer({ min: 0, max: 120 }),
    }),
    { minLength: 25, maxLength: 40 },
  );
  const [timeline] = fc.sample(arbitrary, { numRuns: 1, seed: SEED });
  if (timeline === undefined) throw new Error('failed to generate a timeline');
  return [...timeline].sort((a, b) => a.step - b.step);
}

let testDb: TestDatabase;
let db: Kysely<DB>;
let timeline: TimelineEvent[];
/** Knowledge times spanning before the first write to after the last one. */
const knowledgeTimes: Date[] = [];

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
  await testDb.truncate();

  timeline = generateTimeline();

  // Runs: one per step, so health and cutoffs have a history to read.
  for (let step = 0; step < STEPS; step += 1) {
    await seedRun(db, {
      sourceId: step % 5 === 0 ? 'emsc' : 'usgs',
      startedAt: at(step),
      status: step % 7 === 3 ? 'FAILED' : 'SUCCEEDED',
      newestObservedAt: at(step),
    });
  }

  // Observations and tombstones.
  for (const event of timeline) {
    const ingestedAt = at(event.step);
    await seedObservation(db, {
      primaryKey: `pb-record-${event.recordIndex}`,
      ingestedAt,
      // `observed_at` is always at or before ingestion here: the future-observation case has its
      // own dedicated test, because the database rejects it outright (I13).
      observedAt: new Date(ingestedAt.getTime() - event.observedLagMinutes * 60_000),
      lifecycleStatus: event.kind === 'tombstone' ? 'DELETED' : 'ACTIVE',
      magnitude: event.magnitude,
      centroid: PLACES.marrakech,
      contentSha256: contentHash(
        `pb-${event.recordIndex}`,
        event.magnitude,
        event.kind,
        event.step,
      ),
    });
  }

  // Canonical links, opened and closed over time, so `linksAsOf` has something to filter.
  const records = await sql<{ id: string }>`
    SELECT id FROM geonerva.source_records ORDER BY id LIMIT 3
  `.execute(db);
  for (const [index, record] of records.rows.entries()) {
    const event = await createCanonicalEvent(db, {
      hazardType: 'EARTHQUAKE',
      createdAt: at(index * 3 + 1),
      publicId: `EQ-PB-${index}`,
    });
    await db.transaction().execute(async (trx) => {
      await linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: record.id,
        relation: index === 0 ? 'PRIMARY' : 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        confidence: 0.9,
        reasons: [{ code: 'PROPERTY_TEST' }],
        algorithmVersion: 'test',
        linkedAt: at(index * 3 + 1),
      });
    });
    if (index === 2) {
      await unlinkRecord(db, record.id, at(index * 3 + 6), 'REVISION_BROKE_MATCH');
    }
  }

  // Fire cluster versions: derived rows that replay filters on `as_of`, not `ingested_at`.
  const clusterId = await createCluster(db, {
    id: newUuid(),
    publicId: 'FC-PB-0',
    createdAt: at(2),
    status: 'ACTIVE',
  });
  for (const step of [2, 6, 11, 19]) {
    await insertClusterVersionIfChanged(db, {
      clusterId,
      asOf: at(step),
      nTotal: step * 3,
      n24h: step,
      overpasses24h: 2,
      firstDetectedAt: at(1),
      lastDetectedAt: at(step),
      frpSum24h: step * 1.5,
      frpMax: 9,
      maxConfidence: 'NOMINAL',
      productIds: [1],
      centroid: PLACES.marrakech,
      hullGeoJson: null,
      status: 'ACTIVE',
      contentSha256: contentHash('cluster', step),
    });
  }

  for (let step = -1; step <= STEPS; step += 1) knowledgeTimes.push(at(step));
}, 180_000);

afterAll(async () => {
  await db.destroy();
});

/** Every read path that can return provider facts, with the timestamps replay must respect. */
async function readEverything(asOf: Date): Promise<{
  readonly stamps: { path: string; stamp: Date }[];
  readonly observationIds: Set<string>;
  readonly linkedRecordCounts: Map<string, number>;
}> {
  const stamps: { path: string; stamp: Date }[] = [];
  const observationIds = new Set<string>();
  const linkedRecordCounts = new Map<string, number>();

  for (const options of [
    { asOf },
    { asOf, excludeTombstones: false },
    { asOf, hazardTypes: ['EARTHQUAKE'] },
    { asOf, near: { point: PLACES.marrakech, radiusM: 300_000 }, orderByDistance: true },
  ]) {
    for (const row of await observationsAsOf(db, options)) {
      stamps.push({ path: 'observationsAsOf.ingested_at', stamp: row.ingested_at });
      observationIds.add(row.source_record_id);
      // I13 on the read path as well as in the constraint.
      expect(
        row.observed_at.getTime(),
        `observed_at must not exceed ingested_at + 5 min (${row.version_id})`,
      ).toBeLessThanOrEqual(row.ingested_at.getTime() + 5 * 60_000);
    }
  }

  for (const row of await linksAsOf(db, { asOf })) {
    stamps.push({ path: 'linksAsOf.linked_at', stamp: row.linked_at });
    if (row.unlinked_at !== null) {
      expect(
        row.unlinked_at.getTime(),
        'an active link cannot have closed before T',
      ).toBeGreaterThan(asOf.getTime());
    }
    linkedRecordCounts.set(
      row.source_record_id,
      (linkedRecordCounts.get(row.source_record_id) ?? 0) + 1,
    );
  }

  for (const row of await clusterVersionsAsOf(db, { asOf })) {
    stamps.push({ path: 'clusterVersionsAsOf.as_of', stamp: row.as_of });
  }

  const health = await healthAsOf(db, { asOf });
  for (const entry of [...health.bySource, ...health.byProduct]) {
    if (entry.lastSuccessAt !== null) {
      stamps.push({ path: 'healthAsOf.lastSuccessAt', stamp: entry.lastSuccessAt });
    }
    if (entry.lastAttemptAt !== null) {
      stamps.push({ path: 'healthAsOf.lastAttemptAt', stamp: entry.lastAttemptAt });
    }
  }

  for (const cutoff of Object.values(await sourceCutoffsAsOf(db, asOf))) {
    if (cutoff !== null) stamps.push({ path: 'sourceCutoffsAsOf', stamp: cutoff });
  }

  return { stamps, observationIds, linkedRecordCounts };
}

describe('replay invariants (property-based)', () => {
  it('the generated dataset is rich enough for the properties to mean anything', async () => {
    const late = at(STEPS);
    const { stamps, observationIds, linkedRecordCounts } = await readEverything(late);
    expect(observationIds.size, 'records visible at the end of the timeline').toBeGreaterThan(2);
    expect(linkedRecordCounts.size, 'active canonical links').toBeGreaterThan(0);
    expect(stamps.length, 'timestamps checked per knowledge time').toBeGreaterThanOrEqual(20);
    expect(
      (await clusterVersionsAsOf(db, { asOf: late })).length,
      'cluster versions',
    ).toBeGreaterThan(0);
    // Early in the timeline the same paths must return (almost) nothing, which is what makes the
    // monotonicity and I2 properties discriminating rather than vacuous.
    const early = await readEverything(at(-1));
    expect(early.observationIds.size).toBe(0);
    expect(early.stamps.length).toBe(0);
  });

  it('I2 — no read path returns anything GeoNerva learned after the knowledge time', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...knowledgeTimes), async (asOf) => {
        const { stamps } = await readEverything(asOf);
        for (const { path, stamp } of stamps) {
          expect(
            stamp.getTime(),
            `${path} returned ${stamp.toISOString()} > asOf ${asOf.toISOString()}`,
          ).toBeLessThanOrEqual(asOf.getTime());
        }
      }),
      { numRuns: 30, seed: SEED, endOnFailure: true },
    );
  }, 180_000);

  it('I3 — knowledge is monotone: what was known at T1 is still known at a later T2', async () => {
    const known = async (asOf: Date): Promise<Set<string>> =>
      new Set(
        (await observationsAsOf(db, { asOf, excludeTombstones: false })).map(
          (row) => row.source_record_id,
        ),
      );

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...knowledgeTimes),
        fc.constantFrom(...knowledgeTimes),
        async (a, b) => {
          const [earlier, later] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
          const before = await known(earlier);
          const after = await known(later);
          for (const id of before) {
            expect(
              after.has(id),
              `record ${id} was known at ${earlier.toISOString()} but vanished by ${later.toISOString()}`,
            ).toBe(true);
          }
        },
      ),
      { numRuns: 25, seed: SEED, endOnFailure: true },
    );
  }, 180_000);

  it('I6 — a source record has at most one active canonical link at any knowledge time', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...knowledgeTimes), async (asOf) => {
        const { linkedRecordCounts } = await readEverything(asOf);
        for (const [recordId, count] of linkedRecordCounts) {
          expect(
            count,
            `record ${recordId} had ${count} active links at ${asOf.toISOString()}`,
          ).toBe(1);
        }
      }),
      { numRuns: 25, seed: SEED, endOnFailure: true },
    );
  }, 180_000);

  it('I13 — the database refuses an observation from the future, whatever the offset', async () => {
    const ingestedAt = at(STEPS + 2);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 6, max: 10_000 }), async (minutesAhead) => {
        await expect(
          seedObservation(db, {
            primaryKey: `future-${minutesAhead}`,
            ingestedAt,
            observedAt: new Date(ingestedAt.getTime() + minutesAhead * 60_000),
            magnitude: 4.2,
            centroid: PLACES.marrakech,
          }),
        ).rejects.toThrow();
      }),
      { numRuns: 15, seed: SEED, endOnFailure: true },
    );
  }, 180_000);

  it('accepts an observation inside the five-minute clock-skew tolerance', async () => {
    const ingestedAt = at(STEPS + 3);
    const result = await seedObservation(db, {
      primaryKey: 'skew-ok',
      ingestedAt,
      observedAt: new Date(ingestedAt.getTime() + 4 * 60_000),
      magnitude: 4.2,
      centroid: PLACES.marrakech,
    });
    expect(result.inserted).toBe(true);
  });
});
