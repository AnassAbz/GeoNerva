/**
 * Repository behaviour against real PostGIS (docs/TESTING.md §4.2–§4.4).
 *
 * The scenarios here are the ones that actually go wrong in production ingestion: a poll that
 * repeats, a provider that revises a value, a provider that restamps a timestamp without changing
 * anything, and ComCat deciding that two events were one all along.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from '../client.ts';
import type { DB } from '../generated/database.ts';
import { setupTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import {
  PLACES,
  contentHash,
  newUuid,
  seedObservation,
  seedRun,
  stableUuid,
} from '../testing/factories.ts';
import { acquireRunLease, finishRun, listRecentRuns } from './ingestion-runs.ts';
import { bulkInsertDetections, createCluster, insertClusterVersionIfChanged } from './fire.ts';
import {
  createCanonicalEvent,
  insertCorrelationCandidate,
  linkRecord,
  mergeCanonicalEvents,
  resolveCanonicalEvent,
} from './canonical.ts';
import { findProductByCode } from './sources.ts';
import {
  insertTombstone,
  listVersions,
  pruneSmallMagnitudeVersionsBefore,
  rebuildHeads,
} from './observation-versions.ts';
import { findSourceRecord, listAliases, resolveSourceRecord } from './source-records.ts';
import { upsertRawRecords, findRawPayload, prunePayloadsBefore } from './raw-records.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const T0 = new Date('2026-09-19T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

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

describe('run lease (DOMAIN_MODEL §6.6)', () => {
  it('lets one run hold the lease and refuses a second', async () => {
    const first = await acquireRunLease(db, {
      sourceId: 'usgs',
      trigger: 'SCHEDULE',
      startedAt: T0,
    });
    expect(first.acquired).toBe(true);

    const second = await acquireRunLease(db, {
      sourceId: 'usgs',
      trigger: 'SCHEDULE',
      startedAt: minutes(1),
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.heldSince).toStrictEqual(T0);
  });

  it('serializes source-level runs even though product_id is NULL', async () => {
    // A NULL product_id would never collide with itself under a plain unique index; the
    // COALESCE in the partial index is what makes this work.
    await acquireRunLease(db, { sourceId: 'gdacs', trigger: 'SCHEDULE', startedAt: T0 });
    const second = await acquireRunLease(db, {
      sourceId: 'gdacs',
      trigger: 'SCHEDULE',
      startedAt: minutes(1),
    });
    expect(second.acquired).toBe(false);
  });

  it('allows concurrent runs for different products of one source', async () => {
    const noaa20 = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await findProductByCode(db, 'firms', 'VIIRS_NOAA21_NRT');
    const first = await acquireRunLease(db, {
      sourceId: 'firms',
      productId: noaa20?.id ?? null,
      trigger: 'SCHEDULE',
      startedAt: T0,
    });
    const second = await acquireRunLease(db, {
      sourceId: 'firms',
      productId: noaa21?.id ?? null,
      trigger: 'SCHEDULE',
      startedAt: T0,
    });
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
  });

  it('expires an abandoned lease and records it as evidence', async () => {
    const stranded = await acquireRunLease(db, {
      sourceId: 'usgs',
      trigger: 'SCHEDULE',
      startedAt: T0,
    });
    expect(stranded.acquired).toBe(true);

    const next = await acquireRunLease(db, {
      sourceId: 'usgs',
      trigger: 'SCHEDULE',
      startedAt: minutes(120),
      staleAfterMs: 30 * 60_000,
    });
    expect(next.acquired).toBe(true);
    if (next.acquired && stranded.acquired) {
      expect(next.expiredRunId).toBe(stranded.runId);
    }

    const expired = await sql<{ status: string; error_class: string }>`
      SELECT status, error_class FROM geonerva.ingestion_runs
      WHERE id = ${stranded.acquired ? stranded.runId : ''}::uuid
    `.execute(db);
    // The failure is committed, because "the worker died mid-poll" is health evidence.
    expect(expired.rows[0]?.status).toBe('FAILED');
    expect(expired.rows[0]?.error_class).toBe('LEASE_EXPIRED');
  });

  it('releases the lease when the run finishes, and stamps committed_at', async () => {
    const lease = await acquireRunLease(db, {
      sourceId: 'usgs',
      trigger: 'SCHEDULE',
      startedAt: T0,
    });
    if (!lease.acquired) throw new Error('lease not acquired');
    const committedAt = await finishRun(db, {
      runId: lease.runId,
      status: 'SUCCEEDED',
      counts: { received: 12, newVersions: 3, unchanged: 9 },
    });
    expect(committedAt).toBeInstanceOf(Date);

    const again = await acquireRunLease(db, {
      sourceId: 'usgs',
      trigger: 'SCHEDULE',
      startedAt: minutes(5),
    });
    expect(again.acquired).toBe(true);
  });

  it('refuses to finish a run twice', async () => {
    const lease = await acquireRunLease(db, {
      sourceId: 'usgs',
      trigger: 'SCHEDULE',
      startedAt: T0,
    });
    if (!lease.acquired) throw new Error('lease not acquired');
    await finishRun(db, { runId: lease.runId, status: 'SUCCEEDED' });
    await expect(finishRun(db, { runId: lease.runId, status: 'FAILED' })).rejects.toThrow(
      /not RUNNING/,
    );
  });

  it('lists only committed runs, newest first', async () => {
    await seedRun(db, { startedAt: T0 });
    await seedRun(db, { startedAt: minutes(5), status: 'FAILED' });
    await acquireRunLease(db, { sourceId: 'usgs', trigger: 'MANUAL', startedAt: minutes(10) });

    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.committedAt !== null)).toBe(true);
  });
});

describe('version insertion (DOMAIN_MODEL §4.7)', () => {
  it('creates the first version of a new record', async () => {
    const result = await seedObservation(db, {
      primaryKey: 'us7000tikb',
      ingestedAt: T0,
      magnitude: 5.1,
      centroid: PLACES.marrakech,
    });
    expect(result.inserted).toBe(true);
    expect(result.versionSeq).toBe(1);
  });

  it('creates a new version when the content hash changes', async () => {
    await seedObservation(db, {
      primaryKey: 'us7000tikb',
      ingestedAt: T0,
      magnitude: 5.1,
      centroid: PLACES.marrakech,
    });
    const revised = await seedObservation(db, {
      primaryKey: 'us7000tikb',
      ingestedAt: minutes(30),
      magnitude: 5.3,
      centroid: PLACES.marrakech,
    });
    expect(revised.inserted).toBe(true);
    expect(revised.versionSeq).toBe(2);

    const versions = await listVersions(db, revised.sourceRecordId);
    expect(versions).toHaveLength(2);
  });

  it('writes nothing when the content is identical (invariant I8)', async () => {
    const first = await seedObservation(db, {
      primaryKey: 'us7000tikb',
      ingestedAt: T0,
      magnitude: 5.1,
      centroid: PLACES.marrakech,
    });
    const repeat = await seedObservation(db, {
      primaryKey: 'us7000tikb',
      ingestedAt: minutes(5),
      magnitude: 5.1,
      centroid: PLACES.marrakech,
    });
    expect(repeat.inserted).toBe(false);
    expect(repeat.versionId).toBe(first.versionId);
    expect(await listVersions(db, first.sourceRecordId)).toHaveLength(1);
  });

  it('ignores a restamped source_updated_at, because GDACS bulk-restamps unrelated events', async () => {
    // GDACS moves `datemodified` on dozens of old events within the same minute (P0 verification).
    // Only the normalized content hash may create a version.
    const first = await seedObservation(db, {
      sourceId: 'gdacs',
      primaryKey: 'FL-1000001',
      hazardType: 'FLOOD',
      ingestedAt: T0,
      centroid: PLACES.montreal,
      sourceUpdatedAt: T0,
      attributes: { has_area_geometry: false },
    });
    const restamped = await seedObservation(db, {
      sourceId: 'gdacs',
      primaryKey: 'FL-1000001',
      hazardType: 'FLOOD',
      ingestedAt: minutes(10),
      centroid: PLACES.montreal,
      // The provider claims it changed, but the content did not.
      sourceUpdatedAt: minutes(9),
      attributes: { has_area_geometry: false },
    });
    expect(restamped.inserted).toBe(false);
    expect(await listVersions(db, first.sourceRecordId)).toHaveLength(1);
  });

  it('stores a content revert as a third version (A → B → A)', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'us-revert',
      ingestedAt: T0,
      magnitude: 5.1,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, {
      primaryKey: 'us-revert',
      ingestedAt: minutes(10),
      magnitude: 5.3,
      centroid: PLACES.marrakech,
    });
    const back = await seedObservation(db, {
      primaryKey: 'us-revert',
      ingestedAt: minutes(20),
      magnitude: 5.1,
      centroid: PLACES.marrakech,
    });
    // "The provider changed its mind back" is itself a fact worth keeping.
    expect(back.inserted).toBe(true);
    expect(back.versionSeq).toBe(3);
    expect(await listVersions(db, record.sourceRecordId)).toHaveLength(3);
  });

  it('keeps the head in step with the latest version, in the same transaction', async () => {
    const first = await seedObservation(db, {
      primaryKey: 'us-head',
      ingestedAt: T0,
      magnitude: 4.2,
      centroid: PLACES.suva,
    });
    const second = await seedObservation(db, {
      primaryKey: 'us-head',
      ingestedAt: minutes(15),
      magnitude: 4.4,
      centroid: PLACES.suva,
    });

    const head = await sql<{ latest_version_id: string; latest_version_seq: number }>`
      SELECT latest_version_id::text AS latest_version_id, latest_version_seq
      FROM geonerva.source_record_heads WHERE source_record_id = ${first.sourceRecordId}::bigint
    `.execute(db);
    expect(head.rows[0]?.latest_version_id).toBe(second.versionId);
    expect(head.rows[0]?.latest_version_seq).toBe(2);
  });

  it('rebuilds the heads cache from versions alone', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'us-rebuild',
      ingestedAt: T0,
      magnitude: 4.2,
      centroid: PLACES.suva,
    });
    await seedObservation(db, {
      primaryKey: 'us-rebuild',
      ingestedAt: minutes(15),
      magnitude: 4.4,
      centroid: PLACES.suva,
    });

    await sql`DELETE FROM geonerva.source_record_heads`.execute(db);
    const rebuilt = await db.transaction().execute((trx) => rebuildHeads(trx));
    expect(rebuilt).toBe(1);

    const head = await sql<{ latest_version_seq: number }>`
      SELECT latest_version_seq FROM geonerva.source_record_heads
      WHERE source_record_id = ${record.sourceRecordId}::bigint
    `.execute(db);
    expect(head.rows[0]?.latest_version_seq).toBe(2);
  });

  it('rebuilds the head by version_seq, not by batch stamp', async () => {
    /*
     * `version_seq` is the authoritative order within a record: assigned under a row lock, in
     * insert order, gap-free. `ingested_at` is a batch stamp shared by every version in a run, so
     * a repair that led with it would be deciding the head by a tiebreak between rows that were
     * never ordered by it — and this is the tool reached for when the heads have *already*
     * drifted, so it has to agree with the live path.
     *
     * The two orderings have to actually disagree or the test proves nothing, so the second
     * version carries an *earlier* batch stamp than the first: a backfill of an older window
     * arriving after a live poll, which is a normal thing for this system to do.
     */
    const record = await seedObservation(db, {
      primaryKey: 'us-out-of-order',
      ingestedAt: minutes(15),
      magnitude: 4.2,
      centroid: PLACES.suva,
    });
    await seedObservation(db, {
      primaryKey: 'us-out-of-order',
      ingestedAt: T0,
      magnitude: 4.9,
      centroid: PLACES.suva,
    });

    await sql`DELETE FROM geonerva.source_record_heads`.execute(db);
    await db.transaction().execute((trx) => rebuildHeads(trx));

    const head = await sql<{ latest_version_seq: number; magnitude: string }>`
      SELECT h.latest_version_seq, v.magnitude
      FROM geonerva.source_record_heads h
      JOIN geonerva.observation_versions v ON v.id = h.latest_version_id
      WHERE h.source_record_id = ${record.sourceRecordId}::bigint
    `.execute(db);
    expect(head.rows[0]?.latest_version_seq, 'the highest seq is the head').toBe(2);
    expect(Number(head.rows[0]?.magnitude)).toBe(4.9);
  });

  it('prunes only small, old earthquakes, and prunes them whole (ADR-035)', async () => {
    /*
     * "Keep facts forever" and "poll an all-magnitude feed" are jointly unaffordable: the live
     * feed adds 238 MiB a year of small earthquakes. M >= 4.5 is kept forever; below that has a
     * replay horizon.
     */
    const old = new Date(T0.getTime() - 90 * 24 * 60 * 60 * 1000);
    const small = await seedObservation(db, {
      primaryKey: 'us-small-old',
      ingestedAt: T0,
      observedAt: old,
      magnitude: 2.1,
      centroid: PLACES.suva,
    });
    const big = await seedObservation(db, {
      primaryKey: 'us-big-old',
      ingestedAt: T0,
      observedAt: old,
      magnitude: 5.2,
      centroid: PLACES.suva,
    });
    const recent = await seedObservation(db, {
      primaryKey: 'us-small-recent',
      ingestedAt: T0,
      observedAt: T0,
      magnitude: 1.4,
      centroid: PLACES.suva,
    });

    const cutoff = new Date(T0.getTime() - 30 * 24 * 60 * 60 * 1000);
    const pruned = await db
      .transaction()
      .execute((trx) => pruneSmallMagnitudeVersionsBefore(trx, cutoff, 4.5));

    expect(pruned, 'only the small old one').toBe(1);

    const remaining = await sql<{ primary_key: string }>`
      SELECT primary_key FROM geonerva.source_records ORDER BY primary_key
    `.execute(db);
    expect(remaining.rows.map((row) => row.primary_key)).toStrictEqual([
      'us-big-old',
      'us-small-recent',
    ]);

    // Pruned whole: no orphan versions, aliases or head rows left behind.
    for (const table of ['observation_versions', 'source_record_aliases'] as const) {
      const orphans = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM geonerva.${sql.table(table)} t
        WHERE NOT EXISTS (SELECT 1 FROM geonerva.source_records r WHERE r.id = t.source_record_id)
      `.execute(db);
      expect(orphans.rows[0]?.n, `${table} has orphans`).toBe('0');
    }
    expect(big.sourceRecordId).not.toBe(small.sourceRecordId);
    expect(recent.sourceRecordId).not.toBe(small.sourceRecordId);
  });

  it('keeps a record entire when any version reached the threshold', async () => {
    // An event revised upward past M4.5 is kept whole. Deleting some versions and keeping others
    // would leave a history with holes, which is worse than one that stops.
    const old = new Date(T0.getTime() - 90 * 24 * 60 * 60 * 1000);
    await seedObservation(db, {
      primaryKey: 'us-revised-up',
      ingestedAt: T0,
      observedAt: old,
      magnitude: 3.9,
      centroid: PLACES.suva,
    });
    await seedObservation(db, {
      primaryKey: 'us-revised-up',
      ingestedAt: minutes(5),
      observedAt: old,
      magnitude: 4.8,
      centroid: PLACES.suva,
    });

    const cutoff = new Date(T0.getTime() - 30 * 24 * 60 * 60 * 1000);
    const pruned = await db
      .transaction()
      .execute((trx) => pruneSmallMagnitudeVersionsBefore(trx, cutoff, 4.5));

    expect(pruned).toBe(0);
    const versions = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.observation_versions
    `.execute(db);
    expect(versions.rows[0]?.n, 'both versions survive').toBe('2');
  });

  it('rejects a version observed more than five minutes in the future (I13)', async () => {
    await expect(
      seedObservation(db, {
        primaryKey: 'us-future',
        ingestedAt: T0,
        observedAt: minutes(6),
        centroid: PLACES.marrakech,
      }),
    ).rejects.toThrow(/FUTURE_OBSERVATION|five minutes/);
  });

  it('accepts a version observed exactly five minutes in the future', async () => {
    const result = await seedObservation(db, {
      primaryKey: 'us-edge',
      ingestedAt: T0,
      observedAt: minutes(5),
      centroid: PLACES.marrakech,
    });
    expect(result.inserted).toBe(true);
  });

  it('writes a tombstone that carries the previous content forward', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'us-deleted',
      ingestedAt: T0,
      magnitude: 5.5,
      centroid: PLACES.marrakech,
    });

    const tombstone = await db.transaction().execute((trx) =>
      insertTombstone(trx, {
        sourceRecordId: record.sourceRecordId,
        status: 'DELETED',
        ingestedAt: minutes(60),
        contentSha256: contentHash('us-deleted', 'DELETED'),
      }),
    );
    expect(tombstone.inserted).toBe(true);

    const stored = await sql<{ lifecycle_status: string; magnitude: string }>`
      SELECT lifecycle_status, magnitude FROM geonerva.observation_versions
      WHERE id = ${tombstone.versionId}::bigint
    `.execute(db);
    expect(stored.rows[0]?.lifecycle_status).toBe('DELETED');
    // The previous values are preserved, so the event page can still show what was believed.
    expect(Number(stored.rows[0]?.magnitude)).toBe(5.5);
  });

  it('distinguishes an inferred disappearance from an explicit deletion', async () => {
    const record = await seedObservation(db, {
      sourceId: 'emsc',
      primaryKey: '20260919_0000123',
      ingestedAt: T0,
      magnitude: 3.2,
      centroid: PLACES.marrakech,
    });
    const tombstone = await db.transaction().execute((trx) =>
      insertTombstone(trx, {
        sourceRecordId: record.sourceRecordId,
        // EMSC's FDSN API cannot be queried for deletions, so absence across two reconciles is
        // an inference, not a provider statement.
        status: 'MISSING_FROM_SOURCE',
        ingestedAt: minutes(60),
        contentSha256: contentHash('emsc-missing'),
      }),
    );
    const stored = await sql<{ lifecycle_status: string }>`
      SELECT lifecycle_status FROM geonerva.observation_versions
      WHERE id = ${tombstone.versionId}::bigint
    `.execute(db);
    expect(stored.rows[0]?.lifecycle_status).toBe('MISSING_FROM_SOURCE');
  });

  it('stores the contributor as a column, because independence depends on it', async () => {
    // P0 found EMSC republishing an NEIC solution with a stale magnitude: USGS M4.5 vs EMSC M3.2
    // at Δt 0 s and Δdistance 0 km. Correlation must be able to see who computed a solution.
    await seedObservation(db, {
      sourceId: 'emsc',
      primaryKey: '20260919_0000999',
      ingestedAt: T0,
      magnitude: 3.2,
      contributor: 'NEIC',
      centroid: PLACES.marrakech,
    });
    const stored = await sql<{ contributor: string }>`
      SELECT contributor FROM geonerva.observation_versions ORDER BY id DESC LIMIT 1
    `.execute(db);
    expect(stored.rows[0]?.contributor).toBe('NEIC');
  });
});

