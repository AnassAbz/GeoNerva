/**
 * Executable spatial queries (docs/ARCHITECTURE.md §7.2).
 *
 * Every function here is documented with the predicate it uses and why, and every one is covered
 * by an integration test against known coordinates — Marrakech, Montréal, Suva (antimeridian) and
 * Longyearbyen (high latitude) — compared with an independently computed Vincenty distance rather
 * than with PostGIS's own answer.
 */

import { sql, type Kysely } from 'kysely';

import type { BoundingBox, LatLon } from '@geonerva/domain';

import type { DB } from '../generated/database.ts';
import {
  areaCoversPoint,
  bufferedConvexHull,
  distanceMeters,
  expressionAsGeoJson,
  geographyPoint,
  knnDistance,
  withinRadius,
} from './fragments.ts';
import { splitViewport } from './viewport.ts';

/** Half of a 375 m VIIRS pixel, used as the default hull buffer (docs/ARCHITECTURE.md §7.4). */
export const VIIRS_HALF_PIXEL_M = 188;

/**
 * Geodesic distance between two points, in metres on the WGS84 spheroid.
 *
 * Used by tests as the "what does PostGIS say?" side of the comparison, and by the storage
 * estimator. Application code measures against stored columns instead, so that the GiST index
 * does the narrowing.
 */
export async function measureDistanceMeters(
  db: Kysely<DB>,
  from: LatLon,
  to: LatLon,
): Promise<number> {
  const result = await sql<{ meters: number }>`
    SELECT ST_Distance(${geographyPoint(from)}, ${geographyPoint(to)})::double precision AS meters
  `.execute(db);
  const meters = result.rows[0]?.meters;
  if (meters === undefined) throw new Error('ST_Distance returned no row');
  return meters;
}

/** True when two points are within `radiusM` metres of each other, by the indexed predicate. */
export async function arePointsWithin(
  db: Kysely<DB>,
  from: LatLon,
  to: LatLon,
  radiusM: number,
): Promise<boolean> {
  const result = await sql<{ within: boolean }>`
    SELECT ST_DWithin(${geographyPoint(from)}, ${geographyPoint(to)}, ${radiusM}) AS within
  `.execute(db);
  return result.rows[0]?.within === true;
}

export interface ObservationDistanceRow {
  readonly version_id: string;
  readonly source_record_id: string;
  readonly hazard_type: string;
  readonly observed_at: Date;
  readonly ingested_at: Date;
  readonly distance_m: number;
}

/**
 * The `n` nearest observation versions to a point, using the GiST KNN operator.
 *
 * `ORDER BY centroid <-> point LIMIT n` walks the index in distance order instead of measuring
 * every candidate. The exact spheroidal distance is reported separately, because `<->` on
 * geography is a sphere approximation good enough to order by but not to quote.
 *
 * This is a **raw** nearest-neighbour search over all versions; the as-of read path in
 * `../asof.ts` is what callers should normally use.
 */
export async function nearestObservationVersions(
  db: Kysely<DB>,
  point: LatLon,
  limit: number,
  options: { hazardTypes?: readonly string[] } = {},
): Promise<ObservationDistanceRow[]> {
  const hazardFilter =
    options.hazardTypes === undefined
      ? sql`TRUE`
      : sql`v.hazard_type = ANY(${sql.val(options.hazardTypes)}::text[])`;

  const result = await sql<ObservationDistanceRow>`
    SELECT v.id::text            AS version_id,
           v.source_record_id::text AS source_record_id,
           v.hazard_type,
           v.observed_at,
           v.ingested_at,
           ${distanceMeters('v.centroid', point)}::double precision AS distance_m
    FROM geonerva.observation_versions v
    WHERE ${hazardFilter}
    ORDER BY ${knnDistance('v.centroid', point)}
    LIMIT ${limit}
  `.execute(db);
  return [...result.rows];
}

