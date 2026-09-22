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

import { sql, type Kysely, type RawBuilder } from 'kysely';

import {
  aggregateSourceHealth,
  deriveSourceHealth,
  freshnessPolicySchema,
  type ErrorClass,
  type RunTrigger,
  type FreshnessPolicy,
  type IngestionRunFact,
  type LatLon,
  type BoundingBox,
  type RunStatus,
  type SourceHealth,
} from '@geonerva/domain';

import type { DB } from './generated/database.ts';
import { splitViewport } from './spatial/viewport.ts';

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
  /** Restrict to these source records — the members of a known set of canonical events. */
  readonly sourceRecordIds?: readonly string[];
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
  //
  // `= ANY(ARRAY(...))` rather than `IN (...)`, and the difference is measured, not stylistic. The
  // planner estimates a geography `ST_DWithin` at one row whatever the radius, so with `IN` it chose
  // a nested-loop semi-join that rescanned the materialized candidates once per version: on the
  // benchmark dataset (scripts/bench-api.ts) the earthquake read for a 7-day briefing's earlier
  // snapshot took 1,275 ms, 14M comparisons for 3,065 candidates. `ARRAY(...)` is an InitPlan —
  // computed once, then an index condition on `source_record_id` — and the same read takes 14 ms.
  // The semantics are identical because `source_record_id` is NOT NULL.
  const candidateFilter =
    options.near === undefined
      ? sql`TRUE`
      : sql`v.source_record_id = ANY(ARRAY(
            SELECT c.source_record_id
            FROM geonerva.observation_versions c
            WHERE c.ingested_at <= ${options.asOf}
              AND ST_DWithin(
                    c.centroid,
                    ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography,
                    ${options.near.radiusM})
          ))`;

  const hazardFilter =
    options.hazardTypes === undefined
      ? sql`TRUE`
      : sql`r.hazard_type = ANY(${sql.val(options.hazardTypes)}::text[])`;
  const sourceFilter =
    options.sourceIds === undefined
      ? sql`TRUE`
      : sql`r.source_id = ANY(${sql.val(options.sourceIds)}::text[])`;
  const recordFilter =
    options.sourceRecordIds === undefined
      ? sql`TRUE`
      : sql`v.source_record_id = ANY(${sql.val(options.sourceRecordIds)}::bigint[])`;

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
        AND ${recordFilter}
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
    options.observedSince === undefined
      ? sql`TRUE`
      : sql`v.observed_at >= ${options.observedSince}`;
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
  /** Distance to the centroid, when the query supplied a point. */
  readonly distance_m?: number | null;
  /**
   * Distance to the cluster's **area** — its buffered hull, or its centroid when it has none —
   * when the query supplied a point. Every detection pixel lies inside the buffered hull, so this
   * is never larger than the distance to the nearest detection: the safe bound for relevance.
   */
  readonly area_distance_m?: number | null;
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
  /*
   * Selected by the cluster's **area**, not its centroid. A family radius is a question about the
   * nearest detection (§9.2), and a large cluster can reach well inside the radius while its
   * centroid sits outside it.
   */
  const radiusFilter =
    options.near === undefined
      ? sql`TRUE`
      : sql`ST_DWithin(COALESCE(latest.hull, latest.centroid), ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography, ${options.near.radiusM})`;
  const distanceExpression =
    options.near === undefined
      ? sql`NULL::double precision`
      : sql`ST_Distance(latest.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography)::double precision`;
  const areaDistanceExpression =
    options.near === undefined
      ? sql`NULL::double precision`
      : sql`ST_Distance(COALESCE(latest.hull, latest.centroid), ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography)::double precision`;

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
           ${distanceExpression} AS distance_m,
           ${areaDistanceExpression} AS area_distance_m
    FROM latest
    JOIN geonerva.fire_clusters c ON c.id = latest.cluster_id
    WHERE (c.merged_at IS NULL OR c.merged_at > ${options.asOf})
      AND ${radiusFilter}
    ORDER BY latest.last_detected_at DESC, latest.id DESC
    LIMIT ${options.limit ?? 500}
  `.execute(db);
  return [...result.rows];
}

export interface ClusterNearestDetectionRow {
  readonly cluster_id: string;
  /** How many members the reconstruction found. Trust `nearest_m` only if this is the version's `n_total`. */
  readonly count: number;
  readonly nearest_m: number | null;
}

/**
 * For each cluster, the members reconstructed as known at its summary version's `as_of`, and the
 * distance from a point to the nearest of them — batched, one query for a whole card.
 *
 * The reconstruction and its caveat are `reconstructClusterDetections`': membership is written in
 * place (ADR-039), so the caller must compare `count` with the version's `n_total` and use
 * `nearest_m` only when they agree. `first_detected_at` bounds the scan to the partitions the
 * cluster can have members in.
 */
export async function nearestClusterDetections(
  db: Kysely<DB>,
  options: {
    readonly clusters: readonly {
      readonly clusterId: string;
      readonly knownAt: Date;
      readonly firstDetectedAt: Date;
      readonly lastDetectedAt: Date;
    }[];
    readonly point: LatLon;
  },
): Promise<ClusterNearestDetectionRow[]> {
  if (options.clusters.length === 0) return [];
  const result = await sql<ClusterNearestDetectionRow>`
    WITH wanted AS (
      SELECT *
      FROM unnest(
        ${sql.val(options.clusters.map((entry) => entry.clusterId))}::uuid[],
        ${sql.val(options.clusters.map((entry) => entry.knownAt))}::timestamptz[],
        ${sql.val(options.clusters.map((entry) => entry.firstDetectedAt))}::timestamptz[],
        ${sql.val(options.clusters.map((entry) => entry.lastDetectedAt))}::timestamptz[]
      ) AS w(cluster_id, known_at, first_detected_at, last_detected_at)
    )
    SELECT w.cluster_id::text AS cluster_id,
           count(d.id)::integer AS count,
           min(ST_Distance(d.geog, ST_SetSRID(ST_MakePoint(${options.point.lon}, ${options.point.lat}), 4326)::geography))::double precision
             AS nearest_m
    FROM wanted w
    LEFT JOIN geonerva.fire_detections d
      ON d.cluster_id = w.cluster_id
     AND d.ingested_at <= w.known_at
     AND d.acquired_at >= w.first_detected_at
     AND d.acquired_at <= w.last_detected_at
    GROUP BY w.cluster_id
    ORDER BY w.cluster_id
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
      : sql`ST_DWithin(COALESCE(v.hull, v.centroid), ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography, ${options.near.radiusM})`;
  const distanceExpression =
    options.near === undefined
      ? sql`NULL::double precision`
      : sql`ST_Distance(v.centroid, ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography)::double precision`;
  const areaDistanceExpression =
    options.near === undefined
      ? sql`NULL::double precision`
      : sql`ST_Distance(COALESCE(v.hull, v.centroid), ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography)::double precision`;

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
           ${distanceExpression} AS distance_m,
           ${areaDistanceExpression} AS area_distance_m
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

