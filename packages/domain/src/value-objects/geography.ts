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

/**
 * Rounds a user-supplied coordinate to `USER_COORDINATE_DECIMALS`.
 *
 * ADR-015 and invariant I15: a visitor's position is rounded to two decimals — about 1.1 km —
 * **at the API boundary**, before it reaches a log line, a cache key or a query. This lives beside
 * the constant and beside `formatCoordinateKey`, which *validates* that a coordinate was already
 * rounded and throws otherwise: one rounder, one validator, no chance of them disagreeing about
 * what "rounded" means.
 *
 * `-0` is folded to `0`. They are the same meridian or parallel, and `(-0).toFixed(2)` is
 * `"-0.00"`, which would be a second cache key for one location.
 */
export function roundUserCoordinate(value: number): number {
  const factor = 10 ** USER_COORDINATE_DECIMALS;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

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

/**
 * Viewport edges may sit on +180: a box whose eastern edge is the antimeridian is meaningful,
 * even though a stored point at +180 is always normalized to −180.
 */
export const viewportLongitudeSchema = z
  .number()
  .refine((value) => Number.isFinite(value) && value >= MIN_LONGITUDE && value <= MAX_LONGITUDE, {
    message: 'must be a longitude within [-180, 180]',
  });

export const boundingBoxSchema = z
  .object({
    west: viewportLongitudeSchema,
    south: latitudeSchema,
    east: viewportLongitudeSchema,
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

/**
 * The regular lat/lon grid the fire aggregate counts on (ADR-011, ADR-040).
 *
 * It lives here, in the domain, rather than in `packages/geo` with the geodesy, for one practical
 * reason: `packages/db` may depend on `domain` and `config` only, and the grid's arithmetic has to
 * be spelled in SQL — `fire_daily_counts.cell_id` is computed by the writer and decomposed again
 * by the as-of read. Three copies of `0.25` in two SQL strings is a silent disagreement waiting to
 * happen: if the writer and the reader ever used different cell sizes, detections would be counted
 * into cells the radius filter then measured in the wrong place, and nothing would fail loudly.
 * One definition, interpolated into both queries and mirrored by the two functions below, which
 * the tests check against the database's own answer.
 *
 * It is not geodesy: equal-area cells are unnecessary because a baseline compares a location with
 * its own past through the same cells (ARCHITECTURE §7.6).
 */
export const FIRE_GRID = {
  /** Cell size in degrees. 0.25° is about 28 km of longitude at the equator, less towards a pole. */
  degrees: 0.25,
  /** Columns in a row: 360° / 0.25°. `cell_id = row * columns + column`. */
  columns: 1440,
} as const;

/** The grid cell a position falls in, identically to the SQL in `packages/db`. */
export function fireCellId(point: LatLon): number {
  const row = Math.floor((point.lat + 90) / FIRE_GRID.degrees);
  const column = Math.floor((point.lon + 180) / FIRE_GRID.degrees);
  return row * FIRE_GRID.columns + column;
}

/**
 * The centre of a cell — the point a radius is measured to, which is why the edge of a circle is
 * approximate by up to half a cell.
 */
export function fireCellCentre(cellId: number): LatLon {
  const half = FIRE_GRID.degrees / 2;
  return {
    lat: Math.floor(cellId / FIRE_GRID.columns) * FIRE_GRID.degrees - 90 + half,
    lon: (cellId % FIRE_GRID.columns) * FIRE_GRID.degrees - 180 + half,
  };
}