/**
 * Observation geometries covering a point (`ST_Covers`), i.e. "is this place inside the flood
 * area / the wind buffer / the alert region?".
 *
 * `ST_Covers` includes the boundary. `ST_Contains` does not, which would report a place exactly
 * on the edge of a flood polygon as outside it — the wrong answer for this product.
 */
export async function geometriesCoveringPoint(
  db: Kysely<DB>,
  point: LatLon,
  options: { versionIds?: readonly string[] } = {},
): Promise<{ observation_version_id: string; role: string; seq: number; is_forecast: boolean }[]> {
  const versionFilter =
    options.versionIds === undefined
      ? sql`TRUE`
      : sql`g.observation_version_id = ANY(${sql.val(options.versionIds)}::bigint[])`;

  const result = await sql<{
    observation_version_id: string;
    role: string;
    seq: number;
    is_forecast: boolean;
  }>`
    SELECT g.observation_version_id::text AS observation_version_id, g.role, g.seq, g.is_forecast
    FROM geonerva.observation_geometries g
    WHERE ${versionFilter}
      AND ${areaCoversPoint('g.geog', point)}
    ORDER BY g.observation_version_id, g.role, g.seq
  `.execute(db);
  return [...result.rows];
}

/**
 * Distance from a point to each nearby geometry, in metres, `0` when the point is inside.
 *
 * The `ST_DWithin` prefilter is what makes this indexable: without it the query would measure
 * every polygon in the table.
 */
export async function distanceToGeometries(
  db: Kysely<DB>,
  point: LatLon,
  maxDistanceM: number,
): Promise<{ observation_version_id: string; role: string; distance_m: number }[]> {
  const result = await sql<{ observation_version_id: string; role: string; distance_m: number }>`
    SELECT g.observation_version_id::text AS observation_version_id,
           g.role,
           ${distanceMeters('g.geog', point)}::double precision AS distance_m
    FROM geonerva.observation_geometries g
    WHERE ${withinRadius('g.geog', point, maxDistanceM)}
    ORDER BY distance_m
  `.execute(db);
  return [...result.rows];
}

export interface ViewportFeatureRow {
  readonly id: string;
  readonly hazard_type: string;
  readonly observed_at: Date;
  readonly geojson: string;
}

/**
 * Observation centroids inside a viewport.
 *
 * The box is split first, so an antimeridian viewport becomes two envelopes and the query returns
 * what the user is looking at rather than the rest of the planet. The planar `&&` test against
 * `(centroid::geometry)` uses the GiST expression index; no measurement happens here, so degrees
 * are exactly the right unit.
 */
export async function observationsInViewport(
  db: Kysely<DB>,
  bbox: BoundingBox,
  options: { hazardTypes?: readonly string[]; limit?: number } = {},
): Promise<ViewportFeatureRow[]> {
  const envelopes = splitViewport(bbox);
  const envelopeTests = envelopes.map(
    (envelope) =>
      sql`v.centroid::geometry && ST_MakeEnvelope(${envelope.west}, ${envelope.south}, ${envelope.east}, ${envelope.north}, 4326)`,
  );
  const envelopeFilter = sql.join(envelopeTests, sql` OR `);
  const hazardFilter =
    options.hazardTypes === undefined
      ? sql`TRUE`
      : sql`v.hazard_type = ANY(${sql.val(options.hazardTypes)}::text[])`;

  const result = await sql<ViewportFeatureRow>`
    SELECT v.id::text AS id,
           v.hazard_type,
           v.observed_at,
           ST_AsGeoJSON(v.centroid::geometry, 6) AS geojson
    FROM geonerva.observation_versions v
    WHERE (${envelopeFilter})
      AND ${hazardFilter}
    ORDER BY v.observed_at DESC
    LIMIT ${options.limit ?? 2000}
  `.execute(db);
  return [...result.rows];
}

