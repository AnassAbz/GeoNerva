/**
 * Geographic value objects and boundary validation (docs/ARCHITECTURE.md §7.1).
 *
 * The domain owns the *types* and the *validation rules* at the adapter and API boundary.
 * Geodesy itself — distance, bbox splitting, coordinate parsing, rounding, grid cells — lives in
 * `packages/geo`, so nothing here computes on the spheroid.
 */

import { z } from 'zod';

/** A WGS84 (SRID 4326) coordinate pair in degrees. Longitude is normalized to [−180, 180). */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** Decimal places user-supplied coordinates are rounded to at the API boundary (≈ 1.1 km). */
export const USER_COORDINATE_DECIMALS = 2;

/** Latitude bounds, inclusive. */
export const MIN_LATITUDE = -90;
export const MAX_LATITUDE = 90;

/** Longitude bounds: −180 inclusive, +180 exclusive, so that ±180 has one representation. */
export const MIN_LONGITUDE = -180;
export const MAX_LONGITUDE = 180;

/** True for a finite latitude within [−90, 90]. */
export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_LATITUDE && value <= MAX_LATITUDE;
}

/** True for a finite longitude within [−180, 180). `180` is rejected; it normalizes to `−180`. */
export function isNormalizedLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_LONGITUDE && value < MAX_LONGITUDE;
}

/**
 * `(0, 0)` is in the Gulf of Guinea and is almost always a provider default rather than a real
 * position. Records there are flagged `NULL_ISLAND` rather than silently trusted.
 */
export function isNullIsland(point: LatLon): boolean {
  return point.lat === 0 && point.lon === 0;
}

export const latitudeSchema = z
  .number()
  .refine(isValidLatitude, { message: 'must be a latitude within [-90, 90]' });

export const longitudeSchema = z
  .number()
  .refine(isNormalizedLongitude, { message: 'must be a longitude within [-180, 180)' });

export const latLonSchema = z.object({ lat: latitudeSchema, lon: longitudeSchema });

/**
 * A viewport rectangle in degrees. `west > east` means the box crosses the antimeridian and must
 * be split into two envelopes before it reaches PostGIS (`packages/db/src/spatial/viewport.ts`).
 */
export interface BoundingBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** True when the box crosses the antimeridian (`west > east`). */
export function crossesAntimeridian(bbox: BoundingBox): boolean {
  return bbox.west > bbox.east;
}

export const boundingBoxSchema = z
  .object({
    west: longitudeSchema,
    south: latitudeSchema,
    east: longitudeSchema,
    north: latitudeSchema,
  })
  .refine((bbox) => bbox.south <= bbox.north, {
    message: 'south must not be north of north',
    path: ['south'],
  });

/**
 * GeoJSON geometry as it reaches the API layer. The domain keeps this deliberately loose: the
 * authoritative geometry lives in PostGIS as `geography(…, 4326)`, and every geometry crossing a
 * boundary is produced by `ST_AsGeoJSON`, which is already valid by construction.
 */
export const GEOJSON_GEOMETRY_TYPES = [
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
] as const;
export type GeoJsonGeometryType = (typeof GEOJSON_GEOMETRY_TYPES)[number];

/** A GeoJSON geometry object in WGS84, as emitted by `ST_AsGeoJSON`. */
export interface GeoJsonGeometry {
  readonly type: GeoJsonGeometryType;
  /** Coordinates, or — for a `GeometryCollection` — `geometries`. */
  readonly coordinates?: unknown;
  readonly geometries?: readonly GeoJsonGeometry[];
}

/** Search radius in metres, bounded so that a request cannot ask for a hemisphere. */
export const MAX_SEARCH_RADIUS_M = 1_500_000;

export const radiusMetersSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_SEARCH_RADIUS_M, { message: 'exceeds the maximum search radius' });
