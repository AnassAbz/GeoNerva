/**
 * Fire clustering against a real database (ARCHITECTURE §7.4, ADR-039, ADR-045).
 *
 * `single-linkage.test.ts` owns the geometry — what links to what. Everything here is about
 * **identity over time**, which is where this feature can be subtly and expensively wrong: a
 * cluster whose public id changes under a reader, a merge that rewrites what GeoNerva showed last
 * week, a second run that mints a duplicate of every fire on the planet.
 *
 * The replay tests are the ones worth reading twice. Invariant I16 says a replay of `T` uses the
 * assignments and merges known by `T` and nothing that became true afterwards, and clustering is
 * the worked example the whole invariant was written around.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assignDetectionsToCluster,
  bulkInsertDetections,
  clusterVersionsAsOf,
  createCluster,
  createDb,
  generateFireClusterPublicId,
  type DB,
} from '@geonerva/db';
import { randomUUID } from 'node:crypto';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';

import { clusterFireDetections } from './fire-cluster.ts';
import { runClustering } from './correlate-job.ts';
import { createJsonLogger, type Logger } from './logging.ts';

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

const ACQUIRED = new Date('2026-09-20T08:00:00.000Z');
const INGEST = new Date('2026-09-20T08:30:00.000Z');
const AS_OF = new Date('2026-09-20T09:00:00.000Z');
const MARRAKECH = { lat: 31.6295, lon: -7.9811 };

function collectingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createJsonLogger(
    (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    () => AS_OF,
  );
  return { logger, lines };
}

async function productId(code = 'VIIRS_NOAA20_NRT'): Promise<number> {
  const row = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = 'firms' AND code = ${code}
  `.execute(db);
  return row.rows[0]?.id ?? 0;
}

/** A detection `metresNorth` of Marrakech. The helper uses the shortest degree of latitude. */
async function detect(options: {
  readonly metresNorth: number;
  readonly acquiredAt?: Date;
  readonly ingestedAt?: Date;
  readonly productCode?: string;
  readonly frp?: number | null;
}): Promise<void> {
  await bulkInsertDetections(db, [
    {
      productId: await productId(options.productCode),
      acquiredAt: options.acquiredAt ?? ACQUIRED,
      lat: MARRAKECH.lat + options.metresNorth / 110_574,
      lon: MARRAKECH.lon,
      confidenceClass: 'NOMINAL',
      confidenceRaw: 'n',
      frp: options.frp ?? 5,
      brightTi4: 330,
      brightTi5: 290,
      scan: 0.4,
      track: 0.4,
      daynight: 'D',
      providerVersion: '2.0NRT',
      ingestedAt: options.ingestedAt ?? INGEST,
    },
  ]);
}

