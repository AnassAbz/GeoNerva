/**
 * Fire detections and clusters (DOMAIN_MODEL §4.9, §4.10, ARCHITECTURE §7.4).
 *
 * Detections are the one high-volume path in GeoNerva — P0 measured ≈146k rows/day for
 * NOAA-20 + NOAA-21 together — so the insert is written for throughput:
 *
 *  - one statement per chunk, built with `unnest(...)` over parallel arrays, so 1,000 detections
 *    cost one round trip and a handful of bind parameters rather than 1,000 of each;
 *  - `ON CONFLICT DO NOTHING` against `(product_id, acquired_at, lat_e4, lon_e4)`, which is what
 *    makes re-ingesting an overlapping `DAY_RANGE=2` window a no-op (invariant I8). FIRMS has no
 *    stable detection id, so the rounded coordinates *are* the identity.
 *
 * `COPY` would be marginally faster still, but it cannot express `ON CONFLICT DO NOTHING`, and
 * idempotency is worth more here than the last few percent of insert speed: every poll overlaps
 * the previous one by design.
 */

import { sql, type Kysely, type Transaction } from 'kysely';

import type { ConfidenceClass } from '@geonerva/domain';

import type { DB } from '../generated/database.ts';
import { clusterLineageAsOf } from '../asof-membership.ts';

type Db = Kysely<DB> | Transaction<DB>;

/** Rows per statement. Large enough to amortize round trips, small enough to stay readable. */
export const DETECTION_CHUNK_SIZE = 1_000;

export interface FireDetectionInput {
  readonly productId: number;
  readonly acquiredAt: Date;
  readonly lat: number;
  readonly lon: number;
  readonly confidenceClass: ConfidenceClass | null;
  readonly confidenceRaw: string | null;
  readonly frp: number | null;
  readonly brightTi4: number | null;
  readonly brightTi5: number | null;
  readonly scan: number | null;
  readonly track: number | null;
  readonly daynight: 'D' | 'N' | null;
  readonly providerVersion: string | null;
  readonly ingestionRunId?: string | null;
  readonly ingestedAt: Date;
}

export interface BulkInsertResult {
  readonly received: number;
  readonly inserted: number;
  /** Rows already present: the overlap between consecutive polls. */
  readonly duplicates: number;
  readonly partitionsCreated: readonly string[];
}

/**
 * Raised when a chunked insert fails partway, carrying how far it got.
 *
 * The `cause` is the driver's error and must never be quoted into a stored message — it can hold
 * a connection string (SECURITY.md M7). The caller reads `inserted` and the SQLSTATE, not the text.
 */
export class PartialDetectionInsertError extends Error {
  readonly inserted: number;
  readonly received: number;
  readonly partitionsCreated: readonly string[];

  constructor(
    inserted: number,
    received: number,
    partitionsCreated: readonly string[],
    cause: unknown,
  ) {
    super(`the detection insert failed after ${inserted} of ${received} rows`, { cause });
    this.name = 'PartialDetectionInsertError';
    this.inserted = inserted;
    this.received = received;
    this.partitionsCreated = partitionsCreated;
  }
}

/** Ensures the daily partitions for the days a batch touches exist. */
export async function ensurePartitionsForDays(
  db: Db,
  days: readonly Date[],
): Promise<readonly string[]> {
  const unique = [...new Set(days.map((day) => day.toISOString().slice(0, 10)))].sort();
  const created: string[] = [];
  for (const day of unique) {
    const result = await sql<{ name: string }>`
      SELECT geonerva.ensure_fire_detection_partition(${day}::date) AS name
    `.execute(db);
    const name = result.rows[0]?.name;
    if (name !== undefined) created.push(name);
  }
  return created;
}

/**
 * Inserts detections, skipping ones already stored.
 *
 * Partitions are created first, because an insert into a range-partitioned table with no matching
 * partition fails outright — and a satellite does not wait for a nightly maintenance job.
 */
