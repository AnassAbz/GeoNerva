/**
 * The as-of read layer — **the only way to read facts** (ADR-003, docs/ARCHITECTURE.md §5).
 *
 * Every read is parameterized by a knowledge time `asOf`, and the rule is absolute:
 *
 * > The view of the world as of `T` contains exactly the versions with `ingested_at <= T`, and
 * > for each record only the latest such version. Nothing else.
 *
 * That is invariant **I2** ("replay never sees the future"), and it is property-tested against
 * *every* function exported here. Three consequences shape the SQL below:
 *
 *  1. **A merge is knowledge too.** A record merged into another at time `M` is still a separate
 *     record for any `T < M`. The filter is therefore `merged_at IS NULL OR merged_at > T`, not
 *     `merged_at IS NULL`.
 *  2. **Filters apply to the latest version, not to any version.** An event whose epicentre was
 *     revised out of the search radius must disappear from the radius at `T`, and one revised
 *     into it must appear. So the spatial predicate narrows *candidates* through the GiST index,
 *     and is then re-applied to the latest version — never only as a pre-filter.
 *  3. **Derived artifacts carry `as_of`, not `ingested_at`.** Cluster versions and links are
 *     computed, not ingested, so their knowledge time is the one that participates in replay.
 *
 * The "now" fast path reads the `*_heads` caches instead of scanning versions. Both paths are
 * asserted to return identical rows by an integration test, which is the only thing that makes
 * the cache safe to trust.
 */

import { sql, type Kysely } from 'kysely';

import {
  aggregateSourceHealth,
  deriveSourceHealth,
  freshnessPolicySchema,
  type ErrorClass,
  type FreshnessPolicy,
  type IngestionRunFact,
  type LatLon,
  type RunStatus,
  type SourceHealth,
} from '@geonerva/domain';

import type { DB } from './generated/database.ts';

/** A row from the as-of observation view. Ids are decimal strings (see `DatabaseId`). */
export interface ObservationRow {
  readonly version_id: string;
  readonly source_record_id: string;
  readonly source_id: string;
  readonly product_id: number | null;
  readonly primary_key: string;
  readonly version_seq: number;
  readonly hazard_type: string;
  readonly ingested_at: Date;
  readonly observed_at: Date;
  readonly valid_from: Date | null;
  readonly valid_to: Date | null;
  readonly source_updated_at: Date | null;
  readonly lifecycle_status: string;
  readonly severity_scheme: string | null;
  readonly severity_value: string | null;
  readonly provider_status: string | null;
  readonly contributor: string | null;
  readonly magnitude: string | null;
  readonly magnitude_type: string | null;
  readonly depth_km: string | null;
  readonly geometry_kind: string;
  readonly title: string | null;
  readonly source_url: string | null;
  readonly attributes: unknown;
  readonly derived_from: unknown;
  readonly lat: number;
  readonly lon: number;
  /** Present only when the query supplied a point. */
  readonly distance_m?: number | null;
}

export interface ObservationsAsOfOptions {
  /** Knowledge time. Every returned version has `ingested_at <= asOf`. */
  readonly asOf: Date;
  readonly hazardTypes?: readonly string[];
  readonly sourceIds?: readonly string[];
  /** Restrict to a radius around a point, measured on the spheroid. */
  readonly near?: { readonly point: LatLon; readonly radiusM: number };
  /** Drop versions whose `observed_at` is older than this. Applied to the latest version. */
  readonly observedSince?: Date;
  /** Exclude tombstones (`DELETED`, `MISSING_FROM_SOURCE`). Default `true`. */
  readonly excludeTombstones?: boolean;
  readonly limit?: number;
  /** Order by distance from `near.point` instead of by `observed_at`. */
  readonly orderByDistance?: boolean;
}

const TOMBSTONE_STATUSES = ['DELETED', 'MISSING_FROM_SOURCE'];

/**
 * The latest version of every source record, as known at `asOf`.
 *
 * `DISTINCT ON (source_record_id) … ORDER BY source_record_id, ingested_at DESC, version_seq DESC`
 * is the whole trick: it picks one row per record, and the tiebreak on `version_seq` makes the
 * result deterministic when a batch commits several versions of one record at the same
 * `ingested_at` — which is exactly what a backfill does.
 */
