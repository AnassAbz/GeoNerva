/**
 * Detail reads for the as-of layer: one canonical event, one fire cluster (ADR-003, invariant I2).
 *
 * Part of the as-of layer and re-exported through `@geonerva/db/asof`, which remains the only way a
 * reader reaches a fact. It is a separate module only because the detail views need tables the
 * list views never touch — the version history, the correlation decisions including withdrawn
 * ones, the near-misses, the related subjects, the merge redirects — and `asof.ts` was already
 * the longest file in the package.
 *
 * ### Two rules for a column that is closed in place
 *
 * Several of these tables close a row **in place**: `unlinked_at`, `superseded_at`, `ended_at`,
 * `merged_at`. Each read below applies two different rules to such a column. The row is
 * *visible* when it was opened at or before `T`; its closure is *reported* only when the closure,
 * too, happened at or before `T`. A link withdrawn at 14:00 is an open link in a replay at 13:00,
 * not a withdrawn one — reporting its future closure would be the leak invariant I2 forbids.
 */

import { sql, type Kysely } from 'kysely';

import type { LatLon } from '@geonerva/domain';

import type { DB } from './generated/database.ts';
export interface CanonicalEventRow {
  readonly id: string;
  readonly public_id: string;
  readonly hazard_type: string;
  readonly created_at: Date;
  /** The survivor's public id, only once the merge is known at `asOf`. */
  readonly merged_into_public_id: string | null;
  readonly merged_at: Date | null;
}

/**
 * One canonical event by public id, as known at `asOf`.
 *
 * `null` before the event was created: an identity minted at 14:00 did not exist at 13:00, and a
 * replay must answer "not found" rather than show it early. The merge is reported only from the
 * moment it happened, for the reason in the section header.
 */
export async function canonicalEventAsOf(
  db: Kysely<DB>,
  options: { readonly publicId: string; readonly asOf: Date },
): Promise<CanonicalEventRow | null> {
  const result = await sql<CanonicalEventRow>`
    SELECT e.id::text AS id,
           e.public_id,
           e.hazard_type,
           e.created_at,
           CASE WHEN e.merged_at <= ${options.asOf} THEN survivor.public_id END AS merged_into_public_id,
           CASE WHEN e.merged_at <= ${options.asOf} THEN e.merged_at END AS merged_at
    FROM geonerva.canonical_events e
    LEFT JOIN geonerva.canonical_events survivor ON survivor.id = e.merged_into
    WHERE e.public_id = ${options.publicId}
      AND e.created_at <= ${options.asOf}
  `.execute(db);
  return result.rows[0] ?? null;
}

/**
 * Every public id that had been merged into this event by `asOf`, through any number of merges —
 * the ids that now redirect here (`EventDetail.supersededPublicIds`).
 */
export async function supersededEventIdsAsOf(
  db: Kysely<DB>,
  options: { readonly canonicalEventId: string; readonly asOf: Date },
): Promise<string[]> {
  const result = await sql<{ public_id: string }>`
    WITH RECURSIVE absorbed AS (
      SELECT e.id, e.public_id
      FROM geonerva.canonical_events e
      WHERE e.merged_into = ${options.canonicalEventId}::uuid
        AND e.merged_at <= ${options.asOf}
      UNION
      SELECT e.id, e.public_id
      FROM geonerva.canonical_events e
      JOIN absorbed a ON e.merged_into = a.id
      WHERE e.merged_at <= ${options.asOf}
    )
    SELECT public_id FROM absorbed ORDER BY public_id
  `.execute(db);
  return result.rows.map((row) => row.public_id);
}

export interface LinkHistoryRow {
  readonly link_id: string;
  readonly source_record_id: string;
  readonly source_id: string;
  readonly primary_key: string;
  readonly relation: string;
  readonly match_kind: string;
  readonly confidence: string | null;
  readonly reasons: unknown;
  readonly algorithm_version: string;
  readonly linked_at: Date;
  /** Only when the withdrawal is known at `asOf`; a later one is invisible. */
  readonly unlinked_at: Date | null;
  readonly unlink_reason: string | null;
}