/** Thermal detections inside a viewport, capped. Only shown at zoom ≥ 8 (ARCHITECTURE §7.5). */
export async function fireDetectionsInViewport(
  db: Kysely<DB>,
  bbox: BoundingBox,
  options: { since?: Date; limit?: number } = {},
): Promise<{ id: string; acquired_at: Date; lat: number; lon: number; frp: number | null }[]> {
  const envelopes = splitViewport(bbox);
  const envelopeFilter = sql.join(
    envelopes.map(
      (envelope) =>
        sql`d.geog::geometry && ST_MakeEnvelope(${envelope.west}, ${envelope.south}, ${envelope.east}, ${envelope.north}, 4326)`,
    ),
    sql` OR `,
  );
  const sinceFilter =
    options.since === undefined ? sql`TRUE` : sql`d.acquired_at >= ${options.since}`;

  const result = await sql<{
    id: string;
    acquired_at: Date;
    lat: number;
    lon: number;
    frp: number | null;
  }>`
    SELECT d.id::text AS id, d.acquired_at, d.lat, d.lon, d.frp
    FROM geonerva.fire_detections d
    WHERE (${envelopeFilter})
      AND ${sinceFilter}
    ORDER BY d.acquired_at DESC
    LIMIT ${options.limit ?? 5000}
  `.execute(db);
  return [...result.rows];
}

export interface ClusterHullResult {
  readonly hullGeoJson: string | null;
  readonly centroidGeoJson: string;
  readonly detectionCount: number;
}

/**
 * Builds the hull of a cluster's detections: convex hull of the pixel centres, buffered by half a
 * pixel, as geography.
 *
 * `ST_ConvexHull` is geometry-only, which is why the points are cast, hulled, and cast back
 * before buffering in metres. A one-detection cluster produces a circle and a two-detection
 * cluster a capsule; both are honest representations of "we saw heat here", and neither is a fire
 * perimeter.
 */
export async function buildClusterHull(
  db: Kysely<DB>,
  clusterId: string,
  bufferMeters: number = VIIRS_HALF_PIXEL_M,
): Promise<ClusterHullResult> {
  const hullExpression = bufferedConvexHull(sql`d.geog`, bufferMeters);
  const result = await sql<{
    hull: string | null;
    centroid: string;
    n: string;
  }>`
    SELECT ${expressionAsGeoJson(hullExpression)} AS hull,
           ST_AsGeoJSON(ST_Centroid(ST_Collect(d.geog::geometry)), 6) AS centroid,
           count(*)::text AS n
    FROM geonerva.fire_detections d
    WHERE d.cluster_id = ${clusterId}::uuid
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined || row.centroid === null) {
    throw new Error(`cluster ${clusterId} has no detections`);
  }
  return {
    hullGeoJson: row.hull,
    centroidGeoJson: row.centroid,
    detectionCount: Number(row.n),
  };
}

/** The nearest detections to a point, for "distance to the nearest detection" in relevance. */
export async function nearestDetections(
  db: Kysely<DB>,
  point: LatLon,
  limit: number,
  options: { clusterId?: string; since?: Date } = {},
): Promise<{ id: string; acquired_at: Date; distance_m: number; cluster_id: string | null }[]> {
  const clusterFilter =
    options.clusterId === undefined ? sql`TRUE` : sql`d.cluster_id = ${options.clusterId}::uuid`;
  const sinceFilter =
    options.since === undefined ? sql`TRUE` : sql`d.acquired_at >= ${options.since}`;

  const result = await sql<{
    id: string;
    acquired_at: Date;
    distance_m: number;
    cluster_id: string | null;
  }>`
    SELECT d.id::text AS id,
           d.acquired_at,
           ${distanceMeters('d.geog', point)}::double precision AS distance_m,
           d.cluster_id::text AS cluster_id
    FROM geonerva.fire_detections d
    WHERE ${clusterFilter} AND ${sinceFilter}
    ORDER BY ${knnDistance('d.geog', point)}
    LIMIT ${limit}
  `.execute(db);
  return [...result.rows];
}