/**
 * The `ST_MakeEnvelope` tests for a viewport, split at the antimeridian and OR-ed together.
 *
 * Planar on purpose. A viewport is a rectangle in longitude and latitude, and the geometry cast of
 * a geography point is exactly its `(lon, lat)` — so this is the exact test, not an approximation.
 * The geography `&&` operator would **not** be: it compares geocentric boxes, and the geodesic
 * edges of an envelope cast to geography bow towards the pole, so it misses points just inside
 * the rectangle's equatorward edge. It cannot even serve as a candidate pre-filter for that
 * reason.
 */
function viewportTest(expression: RawBuilder<unknown>, bbox: BoundingBox): RawBuilder<boolean> {
  const tests = splitViewport(bbox).map(
    (envelope) =>
      sql<boolean>`${expression} && ST_MakeEnvelope(${envelope.west}, ${envelope.south}, ${envelope.east}, ${envelope.north}, 4326)`,
  );
  return sql<boolean>`(${sql.join(tests, sql` OR `)})`;
}

/**
 * Separates the windowed `total` column from the rows that carried it.
 *
 * Every row of a `count(*) OVER ()` result carries the same total, and an empty result carries
 * none — which is a total of zero, not an unknown one: no row qualified.
 */
function splitTotal<Row, Result>(
  rows: readonly (Row & { readonly total: number })[],
  build: (rows: Row[], total: number) => Result,
): Result {
  const stripped = rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    Reflect.deleteProperty(copy, 'total');
    return copy as Row;
  });
  return build(stripped, rows[0]?.total ?? 0);
}

export interface ViewportEventRow {
  readonly canonical_event_id: string;
  readonly public_id: string;
  /** The newest `observed_at` among the event's members that are inside the viewport. */
  readonly newest_observed_at: Date;
}

export interface CanonicalEventsInViewportOptions {
  readonly asOf: Date;
  /** Any rectangle; one crossing the antimeridian (`west > east`) is split into two. */
  readonly bbox: BoundingBox;
  /**
   * The record-level hazard types to read, each with its own recency window — ADR-037 gives the
   * families different windows, and one query with one exact total needs them all at once. The
   * window is applied to the latest version, as `observationsAsOf` applies `observedSince`.
   */
  readonly windows: readonly { readonly hazardType: string; readonly observedSince: Date }[];
  readonly limit: number;
}

/**
 * The canonical events with at least one member inside a viewport, as known at `asOf`, and how
 * many there are in total.
 *
 * ### Why an event rather than a record, and why "at least one member"
 *
 * A map feature is a *subject*, the same one a briefing card lists — so this reads canonical
 * events through their links, and a record with no active link is not a feature, exactly as it is
 * not a card item (see `buildSnapshot`). An event is in the viewport when **any** of its members'
 * latest version is: that membership test is expressible in SQL, so the total below is exact, and
 * it is stable under panning — an event whose members straddle the viewport's edge appears in
 * both viewports rather than in neither.
 *
 * ### Why the total is counted here
 *
 * `MapFeaturesResponse` refines `truncated` to mean exactly `total > features.length`. A total
 * that stopped counting at the query's `LIMIT` would be a floor presented as a total, and the
 * refinement would then let a truncated map claim it was complete. `count(*) OVER ()` is
 * evaluated before `LIMIT`, so it counts every qualifying event, not every returned one.
 *
 * ### Replay
 *
 * Every predicate is the one `observationsAsOf` and `linksAsOf` apply, at the same `asOf`: the
 * latest version by `ingested_at`, the record-merge rule, tombstones, the link window
 * `linked_at <= T < unlinked_at`, and the event-merge rule. The spatial and recency predicates
 * narrow **candidates** through versions — a superset, because the qualifying latest version is
 * itself a witness — and are then re-applied to the latest version, so an epicentre revised out of
 * the viewport leaves it at the knowledge time of the revision and not before.
 */
export async function canonicalEventsInViewportAsOf(
  db: Kysely<DB>,
  options: CanonicalEventsInViewportOptions,
): Promise<{ readonly events: ViewportEventRow[]; readonly total: number }> {
  if (options.windows.length === 0) return { events: [], total: 0 };
  const hazardTypes = options.windows.map((window) => window.hazardType);
  const sinces = options.windows.map((window) => window.observedSince);
  // The widest window, for candidate narrowing only; each type's own window is applied below.
  const earliestSince = new Date(Math.min(...sinces.map((since) => since.getTime())));

  const result = await sql<ViewportEventRow & { total: number }>`
    WITH windows AS (
      SELECT w.hazard_type, w.observed_since
      FROM unnest(${sql.val(hazardTypes)}::text[], ${sql.val(sinces)}::timestamptz[])
           AS w(hazard_type, observed_since)
    ),
    candidates AS (
      SELECT DISTINCT c.source_record_id
      FROM geonerva.observation_versions c
      WHERE c.ingested_at <= ${options.asOf}
        AND c.observed_at >= ${earliestSince}
        AND ${viewportTest(sql`c.centroid::geometry`, options.bbox)}
    ),
    latest AS (
      SELECT DISTINCT ON (v.source_record_id)
             v.source_record_id,
             v.observed_at,
             v.lifecycle_status,
             v.centroid,
             r.merged_at,
             windows.observed_since
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      JOIN windows ON windows.hazard_type = r.hazard_type
      WHERE v.ingested_at <= ${options.asOf}
        AND v.source_record_id IN (SELECT source_record_id FROM candidates)
      ORDER BY v.source_record_id, v.ingested_at DESC, v.version_seq DESC
    ),
    visible AS (
      SELECT latest.source_record_id, latest.observed_at
      FROM latest
      WHERE (latest.merged_at IS NULL OR latest.merged_at > ${options.asOf})
        AND latest.lifecycle_status <> ALL(${sql.val(TOMBSTONE_STATUSES)}::text[])
        AND latest.observed_at >= latest.observed_since
        AND ${viewportTest(sql`latest.centroid::geometry`, options.bbox)}
    ),
    events AS (
      SELECT l.canonical_event_id,
             e.public_id,
             max(visible.observed_at) AS newest_observed_at
      FROM visible
      JOIN geonerva.canonical_links l ON l.source_record_id = visible.source_record_id
      JOIN geonerva.canonical_events e ON e.id = l.canonical_event_id
      WHERE l.linked_at <= ${options.asOf}
        AND (l.unlinked_at IS NULL OR l.unlinked_at > ${options.asOf})
        AND (e.merged_at IS NULL OR e.merged_at > ${options.asOf})
      GROUP BY l.canonical_event_id, e.public_id
    )
    SELECT canonical_event_id::text AS canonical_event_id,
           public_id,
           newest_observed_at,
           (count(*) OVER ())::integer AS total
    FROM events
    ORDER BY newest_observed_at DESC, public_id ASC
    LIMIT ${options.limit}
  `.execute(db);

  return splitTotal(result.rows, (rows, total) => ({ events: rows, total }));
}