describe('record identity and the USGS merge (DOMAIN_MODEL §4.6)', () => {
  it('resolves a record by any alias it has ever had', async () => {
    await seedObservation(db, {
      primaryKey: 'us7000tikb',
      aliases: ['us7000tikb', 'pr2026123'],
      ingestedAt: T0,
      magnitude: 5.1,
      centroid: PLACES.marrakech,
    });

    // The provider's preferred id changed, but it is the same event.
    const second = await seedObservation(db, {
      primaryKey: 'pr2026123',
      aliases: ['us7000tikb', 'pr2026123'],
      ingestedAt: minutes(10),
      magnitude: 5.2,
      centroid: PLACES.marrakech,
    });

    expect(second.versionSeq).toBe(2);
    const records = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.source_records WHERE source_id = 'usgs'
    `.execute(db);
    expect(Number(records.rows[0]?.n)).toBe(1);
  });

  it('adds new aliases without creating a record', async () => {
    const first = await seedObservation(db, {
      primaryKey: 'us-alias',
      ingestedAt: T0,
      magnitude: 4.0,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, {
      primaryKey: 'us-alias',
      aliases: ['us-alias', 'ci-alias', 'nc-alias'],
      ingestedAt: minutes(5),
      magnitude: 4.1,
      centroid: PLACES.marrakech,
    });
    expect(await listAliases(db, 'usgs', first.sourceRecordId)).toStrictEqual([
      'ci-alias',
      'nc-alias',
      'us-alias',
    ]);
  });

  it('merges two records when the provider associates their ids', async () => {
    const older = await seedObservation(db, {
      primaryKey: 'us-aaa',
      ingestedAt: T0,
      magnitude: 4.8,
      centroid: PLACES.marrakech,
    });
    const younger = await seedObservation(db, {
      primaryKey: 'nc-bbb',
      ingestedAt: minutes(5),
      magnitude: 4.9,
      centroid: PLACES.marrakech,
    });

    // ComCat now publishes both ids on one event.
    const merged = await db.transaction().execute((trx) =>
      resolveSourceRecord(trx, {
        sourceId: 'usgs',
        hazardType: 'EARTHQUAKE',
        primaryKey: 'us-aaa',
        aliases: ['us-aaa', 'nc-bbb'],
        firstIngestedAt: minutes(20),
      }),
    );

    // The older record survives: users may already have seen its identity.
    expect(merged.sourceRecordId).toBe(older.sourceRecordId);
    expect(merged.mergedRecordIds).toStrictEqual([younger.sourceRecordId]);

    const absorbed = await findSourceRecord(db, 'usgs', 'nc-bbb');
    expect(absorbed?.mergedInto).toBe(older.sourceRecordId);
    expect(absorbed?.mergedAt).toStrictEqual(minutes(20));

    // The absorbed record keeps its versions: nothing is destroyed by a merge.
    expect(await listVersions(db, younger.sourceRecordId)).toHaveLength(1);

    // Aliases now resolve to the survivor, so the next poll lands on one record.
    const again = await db.transaction().execute((trx) =>
      resolveSourceRecord(trx, {
        sourceId: 'usgs',
        hazardType: 'EARTHQUAKE',
        primaryKey: 'nc-bbb',
        firstIngestedAt: minutes(30),
      }),
    );
    expect(again.sourceRecordId).toBe(older.sourceRecordId);
    expect(again.created).toBe(false);
  });

  it('does not report an existing record as newly created', async () => {
    /*
     * The insert uses `ON CONFLICT … DO UPDATE … RETURNING`, which returns the *existing* row's
     * id on a conflict. Reporting that as `created` inflates `n_new_records` on every run where
     * a record's alias rows are missing — a run row that says a quiet day discovered 230 new
     * earthquakes.
     */
    const first = await db.transaction().execute((trx) =>
      resolveSourceRecord(trx, {
        sourceId: 'usgs',
        hazardType: 'EARTHQUAKE',
        primaryKey: 'nc-created-once',
        firstIngestedAt: T0,
      }),
    );
    expect(first.created).toBe(true);

    // Remove the alias rows so the second call has to fall through to the insert path.
    await sql`
      DELETE FROM geonerva.source_record_aliases WHERE alias = 'nc-created-once'
    `.execute(db);

    const second = await db.transaction().execute((trx) =>
      resolveSourceRecord(trx, {
        sourceId: 'usgs',
        hazardType: 'EARTHQUAKE',
        primaryKey: 'nc-created-once',
        firstIngestedAt: minutes(5),
      }),
    );
    expect(second.sourceRecordId).toBe(first.sourceRecordId);
    expect(second.created, 'the same record cannot be created twice').toBe(false);
  });

  it('keeps the merge deterministic regardless of the order ids arrive in', async () => {
    const older = await seedObservation(db, {
      primaryKey: 'us-first',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, {
      primaryKey: 'us-second',
      ingestedAt: minutes(1),
      centroid: PLACES.marrakech,
    });

    const merged = await db.transaction().execute((trx) =>
      resolveSourceRecord(trx, {
        sourceId: 'usgs',
        hazardType: 'EARTHQUAKE',
        // Listed younger-first on purpose.
        primaryKey: 'us-second',
        aliases: ['us-second', 'us-first'],
        firstIngestedAt: minutes(10),
      }),
    );
    expect(merged.sourceRecordId).toBe(older.sourceRecordId);
  });
});

describe('raw payload storage (DOMAIN_MODEL §4.5)', () => {
  async function capturedOf(digest: Buffer): Promise<boolean | undefined> {
    const result = await sql<{ captured: boolean }>`
      SELECT payload_captured AS captured FROM geonerva.raw_source_records
      WHERE payload_sha256 = ${digest}
    `.execute(db);
    return result.rows[0]?.captured;
  }

  it('fills in a live body over a row a backfill stored pruned (ADR-033)', async () => {
    /*
     * A backfill and a live poll collide on the same digest whenever the feature has not changed,
     * by design. With a no-op upsert the *first* writer decided forever: a backfill running first
     * meant the live body was never stored, so ADR-033's 30-day debugging window silently did not
     * apply to those records and the stored state depended on ingest order.
     */
    const digest = Buffer.alloc(32, 42);
    await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: digest, payload: { a: 1 }, pruned: true },
    ]);
    const ids = await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: digest, payload: { a: 1 }, pruned: false },
    ]);

    const stored = await findRawPayload(db, ids.get(digest.toString('hex')) ?? '');
    expect(stored?.payload, 'the live body is filled in').toStrictEqual({ a: 1 });
    expect(stored?.pruned).toBe(false);
    // ADR-038: a row that now holds a body was captured.
    expect(await capturedOf(digest)).toBe(true);
  });

  it('does not un-prune when the later writer has no body either', async () => {
    const digest = Buffer.alloc(32, 43);
    await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: digest, payload: { b: 2 }, pruned: true },
    ]);
    const ids = await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: digest, payload: { b: 2 }, pruned: true },
    ]);
    const stored = await findRawPayload(db, ids.get(digest.toString('hex')) ?? '');
    expect(stored?.payload).toBeNull();
    expect(stored?.pruned).toBe(true);
    // ADR-038: no body ever stored, so never captured.
    expect(await capturedOf(digest)).toBe(false);
  });

  it('never replaces a body that is already there', async () => {
    // Pruning only ever removes, so a stored body must survive a later pruned write.
    const digest = Buffer.alloc(32, 44);
    await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: digest, payload: { c: 3 }, pruned: false },
    ]);
    const ids = await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: digest, payload: { c: 3 }, pruned: true },
    ]);
    const stored = await findRawPayload(db, ids.get(digest.toString('hex')) ?? '');
    expect(stored?.payload).toStrictEqual({ c: 3 });
    expect(stored?.pruned).toBe(false);
  });

  it('stores identical payloads once and reuses the id', async () => {
    const hash = contentHash('payload-a');
    const first = await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: hash, payload: { a: 1 } },
    ]);
    const second = await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: hash, payload: { a: 1 } },
    ]);
    expect(first.get(hash.toString('hex'))).toBe(second.get(hash.toString('hex')));

    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.raw_source_records
    `.execute(db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('deduplicates within a single batch', async () => {
    const hash = contentHash('payload-b');
    const ids = await upsertRawRecords(db, [
      { sourceId: 'usgs', payloadSha256: hash, payload: { b: 1 } },
      { sourceId: 'usgs', payloadSha256: hash, payload: { b: 1 } },
    ]);
    expect(ids.size).toBe(1);
  });

  it('prunes the body but keeps the hash forever', async () => {
    const hash = contentHash('payload-c');
    const ids = await upsertRawRecords(db, [
      {
        sourceId: 'usgs',
        payloadSha256: hash,
        payload: { c: 1 },
        firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const id = ids.get(hash.toString('hex')) ?? '';

    const pruned = await prunePayloadsBefore(db, new Date('2026-06-01T00:00:00Z'));
    expect(pruned).toBe(1);

    const stored = await findRawPayload(db, id);
    expect(stored?.payload).toBeNull();
    expect(stored?.pruned).toBe(true);
    expect(stored?.sha256Hex).toBe(hash.toString('hex'));
  });
});

describe('fire detections (DOMAIN_MODEL §4.9)', () => {
  const acquiredAt = new Date('2026-09-18T12:34:00.000Z');

  function detections(count: number, productId: number) {
    return Array.from({ length: count }, (_, index) => ({
      productId,
      acquiredAt,
      lat: 31.6 + index * 0.01,
      lon: -8.0 + index * 0.01,
      confidenceClass: 'NOMINAL' as const,
      confidenceRaw: 'nominal',
      frp: 4.2,
      brightTi4: 320.1,
      brightTi5: 290.4,
      scan: 0.4,
      track: 0.36,
      daynight: 'D' as const,
      providerVersion: '2.0NRT',
      ingestedAt: T0,
    }));
  }

  it('inserts a batch and creates the daily partition it needs', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const result = await bulkInsertDetections(db, detections(50, product?.id ?? 1));
    expect(result.inserted).toBe(50);
    expect(result.partitionsCreated).toContain('fire_detections_20260918');
  });

  it('is idempotent: the overlapping half of the next poll inserts nothing (I8)', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const batch = detections(30, product?.id ?? 1);
    await bulkInsertDetections(db, batch);
    const second = await bulkInsertDetections(db, batch);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(30);
  });

  it('keys detections on rounded coordinates, because FIRMS has no detection id', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const base = {
      productId: product?.id ?? 1,
      acquiredAt,
      confidenceClass: 'HIGH' as const,
      confidenceRaw: 'high',
      frp: 1,
      brightTi4: null,
      brightTi5: null,
      scan: null,
      track: null,
      daynight: 'N' as const,
      providerVersion: '2.0NRT',
      ingestedAt: T0,
    };
    await bulkInsertDetections(db, [{ ...base, lat: 31.63001, lon: -8.00001 }]);
    // The same pixel centre, reported with a hair more precision, is the same detection.
    const second = await bulkInsertDetections(db, [{ ...base, lat: 31.630014, lon: -8.000012 }]);
    expect(second.inserted).toBe(0);
  });

  it('computes the geography column from the coordinates', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    await bulkInsertDetections(db, detections(1, product?.id ?? 1));
    const stored = await sql<{ lat: number; lon: number }>`
      SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lon
      FROM geonerva.fire_detections LIMIT 1
    `.execute(db);
    expect(stored.rows[0]?.lat).toBeCloseTo(31.6, 6);
    expect(stored.rows[0]?.lon).toBeCloseTo(-8.0, 6);
  });
});

describe('fire cluster versions (DOMAIN_MODEL §4.10)', () => {
  it('writes a version only when the summary changed', async () => {
    const clusterId = stableUuid('cluster-a');
    await createCluster(db, {
      id: clusterId,
      publicId: 'FR-26-AAAAAA',
      createdAt: T0,
      status: 'ACTIVE',
    });

    const summary = {
      clusterId,
      asOf: T0,
      nTotal: 12,
      n24h: 12,
      overpasses24h: 2,
      firstDetectedAt: T0,
      lastDetectedAt: T0,
      frpSum24h: 40,
      frpMax: 12,
      maxConfidence: 'HIGH' as const,
      productIds: [1],
      hullGeoJson: null,
      centroid: PLACES.marrakech,
      contentSha256: contentHash('cluster-a', 12),
      status: 'ACTIVE' as const,
    };

    const first = await insertClusterVersionIfChanged(db, summary);
    expect(first.inserted).toBe(true);

    // A later clustering run over an unchanged cluster: nothing burned, the satellite simply
    // passed elsewhere. Writing a version would make "we looked again" look like "it grew".
    const repeat = await insertClusterVersionIfChanged(db, { ...summary, asOf: minutes(30) });
    expect(repeat.inserted).toBe(false);
    expect(repeat.clusterVersionId).toBe(first.clusterVersionId);

    const grown = await insertClusterVersionIfChanged(db, {
      ...summary,
      asOf: minutes(60),
      nTotal: 31,
      n24h: 19,
      contentSha256: contentHash('cluster-a', 31),
    });
    expect(grown.inserted).toBe(true);

    const head = await sql<{ latest_version_id: string }>`
      SELECT latest_version_id::text AS latest_version_id FROM geonerva.fire_cluster_heads
      WHERE cluster_id = ${clusterId}::uuid
    `.execute(db);
    expect(head.rows[0]?.latest_version_id).toBe(grown.clusterVersionId);
  });
});

describe('canonical events and links (DOMAIN_MODEL §4.8)', () => {
  it('links a record and refuses a second active link (invariant I6)', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'us-link',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });

    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: record.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        algorithmVersion: 'test-1',
        linkedAt: T0,
      }),
    );

    await expect(
      sql`
        INSERT INTO geonerva.canonical_links
          (canonical_event_id, source_record_id, relation, match_kind, algorithm_version, linked_at)
        VALUES (${event.id}::uuid, ${record.sourceRecordId}::bigint, 'SAME_EVENT', 'SEED',
                'test-1', ${minutes(5)})
      `.execute(db),
    ).rejects.toThrow();
  });

  it('closes the previous link instead of mutating it when a record moves event', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'us-move',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    const first = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });
    const second = await createCanonicalEvent(db, {
      hazardType: 'EARTHQUAKE',
      createdAt: minutes(1),
    });

    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: first.id,
        sourceRecordId: record.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        algorithmVersion: 'test-1',
        linkedAt: T0,
      }),
    );
    const moved = await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: second.id,
        sourceRecordId: record.sourceRecordId,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'test-1',
        linkedAt: minutes(10),
      }),
    );
    expect(moved.closedLinkId).not.toBeNull();

    const links = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.canonical_links
      WHERE source_record_id = ${record.sourceRecordId}::bigint
    `.execute(db);
    // Two rows: the history of the split survives.
    expect(Number(links.rows[0]?.n)).toBe(2);
  });

  it('is idempotent when the same link is asserted twice', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'us-idem',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });
    const input = {
      canonicalEventId: event.id,
      sourceRecordId: record.sourceRecordId,
      relation: 'PRIMARY' as const,
      matchKind: 'SEED' as const,
      algorithmVersion: 'test-1',
      linkedAt: T0,
    };
    await db.transaction().execute((trx) => linkRecord(trx, input));
    const again = await db.transaction().execute((trx) => linkRecord(trx, input));
    expect(again.created).toBe(false);
  });

  it('merges events, re-points links and redirects the public id', async () => {
    const recordA = await seedObservation(db, {
      primaryKey: 'us-merge-a',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    const recordB = await seedObservation(db, {
      sourceId: 'emsc',
      primaryKey: 'emsc-merge-b',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });

    const older = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });
    const younger = await createCanonicalEvent(db, {
      hazardType: 'EARTHQUAKE',
      createdAt: minutes(5),
    });

    await db.transaction().execute(async (trx) => {
      await linkRecord(trx, {
        canonicalEventId: older.id,
        sourceRecordId: recordA.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        algorithmVersion: 'test-1',
        linkedAt: T0,
      });
      await linkRecord(trx, {
        canonicalEventId: younger.id,
        sourceRecordId: recordB.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        algorithmVersion: 'test-1',
        linkedAt: minutes(5),
      });
    });

    const result = await db.transaction().execute((trx) =>
      mergeCanonicalEvents(trx, {
        survivorId: older.id,
        absorbedIds: [younger.id],
        mergedAt: minutes(30),
        algorithmVersion: 'test-2',
      }),
    );
    expect(result.relinked).toBe(1);

    const redirected = await resolveCanonicalEvent(db, younger.publicId);
    expect(redirected?.id).toBe(older.id);
    expect(redirected?.redirected).toBe(true);

    // The absorbed event's link history survives: one closed, one reopened on the survivor.
    const links = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.canonical_links
      WHERE source_record_id = ${recordB.sourceRecordId}::bigint
    `.execute(db);
    expect(Number(links.rows[0]?.n)).toBe(2);
  });

  it('stores a near-miss as a candidate rather than merging it', async () => {
    const a = await seedObservation(db, {
      primaryKey: 'us-near-a',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    const b = await seedObservation(db, {
      sourceId: 'emsc',
      primaryKey: 'emsc-near-b',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });

    const id = await insertCorrelationCandidate(db, {
      // Deliberately passed in the "wrong" order: the pair is normalized before storage.
      recordA: b.sourceRecordId,
      recordB: a.sourceRecordId,
      decision: 'POSSIBLE_MATCH',
      score: 0.71,
      reasons: { codes: ['CLOSE_IN_TIME', 'MAGNITUDE_DIFFERS'] },
      algorithmVersion: 'test-1',
      evaluatedAt: T0,
    });
    expect(id).not.toBeNull();

    const stored = await sql<{ record_a: string; record_b: string }>`
      SELECT record_a::text AS record_a, record_b::text AS record_b
      FROM geonerva.correlation_candidates
    `.execute(db);
    expect(BigInt(stored.rows[0]?.record_a ?? '0')).toBeLessThan(
      BigInt(stored.rows[0]?.record_b ?? '0'),
    );
  });

  it('allocates a distinct public id per event', async () => {
    const ids = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const event = await createCanonicalEvent(db, {
        hazardType: 'EARTHQUAKE',
        createdAt: T0,
        id: newUuid(),
      });
      expect(event.publicId).toMatch(/^EQ-26-[0-9A-HJKMNP-TV-Z]{6}$/);
      ids.add(event.publicId);
    }
    expect(ids.size).toBe(20);
  });
});