/**
 * Every correlation decision about one event made by `asOf`, including the ones later withdrawn —
 * the audit trail `CorrelationView.decisions` shows.
 */
export async function eventLinkHistoryAsOf(
  db: Kysely<DB>,
  options: { readonly canonicalEventId: string; readonly asOf: Date },
): Promise<LinkHistoryRow[]> {
  const result = await sql<LinkHistoryRow>`
    SELECT l.id::text               AS link_id,
           l.source_record_id::text AS source_record_id,
           r.source_id,
           r.primary_key,
           l.relation,
           l.match_kind,
           l.confidence,
           l.reasons,
           l.algorithm_version,
           l.linked_at,
           CASE WHEN l.unlinked_at <= ${options.asOf} THEN l.unlinked_at END AS unlinked_at,
           CASE WHEN l.unlinked_at <= ${options.asOf} THEN l.unlink_reason END AS unlink_reason
    FROM geonerva.canonical_links l
    JOIN geonerva.source_records r ON r.id = l.source_record_id
    WHERE l.canonical_event_id = ${options.canonicalEventId}::uuid
      AND l.linked_at <= ${options.asOf}
    ORDER BY l.linked_at DESC, l.id DESC
  `.execute(db);
  return [...result.rows];
}

export interface VersionHistoryRow {
  readonly version_id: string;
  readonly source_record_id: string;
  readonly source_id: string;
  readonly version_seq: number;
  readonly ingested_at: Date;
  readonly observed_at: Date;
  readonly source_updated_at: Date | null;
  readonly lifecycle_status: string;
  readonly severity_scheme: string | null;
  readonly severity_value: string | null;
  readonly provider_status: string | null;
  readonly magnitude: string | null;
  readonly magnitude_type: string | null;
  readonly depth_km: string | null;
  readonly lat: number;
  readonly lon: number;
}

/**
 * Every version of the given records ingested by `asOf`, newest first — the event timeline.
 *
 * Bounded, because a record revised thousands of times would otherwise make one detail response
 * unbounded; the bound is far above any provider's real revision count.
 */
export async function versionHistoryAsOf(
  db: Kysely<DB>,
  options: {
    readonly sourceRecordIds: readonly string[];
    readonly asOf: Date;
    readonly limit: number;
  },
): Promise<VersionHistoryRow[]> {
  if (options.sourceRecordIds.length === 0) return [];
  const result = await sql<VersionHistoryRow>`
    SELECT v.id::text               AS version_id,
           v.source_record_id::text AS source_record_id,
           r.source_id,
           v.version_seq,
           v.ingested_at,
           v.observed_at,
           v.source_updated_at,
           v.lifecycle_status,
           v.severity_scheme,
           v.severity_value,
           v.provider_status,
           v.magnitude,
           v.magnitude_type,
           v.depth_km,
           ST_Y(v.centroid::geometry) AS lat,
           ST_X(v.centroid::geometry) AS lon
    FROM geonerva.observation_versions v
    JOIN geonerva.source_records r ON r.id = v.source_record_id
    WHERE v.source_record_id = ANY(${sql.val(options.sourceRecordIds)}::bigint[])
      AND v.ingested_at <= ${options.asOf}
    ORDER BY v.ingested_at DESC, v.version_seq DESC, v.id DESC
    LIMIT ${options.limit}
  `.execute(db);
  return [...result.rows];
}

export interface VersionGeometryRow {
  readonly version_id: string;
  readonly role: string;
  readonly seq: number;
  readonly valid_at: Date | null;
  readonly is_forecast: boolean;
  readonly geojson: string;
}

/**
 * The role-tagged geometries of the given versions.
 *
 * A version's geometries are written with the version and never change, so knowing the version
 * at `asOf` is knowing its geometries; the caller passes only versions it read at `asOf`.
 */