export interface ClustersInViewportOptions {
  readonly asOf: Date;
  readonly bbox: BoundingBox;
  /** Applied to the latest version's `last_detected_at`. */
  readonly lastDetectedSince: Date;
  readonly limit: number;
}

/**
 * The latest version of every fire cluster whose **centroid** is inside a viewport, as known at
 * `asOf`, and how many there are in total.
 *
 * The centroid is what the map draws at low zoom (ARCHITECTURE §7.5: "fire cluster centroids"), so
 * it is what decides membership. As in `clusterVersionsAsOf`, the knowledge time is the version's
 * `as_of` — cluster versions are derived, not ingested — and a cluster merged at or before `asOf`
 * is gone. The total is counted before `LIMIT`, for the reason given on
 * `canonicalEventsInViewportAsOf`.
 *
 * The cluster's `status` column is **not** read. It is updated in place as a cluster cools, so at
 * a past knowledge time it would report the present; the caller derives the state from
 * `last_detected_at` and `asOf`, which is what `buildSnapshot` already does.
 */
export async function clustersInViewportAsOf(
  db: Kysely<DB>,
  options: ClustersInViewportOptions,
): Promise<{ readonly clusters: ClusterVersionRow[]; readonly total: number }> {
  const result = await sql<ClusterVersionRow & { total: number }>`
    WITH latest AS (
      SELECT DISTINCT ON (v.cluster_id)
             v.id, v.cluster_id, v.as_of, v.n_total, v.n_24h, v.overpasses_24h,
             v.first_detected_at, v.last_detected_at, v.frp_sum_24h, v.frp_max,
             v.max_confidence, v.product_ids, v.hull, v.centroid
      FROM geonerva.fire_cluster_versions v
      WHERE v.as_of <= ${options.asOf}
        AND v.cluster_id IN (
              SELECT c.cluster_id
              FROM geonerva.fire_cluster_versions c
              WHERE c.as_of <= ${options.asOf}
                AND c.last_detected_at >= ${options.lastDetectedSince}
                AND ${viewportTest(sql`c.centroid::geometry`, options.bbox)}
            )
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
           NULL::double precision AS distance_m,
           (count(*) OVER ())::integer AS total
    FROM latest
    JOIN geonerva.fire_clusters c ON c.id = latest.cluster_id
    WHERE (c.merged_at IS NULL OR c.merged_at > ${options.asOf})
      AND latest.last_detected_at >= ${options.lastDetectedSince}
      AND ${viewportTest(sql`latest.centroid::geometry`, options.bbox)}
    ORDER BY latest.last_detected_at DESC, c.public_id ASC
    LIMIT ${options.limit}
  `.execute(db);

  return splitTotal(result.rows, (rows, total) => ({ clusters: rows, total }));
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
  readonly trigger: string;
}

/** Health of one source or product, plus which product it describes. */
export interface SourceHealthAsOf extends SourceHealth {
  readonly productCode: string | null;
}