export async function observationsAsOf(
  db: Kysely<DB>,
  options: ObservationsAsOfOptions,
): Promise<ObservationRow[]> {
  const excludeTombstones = options.excludeTombstones ?? true;

  // Candidate narrowing. The spatial predicate here only reduces the set of *records* to look at,
  // using the GiST index; the authoritative test is re-applied to the latest version below.
  const candidateFilter =
    options.near === undefined
      ? sql`TRUE`
      : sql`v.source_record_id IN (
            SELECT c.source_record_id
            FROM geonerva.observation_versions c
            WHERE c.ingested_at <= ${options.asOf}
              AND ST_DWithin(
                    c.centroid,
                    ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography,
                    ${options.near.radiusM})
          )`;

  const hazardFilter =
    options.hazardTypes === undefined
      ? sql`TRUE`
      : sql`r.hazard_type = ANY(${sql.val(options.hazardTypes)}::text[])`;
  const sourceFilter =
    options.sourceIds === undefined
      ? sql`TRUE`
      : sql`r.source_id = ANY(${sql.val(options.sourceIds)}::text[])`;

  const distanceExpression =
    options.near === undefined
      ? sql`NULL::double precision`
      : sql`ST_Distance(latest.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography)::double precision`;

  const radiusFilter =
    options.near === undefined
      ? sql`TRUE`
      : sql`ST_DWithin(latest.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography, ${options.near.radiusM})`;

  const tombstoneFilter = excludeTombstones
    ? sql`latest.lifecycle_status <> ALL(${sql.val(TOMBSTONE_STATUSES)}::text[])`
    : sql`TRUE`;

  const observedSinceFilter =
    options.observedSince === undefined
      ? sql`TRUE`
      : sql`latest.observed_at >= ${options.observedSince}`;

  const ordering =
    options.orderByDistance === true && options.near !== undefined
      ? sql`distance_m ASC NULLS LAST, latest.observed_at DESC`
      : sql`latest.observed_at DESC, latest.version_id DESC`;

  const result = await sql<ObservationRow>`
    WITH latest AS (
      SELECT DISTINCT ON (v.source_record_id)
             v.id AS version_id,
             v.source_record_id,
             v.version_seq,
             v.hazard_type,
             v.ingested_at,
             v.observed_at,
             v.valid_from,
             v.valid_to,
             v.source_updated_at,
             v.lifecycle_status,
             v.severity_scheme,
             v.severity_value,
             v.provider_status,
             v.contributor,
             v.magnitude,
             v.magnitude_type,
             v.depth_km,
             v.geometry_kind,
             v.title,
             v.source_url,
             v.attributes,
             v.derived_from,
             v.centroid,
             r.source_id,
             r.product_id,
             r.primary_key,
             r.merged_at
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE v.ingested_at <= ${options.asOf}
        AND ${hazardFilter}
        AND ${sourceFilter}
        AND ${candidateFilter}
      ORDER BY v.source_record_id, v.ingested_at DESC, v.version_seq DESC
    )
    SELECT latest.version_id::text        AS version_id,
           latest.source_record_id::text  AS source_record_id,
           latest.source_id,
           latest.product_id,
           latest.primary_key,
           latest.version_seq,
           latest.hazard_type,
           latest.ingested_at,
           latest.observed_at,
           latest.valid_from,
           latest.valid_to,
           latest.source_updated_at,
           latest.lifecycle_status,
           latest.severity_scheme,
           latest.severity_value,
           latest.provider_status,
           latest.contributor,
           latest.magnitude,
           latest.magnitude_type,
           latest.depth_km,
           latest.geometry_kind,
           latest.title,
           latest.source_url,
           latest.attributes,
           latest.derived_from,
           ST_Y(latest.centroid::geometry) AS lat,
           ST_X(latest.centroid::geometry) AS lon,
           ${distanceExpression} AS distance_m
    FROM latest
    WHERE (latest.merged_at IS NULL OR latest.merged_at > ${options.asOf})
      AND ${tombstoneFilter}
      AND ${observedSinceFilter}
      AND ${radiusFilter}
    ORDER BY ${ordering}
    LIMIT ${options.limit ?? 500}
  `.execute(db);

  return [...result.rows];
}

/**
 * The "now" fast path: the same result set, read from `source_record_heads` instead of scanning
 * versions. An integration test asserts that this and `observationsAsOf(now)` agree exactly,
 * which is the only reason the cache may be trusted (docs/ARCHITECTURE.md §5).
 */