export async function geometriesOfVersions(
  db: Kysely<DB>,
  versionIds: readonly string[],
): Promise<VersionGeometryRow[]> {
  if (versionIds.length === 0) return [];
  const result = await sql<VersionGeometryRow>`
    SELECT g.observation_version_id::text AS version_id,
           g.role,
           g.seq,
           g.valid_at,
           g.is_forecast,
           ST_AsGeoJSON(g.geog::geometry, 6) AS geojson
    FROM geonerva.observation_geometries g
    WHERE g.observation_version_id = ANY(${sql.val(versionIds)}::bigint[])
    ORDER BY g.observation_version_id, g.role, g.seq
  `.execute(db);
  return [...result.rows];
}

/** Every alias a provider had used for these records by `asOf`. */
export async function aliasesAsOf(
  db: Kysely<DB>,
  options: { readonly sourceRecordIds: readonly string[]; readonly asOf: Date },
): Promise<{ readonly source_record_id: string; readonly alias: string }[]> {
  if (options.sourceRecordIds.length === 0) return [];
  const result = await sql<{ source_record_id: string; alias: string }>`
    SELECT a.source_record_id::text AS source_record_id, a.alias
    FROM geonerva.source_record_aliases a
    WHERE a.source_record_id = ANY(${sql.val(options.sourceRecordIds)}::bigint[])
      AND a.first_seen_at <= ${options.asOf}
    ORDER BY a.source_record_id, a.alias
  `.execute(db);
  return [...result.rows];
}

export interface PossibleMatchRow {
  readonly other_record_id: string;
  readonly other_source_id: string;
  readonly other_primary_key: string;
  /** The event the other record belonged to at `asOf`, if any. */
  readonly other_public_id: string | null;
  readonly score: string | null;
  readonly reasons: unknown;
  readonly evaluated_at: Date;
}

/**
 * Near-misses: pairs scored close to one of these records but not merged, current at `asOf`
 * (`CorrelationView.possibleMatches`). A pair whose other record is itself a member is not a
 * near-miss — it is the event — and is left out.
 */
export async function possibleMatchesAsOf(
  db: Kysely<DB>,
  options: { readonly sourceRecordIds: readonly string[]; readonly asOf: Date },
): Promise<PossibleMatchRow[]> {
  if (options.sourceRecordIds.length === 0) return [];
  const members = sql.val(options.sourceRecordIds);
  const result = await sql<PossibleMatchRow>`
    WITH pairs AS (
      SELECT CASE WHEN c.record_a = ANY(${members}::bigint[]) THEN c.record_b ELSE c.record_a END
               AS other_record_id,
             c.score, c.reasons, c.evaluated_at
      FROM geonerva.correlation_candidates c
      WHERE (c.record_a = ANY(${members}::bigint[]) OR c.record_b = ANY(${members}::bigint[]))
        AND c.decision = 'POSSIBLE_MATCH'
        AND c.evaluated_at <= ${options.asOf}
        AND (c.superseded_at IS NULL OR c.superseded_at > ${options.asOf})
    )
    SELECT p.other_record_id::text AS other_record_id,
           r.source_id              AS other_source_id,
           r.primary_key            AS other_primary_key,
           (SELECT e.public_id
            FROM geonerva.canonical_links l
            JOIN geonerva.canonical_events e ON e.id = l.canonical_event_id
            WHERE l.source_record_id = p.other_record_id
              AND l.linked_at <= ${options.asOf}
              AND (l.unlinked_at IS NULL OR l.unlinked_at > ${options.asOf})
              AND (e.merged_at IS NULL OR e.merged_at > ${options.asOf})
            ORDER BY l.linked_at DESC
            LIMIT 1) AS other_public_id,
           p.score,
           p.reasons,
           p.evaluated_at
    FROM pairs p
    JOIN geonerva.source_records r ON r.id = p.other_record_id
    WHERE p.other_record_id <> ALL(${members}::bigint[])
    ORDER BY p.evaluated_at DESC, p.other_record_id
  `.execute(db);
  return [...result.rows];
}