describe('aliases carry the knowledge time of the poll that reported them', () => {
  /*
   * `first_seen_at` defaulted to the database's `now()`, a different clock from every other fact
   * the record carries: a backfill stamped historical aliases with the day it ran, and a replay at
   * a record's own ingestion time could show the record without the id it arrived under.
   */
  async function seenAt(alias: string): Promise<Date | undefined> {
    const result = await sql<{ first_seen_at: Date }>`
      SELECT first_seen_at FROM geonerva.source_record_aliases WHERE alias = ${alias}
    `.execute(db);
    return result.rows[0]?.first_seen_at;
  }

  it('stamps a new record’s aliases with its ingestion time', async () => {
    await seedObservation(db, {
      primaryKey: 'us-clock',
      aliases: ['us-clock', 'ci-clock'],
      ingestedAt: minutes(15),
      centroid: PLACES.marrakech,
    });
    expect(await seenAt('us-clock')).toStrictEqual(minutes(15));
    expect(await seenAt('ci-clock')).toStrictEqual(minutes(15));
  });

  it('stamps an alias added to an existing record with the poll that added it', async () => {
    await seedObservation(db, {
      primaryKey: 'us-grow',
      aliases: ['us-grow'],
      ingestedAt: minutes(15),
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, {
      primaryKey: 'us-grow',
      aliases: ['us-grow', 'nc-grow'],
      ingestedAt: minutes(40),
      centroid: PLACES.marrakech,
    });
    expect(await seenAt('us-grow')).toStrictEqual(minutes(15));
    expect(await seenAt('nc-grow')).toStrictEqual(minutes(40));
  });
});