export async function observationsNow(
  db: Kysely<DB>,
  options: Omit<ObservationsAsOfOptions, 'asOf'>,
): Promise<ObservationRow[]> {
  const excludeTombstones = options.excludeTombstones ?? true;

  const hazardFilter =
    options.hazardTypes === undefined
      ? sql`TRUE`
      : sql`r.hazard_type = ANY(${sql.val(options.hazardTypes)}::text[])`;
  const sourceFilter =
    options.sourceIds === undefined
      ? sql`TRUE`
      : sql`r.source_id = ANY(${sql.val(options.sourceIds)}::text[])`;
  const radiusFilter =
    options.near === undefined
      ? sql`TRUE`
      : sql`ST_DWithin(v.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography, ${options.near.radiusM})`;
  const distanceExpression =
    options.near === undefined
      ? sql`NULL::double precision`
      : sql`ST_Distance(v.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography)::double precision`;
  const tombstoneFilter = excludeTombstones
    ? sql`v.lifecycle_status <> ALL(${sql.val(TOMBSTONE_STATUSES)}::text[])`
    : sql`TRUE`;
  const observedSinceFilter =
    options.observedSince === undefined ? sql`TRUE` : sql`v.observed_at >= ${options.observedSince}`;
  const ordering =
    options.orderByDistance === true && options.near !== undefined
      ? sql`distance_m ASC NULLS LAST, v.observed_at DESC`
      : sql`v.observed_at DESC, v.id DESC`;

  const result = await sql<ObservationRow>`
    SELECT v.id::text               AS version_id,
           v.source_record_id::text AS source_record_id,
           r.source_id,
           r.product_id,
           r.primary_key,
           v.version_seq,
           v.hazard_type,
           v.ingested_at,
           v.observed_at,
           v.valid_from,
           v.valid_to,
           v.source_updated_at,
           v.lifecycle_status,
           v.severity_scheme,
           v.severity_value,
           v.provider_status,
           v.contributor,
           v.magnitude,
           v.magnitude_type,
           v.depth_km,
           v.geometry_kind,
           v.title,
           v.source_url,
           v.attributes,
           v.derived_from,
           ST_Y(v.centroid::geometry) AS lat,
           ST_X(v.centroid::geometry) AS lon,
           ${distanceExpression} AS distance_m
    FROM geonerva.source_record_heads h
    JOIN geonerva.observation_versions v ON v.id = h.latest_version_id
    JOIN geonerva.source_records r ON r.id = h.source_record_id
    WHERE r.merged_at IS NULL
      AND ${hazardFilter}
      AND ${sourceFilter}
      AND ${tombstoneFilter}
      AND ${observedSinceFilter}
      AND ${radiusFilter}
    ORDER BY ${ordering}
    LIMIT ${options.limit ?? 500}
  `.execute(db);

  return [...result.rows];
}

export interface LinkRow {
  readonly link_id: string;
  readonly canonical_event_id: string;
  readonly canonical_public_id: string;
  readonly source_record_id: string;
  readonly relation: string;
  readonly match_kind: string;
  readonly confidence: string | null;
  readonly reasons: unknown;
  readonly algorithm_version: string;
  readonly linked_at: Date;
  readonly unlinked_at: Date | null;
}

/**
 * Canonical links active at `asOf`: `linked_at <= T < coalesce(unlinked_at, ∞)`.
 *
 * Links are closed and reopened rather than mutated, so a replay sees the correlation GeoNerva
 * actually believed at `T`, including a split that was later undone.
 */