export async function bulkInsertDetections(
  db: Db,
  detections: readonly FireDetectionInput[],
  options: { chunkSize?: number } = {},
): Promise<BulkInsertResult> {
  if (detections.length === 0) {
    return { received: 0, inserted: 0, duplicates: 0, partitionsCreated: [] };
  }

  const partitionsCreated = await ensurePartitionsForDays(
    db,
    detections.map((detection) => detection.acquiredAt),
  );

  const chunkSize = options.chunkSize ?? DETECTION_CHUNK_SIZE;
  let inserted = 0;

  for (let start = 0; start < detections.length; start += chunkSize) {
    const chunk = detections.slice(start, start + chunkSize);
    let result;
    try {
      result = await sql<{ id: string }>`
      INSERT INTO geonerva.fire_detections (
        product_id, acquired_at, lat, lon, geog, confidence_class, confidence_raw, frp,
        bright_ti4, bright_ti5, scan, track, daynight, provider_version, ingestion_run_id,
        ingested_at)
      SELECT product_id,
             acquired_at,
             lat,
             lon,
             ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
             confidence_class,
             confidence_raw,
             frp,
             bright_ti4,
             bright_ti5,
             scan,
             track,
             daynight,
             provider_version,
             ingestion_run_id,
             ingested_at
      FROM unnest(
        ${sql.val(chunk.map((d) => d.productId))}::smallint[],
        ${sql.val(chunk.map((d) => d.acquiredAt.toISOString()))}::timestamptz[],
        ${sql.val(chunk.map((d) => d.lat))}::double precision[],
        ${sql.val(chunk.map((d) => d.lon))}::double precision[],
        ${sql.val(chunk.map((d) => d.confidenceClass))}::text[],
        ${sql.val(chunk.map((d) => d.confidenceRaw))}::text[],
        ${sql.val(chunk.map((d) => d.frp))}::real[],
        ${sql.val(chunk.map((d) => d.brightTi4))}::real[],
        ${sql.val(chunk.map((d) => d.brightTi5))}::real[],
        ${sql.val(chunk.map((d) => d.scan))}::real[],
        ${sql.val(chunk.map((d) => d.track))}::real[],
        ${sql.val(chunk.map((d) => d.daynight))}::char(1)[],
        ${sql.val(chunk.map((d) => d.providerVersion))}::text[],
        ${sql.val(chunk.map((d) => d.ingestionRunId ?? null))}::uuid[],
        ${sql.val(chunk.map((d) => d.ingestedAt.toISOString()))}::timestamptz[]
      ) AS t(product_id, acquired_at, lat, lon, confidence_class, confidence_raw, frp,
             bright_ti4, bright_ti5, scan, track, daynight, provider_version, ingestion_run_id,
             ingested_at)
      ON CONFLICT (product_id, acquired_at, lat_e4, lon_e4) DO NOTHING
      RETURNING id::text AS id
      `.execute(db);
    } catch (error) {
      /*
       * A chunk failed, and the rows before it are committed.
       *
       * This insert is deliberately *not* one transaction — 128,000 rows under one lock would
       * park every other writer — so a failing chunk leaves the earlier ones in place. That is
       * safe, because `ON CONFLICT DO NOTHING` makes the retry exact rather than merely
       * idempotent. What it is not, by itself, is *honest*: the caller caught a bare error, had
       * no idea how much had landed, and wrote `n_received = 0` on a run with 33,000 rows already
       * stored under its id. A live NOAA-21 batch did exactly that.
       *
       * So the progress travels with the failure. The caller can then say "received 128,000,
       * stored 33,000, failed", which is what happened.
       */
      throw new PartialDetectionInsertError(inserted, detections.length, partitionsCreated, error);
    }
    inserted += result.rows.length;
  }

  return {
    received: detections.length,
    inserted,
    duplicates: detections.length - inserted,
    partitionsCreated,
  };
}

/**
 * Retention: drops whole daily partitions, **one statement at a time** (ADR-018, S-7).
 *
 * `DROP TABLE` on a partition takes ACCESS EXCLUSIVE on the parent, and PostgreSQL's lock queue
 * is FIFO: dropping every expired day in one transaction would park all ingestion behind one
 * long-running reader. Each day is dropped separately, under a lock timeout, and a day that is
 * busy right now is simply left for the next run — retention is never urgent.
 */
