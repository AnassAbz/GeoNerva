/**
 * **Changing a fire cluster after T does not change a replay of T** (ADR-039, accepted by the
 * product owner 2026-09-23).
 *
 * The owner's words: "A historical replay at time `T` must not recompute fire clusters,
 * aggregates, or historical values using information, cluster membership, algorithms, or derived
 * state that became available after `T`." Membership was the one input that could not honour that,
 * because `fire_detections.cluster_id` was written in place at assignment and rewritten on merge,
 * with no record of when either happened.
 *
 * So this file does the only thing that proves the fix: it **reads a replay, then changes the
 * world, then reads the same replay again** and asserts the two answers are identical.
 *
 * Not every test here would have failed against the old code, and it is worth saying which. The
 * two merge tests and the absorbed-cluster one passed before as well, because the old code reached
 * the same numbers by the opposite mechanism — it re-pointed `cluster_id`, so the detections had
 * physically moved. They are kept because they pin the *rule* against the mechanism that replaced
 * it, and the first of them fails today if a merge after `T` is allowed to fold. The ones that
 * could only ever pass with `cluster_assigned_at` are the four about assignment time: a detection
 * held at `T` and clustered later, the boundary at `T` itself, one millisecond past it, and an
 * assignment with no knowledge time at all.
 *
 * The exception in the owner's decision is deliberate and is tested too — "unless the historical
 * state itself was versioned as known by T". A new *version* stamped at or before T is knowledge
 * GeoNerva had at T, and a replay must pick it up; a version stamped after T must not move it.
 */

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { reconstructClusterDetections } from './asof-detail.ts';
import { clusterWindowCountsAsOf, nearestClusterDetections } from './asof.ts';
import { createDb, type DB } from './index.ts';
import {
  assignDetectionsToCluster,
  bulkInsertDetections,
  mergeClusters,
} from './repositories/fire.ts';
import { setupTestDatabase, type TestDatabase } from './testing/test-database.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
  /*
   * The last test in this file drops `fire_detections_assignment_time_check` to build a row the
   * schema refuses, and restores it in a `finally`. If a run dies between the two — a timeout, or
   * this machine running out of memory — the constraint stays gone for every later suite, because
   * the migrator has recorded 0020 as applied and will not add it again. Restoring it here as well
   * makes the damage last one run instead of forever.
   */
  await sql`
    ALTER TABLE geonerva.fire_detections
      DROP CONSTRAINT IF EXISTS fire_detections_assignment_time_check
  `.execute(db);
  await sql`
    ALTER TABLE geonerva.fire_detections
      ADD CONSTRAINT fire_detections_assignment_time_check
      CHECK ((cluster_id IS NULL) = (cluster_assigned_at IS NULL)) NOT VALID
  `.execute(db);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
});