export async function linksAsOf(
  db: Kysely<DB>,
  options: {
    readonly asOf: Date;
    readonly canonicalEventIds?: readonly string[];
    readonly sourceRecordIds?: readonly string[];
    readonly limit?: number;
  },
): Promise<LinkRow[]> {
  const eventFilter =
    options.canonicalEventIds === undefined
      ? sql`TRUE`
      : sql`l.canonical_event_id = ANY(${sql.val(options.canonicalEventIds)}::uuid[])`;
  const recordFilter =
    options.sourceRecordIds === undefined
      ? sql`TRUE`
      : sql`l.source_record_id = ANY(${sql.val(options.sourceRecordIds)}::bigint[])`;

  const result = await sql<LinkRow>`
    SELECT l.id::text                 AS link_id,
           l.canonical_event_id::text AS canonical_event_id,
           e.public_id                AS canonical_public_id,
           l.source_record_id::text   AS source_record_id,
           l.relation,
           l.match_kind,
           l.confidence,
           l.reasons,
           l.algorithm_version,
           l.linked_at,
           l.unlinked_at
    FROM geonerva.canonical_links l
    JOIN geonerva.canonical_events e ON e.id = l.canonical_event_id
    WHERE l.linked_at <= ${options.asOf}
      AND (l.unlinked_at IS NULL OR l.unlinked_at > ${options.asOf})
      AND (e.merged_at IS NULL OR e.merged_at > ${options.asOf})
      AND ${eventFilter}
      AND ${recordFilter}
    ORDER BY l.canonical_event_id, l.linked_at, l.id
    LIMIT ${options.limit ?? 1000}
  `.execute(db);
  return [...result.rows];
}

export interface ClusterVersionRow {
  readonly cluster_version_id: string;
  readonly cluster_id: string;
  readonly public_id: string;
  readonly as_of: Date;
  readonly n_total: number;
  readonly n_24h: number;
  readonly overpasses_24h: number;
  readonly first_detected_at: Date;
  readonly last_detected_at: Date;
  readonly frp_sum_24h: number | null;
  readonly frp_max: number | null;
  readonly max_confidence: string | null;
  readonly product_ids: number[];
  readonly centroid_lat: number;
  readonly centroid_lon: number;
  readonly hull_geojson: string | null;
  readonly distance_m?: number | null;
}

/**
 * The latest cluster summary per cluster, as known at `asOf`.
 *
 * Cluster versions carry `as_of` rather than `ingested_at` because they are derived: `as_of` is
 * the knowledge time the clustering run was computed for, and it is what replay filters on
 * (DOMAIN_MODEL §2).
 */
export async function clusterVersionsAsOf(
  db: Kysely<DB>,
  options: {
    readonly asOf: Date;
    readonly clusterIds?: readonly string[];
    readonly near?: { readonly point: LatLon; readonly radiusM: number };
    readonly limit?: number;
  },
): Promise<ClusterVersionRow[]> {
  const clusterFilter =
    options.clusterIds === undefined
      ? sql`TRUE`
      : sql`v.cluster_id = ANY(${sql.val(options.clusterIds)}::uuid[])`;
  const radiusFilter =
    options.near === undefined
      ? sql`TRUE`
      : sql`ST_DWithin(latest.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography, ${options.near.radiusM})`;
  const distanceExpression =
    options.near === undefined
      ? sql`NULL::double precision`
      : sql`ST_Distance(latest.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography)::double precision`;

  const result = await sql<ClusterVersionRow>`
    WITH latest AS (
      SELECT DISTINCT ON (v.cluster_id)
             v.id, v.cluster_id, v.as_of, v.n_total, v.n_24h, v.overpasses_24h,
             v.first_detected_at, v.last_detected_at, v.frp_sum_24h, v.frp_max,
             v.max_confidence, v.product_ids, v.hull, v.centroid
      FROM geonerva.fire_cluster_versions v
      WHERE v.as_of <= ${options.asOf}
        AND ${clusterFilter}
      ORDER BY v.cluster_id, v.as_of DESC, v.id DESC
    )
    SELECT latest.id::text         AS cluster_version_id,
           latest.cluster_id::text AS cluster_id,
           c.public_id,
           latest.as_of,
           latest.n_total,
           latest.n_24h,
           latest.overpasses_24h,
           latest.first_detected_at,
           latest.last_detected_at,
           latest.frp_sum_24h,
           latest.frp_max,
           latest.max_confidence,
           latest.product_ids,
           ST_Y(latest.centroid::geometry) AS centroid_lat,
           ST_X(latest.centroid::geometry) AS centroid_lon,
           ST_AsGeoJSON(latest.hull::geometry, 6) AS hull_geojson,
           ${distanceExpression} AS distance_m
    FROM latest
    JOIN geonerva.fire_clusters c ON c.id = latest.cluster_id
    WHERE (c.merged_at IS NULL OR c.merged_at > ${options.asOf})
      AND ${radiusFilter}
    ORDER BY latest.last_detected_at DESC, latest.id DESC
    LIMIT ${options.limit ?? 500}
  `.execute(db);
  return [...result.rows];
}