function policyOf(raw: unknown, fallback?: FreshnessPolicy): FreshnessPolicy {
  if (raw !== null && typeof raw === 'object' && 'freshness' in raw) {
    const parsed = freshnessPolicySchema.safeParse(raw.freshness);
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
           r.committed_at, r.newest_observed_at, r.error_class, r.trigger
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
      trigger: row.trigger as RunTrigger,
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

/** The state of one derivation kind at a knowledge time. */
export interface DerivationStatusAsOf {
  readonly kind: string;
  readonly locationKey: string | null;
  /** The most recent run of any outcome that had finished by `asOf`. */
  readonly latestFinishedAt: Date | null;
  readonly latestStatus: string | null;
  readonly latestEngineVersion: string | null;
  /**
   * The most recent **`SUCCEEDED`** run that had finished by `asOf`.
   *
   * `PARTIAL` deliberately does not count. A partial derivation produced *some* results, and
   * nothing in the row says which — so it cannot be assumed to cover the location being asked
   * about. Falling back to the last complete run reports a family as behind rather than current,
   * which is the direction that fails loudly. A system that only ever manages `PARTIAL` therefore
   * reports its derivations as un-run, and that is the intended noise.
   */
  readonly lastSucceededAt: Date | null;
  readonly lastSucceededEngineVersion: string | null;
}

/**
 * Derivation state at `asOf` — the fourth as-of reader, alongside observations, links and health.
 *
 * **A derivation's knowledge time is `finished_at`, not `started_at`.** A run in flight has
 * produced nothing a reader can see, and a replay at a `T` inside that run must not credit it
 * with results that did not exist yet. `RUNNING` rows are therefore invisible here by
 * construction, not by a status filter: `finished_at IS NULL` makes `finished_at <= asOf`
 * evaluate to NULL, which `WHERE` discards. An explicit `finished_at IS NOT NULL` stood here
 * until a mutation control showed that removing it changed no test — it could not, because the
 * comparison already does the work — and a predicate no test can distinguish is worse
 * documentation than this sentence.
 *
 * This exists so that `resolveAvailability` can tell "derived nothing" from "did not derive". No
 * other reader in the system can: an un-run derivation and a quiet world produce byte-identical
 * empty results.
 */
export async function derivationsAsOf(
  db: Kysely<DB>,
  options: {
    readonly asOf: Date;
    readonly kinds?: readonly string[];
    /** `null` selects the global (location-independent) runs, which is the default. */
    readonly locationKey?: string | null;
  },
): Promise<DerivationStatusAsOf[]> {
  const locationKey = options.locationKey ?? null;
  const kindFilter =
    options.kinds === undefined ? sql`TRUE` : sql`kind = ANY(${sql.val(options.kinds)}::text[])`;
  const locationFilter =
    locationKey === null ? sql`location_key IS NULL` : sql`location_key = ${locationKey}`;

  const result = await sql<{
    kind: string;
    latest_finished_at: Date | null;
    latest_status: string | null;
    latest_engine_version: string | null;
    last_succeeded_at: Date | null;
    last_succeeded_engine_version: string | null;
  }>`
    WITH visible AS (
      SELECT kind, finished_at, status, engine_version
      FROM geonerva.analysis_runs
      WHERE finished_at <= ${options.asOf}
        AND ${locationFilter}
        AND ${kindFilter}
    ),
    latest AS (
      SELECT DISTINCT ON (kind) kind, finished_at, status, engine_version
      FROM visible
      ORDER BY kind, finished_at DESC, status
    ),
    succeeded AS (
      SELECT DISTINCT ON (kind) kind, finished_at, engine_version
      FROM visible
      WHERE status = 'SUCCEEDED'
      ORDER BY kind, finished_at DESC
    )
    SELECT l.kind,
           l.finished_at    AS latest_finished_at,
           l.status         AS latest_status,
           l.engine_version AS latest_engine_version,
           s.finished_at    AS last_succeeded_at,
           s.engine_version AS last_succeeded_engine_version
    FROM latest l
    LEFT JOIN succeeded s ON s.kind = l.kind
    ORDER BY l.kind
  `.execute(db);

  return result.rows.map((row) => ({
    kind: row.kind,
    locationKey,
    latestFinishedAt: row.latest_finished_at,
    latestStatus: row.latest_status,
    latestEngineVersion: row.latest_engine_version,
    lastSucceededAt: row.last_succeeded_at,
    lastSucceededEngineVersion: row.last_succeeded_engine_version,
  }));
}

/** One source product, with whether it covers a given point. */
export interface ProductCoverageRow {
  readonly source_id: string;
  readonly source_name: string;
  readonly product_id: number;
  readonly product_code: string;
  readonly hazard_types: readonly string[];
  readonly source_enabled: boolean;
  readonly product_enabled: boolean;
  readonly product_status: string;
  readonly active_from: Date | null;
  readonly active_to: Date | null;
  /** `true` when the source's coverage polygon contains the point, or coverage is global. */
  readonly covers_point: boolean;
  readonly coverage_note: string | null;
}

/**
 * Which products could tell GeoNerva about a given place.
 *
 * Coverage is a property of the **source set**, not of the data: ECCC is Canada-only and no
 * amount of healthy polling makes it report a warning for Marrakech. `sources.coverage` is a
 * polygon and `NULL` means global, so the point test is the whole question — and it is answered
 * here, in the one package allowed to hold SQL, rather than by a hard-coded list of source ids.
 *
 * **A stated limitation.** Source configuration is not versioned, so this reflects the
 * configuration as it stands now, not as it stood at `asOf`. A replay from before a source was
 * added will therefore describe that family using today's source set. The alternative — a
 * bitemporal configuration table — is a real design, and it is not one this phase invented
 * quietly; `activeFrom`/`activeTo` are returned so a caller can at least see a product that was
 * not yet operating.
 */
export async function productCoverageFor(
  db: Kysely<DB>,
  point: LatLon,
): Promise<ProductCoverageRow[]> {
  const result = await sql<ProductCoverageRow>`
    SELECT s.id                AS source_id,
           s.name              AS source_name,
           p.id                AS product_id,
           p.code              AS product_code,
           p.hazard_types      AS hazard_types,
           s.enabled           AS source_enabled,
           p.enabled           AS product_enabled,
           p.status            AS product_status,
           p.active_from,
           p.active_to,
           (s.coverage IS NULL OR ST_Intersects(
              s.coverage,
              ST_SetSRID(ST_MakePoint(${point.lon}, ${point.lat}), 4326)::geography))
                               AS covers_point,
           s.coverage_note
    FROM geonerva.sources s
    JOIN geonerva.source_products p ON p.source_id = s.id
    ORDER BY s.id, p.id
  `.execute(db);
  return [...result.rows];
}

/**
 * The newest fire detection visible at `asOf`, by ingestion time, within a radius.
 *
 * This is the input the **clustering** derivation reads. Without it the fire card's derivation
 * axis is measured against GDACS wildfire *events* — a different provider, a different table, and
 * usually empty — so the axis cannot fire, and a place with 235,707 unclustered detections
 * reports "no fire activity to report". The whole point of the axis is that GeoNerva's own
 * pipeline failing must be visible, and it can only be visible against the right input.
 */
export async function newestDetectionIngestAt(
  db: Kysely<DB>,
  options: { readonly asOf: Date; readonly near: { point: LatLon; radiusM: number } },
): Promise<Date | null> {
  const result = await sql<{ newest: Date | null }>`
    SELECT max(d.ingested_at) AS newest
    FROM geonerva.fire_detections d
    WHERE d.ingested_at <= ${options.asOf}
      AND ST_DWithin(
            d.geog,
            ST_SetSRID(ST_MakePoint(${options.near.point.lon}, ${options.near.point.lat}), 4326)::geography,
            ${options.near.radiusM})
  `.execute(db);
  return result.rows[0]?.newest ?? null;
}

/** One manifest row, before it becomes an `EvidenceItem`. */
export interface EvidenceRow {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly source_id: string | null;
  readonly product_id: number | null;
  readonly observed_at: Date | null;
  readonly ingested_at: Date;
  readonly url: string | null;
}

/**
 * Resolves evidence IDs into manifest rows (invariant I9).
 *
 * Every ID referenced anywhere in a response must appear in that response's manifest, so this is
 * the function that makes a citation resolvable rather than decorative. It reads the **immutable**
 * rows the IDs point at — an observation version, a correlation link, an ingestion run, a cluster
 * version — none of which can change once written, which is why they can be cited at all.
 *
 * Content-addressed kinds (`BAS`, `REL`, `CHG`) are **not** looked up: their ID *is* the hash of
 * the computation, they are self-contained in the manifest, and there is no row to fetch. The
 * caller supplies those directly.
 *
 * `asOf` bounds every lookup, so a manifest built for a replay cannot resolve an ID to something
 * that did not exist yet. An ID outside the knowledge time comes back missing, which surfaces as a
 * manifest gap rather than as a silent time-travelling citation.
 */
export async function evidenceItemsAsOf(
  db: Kysely<DB>,
  options: { readonly asOf: Date; readonly ids: readonly string[] },
): Promise<EvidenceRow[]> {
  const byKind = new Map<string, string[]>();
  for (const id of options.ids) {
    const parts = id.split(':');
    const kind = parts[1];
    const body = parts[2];
    if (kind === undefined || body === undefined) continue;
    const bucket = byKind.get(kind);
    if (bucket === undefined) byKind.set(kind, [body]);
    else bucket.push(body);
  }

  const rows: EvidenceRow[] = [];

  const observationIds = byKind.get('OBS') ?? [];
  if (observationIds.length > 0) {
    const result = await sql<EvidenceRow>`
      SELECT 'EV:OBS:' || v.id::text AS id,
             'OBS'                   AS kind,
             r.source_id || ' ' || r.primary_key || ' version ' || v.version_seq::text AS summary,
             r.source_id             AS source_id,
             r.product_id            AS product_id,
             v.observed_at           AS observed_at,
             v.ingested_at           AS ingested_at,
             v.source_url            AS url
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE v.id = ANY(${sql.val(observationIds)}::bigint[])
        AND v.ingested_at <= ${options.asOf}
      ORDER BY v.id
    `.execute(db);
    rows.push(...result.rows);
  }

  const linkIds = byKind.get('COR') ?? [];
  if (linkIds.length > 0) {
    const result = await sql<EvidenceRow>`
      SELECT 'EV:COR:' || l.id::text AS id,
             'COR'                   AS kind,
             'correlation ' || l.match_kind || ' ' || l.relation || ' for ' || e.public_id
                                     AS summary,
             r.source_id             AS source_id,
             r.product_id            AS product_id,
             NULL::timestamptz       AS observed_at,
             l.linked_at             AS ingested_at,
             NULL::text              AS url
      FROM geonerva.canonical_links l
      JOIN geonerva.canonical_events e ON e.id = l.canonical_event_id
      JOIN geonerva.source_records r ON r.id = l.source_record_id
      WHERE l.id = ANY(${sql.val(linkIds)}::bigint[])
        AND l.linked_at <= ${options.asOf}
      ORDER BY l.id
    `.execute(db);
    rows.push(...result.rows);
  }

  const runIds = byKind.get('RUN') ?? [];
  if (runIds.length > 0) {
    const result = await sql<EvidenceRow>`
      SELECT 'EV:RUN:' || i.id::text AS id,
             'RUN'                   AS kind,
             i.source_id || ' ingestion run, ' || i.status AS summary,
             i.source_id             AS source_id,
             i.product_id            AS product_id,
             i.newest_observed_at    AS observed_at,
             i.committed_at          AS ingested_at,
             NULL::text              AS url
      FROM geonerva.ingestion_runs i
      WHERE i.id = ANY(${sql.val(runIds)}::uuid[])
        AND i.committed_at IS NOT NULL
        AND i.committed_at <= ${options.asOf}
      ORDER BY i.id
    `.execute(db);
    rows.push(...result.rows);
  }

  const clusterVersionIds = byKind.get('FCV') ?? [];
  if (clusterVersionIds.length > 0) {
    const result = await sql<EvidenceRow>`
      SELECT 'EV:FCV:' || v.id::text AS id,
             'FCV'                   AS kind,
             'fire cluster ' || c.public_id || ' summary, ' || v.n_total::text || ' detections'
                                     AS summary,
             'firms'                 AS source_id,
             NULL::smallint          AS product_id,
             v.last_detected_at      AS observed_at,
             v.as_of                 AS ingested_at,
             NULL::text              AS url
      FROM geonerva.fire_cluster_versions v
      JOIN geonerva.fire_clusters c ON c.id = v.cluster_id
      WHERE v.id = ANY(${sql.val(clusterVersionIds)}::bigint[])
        AND v.as_of <= ${options.asOf}
      ORDER BY v.id
    `.execute(db);
    rows.push(...result.rows);
  }

  return rows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Attribution and licence per source, for the footer and `/methodology`. */
export interface AttributionRow {
  readonly source_id: string;
  readonly name: string;
  readonly homepage: string | null;
  readonly licence: string;
  readonly attribution_text: string;
  readonly terms_url: string | null;
  readonly disclaimer: string | null;
}

/**
 * Attribution for the given sources.
 *
 * Not optional and not summarizable: several providers' terms require the attribution text and
 * the disclaimer verbatim, which is why both are columns rather than something the UI composes.
 */
export async function attributionsFor(
  db: Kysely<DB>,
  sourceIds: readonly string[],
): Promise<AttributionRow[]> {
  if (sourceIds.length === 0) return [];
  const result = await sql<AttributionRow>`
    SELECT id AS source_id, name, homepage, licence, attribution_text, terms_url, disclaimer
    FROM geonerva.sources
    WHERE id = ANY(${sql.val(sourceIds)}::text[])
    ORDER BY id
  `.execute(db);
  return [...result.rows];
}

/** One committed run, shaped for `RunSummaryView`. */
export interface RunSummaryRow {
  readonly id: string;
  readonly source_id: string;
  readonly product_id: number | null;
  readonly trigger: string;
  readonly status: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly committed_at: Date;
  readonly n_received: number;
  readonly n_new_records: number;
  readonly n_new_versions: number;
  readonly n_unchanged: number;
  readonly n_rejected: number;
  readonly newest_observed_at: Date | null;
  readonly error_class: string | null;
}

/**
 * The most recent committed runs per source, as known at `asOf`.
 *
 * **Committed only.** `committed_at` is the timestamp replay filters on, so a run still in flight
 * is invisible here by construction — `NULL <= asOf` is never true. That is the honest answer: a
 * `RUNNING` run has produced no knowledge yet, and showing it would let the data-status page
 * report activity whose results no reader can see.
 *
 * Bounded by `perSource` **per source, in the index**, through a lateral join. The first version
 * used `row_number() OVER (PARTITION BY source_id …)` with the rank filtered above the window,
 * which reads and sorts the *entire* committed run history on every call: `EXPLAIN` showed
 * `WindowAgg (Run Condition: row_number() <= 10)` sitting on a full `Sort` over a `Seq Scan`,
 * because a run condition prunes output rows rather than input. At eight products polled every
 * 5–15 minutes that is ~100k rows a year, on the cheapest request in the API. The lateral form
 * keeps the one round trip and makes the work proportional to `sources × perSource` instead of to
 * how long the deployment has been running.
 *
 * `error_message` is deliberately **not** selected. It is sanitized and capped at write time, but
 * `RunSummaryView` has no field for it and a public endpoint is the wrong place to serve provider
 * error text; an operator reads it from the database.
 */
export async function runSummariesAsOf(
  db: Kysely<DB>,
  options: { readonly asOf: Date; readonly perSource?: number },
): Promise<RunSummaryRow[]> {
  const perSource = Math.max(1, Math.min(options.perSource ?? 10, 50));
  const result = await sql<RunSummaryRow>`
    SELECT recent.id,
           s.id              AS source_id,
           recent.product_id,
           recent.trigger,
           recent.status,
           recent.started_at,
           recent.finished_at,
           recent.committed_at,
           recent.n_received,
           recent.n_new_records,
           recent.n_new_versions,
           recent.n_unchanged,
           recent.n_rejected,
           recent.newest_observed_at,
           recent.error_class
    FROM geonerva.sources s
    CROSS JOIN LATERAL (
      SELECT r.id::text AS id, r.product_id, r.trigger, r.status, r.started_at, r.finished_at,
             r.committed_at, r.n_received, r.n_new_records, r.n_new_versions, r.n_unchanged,
             r.n_rejected, r.newest_observed_at, r.error_class
      FROM geonerva.ingestion_runs r
      WHERE r.source_id = s.id
        AND r.committed_at IS NOT NULL
        AND r.committed_at <= ${options.asOf}
      ORDER BY r.committed_at DESC, r.id DESC
      LIMIT ${perSource}
    ) recent
    ORDER BY s.id, recent.committed_at DESC, recent.id DESC
  `.execute(db);
  return [...result.rows];
}

/** Committed runs per source in the 24 hours before `asOf`, and how many of them succeeded. */
export interface RunTallyRow {
  readonly source_id: string;
  readonly total: number;
  readonly succeeded: number;
}

/**
 * The 24-hour success tally, so that `successRate24h` can be read honestly.
 *
 * The denominator travels with the rate. "100 % successful" from one run is a different statement
 * from the same figure over two hundred, which is why `SourceStatusEntry` carries `runCount24h`
 * beside the rate: a proportion without its sample size reassures without informing.
 *
 * `PARTIAL` is **not** counted as a success. A run that committed some records and rejected others
 * did not do its job, and folding it into the success rate would hide exactly the slow degradation
 * the data-status page exists to show.
 */
export async function runTally24hAsOf(db: Kysely<DB>, asOf: Date): Promise<RunTallyRow[]> {
  const since = new Date(asOf.getTime() - 24 * 60 * 60 * 1000);
  const result = await sql<RunTallyRow>`
    SELECT r.source_id,
           count(*)::int                                      AS total,
           count(*) FILTER (WHERE r.status = 'SUCCEEDED')::int AS succeeded
    FROM geonerva.ingestion_runs r
    WHERE r.committed_at IS NOT NULL
      AND r.committed_at <= ${asOf}
      AND r.committed_at >= ${since}
    GROUP BY r.source_id
    ORDER BY r.source_id
  `.execute(db);
  return [...result.rows];
}

/** The ingestion worker heartbeat row. */
export interface WorkerHeartbeatRow {
  readonly last_seen_at: Date;
  readonly version: string | null;
}

/**
 * The worker heartbeat, if it was already in the past at `asOf`.
 *
 * ### This one read is not replayable, and says so
 *
 * `worker_heartbeat` is a **single row updated in place** every minute (migration 0002): there is
 * no history, so what the heartbeat said at a past `asOf` is not recoverable. The filter here is
 * therefore the only honest one available — a heartbeat stamped after `asOf` is future knowledge
 * and is withheld — but the consequence is that a replay returns `null`, which the read model can
 * only render as "GeoNerva cannot state the worker liveness at this knowledge time".
 *
 * That is a deliberate asymmetry with every other read in this file, and it is acceptable because
 * worker liveness is an operational signal about GeoNerva rather than a fact about a hazard. It is
 * never allowed to influence hazard availability: a source is `UNAVAILABLE` because its own runs
 * say so (ADR-022), not because this row is missing.
 */
export async function workerHeartbeatAsOf(
  db: Kysely<DB>,
  asOf: Date,
): Promise<WorkerHeartbeatRow | null> {
  /*
   * A skew allowance, because the two timestamps come from different clocks.
   *
   * `last_seen_at` is stamped by the **database** and `asOf` for a live request is the **web**
   * process's `new Date()`. If the database clock leads the web clock at all — routine between a
   * serverless function and a managed Postgres — then for a window equal to the skew after each
   * minute's heartbeat write, a strict `<=` reports `worker: null` on a perfectly healthy system,
   * and the read model can only render that as "the worker has never reported in". The same
   * happens when the heartbeat is written *during* a slow request.
   *
   * The allowance is the same five seconds `parseAsOf` uses for the same reason, and it cannot
   * leak meaningful future knowledge: the heartbeat is one row saying the worker was alive, and
   * five seconds of it is not a fact about a hazard.
   */
  const bound = new Date(asOf.getTime() + HEARTBEAT_CLOCK_SKEW_MS);
  const result = await sql<WorkerHeartbeatRow>`
    SELECT last_seen_at, version
    FROM geonerva.worker_heartbeat
    WHERE last_seen_at <= ${bound}
    ORDER BY last_seen_at DESC
    LIMIT 1
  `.execute(db);
  return result.rows[0] ?? null;
}

/** Matches `AS_OF_FUTURE_TOLERANCE_MS` in the API layer, for the same clock-skew reason. */
const HEARTBEAT_CLOCK_SKEW_MS = 5_000;

/** One provider, as the data-status page describes it. */
export interface SourceRow {
  readonly source_id: string;
  readonly name: string;
  readonly homepage: string | null;
  readonly licence: string;
  readonly attribution_text: string;
  readonly terms_url: string | null;
  readonly disclaimer: string | null;
  readonly coverage_note: string | null;
  /** True when the source carries a coverage polygon; `false` means global coverage. */
  readonly coverage_geometry_available: boolean;
  readonly enabled: boolean;
}

/** One feed or sensor belonging to a source. */
export interface SourceProductRow {
  readonly product_id: number;
  readonly source_id: string;
  readonly code: string;
  readonly hazard_types: readonly string[];
  readonly capabilities: readonly string[];
  readonly platform: string | null;
  readonly instrument: string | null;
  readonly resolution_m: number | null;
  readonly status: string;
  readonly active_from: string | null;
  readonly active_to: string | null;
  readonly enabled: boolean;
}

/**
 * The source and product catalogue.
 *
 * **Not parameterized by `asOf`, and named so that it does not pretend to be.** `sources` and
 * `source_products` are reference data updated in place by migrations and by configuration
 * changes; they are not versioned, so there is no past state to read. Taking an `asOf` argument
 * that every row satisfied would be a worse lie than leaving it out.
 *
 * The practical consequence is narrow: a replay describes today's *catalogue* — a retired sensor
 * shows as retired even when replaying a time it was active — while every *fact*, every health
 * judgement and every run the same response reports is bounded by the knowledge time.
 *
 * The coverage polygon is reported only as present-or-absent. It is never rendered by this
 * endpoint, and shipping it would make a cached response tens of kilobytes for no reader.
 */
export async function sourceCatalog(db: Kysely<DB>): Promise<{
  readonly sources: readonly SourceRow[];
  readonly products: readonly SourceProductRow[];
}> {
  const sourceResult = await sql<SourceRow>`
    SELECT s.id                     AS source_id,
           s.name,
           s.homepage,
           s.licence,
           s.attribution_text,
           s.terms_url,
           s.disclaimer,
           s.coverage_note,
           (s.coverage IS NOT NULL) AS coverage_geometry_available,
           s.enabled
    FROM geonerva.sources s
    ORDER BY s.id
  `.execute(db);

  const productResult = await sql<SourceProductRow>`
    SELECT p.id                 AS product_id,
           p.source_id,
           p.code,
           p.hazard_types,
           p.capabilities,
           p.platform,
           p.instrument,
           p.resolution_m,
           p.status,
           p.active_from::text  AS active_from,
           p.active_to::text    AS active_to,
           p.enabled
    FROM geonerva.source_products p
    ORDER BY p.source_id, p.id
  `.execute(db);

  return { sources: [...sourceResult.rows], products: [...productResult.rows] };
}

/*
 * ── Evidence detail (`GET /api/v1/evidence/{id}`) ───────────────────────────────
 *
 * One function per primary kind, each returning the row the frozen `EvidenceDetail` payload needs.
 * They are separate rather than one polymorphic query because the four kinds share no columns:
 * an observation version, a cluster summary, an ingestion run and a correlation link are four
 * different tables with four different knowledge-time columns (`ingested_at`, `as_of`,
 * `committed_at`, `linked_at`), and the whole point of this file is that each one is filtered on
 * the column that actually participates in replay.
 *
 * **None of them reads a raw payload body.** Migration 0007 revokes `SELECT` on
 * `raw_source_records` from `geonerva_web`, and migration 0016 (ADR-038) grants back exactly the
 * metadata columns — digest, pruned, captured, first seen. The observation read names only those
 * columns; `payload` is unreachable from the web role, so a later `SELECT *` fails at the database
 * rather than in review.
 */

/** `EV:OBS:<id>` — one immutable observation version. */
export interface ObservationEvidenceRow {
  readonly version_id: string;
  readonly version_seq: number;
  readonly source_id: string;
  readonly product_id: number | null;
  readonly primary_key: string;
  readonly hazard_type: string;
  readonly lifecycle_status: string;
  readonly observed_at: Date;
  readonly valid_from: Date | null;
  readonly valid_to: Date | null;
  readonly source_updated_at: Date | null;
  readonly ingested_at: Date;
  readonly contributor: string | null;
  readonly content_sha256: string;
  readonly source_url: string | null;
  /** Whether the version references a raw payload row at all. */
  readonly raw_record_present: boolean;
  /**
   * The referenced row's metadata, or `null` when it cannot be read — no row, or one the serving
   * role cannot see. Never the body (ADR-038).
   */
  readonly raw_payload_sha256: string | null;
  readonly raw_payload_pruned: boolean | null;
  readonly raw_payload_captured: boolean | null;
  readonly raw_first_seen_at: Date | null;
}

/**
 * One observation version, if GeoNerva knew it at `asOf`.
 *
 * The merge filter that every other read in this file applies is **absent here on purpose**. A
 * merged record's versions survive the merge (§4.6) and an evidence ID that was cited in an older
 * response must keep resolving, or the citation rots — which is the one thing an append-only
 * store is supposed to prevent. Whether the *record* is still separately listed is a question for
 * `observationsAsOf`; whether this *version* existed is a question about one immutable row.
 */
export async function observationEvidenceAsOf(
  db: Kysely<DB>,
  options: { readonly asOf: Date; readonly versionId: string },
): Promise<ObservationEvidenceRow | null> {
  const result = await sql<ObservationEvidenceRow>`
    SELECT v.id::text                       AS version_id,
           v.version_seq,
           r.source_id,
           r.product_id,
           r.primary_key,
           v.hazard_type,
           v.lifecycle_status,
           v.observed_at,
           v.valid_from,
           v.valid_to,
           v.source_updated_at,
           v.ingested_at,
           v.contributor,
           encode(v.content_sha256, 'hex')  AS content_sha256,
           v.source_url,
           (v.raw_record_id IS NOT NULL)    AS raw_record_present,
           encode(w.payload_sha256, 'hex')  AS raw_payload_sha256,
           w.payload_pruned                 AS raw_payload_pruned,
           w.payload_captured               AS raw_payload_captured,
           w.first_seen_at                  AS raw_first_seen_at
    FROM geonerva.observation_versions v
    JOIN geonerva.source_records r ON r.id = v.source_record_id
    LEFT JOIN geonerva.raw_source_records w ON w.id = v.raw_record_id
    WHERE v.id = ${options.versionId}::bigint
      AND v.ingested_at <= ${options.asOf}
  `.execute(db);
  return result.rows[0] ?? null;
}

/** `EV:FCV:<id>` — one fire-cluster summary version. */
export interface ClusterEvidenceRow {
  readonly cluster_version_id: string;
  readonly cluster_public_id: string;
  readonly as_of: Date;
  readonly n_total: number;
  readonly n_24h: number;
  readonly overpasses_24h: number;
  readonly first_detected_at: Date;
  readonly last_detected_at: Date;
  readonly frp_sum_24h: number | null;
  readonly frp_max: number | null;
  readonly max_confidence: string | null;
  readonly product_ids: readonly number[];
  readonly content_sha256: string;
}

/** One cluster summary version, if it had been computed by `asOf`. */
export async function clusterEvidenceAsOf(
  db: Kysely<DB>,
  options: { readonly asOf: Date; readonly clusterVersionId: string },
): Promise<ClusterEvidenceRow | null> {
  const result = await sql<ClusterEvidenceRow>`
    SELECT v.id::text                       AS cluster_version_id,
           c.public_id                      AS cluster_public_id,
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
           encode(v.content_sha256, 'hex')  AS content_sha256
    FROM geonerva.fire_cluster_versions v
    JOIN geonerva.fire_clusters c ON c.id = v.cluster_id
    WHERE v.id = ${options.clusterVersionId}::bigint
      AND v.as_of <= ${options.asOf}
  `.execute(db);
  return result.rows[0] ?? null;
}

/** `EV:RUN:<uuid>` — one ingestion run, the evidence behind every health statement. */
export interface RunEvidenceRow {
  readonly run_id: string;
  readonly source_id: string;
  readonly product_id: number | null;
  readonly trigger: string;
  readonly status: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly committed_at: Date | null;
  readonly http_status: number | null;
  readonly bytes_received: number | null;
  readonly n_received: number;
  readonly n_new_records: number;
  readonly n_new_versions: number;
  readonly n_unchanged: number;
  readonly n_rejected: number;
  readonly newest_observed_at: Date | null;
  readonly error_class: string | null;
  /** Bounded to 1 KB at write time. **Not redacted** — see `runEvidenceAsOf`. */
  readonly error_message: string | null;
  readonly payload_sha256: string | null;
  readonly worker_version: string | null;
}

/**
 * One ingestion run, if it had committed by `asOf`.
 *
 * `error_message` is selected and the API serves `null` for it. The reason is worth recording,
 * because the first version of this comment justified publishing it and the justification was
 * wrong.
 *
 * `sanitizeDetail` collapses whitespace and caps the value at 1,000 bytes. **It redacts nothing.**
 * What reaches the column includes `SourceFetchError.describe()`, which carries the provider's
 * host and path, and Zod issue text from a normalization failure, which quotes provider payload
 * values. Two real controls exist — `describeDatabaseFailure` keeps driver messages out, and the
 * FIRMS adapter scrubs `MAP_KEY` — but neither makes the column safe for an anonymous reader, and
 * "every path passes through `sanitizeDetail`" describes a length cap, not a redaction.
 *
 * `EvidenceDetail.errorMessage` is `string | null`, so serving `null` satisfies the contract while
 * the contract's own promise — "never a raw provider body and never a connection string" — remains
 * a property of the *writer* that nothing currently enforces. The column stays in this row so an
 * operator reading the database sees what it holds.
 */
export async function runEvidenceAsOf(
  db: Kysely<DB>,
  options: { readonly asOf: Date; readonly runId: string },
): Promise<RunEvidenceRow | null> {
  const result = await sql<RunEvidenceRow>`
    SELECT i.id::text  AS run_id,
           i.source_id,
           i.product_id,
           i.trigger,
           i.status,
           i.started_at,
           i.finished_at,
           i.committed_at,
           i.http_status,
           i.bytes_received,
           i.n_received,
           i.n_new_records,
           i.n_new_versions,
           i.n_unchanged,
           i.n_rejected,
           i.newest_observed_at,
           i.error_class,
           i.error_message,
           i.payload_sha256,
           i.worker_version
    FROM geonerva.ingestion_runs i
    WHERE i.id = ${options.runId}::uuid
      AND i.committed_at IS NOT NULL
      AND i.committed_at <= ${options.asOf}
  `.execute(db);
  return result.rows[0] ?? null;
}

/** `EV:COR:<id>` — one correlation decision. */
export interface CorrelationEvidenceRow {
  readonly link_id: string;
  readonly canonical_event_public_id: string;
  readonly source_record_primary_key: string;
  readonly source_id: string;
  readonly relation: string;
  readonly match_kind: string;
  readonly confidence: string | null;
  readonly reasons: unknown;
  readonly algorithm_version: string;
  readonly linked_at: Date;
  readonly unlinked_at: Date | null;
  readonly unlink_reason: string | null;
}

/**
 * One correlation link, if it had been made by `asOf`.
 *
 * `unlinked_at` is returned **unfiltered**, and that is the interesting part. A link that was
 * later closed is still a real decision that was cited while it was open, so the evidence resolves
 * — but the response says when it was closed and why. Filtering closed links out would make a
 * citation in an old response un-resolvable; filtering the `unlinked_at` *value* out would make a
 * withdrawn decision look current. Neither is the truth, and the truth here is cheap.
 *
 * The one thing that is filtered is future knowledge: an `unlinked_at` after `asOf` is reported as
 * `null`, because at that knowledge time the link was still open.
 */
export async function correlationEvidenceAsOf(
  db: Kysely<DB>,
  options: { readonly asOf: Date; readonly linkId: string },
): Promise<CorrelationEvidenceRow | null> {
  const result = await sql<CorrelationEvidenceRow>`
    SELECT l.id::text            AS link_id,
           e.public_id           AS canonical_event_public_id,
           r.primary_key         AS source_record_primary_key,
           r.source_id,
           l.relation,
           l.match_kind,
           l.confidence::text    AS confidence,
           l.reasons,
           l.algorithm_version,
           l.linked_at,
           CASE WHEN l.unlinked_at <= ${options.asOf} THEN l.unlinked_at END AS unlinked_at,
           CASE WHEN l.unlinked_at <= ${options.asOf} THEN l.unlink_reason END AS unlink_reason
    FROM geonerva.canonical_links l
    JOIN geonerva.canonical_events e ON e.id = l.canonical_event_id
    JOIN geonerva.source_records r ON r.id = l.source_record_id
    WHERE l.id = ${options.linkId}::bigint
      AND l.linked_at <= ${options.asOf}
  `.execute(db);
  return result.rows[0] ?? null;
}

/*
 * The detail reads live in their own module because the file was already long. They are part of
 * this layer and reach callers only through this entry point, like everything above.
 */
export * from './asof-detail.ts';
export * from './asof-history.ts';