const T0 = new Date('2026-09-20T00:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

/** The knowledge time every replay in this file is taken at. */
const T = minutes(60);

const POINT = { lat: 31.63, lon: -8.0 };

async function productId(): Promise<number> {
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE code = 'VIIRS_NOAA20_NRT'
  `.execute(db);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('no FIRMS product');
  return id;
}

async function makeCluster(createdAt: Date): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO geonerva.fire_clusters (id, public_id, created_at, status)
    VALUES (${id}::uuid, ${`FR-26-${id.slice(0, 6).toUpperCase()}`}, ${createdAt}, 'ACTIVE')
  `.execute(db);
  /*
   * No `fire_cluster_heads` row: it needs a version, and the reads under test resolve membership
   * from the detections and the merge chain rather than from the head pointer. A head here would
   * be fixture furniture standing in for a fact nothing reads.
   */
  return id;
}

/** Ingests `count` detections and assigns them to `clusterId`, as one clustering run would. */
async function detect(
  clusterId: string,
  options: {
    readonly count: number;
    readonly at: Date;
    readonly assignedAt: Date;
    readonly km: number;
  },
): Promise<void> {
  const product = await productId();
  await bulkInsertDetections(
    db,
    Array.from({ length: options.count }, (_unused, index) => ({
      productId: product,
      // Ingested at its own acquisition: the table refuses a detection acquired more than five
      // minutes after it was stored, and a batch spread over more than that would trip it.
      acquiredAt: new Date(options.at.getTime() + index * 60_000),
      lat: POINT.lat + options.km / 110.574,
      lon: POINT.lon,
      confidenceClass: 'NOMINAL' as const,
      confidenceRaw: 'n',
      frp: 4,
      brightTi4: 330,
      brightTi5: 290,
      scan: 0.4,
      track: 0.4,
      daynight: 'D' as const,
      providerVersion: '2.0NRT',
      ingestedAt: new Date(options.at.getTime() + index * 60_000),
    })),
  );
  const unassigned = await sql<{ id: string }>`
    SELECT id::text AS id FROM geonerva.fire_detections WHERE cluster_id IS NULL
  `.execute(db);
  await assignDetectionsToCluster(
    db,
    clusterId,
    unassigned.rows.map((row) => row.id),
    options.assignedAt,
  );
}

/** Everything a replay of `T` can say about one cluster's members. */
async function replay(clusterId: string) {
  const [counts, nearestByVersion, members] = await Promise.all([
    clusterWindowCountsAsOf(db, { clusterId, asOf: T, windowHours: 24 }),
    nearestClusterDetections(db, {
      clusters: [
        {
          clusterId,
          knownAt: T,
          firstDetectedAt: T0,
          lastDetectedAt: T,
        },
      ],
      point: POINT,
    }),
    reconstructClusterDetections(db, {
      clusterId,
      knownAt: T,
      firstDetectedAt: T0,
      lastDetectedAt: T,
      cap: 100,
      point: POINT,
    }),
  ]);
  return {
    detections: counts.detections,
    nearestCount: nearestByVersion[0]?.count ?? 0,
    memberCount: members.count,
    days: members.byDay.map((day) => `${day.day}:${String(day.count)}`).join(','),
  };
}

describe('ADR-039 — a replay of T is not moved by anything that happened after T', () => {
  it('a merge after T does not fold two clusters into one in the replay', async () => {
    const survivor = await makeCluster(T0);
    const absorbed = await makeCluster(minutes(5));
    await detect(survivor, { count: 2, at: minutes(10), assignedAt: minutes(15), km: 3 });
    await detect(absorbed, { count: 3, at: minutes(20), assignedAt: minutes(25), km: 9 });

    const before = await replay(survivor);
    expect(before.detections).toBe(2);
    expect(before.memberCount).toBe(2);

    /* The merge happens *after* T, so a replay of T must still see two areas of activity. */
    await db.transaction().execute((trx) => mergeClusters(trx, survivor, [absorbed], minutes(120)));

    expect(await replay(survivor)).toEqual(before);
  });

  /* The other half of the same rule: a merge GeoNerva knew about at T *is* part of the replay. */
  it('a merge before T is applied to the replay', async () => {
    const survivor = await makeCluster(T0);
    const absorbed = await makeCluster(minutes(5));
    await detect(survivor, { count: 2, at: minutes(10), assignedAt: minutes(15), km: 3 });
    await detect(absorbed, { count: 3, at: minutes(20), assignedAt: minutes(25), km: 9 });

    await db.transaction().execute((trx) => mergeClusters(trx, survivor, [absorbed], minutes(30)));

    const after = await replay(survivor);
    expect(after.detections).toBe(5);
    expect(after.memberCount).toBe(5);
  });

  /*
   * The mirror of the merge rule. A cluster absorbed by T is not a subject at T any more — the
   * list read skips it and the detail read redirects to its survivor — so it is not a target of
   * its own lineage either. Were it one, a replay could answer twice for the same detections: once
   * under the survivor, and once under a cluster GeoNerva had already stopped showing.
   */
  it('a cluster absorbed by T is not a target of its own replay', async () => {
    const survivor = await makeCluster(T0);
    const absorbed = await makeCluster(minutes(5));
    await detect(survivor, { count: 2, at: minutes(10), assignedAt: minutes(15), km: 3 });
    await detect(absorbed, { count: 3, at: minutes(20), assignedAt: minutes(25), km: 9 });
    await db.transaction().execute((trx) => mergeClusters(trx, survivor, [absorbed], minutes(30)));

    const replayed = await replay(absorbed);
    expect(replayed.detections).toBe(0);
    expect(replayed.memberCount).toBe(0);
    /*
     * The batched distance read too. It resolves membership for a whole card of clusters at once,
     * so it is the one path where an absorbed cluster answering for itself would put the same
     * detections on screen twice — once under the survivor, once under a cluster GeoNerva had
     * stopped showing.
     */
    expect(replayed.nearestCount).toBe(0);
    expect((await replay(survivor)).detections).toBe(5);
  });

  /*
   * A merge is a one-way step out of the graph. If two clusters could be pointed at each other,
   * the walk would find no survivor to seed from and return *nothing* — every detection beneath
   * them would vanish from every read at every knowledge time, silently. The writer refuses the
   * second merge rather than leaving the reads to cope with a cycle they cannot represent.
   */
  it('a merge cannot point two clusters at each other', async () => {
    const survivor = await makeCluster(T0);
    const absorbed = await makeCluster(minutes(5));
    await detect(survivor, { count: 2, at: minutes(10), assignedAt: minutes(15), km: 3 });
    await detect(absorbed, { count: 3, at: minutes(20), assignedAt: minutes(25), km: 9 });
    await db.transaction().execute((trx) => mergeClusters(trx, survivor, [absorbed], minutes(30)));

    const backwards = await db
      .transaction()
      .execute((trx) => mergeClusters(trx, absorbed, [survivor], minutes(40)));

    expect(backwards).toBe(0);
    /* And the replay still answers, which a cycle would have stopped it doing. */
    expect((await replay(survivor)).detections).toBe(5);

    /*
     * The other half of the same guard: a cluster that has already been absorbed cannot be
     * absorbed again. Re-pointing it would move its detections out from under the survivor that
     * had already counted them, and would rewrite what a replay of a moment after the first merge
     * says — the exact rewriting of the past this ADR exists to prevent.
     */
    const elsewhere = await makeCluster(minutes(7));
    const again = await db
      .transaction()
      .execute((trx) => mergeClusters(trx, elsewhere, [absorbed], minutes(45)));

    expect(again).toBe(0);
    expect((await replay(survivor)).detections).toBe(5);
    expect((await replay(elsewhere)).detections).toBe(0);
  });

  it('detections assigned after T are not in the replay, however many arrive', async () => {
    const cluster = await makeCluster(T0);
    await detect(cluster, { count: 2, at: minutes(10), assignedAt: minutes(15), km: 3 });

    const before = await replay(cluster);
    expect(before.detections).toBe(2);

    /*
     * Acquired and ingested *before* T, assigned after it. Stamping the arrival after T as well
     * would prove nothing here: `ingested_at <= T` already excluded those before this change, so
     * the test would pass against the column it replaced. Only the assignment time can keep these
     * seven out.
     */
    await detect(cluster, { count: 7, at: minutes(40), assignedAt: minutes(95), km: 1 });

    expect(await replay(cluster)).toEqual(before);
  });

  /*
   * The subtle one, and the reason `cluster_assigned_at` exists rather than a reliance on
   * `ingested_at`: a detection can be *held* at T and assigned to a cluster only afterwards. Its
   * own facts were known; its membership was not.
   */
  it('a detection ingested before T but clustered after T is not a member in the replay', async () => {
    const cluster = await makeCluster(T0);
    await detect(cluster, { count: 2, at: minutes(10), assignedAt: minutes(15), km: 3 });
    const before = await replay(cluster);

    const product = await productId();
    await bulkInsertDetections(db, [
      {
        productId: product,
        acquiredAt: minutes(20),
        lat: POINT.lat + 0.5 / 110.574,
        lon: POINT.lon,
        confidenceClass: 'NOMINAL' as const,
        confidenceRaw: 'n',
        frp: 9,
        brightTi4: 340,
        brightTi5: 295,
        scan: 0.4,
        track: 0.4,
        daynight: 'D' as const,
        providerVersion: '2.0NRT',
        ingestedAt: minutes(25),
      },
    ]);
    const late = await sql<{ id: string }>`
      SELECT id::text AS id FROM geonerva.fire_detections WHERE cluster_id IS NULL
    `.execute(db);
    expect(late.rows.length).toBe(1);
    await assignDetectionsToCluster(
      db,
      cluster,
      late.rows.map((row) => row.id),
      minutes(200),
    );

    /*
     * Half a kilometre away and held since minute 25 — if membership were read from the column it
     * would be the nearest member and would change the distance the card states. It is not a
     * member at T, because at T nothing had put it in this cluster.
     */
    expect(await replay(cluster)).toEqual(before);
  });

  /*
   * The exception the owner's decision names: "unless the historical state itself was versioned as
   * known by T". An assignment stamped at T is knowledge GeoNerva had at T, so a replay of T sees
   * it — the rule is about *when a fact became true*, not about when the row was written.
   */
  it('an assignment stamped at T itself is part of the replay of T', async () => {
    const cluster = await makeCluster(T0);
    await detect(cluster, { count: 2, at: minutes(10), assignedAt: minutes(15), km: 3 });
    await detect(cluster, { count: 4, at: minutes(50), assignedAt: T, km: 2 });

    expect((await replay(cluster)).detections).toBe(6);
  });

  it('an assignment one millisecond after T is not', async () => {
    const cluster = await makeCluster(T0);
    await detect(cluster, { count: 2, at: minutes(10), assignedAt: minutes(15), km: 3 });
    await detect(cluster, {
      count: 4,
      at: minutes(50),
      assignedAt: new Date(T.getTime() + 1),
      km: 2,
    });

    expect((await replay(cluster)).detections).toBe(2);
  });

  /*
   * Membership predating migration 0020 has a cluster and no knowledge time for it. That is
   * unknowable at any past T, and the reads withhold rather than guess — the conservative error,
   * and the one that cannot invent a history GeoNerva never observed.
   */
  it('an assignment with no knowledge time is in no replay at all', async () => {
    const cluster = await makeCluster(T0);
    await detect(cluster, { count: 3, at: minutes(10), assignedAt: minutes(15), km: 3 });
    expect((await replay(cluster)).detections).toBe(3);

    /*
     * The shape has to be forced, because the schema refuses to create it: a row with a cluster
     * and no assignment time can only be legacy data. The constraint goes back in a `finally` —
     * these tests share one database with every other integration suite, and a test that leaves
     * the schema weaker than it found it would quietly disarm theirs.
     */
    await sql`
      ALTER TABLE geonerva.fire_detections
        DROP CONSTRAINT IF EXISTS fire_detections_assignment_time_check
    `.execute(db);
    try {
      await sql`UPDATE geonerva.fire_detections SET cluster_assigned_at = NULL`.execute(db);

      const replayed = await replay(cluster);
      expect(replayed.detections).toBe(0);
      expect(replayed.memberCount).toBe(0);
      // All three read paths, including the one the distance on a card is measured through.
      expect(replayed.nearestCount).toBe(0);
    } finally {
      await sql`
        ALTER TABLE geonerva.fire_detections
          ADD CONSTRAINT fire_detections_assignment_time_check
          CHECK ((cluster_id IS NULL) = (cluster_assigned_at IS NULL)) NOT VALID
      `.execute(db);
    }
  });
});