/** The "now" fast path for clusters, reading `fire_cluster_heads`. */
export async function clusterVersionsNow(
  db: Kysely<DB>,
  options: {
    readonly clusterIds?: readonly string[];
    readonly near?: { readonly point: LatLon; readonly radiusM: number };
    readonly limit?: number;
  } = {},
): Promise<ClusterVersionRow[]> {
  const clusterFilter =
    options.clusterIds === undefined
      ? sql`TRUE`
      : sql`h.cluster_id = ANY(${sql.val(options.clusterIds)}::uuid[])`;
  const radiusFilter =
    options.near === undefined
      ? sql`TRUE`
      : sql`ST_DWithin(v.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography, ${options.near.radiusM})`;
  const distanceExpression =
    options.near === undefined
      ? sql`NULL::double precision`
      : sql`ST_Distance(v.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography)::double precision`;

  const result = await sql<ClusterVersionRow>`
    SELECT v.id::text         AS cluster_version_id,
           v.cluster_id::text AS cluster_id,
           c.public_id,
           v.as_of,
           v.n_total,
           v.n_24h,
           v.overpasses_24h,
           v.first_detected_at,
           v.last_detected_at,
           v.frp_sum_24h,
           v.frp_max,
           v.max_confidence,
           v.product_ids,
           ST_Y(v.centroid::geometry) AS centroid_lat,
           ST_X(v.centroid::geometry) AS centroid_lon,
           ST_AsGeoJSON(v.hull::geometry, 6) AS hull_geojson,
           ${distanceExpression} AS distance_m
    FROM geonerva.fire_cluster_heads h
    JOIN geonerva.fire_cluster_versions v ON v.id = h.latest_version_id
    JOIN geonerva.fire_clusters c ON c.id = h.cluster_id
    WHERE c.merged_at IS NULL
      AND ${clusterFilter}
      AND ${radiusFilter}
    ORDER BY v.last_detected_at DESC, v.id DESC
    LIMIT ${options.limit ?? 500}
  `.execute(db);
  return [...result.rows];
}

interface SourcePolicyRow {
  readonly source_id: string;
  readonly product_id: number | null;
  readonly product_code: string | null;
  readonly source_enabled: boolean;
  readonly product_enabled: boolean | null;
  readonly product_status: string | null;
  readonly source_policy: unknown;
  readonly product_policy: unknown;
}

interface RunRow {
  readonly id: string;
  readonly source_id: string;
  readonly product_id: number | null;
  readonly status: string;
  readonly started_at: Date;
  readonly committed_at: Date | null;
  readonly newest_observed_at: Date | null;
  readonly error_class: string | null;
}

/** Health of one source or product, plus which product it describes. */
export interface SourceHealthAsOf extends SourceHealth {
  readonly productCode: string | null;
}

function policyOf(raw: unknown, fallback?: FreshnessPolicy): FreshnessPolicy {
  if (raw !== null && typeof raw === 'object' && 'freshness' in raw) {
    const parsed = freshnessPolicySchema.safeParse((raw as { freshness: unknown }).freshness);
    if (parsed.success) return parsed.data;
  }
  if (fallback !== undefined) return fallback;
  throw new Error('source policy is missing or invalid; migrations seed a valid policy');
}

/**
 * Source health at a knowledge time (ADR-022).
 *
 * The database's only job here is to hand the pure derivation its inputs: the committed runs at
 * or before `asOf`, and the policy. All of the judgement lives in `packages/domain`, which is why
 * the same states can be unit-tested with a fake clock and no database at all.
 */