export interface RelatedSubjectRow {
  readonly other_ref: string;
  readonly relation: string;
  readonly reasons: unknown;
  /** From the canonical event or cluster the other reference names, when it existed at `asOf`. */
  readonly other_hazard_type: string | null;
}

/**
 * `RELATED` edges touching a subject at `asOf` — open at `T`, whichever direction they were
 * written in. The other end is resolved to a hazard type only when it existed at `T`; an edge to a
 * subject created later is dropped rather than pointing at something a replay cannot show.
 */
export async function relatedSubjectsAsOf(
  db: Kysely<DB>,
  options: { readonly subjectRef: string; readonly asOf: Date },
): Promise<RelatedSubjectRow[]> {
  const result = await sql<RelatedSubjectRow>`
    WITH edges AS (
      SELECT CASE WHEN x.from_ref = ${options.subjectRef} THEN x.to_ref ELSE x.from_ref END
               AS other_ref,
             x.relation, x.reasons, x.id
      FROM geonerva.event_relations x
      WHERE (x.from_ref = ${options.subjectRef} OR x.to_ref = ${options.subjectRef})
        AND x.established_at <= ${options.asOf}
        AND (x.ended_at IS NULL OR x.ended_at > ${options.asOf})
    )
    SELECT edges.other_ref,
           edges.relation,
           edges.reasons,
           CASE
             WHEN edges.other_ref LIKE 'CE:%' THEN ce.hazard_type
             WHEN edges.other_ref LIKE 'FC:%' AND fc.id IS NOT NULL THEN 'THERMAL_ACTIVITY'
           END AS other_hazard_type
    FROM edges
    LEFT JOIN geonerva.canonical_events ce
      ON edges.other_ref = 'CE:' || ce.public_id
     AND ce.created_at <= ${options.asOf}
     AND (ce.merged_at IS NULL OR ce.merged_at > ${options.asOf})
    LEFT JOIN geonerva.fire_clusters fc
      ON edges.other_ref = 'FC:' || fc.public_id
     AND fc.created_at <= ${options.asOf}
     AND (fc.merged_at IS NULL OR fc.merged_at > ${options.asOf})
    ORDER BY edges.other_ref, edges.id
  `.execute(db);
  return result.rows.filter((row) => row.other_hazard_type !== null);
}

export interface FireClusterRow {
  readonly id: string;
  readonly public_id: string;
  readonly created_at: Date;
  /** The survivor's public id, only once the merge is known at `asOf`. */
  readonly merged_into_public_id: string | null;
  readonly merged_at: Date | null;
}

/**
 * One fire cluster by public id, as known at `asOf` — `null` before the cluster was created.
 *
 * `fire_clusters.status` is deliberately not read: it is updated in place as the cluster cools,
 * so at a past knowledge time it would report the present. The caller derives the state from the
 * summary version and `asOf`.
 */
export async function fireClusterAsOf(
  db: Kysely<DB>,
  options: { readonly publicId: string; readonly asOf: Date },
): Promise<FireClusterRow | null> {
  const result = await sql<FireClusterRow>`
    SELECT c.id::text AS id,
           c.public_id,
           c.created_at,
           CASE WHEN c.merged_at <= ${options.asOf} THEN survivor.public_id END AS merged_into_public_id,
           CASE WHEN c.merged_at <= ${options.asOf} THEN c.merged_at END AS merged_at
    FROM geonerva.fire_clusters c
    LEFT JOIN geonerva.fire_clusters survivor ON survivor.id = c.merged_into
    WHERE c.public_id = ${options.publicId}
      AND c.created_at <= ${options.asOf}
  `.execute(db);
  return result.rows[0] ?? null;
}