export async function dropDetectionPartitionsBefore(
  // Deliberately `Kysely<DB>` and not `Db`: this catches 55P03 to defer a busy partition, and a
  // caught error inside a transaction aborts it, so every later statement would fail with 25P02
  // (R-3). Retention runs on its own connection, one statement per partition.
  db: Kysely<DB>,
  cutoff: Date,
  options: { lockTimeoutMs?: number } = {},
): Promise<{ readonly dropped: readonly string[]; readonly deferred: readonly string[] }> {
  // Kysely's `Transaction<DB>` *extends* `Kysely<DB>`, so the parameter type documents the
  // requirement without enforcing it (V-3). Check at run time: this function catches 55P03 to
  // defer a busy partition, and a caught error inside a transaction poisons everything after it.
  if (db.isTransaction) {
    throw new Error(
      'dropDetectionPartitionsBefore must run on its own connection, not inside a transaction: ' +
        'it defers a locked partition by catching an error, which would abort the transaction.',
    );
  }

  const due = await sql<{ day: string }>`
    SELECT to_char(day, 'YYYYMMDD') AS day
    FROM geonerva.fire_detection_partitions_before(${cutoff.toISOString().slice(0, 10)}::date) AS day
  `.execute(db);

  const dropped: string[] = [];
  const deferred: string[] = [];
  for (const { day } of due.rows) {
    try {
      const result = await sql<{ dropped: boolean }>`
        SELECT geonerva.drop_fire_detection_partition(
          to_date(${day}, 'YYYYMMDD'), ${options.lockTimeoutMs ?? 5000}
        ) AS dropped
      `.execute(db);
      if (result.rows[0]?.dropped === true) dropped.push(`fire_detections_${day}`);
    } catch (error) {
      // 55P03 lock_not_available: someone is reading the fire table. Try again tonight.
      if ((error as { code?: string }).code === '55P03') {
        deferred.push(`fire_detections_${day}`);
        continue;
      }
      throw error;
    }
  }
  return { dropped, deferred };
}

/** The days that currently have a partition, oldest first: the fire replay horizon in practice. */
export async function listDetectionPartitionDays(db: Db): Promise<string[]> {
  const result = await sql<{ day: string }>`
    SELECT right(c.relname, 8) AS day
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE n.nspname = 'geonerva'
      AND parent.relname = 'fire_detections'
      AND c.relname ~ '^fire_detections_[0-9]{8}$'
    ORDER BY 1
  `.execute(db);
  return result.rows.map((row) => row.day);
}

export interface CreateClusterInput {
  readonly id: string;
  readonly publicId: string;
  readonly createdAt: Date;
  readonly status: 'ACTIVE' | 'COOLING' | 'INACTIVE';
}

/** Creates a cluster identity. Summaries are versions; this row never changes except on merge. */
export async function createCluster(db: Db, input: CreateClusterInput): Promise<string> {
  const result = await sql<{ id: string }>`
    INSERT INTO geonerva.fire_clusters (id, public_id, created_at, status)
    VALUES (${input.id}::uuid, ${input.publicId}, ${input.createdAt}, ${input.status})
    RETURNING id::text AS id
  `.execute(db);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('failed to create fire cluster');
  return id;
}

/**
 * Assigns detections to a cluster, recording **when** the assignment became true.
 *
 * A detection's cluster is assigned once and never reassigned; when two clusters turn out to be
 * connected, the *clusters* merge and the merge is recorded on the cluster row. That keeps
 * membership immutable and makes the history of an area of thermal activity readable.
 *
 * `assignedAt` is the clustering run's `as_of`, and it is what makes membership a bitemporal fact
 * rather than a column describing the present (ADR-039). Without it a replay of a knowledge time
 * before the assignment would have drawn the detection inside a cluster it did not yet belong to —
 * future knowledge leaking backward, which is the one thing the as-of layer exists to prevent.
 */
export async function assignDetectionsToCluster(
  db: Db,
  clusterId: string,
  detectionIds: readonly string[],
  assignedAt: Date,
): Promise<number> {
  if (detectionIds.length === 0) return 0;
  const result = await sql`
    UPDATE geonerva.fire_detections
    SET cluster_id = ${clusterId}::uuid,
        cluster_assigned_at = ${assignedAt}
    WHERE id = ANY(${sql.val(detectionIds)}::bigint[])
      AND cluster_id IS NULL
  `.execute(db);
  return Number(result.numAffectedRows ?? 0n);
}

export interface ClusterVersionInput {
  readonly clusterId: string;
  readonly analysisRunId?: string | null;
  readonly asOf: Date;
  readonly nTotal: number;
  readonly n24h: number;
  readonly overpasses24h: number;
  readonly firstDetectedAt: Date;
  readonly lastDetectedAt: Date;
  readonly frpSum24h: number | null;
  readonly frpMax: number | null;
  readonly maxConfidence: ConfidenceClass | null;
  readonly productIds: readonly number[];
  /** GeoJSON polygon of the buffered hull, or `null` when it could not be built. */
  readonly hullGeoJson: unknown;
  readonly centroid: { readonly lat: number; readonly lon: number };
  readonly contentSha256: Buffer;
  readonly status: 'ACTIVE' | 'COOLING' | 'INACTIVE' | 'MERGED';
}

