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
    const result = await sql<{ id: string }>`
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
 * Assigns detections to a cluster.
 *
 * A detection's cluster is assigned once and never reassigned; when two clusters turn out to be
 * connected, the *clusters* merge and the merge is recorded on the cluster row. That keeps
 * membership immutable and makes the history of an area of thermal activity readable.
 */
export async function assignDetectionsToCluster(
  db: Db,
  clusterId: string,
  detectionIds: readonly string[],
): Promise<number> {
  if (detectionIds.length === 0) return 0;
  const result = await sql`
    UPDATE geonerva.fire_detections
    SET cluster_id = ${clusterId}::uuid
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
 * history is the longer one. Detections are re-pointed — the one case where a detection's
 * `cluster_id` changes — and the absorbed clusters keep their rows and versions so that a replay
 * before the merge still shows two separate areas of activity.
 */
export async function mergeClusters(
  trx: Transaction<DB>,
  survivorId: string,
  absorbedIds: readonly string[],
  mergedAt: Date,
): Promise<number> {
  if (absorbedIds.length === 0) return 0;

  await sql`
    UPDATE geonerva.fire_clusters
    SET status = 'MERGED', merged_into = ${survivorId}::uuid, merged_at = ${mergedAt}
    WHERE id = ANY(${sql.val(absorbedIds)}::uuid[]) AND id <> ${survivorId}::uuid
  `.execute(trx);

  const moved = await sql`
    UPDATE geonerva.fire_detections
    SET cluster_id = ${survivorId}::uuid
    WHERE cluster_id = ANY(${sql.val(absorbedIds)}::uuid[])
  `.execute(trx);

  await sql`
    UPDATE geonerva.fire_cluster_heads SET status = 'MERGED'
    WHERE cluster_id = ANY(${sql.val(absorbedIds)}::uuid[])
  `.execute(trx);

  return Number(moved.numAffectedRows ?? 0n);
}

/** Records a day on which FIRMS reported no satellite data, so trends can exclude it. */
export async function recordMissingDataDay(db: Db, productId: number, day: Date): Promise<void> {
  await sql`
    INSERT INTO geonerva.fire_missing_data_days (product_id, day)
    VALUES (${productId}, ${day.toISOString().slice(0, 10)}::date)
    ON CONFLICT (product_id, day) DO NOTHING
  `.execute(db);
}