/** Every cluster merged into this one by `asOf`, through any number of merges. */
export async function mergedFromClustersAsOf(
  db: Kysely<DB>,
  options: { readonly clusterId: string; readonly asOf: Date },
): Promise<string[]> {
  const result = await sql<{ public_id: string }>`
    WITH RECURSIVE absorbed AS (
      SELECT c.id, c.public_id
      FROM geonerva.fire_clusters c
      WHERE c.merged_into = ${options.clusterId}::uuid
        AND c.merged_at <= ${options.asOf}
      UNION
      SELECT c.id, c.public_id
      FROM geonerva.fire_clusters c
      JOIN absorbed a ON c.merged_into = a.id
      WHERE c.merged_at <= ${options.asOf}
    )
    SELECT public_id FROM absorbed ORDER BY public_id
  `.execute(db);
  return result.rows.map((row) => row.public_id);
}

export interface ClusterVersionHistoryRow {
  readonly cluster_version_id: string;
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
  /** Distance from the requested point to the cluster's buffered hull, or its centroid without one. */
  readonly area_distance_m: number | null;
  readonly centroid_distance_m: number | null;
}

/**
 * Every summary version of one cluster computed for a knowledge time at or before `asOf`, newest
 * first — the latest is the cluster *at* `asOf`, and the rest are its history.
 *
 * With a point, each row also carries the distance to the cluster's **area** — its buffered
 * convex hull — and to its centroid. The area distance is what relevance must use when the
 * individual detections are not available: every detection pixel lies inside the buffered hull,
 * so the distance to the hull is never more than the distance to the nearest detection. It errs
 * towards "closer", which is the safe direction for a relevance input; the centroid errs away.
 */
export async function clusterVersionHistoryAsOf(
  db: Kysely<DB>,
  options: {
    readonly clusterId: string;
    readonly asOf: Date;
    readonly limit: number;
    readonly point?: LatLon;
  },
): Promise<ClusterVersionHistoryRow[]> {
  const point =
    options.point === undefined
      ? null
      : sql`ST_SetSRID(ST_MakePoint(${options.point.lon}, ${options.point.lat}), 4326)::geography`;
  const areaDistance =
    point === null
      ? sql`NULL::double precision`
      : sql`ST_Distance(COALESCE(v.hull, v.centroid), ${point})::double precision`;
  const centroidDistance =
    point === null
      ? sql`NULL::double precision`
      : sql`ST_Distance(v.centroid, ${point})::double precision`;

  const result = await sql<ClusterVersionHistoryRow>`
    SELECT v.id::text AS cluster_version_id,
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
           ${areaDistance} AS area_distance_m,
           ${centroidDistance} AS centroid_distance_m
    FROM geonerva.fire_cluster_versions v
    WHERE v.cluster_id = ${options.clusterId}::uuid
      AND v.as_of <= ${options.asOf}
    ORDER BY v.as_of DESC, v.id DESC
    LIMIT ${options.limit}
  `.execute(db);
  return [...result.rows];
}

export interface ClusterDetectionRow {
  readonly acquired_at: Date;
  readonly lat: number;
  readonly lon: number;
  readonly product_id: number;
  readonly confidence_class: string | null;
  readonly confidence_raw: string | null;
  readonly frp: number | null;
  readonly bright_ti4: number | null;
  readonly bright_ti5: number | null;
  readonly daynight: string | null;
  readonly scan: number | null;
  readonly track: number | null;
  readonly distance_m: number | null;
}

export interface ClusterDetectionReconstruction {
  /** How many detections the reconstruction found. Compare with the version's `n_total`. */
  readonly count: number;
  readonly sample: ClusterDetectionRow[];
  readonly byDay: {
    readonly day: string;
    readonly count: number;
    readonly frp_sum: number | null;
  }[];
  readonly nearest_m: number | null;
}