export type ClusterVersionResult =
  | { readonly inserted: true; readonly clusterVersionId: string }
  | { readonly inserted: false; readonly clusterVersionId: string };

/**
 * Writes a cluster summary **only if it changed**.
 *
 * A clustering run happens after every FIRMS batch, and most clusters are unchanged between runs
 * — nothing new burned, the satellite simply passed over somewhere else. Writing a version
 * regardless would produce thousands of identical rows a day and would make "this cluster grew"
 * indistinguishable from "we looked again". The unique index on `(cluster_id, content_sha256)` is
 * the mechanism, so idempotency holds even if two runs race.
 */
export async function insertClusterVersionIfChanged(
  db: Db,
  input: ClusterVersionInput,
): Promise<ClusterVersionResult> {
  const hullExpression =
    input.hullGeoJson === null
      ? sql`NULL`
      : sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(input.hullGeoJson)}), 4326)::geography`;

  const inserted = await sql<{ id: string }>`
    INSERT INTO geonerva.fire_cluster_versions (
      cluster_id, analysis_run_id, as_of, n_total, n_24h, overpasses_24h, first_detected_at,
      last_detected_at, frp_sum_24h, frp_max, max_confidence, product_ids, hull, centroid,
      content_sha256)
    VALUES (
      ${input.clusterId}::uuid, ${input.analysisRunId ?? null}::uuid, ${input.asOf},
      ${input.nTotal}, ${input.n24h}, ${input.overpasses24h}, ${input.firstDetectedAt},
      ${input.lastDetectedAt}, ${input.frpSum24h}, ${input.frpMax}, ${input.maxConfidence},
      ${sql.val(input.productIds)}::smallint[], ${hullExpression},
      ST_SetSRID(ST_MakePoint(${input.centroid.lon}, ${input.centroid.lat}), 4326)::geography,
      ${input.contentSha256})
    ON CONFLICT (cluster_id, content_sha256) DO NOTHING
    RETURNING id::text AS id
  `.execute(db);

  const newId = inserted.rows[0]?.id;
  if (newId === undefined) {
    const existing = await sql<{ id: string }>`
      SELECT id::text AS id FROM geonerva.fire_cluster_versions
      WHERE cluster_id = ${input.clusterId}::uuid AND content_sha256 = ${input.contentSha256}
      ORDER BY as_of DESC, id DESC
      LIMIT 1
    `.execute(db);
    const id = existing.rows[0]?.id;
    if (id === undefined) throw new Error('cluster version neither inserted nor found');
    return { inserted: false, clusterVersionId: id };
  }

  await sql`
    INSERT INTO geonerva.fire_cluster_heads
      (cluster_id, latest_version_id, status, as_of, last_detected_at)
    VALUES (${input.clusterId}::uuid, ${newId}::bigint, ${input.status}, ${input.asOf},
            ${input.lastDetectedAt})
    ON CONFLICT (cluster_id) DO UPDATE
      SET latest_version_id = EXCLUDED.latest_version_id,
          status = EXCLUDED.status,
          as_of = EXCLUDED.as_of,
          last_detected_at = EXCLUDED.last_detected_at
  `.execute(db);

  await sql`
    UPDATE geonerva.fire_clusters SET status = ${input.status} WHERE id = ${input.clusterId}::uuid
  `.execute(db);

  return { inserted: true, clusterVersionId: newId };
}

/**
 * Merges clusters into a survivor.
 *
 * The **oldest** cluster survives, because users may already have seen its public id, and its
 * history is the longer one. The absorbed clusters keep their rows and versions so that a replay
 * before the merge still shows two separate areas of activity.
 *
 * **Detections are not re-pointed** (ADR-039). Rewriting `cluster_id` was the second in-place
 * write on the highest-volume table, and it erased where a detection had been: after a merge, a
 * replay of a knowledge time *before* it would have shown one area of activity where GeoNerva had
 * seen two. The merge is already a fact with a knowledge time on the cluster row, so a read at `T`
 * follows `merged_into` for merges with `merged_at <= T` and stops — which is the same answer for
 * the present and the only correct answer for the past.
 */
export async function mergeClusters(
  trx: Transaction<DB>,
  survivorId: string,
  absorbedIds: readonly string[],
  mergedAt: Date,
): Promise<number> {
  if (absorbedIds.length === 0) return 0;

  /*
   * The cycle guard, and it takes both halves. Without it two calls can point a pair of clusters
   * at each other, and then the as-of lineage walk finds no survivor to seed from and silently
   * returns *nothing* — every detection beneath them disappears from every read, at every
   * knowledge time (ADR-039).
   *
   * A merge is a one-way step out of the graph, so neither end may already have taken it: an
   * absorbed cluster must be unmerged (`merged_into IS NULL`), and so must the survivor, or the
   * chain would fork. Guarding only the absorbed side is not enough — merging a live cluster
   * *into* one that was merged away closes the loop just as well. `source_records.ts` guards its
   * own merges the same way.
   */
  const absorbed = await sql`
    UPDATE geonerva.fire_clusters
    SET status = 'MERGED', merged_into = ${survivorId}::uuid, merged_at = ${mergedAt}
    WHERE id = ANY(${sql.val(absorbedIds)}::uuid[])
      AND id <> ${survivorId}::uuid
      AND merged_into IS NULL
      AND EXISTS (
        SELECT 1 FROM geonerva.fire_clusters s
        WHERE s.id = ${survivorId}::uuid AND s.merged_into IS NULL
      )
  `.execute(trx);

  await sql`
    UPDATE geonerva.fire_cluster_heads SET status = 'MERGED'
    WHERE cluster_id = ANY(${sql.val(absorbedIds)}::uuid[])
  `.execute(trx);

  /*
   * The number of clusters this call absorbed, not of detections moved: nothing moves any more. A
   * caller that wants the members of the survivor asks for them at a knowledge time, where the
   * merge is applied or not according to whether it had happened.
   *
   * Measured from the `UPDATE`, not counted from the argument. An id that does not exist, or one
   * already merged into something else, is not absorbed by this call, and saying it was would make
   * the return value a restatement of the request.
   */
  return Number(absorbed.numAffectedRows ?? 0n);
}

/**
 * The newest detection ingest time, for the clustering job's gate (ADR-045).
 *
 * Deliberately **not** the as-of layer's `newestDetectionIngestAt`, which is scoped to a radius
 * around a location because a briefing card only cares about its own neighbourhood. The scheduler
 * asks a global question — has anything at all arrived since the last run? — and answering it with
 * a location-scoped query would leave clustering asleep while the other hemisphere burned.
 *
 * `acquiredAfter` exists to let the partitioned table prune: without it this is a scan of every
 * partition still on disk, run once a minute forever.
 */
export async function newestDetectionIngestedAt(
  db: Db,
  options: { readonly asOf: Date; readonly acquiredAfter: Date },
): Promise<Date | null> {
  const result = await sql<{ newest: Date | null }>`
    SELECT max(d.ingested_at) AS newest
    FROM geonerva.fire_detections d
    WHERE d.ingested_at <= ${options.asOf}
      AND d.acquired_at >= ${options.acquiredAfter}
  `.execute(db);
  return result.rows[0]?.newest ?? null;
}

export interface ClusterableDetection {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  readonly acquiredAt: Date;
  /** The cluster this detection already belongs to, or `null` when it is still unassigned. */
  readonly clusterId: string | null;
}

/**
 * The detections a clustering run considers: the last `windowMs`, as known at `asOf`.
 *
 * **Already-assigned detections are included, and that is the point.** ARCHITECTURE §7.4 calls
 * this incremental clustering, and the increment only works if a new pixel can see the cluster its
 * neighbours are already in. Reading only unassigned rows would open a brand-new cluster beside
 * every existing fire on every pass — the same fire, a new public id each run.
 *
 * Ordered by `(acquired_at, id)`, which §7.4 fixes as the input order. Cluster identity is minted
 * from this order, so leaving it to the planner would let a public id depend on which plan
 * PostgreSQL chose that minute.
 */
export async function detectionsForClustering(
  db: Db,
  options: { readonly asOf: Date; readonly acquiredAfter: Date; readonly limit: number },
): Promise<ClusterableDetection[]> {
  const result = await sql<{
    id: string;
    lat: number;
    lon: number;
    acquired_at: Date;
    cluster_id: string | null;
  }>`
    SELECT d.id::text AS id, d.lat, d.lon, d.acquired_at, d.cluster_id::text AS cluster_id
    FROM geonerva.fire_detections d
    WHERE d.ingested_at <= ${options.asOf}
      AND d.acquired_at >= ${options.acquiredAfter}
      AND d.acquired_at <= ${options.asOf}
    ORDER BY d.acquired_at, d.id
    LIMIT ${options.limit}
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    lat: row.lat,
    lon: row.lon,
    acquiredAt: row.acquired_at,
    clusterId: row.cluster_id,
  }));
}

