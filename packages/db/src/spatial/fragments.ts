/**
 * Parameterized PostGIS fragments (docs/ARCHITECTURE.md §7.2, ADR-002).
 *
 * Everything spatial is isolated here so that there is exactly one place to review. Three rules
 * hold without exception:
 *
 *  1. **Every value is a bind parameter.** Coordinates, radii and envelope edges are interpolated
 *    through Kysely's `sql` template, which emits `$1`, `$2`, … — never string concatenation.
 *    Column references go through `sql.ref`, which quotes identifiers.
 *  2. **`geography`, not `geometry`, for anything measured.** `ST_DWithin` and `ST_Distance` on
 *    geography are metres on the WGS84 spheroid, which is correct across the antimeridian and at
 *    high latitude. The only planar cast is the viewport envelope test, which exists solely to
 *    use the GiST expression index, and the convex hull, because `ST_ConvexHull` is geometry-only.
 *  3. **PostGIS 3.3 only.** Supabase ships 3.3.7 (ADR-031). Every function used here is listed in
 *    `../postgis-requirements.ts` with the version that introduced it, and an integration test
 *    fails if any of them needs more than 3.3.
 */

import { sql, type RawBuilder } from 'kysely';

import type { BoundingBox, LatLon } from '@geonerva/domain';

/** WGS84. The only SRID GeoNerva stores. */
export const SRID_WGS84 = 4326;

/**
 * A `geography(Point, 4326)` literal built from bound parameters.
 *
 * `ST_MakePoint` takes **(x, y)**, i.e. (longitude, latitude). Getting that order wrong is the
 * classic PostGIS bug, so it is written once, here, and every caller passes a named `LatLon`.
 */
export function geographyPoint(point: LatLon): RawBuilder<string> {
  return sql`ST_SetSRID(ST_MakePoint(${point.lon}, ${point.lat}), ${sql.lit(SRID_WGS84)})::geography`;
}

/** A `geometry(Point, 4326)` literal, for the planar operations that need one. */
export function geometryPoint(point: LatLon): RawBuilder<string> {
  return sql`ST_SetSRID(ST_MakePoint(${point.lon}, ${point.lat}), ${sql.lit(SRID_WGS84)})`;
}

/**
 * `ST_DWithin(column, point, radius)` on geography: true when the column is within `radiusM`
 * **metres** of the point, measured on the spheroid. This is the indexed predicate — it uses the
 * GiST index on the geography column, which `ST_Distance(...) < r` would not.
 */
export function withinRadius(column: string, point: LatLon, radiusM: number): RawBuilder<boolean> {
  return sql`ST_DWithin(${sql.ref(column)}, ${geographyPoint(point)}, ${radiusM})`;
}

/**
 * `ST_Distance` on geography: metres on the spheroid, and `0` when the point is inside an area.
 *
 * PostGIS uses the spheroidal calculation by default for geography (`use_spheroid = true`), which
 * is accurate to well under a metre — the tolerance that matters for "37 km away", and correct at
 * the poles and across ±180 where planar degree maths is not.
 */
export function distanceMeters(column: string, point: LatLon): RawBuilder<number> {
  return sql`ST_Distance(${sql.ref(column)}, ${geographyPoint(point)})`;
}

/**
 * KNN ordering operator. `ORDER BY column <-> point LIMIT n` is an index scan that walks the GiST
 * tree in distance order, rather than sorting every candidate. On geography the operator returns
 * the sphere distance in metres, which is close enough for ordering; exact distances are still
 * reported with `distanceMeters`.
 */
export function knnDistance(column: string, point: LatLon): RawBuilder<number> {
  return sql`${sql.ref(column)} <-> ${geographyPoint(point)}`;
}

/**
 * `ST_Covers(area, point)`: true when the point lies inside the area **or exactly on its
 * boundary**. `ST_Contains` excludes the boundary, which for a flood polygon would mean a place
 * on the edge is reported as outside — so `ST_Covers` is the correct predicate here.
 */
export function areaCoversPoint(areaColumn: string, point: LatLon): RawBuilder<boolean> {
  return sql`ST_Covers(${sql.ref(areaColumn)}, ${geographyPoint(point)})`;
}

/**
 * Distance from a point to an area, in metres, `0` inside. Always used behind an `ST_DWithin`
 * prefilter so that the index narrows the candidate set first.
 */
export function distanceToArea(areaColumn: string, point: LatLon): RawBuilder<number> {
  return sql`ST_Distance(${sql.ref(areaColumn)}, ${geographyPoint(point)})`;
}

/**
 * Planar envelope test for a viewport, against the GiST expression index on `(geog::geometry)`.
 *
 * This is the one place a cast to `geometry` is acceptable: `&&` is a bounding-box overlap test,
 * not a measurement, so degrees are exactly what is wanted. Antimeridian boxes must be split
 * first — see `splitViewport` in `./viewport.ts`.
 */
export function intersectsEnvelope(column: string, envelope: BoundingBox): RawBuilder<boolean> {
  return sql`${sql.ref(column)}::geometry && ST_MakeEnvelope(${envelope.west}, ${envelope.south}, ${envelope.east}, ${envelope.north}, ${sql.lit(SRID_WGS84)})`;
}

/** The same test for a column that is already `geometry`. */
export function geometryIntersectsEnvelope(
  column: string,
  envelope: BoundingBox,
): RawBuilder<boolean> {
  return sql`${sql.ref(column)} && ST_MakeEnvelope(${envelope.west}, ${envelope.south}, ${envelope.east}, ${envelope.north}, ${sql.lit(SRID_WGS84)})`;
}

/**
 * The hull of a set of detections: the convex hull of the collected points, buffered by half a
 * pixel so that the shape covers the detected pixels rather than their centres.
 *
 * `ST_ConvexHull` is geometry-only, so the points are cast to geometry, hulled, cast back to
 * geography and buffered in metres. A single point hulls to a point and buffers to a circle; two
 * points hull to a line and buffer to a capsule. Both are correct, and both are still **not** a
 * fire perimeter — the read model says so on every response.
 */
export function bufferedConvexHull(
  pointsExpression: RawBuilder<unknown>,
  bufferMeters: number,
): RawBuilder<string> {
  return sql`ST_Buffer(ST_ConvexHull(ST_Collect(${pointsExpression}::geometry))::geography, ${bufferMeters})`;
}

/** GeoJSON for a geography column, with a bounded number of decimals. */
export function asGeoJson(column: string, decimals = 6): RawBuilder<string> {
  return sql`ST_AsGeoJSON(${sql.ref(column)}::geometry, ${decimals})`;
}

/** GeoJSON for an arbitrary geography expression. */
export function expressionAsGeoJson(
  expression: RawBuilder<unknown>,
  decimals = 6,
): RawBuilder<string> {
  return sql`ST_AsGeoJSON(${expression}::geometry, ${decimals})`;
}

/** The centroid of a geography, returned as geography. */
export function centroidOf(expression: RawBuilder<unknown>): RawBuilder<string> {
  return sql`ST_Centroid(${expression}::geometry)::geography`;
}