/**
 * The detections behind one summary version, **reconstructed** — and only trustworthy when the
 * caller checks the count.
 *
 * Membership is `fire_detections.cluster_id`, which is written in place at assignment and again
 * on merge, with no record of when (ADR-039). So this cannot *read* the set a version summarized;
 * it can only rebuild a candidate from the present: detections assigned to this cluster now,
 * ingested by the version's own knowledge time, and acquired no later than its newest detection.
 * If a merge moved detections in after that version, or retention dropped some since, the
 * candidate differs from the true set — and its size then differs from the version's `n_total`,
 * which *is* a fact at that knowledge time. A caller that finds the counts equal may present the
 * set; one that does not must withhold it.
 */
export async function reconstructClusterDetections(
  db: Kysely<DB>,
  options: {
    readonly clusterId: string;
    /** The summary version's `as_of`: the knowledge time the set is rebuilt for. */
    readonly knownAt: Date;
    readonly firstDetectedAt: Date;
    readonly lastDetectedAt: Date;
    readonly cap: number;
    readonly point?: LatLon;
  },
): Promise<ClusterDetectionReconstruction> {
  const point =
    options.point === undefined
      ? null
      : sql`ST_SetSRID(ST_MakePoint(${options.point.lon}, ${options.point.lat}), 4326)::geography`;
  const distance =
    point === null
      ? sql`NULL::double precision`
      : sql`ST_Distance(d.geog, ${point})::double precision`;
  const members = sql`
    geonerva.fire_detections d
    WHERE d.cluster_id = ${options.clusterId}::uuid
      AND d.ingested_at <= ${options.knownAt}
      AND d.acquired_at >= ${options.firstDetectedAt}
      AND d.acquired_at <= ${options.lastDetectedAt}
  `;

  const [sample, days, summary] = await Promise.all([
    sql<ClusterDetectionRow>`
      SELECT d.acquired_at, d.lat, d.lon, d.product_id, d.confidence_class, d.confidence_raw,
             d.frp, d.bright_ti4, d.bright_ti5, d.daynight::text AS daynight, d.scan, d.track,
             ${distance} AS distance_m
      FROM ${members}
      ORDER BY d.acquired_at DESC, d.id DESC
      LIMIT ${options.cap}
    `.execute(db),
    sql<{ day: string; count: number; frp_sum: number | null }>`
      SELECT to_char((d.acquired_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
             count(*)::integer AS count,
             sum(d.frp)::double precision AS frp_sum
      FROM ${members}
      GROUP BY 1
      ORDER BY 1
    `.execute(db),
    sql<{ count: number; nearest_m: number | null }>`
      SELECT count(*)::integer AS count, min(${distance}) AS nearest_m
      FROM ${members}
    `.execute(db),
  ]);

  return {
    count: summary.rows[0]?.count ?? 0,
    sample: [...sample.rows],
    byDay: [...days.rows],
    nearest_m: summary.rows[0]?.nearest_m ?? null,
  };
}

/**
 * Days FIRMS reported as having no satellite coverage, for the given products, as recorded by
 * `asOf` — so a zero on such a day is shown as "no coverage", never as "no fire".
 */
export async function missingDataDaysAsOf(
  db: Kysely<DB>,
  options: {
    readonly productIds: readonly number[];
    readonly days: readonly string[];
    readonly asOf: Date;
  },
): Promise<{ readonly product_id: number; readonly day: string }[]> {
  if (options.productIds.length === 0 || options.days.length === 0) return [];
  const result = await sql<{ product_id: number; day: string }>`
    SELECT m.product_id, to_char(m.day, 'YYYY-MM-DD') AS day
    FROM geonerva.fire_missing_data_days m
    WHERE m.product_id = ANY(${sql.val(options.productIds)}::smallint[])
      AND m.day = ANY(${sql.val(options.days)}::date[])
      AND m.recorded_at <= ${options.asOf}
    ORDER BY m.day, m.product_id
  `.execute(db);
  return [...result.rows];
}