export interface ClusterIdentityRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly mergedInto: string | null;
}

/** The identity rows for a set of clusters, so a run can pick the oldest and follow merges. */
export async function clusterIdentities(
  db: Db,
  clusterIds: readonly string[],
): Promise<ClusterIdentityRow[]> {
  if (clusterIds.length === 0) return [];
  const result = await sql<{ id: string; created_at: Date; merged_into: string | null }>`
    SELECT id::text AS id, created_at, merged_into::text AS merged_into
    FROM geonerva.fire_clusters
    WHERE id = ANY(${sql.val(clusterIds)}::uuid[])
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    mergedInto: row.merged_into,
  }));
}

export interface ClusterDetectionStats {
  readonly nTotal: number;
  readonly n24h: number;
  readonly overpasses24h: number;
  readonly firstDetectedAt: Date | null;
  readonly lastDetectedAt: Date | null;
  readonly frpSum24h: number | null;
  readonly frpMax: number | null;
  readonly maxConfidence: ConfidenceClass | null;
  readonly productIds: number[];
}

/**
 * Everything a cluster version states about its detections, as known at `asOf`.
 *
 * Resolved through the merge lineage rather than through `fire_detections.cluster_id`, for the
 * reason `buildClusterHull` gives at length: a merge does not re-point detections (ADR-039), so
 * the raw column undercounts a survivor by everything it absorbed. The summary and the read paths
 * must agree, so they resolve membership the same way.
 *
 * `overpasses_24h` counts **distinct acquisition times**, which is what separates "the satellite
 * looked once and saw a lot" from "it kept seeing this over and over".
 */
export async function clusterDetectionStatsAsOf(
  db: Db,
  clusterId: string,
  asOf: Date,
  windowHours = 24,
): Promise<ClusterDetectionStats> {
  const since = new Date(asOf.getTime() - windowHours * 60 * 60 * 1000);
  const result = await sql<{
    n_total: string;
    n_24h: string;
    overpasses_24h: string;
    first_detected_at: Date | null;
    last_detected_at: Date | null;
    frp_sum_24h: number | null;
    frp_max: number | null;
    max_confidence: string | null;
    product_ids: number[] | null;
  }>`
    ${clusterLineageAsOf(clusterId, asOf)}
    SELECT
      count(*)::text AS n_total,
      count(*) FILTER (WHERE d.acquired_at >= ${since})::text AS n_24h,
      count(DISTINCT d.acquired_at) FILTER (WHERE d.acquired_at >= ${since})::text AS overpasses_24h,
      min(d.acquired_at) AS first_detected_at,
      max(d.acquired_at) AS last_detected_at,
      sum(d.frp) FILTER (WHERE d.acquired_at >= ${since}) AS frp_sum_24h,
      max(d.frp) AS frp_max,
      /*
       * The strongest confidence class present, ordered by meaning rather than alphabetically:
       * 'low' < 'nominal' < 'high' is not the string order, and a plain max() over the text would
       * report a cluster of nominal pixels as the same confidence as one holding a high pixel.
       */
      (ARRAY['LOW','NOMINAL','HIGH'])[
        max(array_position(ARRAY['LOW','NOMINAL','HIGH'], d.confidence_class))
      ] AS max_confidence,
      array_agg(DISTINCT d.product_id ORDER BY d.product_id) AS product_ids
    FROM target t
    JOIN lineage l ON l.target_id = t.id
    JOIN geonerva.fire_detections d ON d.cluster_id = l.cluster_id
    WHERE d.cluster_assigned_at IS NOT NULL
      AND d.cluster_assigned_at <= ${asOf}
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) throw new Error(`cluster ${clusterId}: stats returned no row`);
  return {
    nTotal: Number(row.n_total),
    n24h: Number(row.n_24h),
    overpasses24h: Number(row.overpasses_24h),
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    frpSum24h: row.frp_sum_24h,
    frpMax: row.frp_max,
    maxConfidence: (row.max_confidence as ConfidenceClass | null) ?? null,
    productIds: row.product_ids ?? [],
  };
}

/** Records a day on which FIRMS reported no satellite data, so trends can exclude it. */
export async function recordMissingDataDay(db: Db, productId: number, day: Date): Promise<void> {
  await sql`
    INSERT INTO geonerva.fire_missing_data_days (product_id, day)
    VALUES (${productId}, ${day.toISOString().slice(0, 10)}::date)
    ON CONFLICT (product_id, day) DO NOTHING
  `.execute(db);
}