async function clusterCount(): Promise<number> {
  const row = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM geonerva.fire_clusters
  `.execute(db);
  return Number(row.rows[0]?.n ?? '0');
}

async function clusterRows(): Promise<
  { id: string; public_id: string; status: string; merged_into: string | null; created_at: Date }[]
> {
  const rows = await sql<{
    id: string;
    public_id: string;
    status: string;
    merged_into: string | null;
    created_at: Date;
  }>`
    SELECT id::text AS id, public_id, status, merged_into::text AS merged_into, created_at
    FROM geonerva.fire_clusters ORDER BY created_at, id
  `.execute(db);
  return [...rows.rows];
}

describe('clusterFireDetections', () => {
  it('puts two neighbouring detections in one cluster and assigns both', async () => {
    await detect({ metresNorth: 0 });
    await detect({ metresNorth: 400 });

    const result = await clusterFireDetections(db, { asOf: AS_OF });

    expect(result.clustersCreated).toBe(1);
    expect(result.assigned).toBe(2);
    expect(await clusterCount()).toBe(1);
  });

  it('keeps distant detections in separate clusters', async () => {
    await detect({ metresNorth: 0 });
    await detect({ metresNorth: 20_000 });

    const result = await clusterFireDetections(db, { asOf: AS_OF });

    expect(result.clustersCreated).toBe(2);
    expect(result.assigned).toBe(2);
  });

  it('stamps every assignment with the run knowledge time (ADR-039)', async () => {
    await detect({ metresNorth: 0 });
    await clusterFireDetections(db, { asOf: AS_OF });

    const row = await sql<{ assigned: Date | null }>`
      SELECT cluster_assigned_at AS assigned FROM geonerva.fire_detections
    `.execute(db);
    expect(row.rows[0]?.assigned?.toISOString()).toBe(AS_OF.toISOString());
  });

  it('is idempotent: a second pass over unchanged data changes nothing', async () => {
    await detect({ metresNorth: 0 });
    await detect({ metresNorth: 400 });
    const first = await clusterFireDetections(db, { asOf: AS_OF });

    const second = await clusterFireDetections(db, {
      asOf: new Date(AS_OF.getTime() + 60_000),
    });

    expect(second.clustersCreated).toBe(0);
    expect(second.assigned).toBe(0);
    expect(second.clustersMerged).toBe(0);
    /*
     * And no second summary: the content hash is the same, so `insertClusterVersionIfChanged`
     * declines. Without this a cluster would gain a version every five minutes for ever and
     * "this cluster changed" would mean "we looked again".
     */
    expect(second.versionsWritten).toBe(0);
    expect(await clusterCount()).toBe(1);
    expect(first.clustersCreated).toBe(1);
  });

  it('carries identity forward: a later detection joins the existing cluster', async () => {
    await detect({ metresNorth: 0 });
    const first = await clusterFireDetections(db, { asOf: AS_OF });
    const before = await clusterRows();

    /* A new pixel 400 m away, acquired an hour later and ingested after the first run. */
    const later = new Date(AS_OF.getTime() + 60 * 60 * 1000);
    await detect({ metresNorth: 400, acquiredAt: later, ingestedAt: later });
    const second = await clusterFireDetections(db, { asOf: new Date(later.getTime() + 60_000) });

    expect(second.clustersCreated).toBe(0);
    expect(second.assigned).toBe(1);
    expect(await clusterCount()).toBe(1);
    /* The public id a reader may already have open is unchanged. */
    expect((await clusterRows())[0]?.public_id).toBe(before[0]?.public_id);
    expect(first.clustersCreated).toBe(1);
  });

  it('merges two clusters when a detection bridges them, and the oldest survives', async () => {
    /*
     * Two fires 2.4 km apart — outside the 1.5 km epsilon, so two clusters. Then a pixel lands
     * between them, within epsilon of both, and they are one fire after all.
     */
    await detect({ metresNorth: 0 });
    await clusterFireDetections(db, { asOf: AS_OF });
    await detect({ metresNorth: 2_400, acquiredAt: ACQUIRED, ingestedAt: INGEST });
    const secondAsOf = new Date(AS_OF.getTime() + 60_000);
    await clusterFireDetections(db, { asOf: secondAsOf });
    expect(await clusterCount()).toBe(2);
    const before = await clusterRows();
    const oldest = before[0];

    const bridgeAt = new Date(AS_OF.getTime() + 120_000);
    await detect({ metresNorth: 1_200, acquiredAt: ACQUIRED, ingestedAt: bridgeAt });
    const merged = await clusterFireDetections(db, {
      asOf: new Date(bridgeAt.getTime() + 60_000),
    });

    expect(merged.clustersMerged).toBe(1);
    const after = await clusterRows();
    const survivor = after.find((row) => row.merged_into === null);
    const absorbed = after.find((row) => row.merged_into !== null);
    expect(survivor?.id).toBe(oldest?.id);
    expect(absorbed?.status).toBe('MERGED');
    expect(absorbed?.merged_into).toBe(oldest?.id);
  });

  it('records a merge instead of re-pointing detections (ADR-039)', async () => {
    await detect({ metresNorth: 0 });
    await clusterFireDetections(db, { asOf: AS_OF });
    await detect({ metresNorth: 2_400 });
    await clusterFireDetections(db, { asOf: new Date(AS_OF.getTime() + 60_000) });
    const before = await clusterRows();
    const absorbedId = before[1]?.id;

    await detect({ metresNorth: 1_200, ingestedAt: new Date(AS_OF.getTime() + 120_000) });
    await clusterFireDetections(db, { asOf: new Date(AS_OF.getTime() + 180_000) });

    /*
     * The absorbed cluster's detection still points at the absorbed cluster. If a merge rewrote
     * `cluster_id`, a replay of a knowledge time before the merge would show one area of activity
     * where GeoNerva had shown two — future knowledge leaking backwards.
     */
    const still = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.fire_detections
      WHERE cluster_id = ${absorbedId}::uuid
    `.execute(db);
    expect(Number(still.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('does not let a later merge change what a replay of an earlier time shows', async () => {
    /* Two separate clusters, both known at `beforeMerge`. */
    await detect({ metresNorth: 0 });
    await detect({ metresNorth: 2_400 });
    const beforeMerge = AS_OF;
    await clusterFireDetections(db, { asOf: beforeMerge });

    const atTheTime = await clusterVersionsAsOf(db, {
      asOf: new Date(beforeMerge.getTime() + 1),
      near: { point: MARRAKECH, radiusM: 50_000 },
      limit: 100,
    });
    expect(atTheTime).toHaveLength(2);

    /* Now they merge. */
    const bridgeAt = new Date(beforeMerge.getTime() + 60 * 60 * 1000);
    await detect({ metresNorth: 1_200, ingestedAt: bridgeAt });
    await clusterFireDetections(db, { asOf: new Date(bridgeAt.getTime() + 60_000) });

    /* The replay of the earlier moment still shows two. This is invariant I16. */
    const replayed = await clusterVersionsAsOf(db, {
      asOf: new Date(beforeMerge.getTime() + 1),
      near: { point: MARRAKECH, radiusM: 50_000 },
      limit: 100,
    });
    expect(replayed).toHaveLength(2);
  });

  it('does not leak a later assignment into an earlier replay', async () => {
    await detect({ metresNorth: 0 });
    await clusterFireDetections(db, { asOf: AS_OF });

    const clusterId = (await clusterRows())[0]?.id ?? '';
    /*
     * A knowledge time one second before the assignment. This is the predicate every as-of read
     * applies (ADR-039): membership is visible only once `cluster_assigned_at` has passed, so the
     * cluster has no members at all at that moment.
     */
    const earlier = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.fire_detections
      WHERE cluster_id = ${clusterId}::uuid
        AND cluster_assigned_at IS NOT NULL
        AND cluster_assigned_at <= ${new Date(AS_OF.getTime() - 1_000)}
    `.execute(db);
    expect(Number(earlier.rows[0]?.n)).toBe(0);

    /* …and does have them at the assignment's own knowledge time. */
    const atAssignment = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.fire_detections
      WHERE cluster_id = ${clusterId}::uuid
        AND cluster_assigned_at IS NOT NULL
        AND cluster_assigned_at <= ${AS_OF}
    `.execute(db);
    expect(Number(atAssignment.rows[0]?.n)).toBe(1);
  });

  it('does not strand a detection that arrives while a run is in flight', async () => {
    /*
     * The gate compares the newest ingest against the last successful run's `as_of`, not its
     * `finished_at`, precisely so that a detection ingested during a run is picked up next time.
     * Here the detection is ingested *after* the run's knowledge bound, so the first pass cannot
     * see it and the second must.
     */
    await detect({ metresNorth: 0 });
    const first = await clusterFireDetections(db, { asOf: AS_OF });
    expect(first.assigned).toBe(1);

    const during = new Date(AS_OF.getTime() + 30_000);
    await detect({ metresNorth: 20_000, ingestedAt: during });

    const second = await clusterFireDetections(db, { asOf: new Date(during.getTime() + 1_000) });
    expect(second.assigned).toBe(1);

    const unassigned = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.fire_detections WHERE cluster_id IS NULL
    `.execute(db);
    expect(Number(unassigned.rows[0]?.n)).toBe(0);
  });

  it('refuses to move a detection that already belongs to a cluster (ADR-039)', async () => {
    /*
     * The `cluster_id IS NULL` guard in `assignDetectionsToCluster` is the last line of defence
     * for "a detection is assigned once". Nothing in the engine passes an assigned id today — it
     * only ever offers the unassigned ones — so without this test the guard could be deleted and
     * every test would still pass. What it protects against is the case the engine cannot see: a
     * concurrent run working from a snapshot taken before this assignment landed.
     *
     * Moving a detection would silently rewrite history, because the old `cluster_assigned_at`
     * goes with it: a replay of a time before the move would show the detection in a cluster it
     * did not belong to then.
     */
    await detect({ metresNorth: 0 });
    await clusterFireDetections(db, { asOf: AS_OF });

    const before = await sql<{ id: string; cluster_id: string; assigned: Date }>`
      SELECT id::text AS id, cluster_id::text AS cluster_id, cluster_assigned_at AS assigned
      FROM geonerva.fire_detections
    `.execute(db);
    const detection = before.rows[0];
    expect(detection).toBeDefined();

    const thief = randomUUID();
    const later = new Date(AS_OF.getTime() + 60_000);
    await createCluster(db, {
      id: thief,
      publicId: generateFireClusterPublicId(later),
      createdAt: later,
      status: 'ACTIVE',
    });
    const moved = await assignDetectionsToCluster(db, thief, [detection?.id ?? ''], later);

    expect(moved).toBe(0);
    const after = await sql<{ cluster_id: string; assigned: Date }>`
      SELECT cluster_id::text AS cluster_id, cluster_assigned_at AS assigned
      FROM geonerva.fire_detections
    `.execute(db);
    expect(after.rows[0]?.cluster_id).toBe(detection?.cluster_id);
    expect(after.rows[0]?.assigned.toISOString()).toBe(detection?.assigned.toISOString());
  });

  it('ignores a detection ingested after the knowledge bound', async () => {
    await detect({ metresNorth: 0, ingestedAt: new Date(AS_OF.getTime() + 60_000) });

    const result = await clusterFireDetections(db, { asOf: AS_OF });

    expect(result.considered).toBe(0);
    expect(result.clustersCreated).toBe(0);
  });

  it('clusters detections from both sensors into one fire', async () => {
    /*
     * NOAA-20 and NOAA-21 see the same fire. Partitioning by sensor would report one fire as two
     * and double every count a reader sees.
     */
    await detect({ metresNorth: 0, productCode: 'VIIRS_NOAA20_NRT' });
    await detect({ metresNorth: 400, productCode: 'VIIRS_NOAA21_NRT' });

    const result = await clusterFireDetections(db, { asOf: AS_OF });

    expect(result.clustersCreated).toBe(1);
    const version = await sql<{ product_ids: number[] }>`
      SELECT product_ids FROM geonerva.fire_cluster_versions ORDER BY id DESC LIMIT 1
    `.execute(db);
    expect(version.rows[0]?.product_ids).toHaveLength(2);
  });

  it('writes a summary whose counts match the detections it holds', async () => {
    await detect({ metresNorth: 0, frp: 10 });
    await detect({ metresNorth: 400, frp: 20 });

    await clusterFireDetections(db, { asOf: AS_OF });

    const version = await sql<{
      n_total: number;
      n_24h: number;
      overpasses_24h: number;
      frp_max: number;
      hull: string | null;
    }>`
      SELECT n_total, n_24h, overpasses_24h, frp_max, ST_AsText(hull::geometry) AS hull
      FROM geonerva.fire_cluster_versions ORDER BY id DESC LIMIT 1
    `.execute(db);
    const row = version.rows[0];
    expect(row?.n_total).toBe(2);
    expect(row?.n_24h).toBe(2);
    /* Both detections share one acquisition time: one overpass, not two. */
    expect(row?.overpasses_24h).toBe(1);
    expect(row?.frp_max).toBeCloseTo(20, 5);
    expect(row?.hull).toContain('POLYGON');
  });
});

describe('runClustering, the scheduled job', () => {
  it('skips when no detection has arrived since the last successful run', async () => {
    const { logger } = collectingLogger();
    await detect({ metresNorth: 0 });
    const first = await runClustering({ db, logger, asOf: AS_OF });
    expect(first.status).toBe('SUCCEEDED');

    const second = await runClustering({ db, logger, asOf: new Date(AS_OF.getTime() + 60_000) });

    expect(second.status).toBe('SKIPPED');
    expect(second.detail).toContain('nothing ingested since');
  });

  it('skips when there are no detections at all, rather than reporting a fault', async () => {
    const { logger } = collectingLogger();
    const outcome = await runClustering({ db, logger, asOf: AS_OF });
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.detail).toContain('no facts');
  });

  it('runs again once a new detection arrives', async () => {
    const { logger } = collectingLogger();
    await detect({ metresNorth: 0 });
    await runClustering({ db, logger, asOf: AS_OF });

    const later = new Date(AS_OF.getTime() + 60 * 60 * 1000);
    await detect({ metresNorth: 20_000, acquiredAt: later, ingestedAt: later });
    const outcome = await runClustering({ db, logger, asOf: new Date(later.getTime() + 1_000) });

    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.detail).toContain('assigned=1');
  });

  it('does not advance the gate when a run fails', async () => {
    /*
     * A failed run must leave `lastSucceededAt` where it was, or the next tick would decide the
     * facts had been seen and the detections would never be clustered. The failure is induced by
     * removing the table the run reads, which is the bluntest honest way to make it throw.
     */
    const { logger } = collectingLogger();
    await detect({ metresNorth: 0 });

    await sql`ALTER TABLE geonerva.fire_clusters RENAME TO fire_clusters_hidden`.execute(db);
    let failed: Awaited<ReturnType<typeof runClustering>>;
    try {
      failed = await runClustering({ db, logger, asOf: AS_OF });
    } finally {
      await sql`ALTER TABLE geonerva.fire_clusters_hidden RENAME TO fire_clusters`.execute(db);
    }
    expect(failed.status).toBe('FAILED');

    /* The gate still sees work, because no successful run recorded an `as_of`. */
    const recovered = await runClustering({ db, logger, asOf: new Date(AS_OF.getTime() + 1_000) });
    expect(recovered.status).toBe('SUCCEEDED');
    expect(recovered.detail).toContain('assigned=1');
  });

  it('records a FAILED analysis run, so availability degrades on its own', async () => {
    const { logger } = collectingLogger();
    await detect({ metresNorth: 0 });

    await sql`ALTER TABLE geonerva.fire_clusters RENAME TO fire_clusters_hidden`.execute(db);
    try {
      await runClustering({ db, logger, asOf: AS_OF });
    } finally {
      await sql`ALTER TABLE geonerva.fire_clusters_hidden RENAME TO fire_clusters`.execute(db);
    }

    const runs = await sql<{ status: string }>`
      SELECT status FROM geonerva.analysis_runs WHERE kind = 'CLUSTERING'
    `.execute(db);
    expect(runs.rows.map((row) => row.status)).toContain('FAILED');
  });

  it('logs one terminal line at error level exactly when the run failed', async () => {
    const { logger, lines } = collectingLogger();
    await detect({ metresNorth: 0 });
    await runClustering({ db, logger, asOf: AS_OF });

    const terminal = lines.filter((line) => line['event'] === 'clustering.run');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.['level']).toBe('info');
  });

  it('cannot double-assign or double-mint when two runs overlap', async () => {
    /*
     * The advisory lock is what stops two workers minting a cluster each for the same fire. Both
     * runs are started without awaiting the first, so they genuinely overlap; one takes the lock
     * and the other reports SKIPPED rather than queueing behind it.
     */
    const { logger } = collectingLogger();
    await detect({ metresNorth: 0 });
    await detect({ metresNorth: 400 });

    const [left, right] = await Promise.all([
      runClustering({ db, logger, asOf: AS_OF }),
      runClustering({ db, logger, asOf: AS_OF }),
    ]);

    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual(['SKIPPED', 'SUCCEEDED']);
    expect(await clusterCount()).toBe(1);

    const assigned = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.fire_detections WHERE cluster_id IS NOT NULL
    `.execute(db);
    expect(Number(assigned.rows[0]?.n)).toBe(2);
  });
});