export async function healthAsOf(
  db: Kysely<DB>,
  options: {
    readonly asOf: Date;
    readonly sourceIds?: readonly string[];
    /** How far back to read run history. Older runs cannot change the answer. */
    readonly lookbackMs?: number;
  },
): Promise<{
  readonly bySource: readonly SourceHealth[];
  readonly byProduct: readonly SourceHealthAsOf[];
}> {
  const since = new Date(options.asOf.getTime() - (options.lookbackMs ?? 7 * 24 * 60 * 60 * 1000));
  const sourceFilter =
    options.sourceIds === undefined
      ? sql`TRUE`
      : sql`s.id = ANY(${sql.val(options.sourceIds)}::text[])`;

  const policyResult = await sql<SourcePolicyRow>`
    SELECT s.id              AS source_id,
           p.id              AS product_id,
           p.code            AS product_code,
           s.enabled         AS source_enabled,
           p.enabled         AS product_enabled,
           p.status          AS product_status,
           s.policy          AS source_policy,
           p.policy          AS product_policy
    FROM geonerva.sources s
    LEFT JOIN geonerva.source_products p ON p.source_id = s.id
    WHERE ${sourceFilter}
    ORDER BY s.id, p.id
  `.execute(db);

  const runResult = await sql<RunRow>`
    SELECT r.id::text AS id, r.source_id, r.product_id, r.status, r.started_at,
           r.committed_at, r.newest_observed_at, r.error_class
    FROM geonerva.ingestion_runs r
    JOIN geonerva.sources s ON s.id = r.source_id
    WHERE r.committed_at IS NOT NULL
      AND r.committed_at <= ${options.asOf}
      AND r.committed_at >= ${since}
      AND ${sourceFilter}
    ORDER BY r.committed_at
  `.execute(db);

  const runsByProduct = new Map<string, IngestionRunFact[]>();
  for (const row of runResult.rows) {
    const key = `${row.source_id}\u0000${row.product_id ?? ''}`;
    const fact: IngestionRunFact = {
      id: row.id,
      status: row.status as RunStatus,
      startedAt: row.started_at,
      committedAt: row.committed_at,
      newestObservedAt: row.newest_observed_at,
      errorClass: row.error_class as ErrorClass | null,
    };
    const existing = runsByProduct.get(key);
    if (existing === undefined) runsByProduct.set(key, [fact]);
    else existing.push(fact);
  }

  const byProduct: SourceHealthAsOf[] = [];
  const sourcePolicies = new Map<string, FreshnessPolicy>();
  const sourceEnabled = new Map<string, boolean>();
  const productsBySource = new Map<string, SourceHealth[]>();

  for (const row of policyResult.rows) {
    const sourcePolicy = policyOf(row.source_policy);
    sourcePolicies.set(row.source_id, sourcePolicy);
    sourceEnabled.set(row.source_id, row.source_enabled);

    if (row.product_id === null) continue;

    const policy = policyOf(row.product_policy, sourcePolicy);
    const enabled =
      row.source_enabled && row.product_enabled !== false && row.product_status !== 'RETIRED';
    const health = deriveSourceHealth({
      sourceId: row.source_id,
      productId: row.product_id,
      enabled,
      policy,
      runs: runsByProduct.get(`${row.source_id}\u0000${String(row.product_id)}`) ?? [],
      asOf: options.asOf,
    });
    byProduct.push({ ...health, productCode: row.product_code });

    const siblings = productsBySource.get(row.source_id);
    if (siblings === undefined) productsBySource.set(row.source_id, [health]);
    else siblings.push(health);
  }

  const bySource: SourceHealth[] = [];
  for (const [sourceId, policy] of sourcePolicies) {
    const products = productsBySource.get(sourceId) ?? [];
    if (products.length > 0) {
      bySource.push(aggregateSourceHealth(sourceId, policy, products, options.asOf));
      continue;
    }
    // A source with no products (or with all of them filtered out) is judged on its own runs.
    bySource.push(
      deriveSourceHealth({
        sourceId,
        productId: null,
        enabled: sourceEnabled.get(sourceId) ?? false,
        policy,
        runs: runsByProduct.get(`${sourceId}\u0000`) ?? [],
        asOf: options.asOf,
      }),
    );
  }

  return { bySource, byProduct };
}

/**
 * The last run committed at or before `asOf`, per source: the response's data cutoff, which the
 * read models expose as `asOfContext.sourceCutoffs`.
 */
export async function sourceCutoffsAsOf(
  db: Kysely<DB>,
  asOf: Date,
): Promise<Record<string, Date | null>> {
  const result = await sql<{ source_id: string; committed_at: Date | null }>`
    SELECT s.id AS source_id,
           (SELECT max(r.committed_at)
            FROM geonerva.ingestion_runs r
            WHERE r.source_id = s.id
              AND r.committed_at IS NOT NULL
              AND r.committed_at <= ${asOf}) AS committed_at
    FROM geonerva.sources s
    ORDER BY s.id
  `.execute(db);

  const cutoffs: Record<string, Date | null> = {};
  for (const row of result.rows) cutoffs[row.source_id] = row.committed_at;
  return cutoffs;
}
