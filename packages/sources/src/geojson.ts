/**
 * Validation for a provider-supplied GeoJSON geometry, before it reaches PostGIS.
 *
 * `insertVersion` writes shapes with
 * `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)::geography`, and every way that statement can fail
 * aborts the surrounding transaction — which, for a batch, means every *other* record in it is
 * lost too. A provider does not have to be hostile to produce any of these; a flood polygon
 * crossing the antimeridian is enough.
 *
 * What is checked, and why each one is not theoretical:
 *
 *  - **Coordinate range.** `ST_GeomFromGeoJSON` accepts `lon: 200` happily; the `::geography`
 *    cast then raises *"Coordinate values are out of range [-180 -90, 180 90]"*. Half-open on
 *    longitude, because that is what `fire_detections` already enforces and what
 *    `wrapLongitude` produces, so the two halves of this system agree on where +180 belongs.
 *  - **Ring structure.** A linear ring with fewer than four positions, or one that does not
 *    close, makes `ST_GeomFromGeoJSON` raise directly.
 *  - **A `crs` member.** This is the dangerous one, because it does **not** raise.
 *    `ST_GeomFromGeoJSON` honours an embedded CRS, and `ST_SetSRID(..., 4326)` then overwrites
 *    the SRID *without reprojecting* — so a provider that starts emitting a `crs` gets its
 *    coordinates silently relabelled as WGS84. Wrong positions, no error, no trace. The 2008
 *    GeoJSON spec allowed `crs`; RFC 7946 removed it, and providers have not all noticed.
 *  - **Size.** A shape is bounded in positions, because nothing downstream bounds it:
 *    `observation_geometries` has no size constraint, and a months-long flood would store its
 *    largest polygon once per episode.
 *
 * Nothing here alters a shape. A geometry GeoNerva simplified or reprojected is no longer the
 * geometry the provider published, and the whole point of storing it is that it is theirs.
 */

/** Position count above which a shape is refused rather than stored. */
export const MAX_GEOMETRY_POSITIONS = 100_000;

export type GeoJsonDefect =
  | 'NOT_AN_OBJECT'
  | 'UNSUPPORTED_TYPE'
  | 'HAS_CRS'
  | 'BAD_COORDINATES'
  | 'DEGENERATE_RING'
  | 'TOO_MANY_POSITIONS';

export interface GeoJsonVerdict {
  readonly ok: boolean;
  readonly defect?: GeoJsonDefect;
  readonly detail?: string;
  /** Positions counted, for a caller that wants to report size. */
  readonly positions: number;
}

const SUPPORTED = new Set(['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point']);

function isPosition(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function inRange(position: readonly number[]): boolean {
  const [lon, lat] = position as [number, number];
  // Half-open on longitude: +180 and -180 are the same meridian and the normalized form keeps one.
  return lon >= -180 && lon < 180 && lat >= -90 && lat <= 90;
}

function samePosition(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Walks the coordinate tree, counting positions and checking each one.
 *
 * Iterative rather than recursive: the depth is provider-controlled, and a deeply nested array
 * would otherwise be a stack overflow rather than a rejection.
 */
function checkCoordinates(
  coordinates: unknown,
  ringDepth: number,
): { defect?: GeoJsonDefect; detail?: string; positions: number } {
  let positions = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: coordinates, depth: 0 }];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const { value, depth } = entry;

    if (isPosition(value)) {
      positions += 1;
      if (positions > MAX_GEOMETRY_POSITIONS) {
        return {
          defect: 'TOO_MANY_POSITIONS',
          detail: `more than ${MAX_GEOMETRY_POSITIONS} positions`,
          positions,
        };
      }
      if (!inRange(value)) {
        return {
          defect: 'BAD_COORDINATES',
          detail: `position [${value[0]}, ${value[1]}] is outside [-180, 180) × [-90, 90]`,
          positions,
        };
      }
      continue;
    }

    if (!Array.isArray(value)) {
      return { defect: 'BAD_COORDINATES', detail: 'a coordinate is not a number pair', positions };
    }

    // At ring depth, this array is a linear ring: at least four positions, first equal to last.
    if (depth === ringDepth) {
      if (value.length < 4) {
        return {
          defect: 'DEGENERATE_RING',
          detail: `a ring has ${value.length} positions; a closed ring needs at least four`,
          positions,
        };
      }
      const first: unknown = value[0];
      const last: unknown = value[value.length - 1];
      if (!isPosition(first) || !isPosition(last) || !samePosition(first, last)) {
        return { defect: 'DEGENERATE_RING', detail: 'a ring does not close', positions };
      }
    }

    for (const child of value) stack.push({ value: child, depth: depth + 1 });
  }

  return { positions };
}

/** How deep the linear rings sit for each geometry type. `-1` means "no rings". */
function ringDepthOf(type: string): number {
  switch (type) {
    case 'Polygon':
      return 1;
    case 'MultiPolygon':
      return 2;
    default:
      return -1;
  }
}

export function validateGeoJsonGeometry(value: unknown): GeoJsonVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, defect: 'NOT_AN_OBJECT', positions: 0 };
  }
  const geometry = value as Record<string, unknown>;

  /*
   * Refused, not stripped.
   *
   * Stripping the `crs` and storing the coordinates would be GeoNerva deciding that they were
   * WGS84 after the provider said they were something else — which is the silent-wrong-position
   * case this check exists to prevent, arrived at deliberately instead of accidentally.
   */
  if ('crs' in geometry) {
    return {
      ok: false,
      defect: 'HAS_CRS',
      detail:
        'the geometry declares its own crs, which ST_SetSRID would overwrite without reprojecting',
      positions: 0,
    };
  }

  const type = geometry['type'];
  if (typeof type !== 'string' || !SUPPORTED.has(type)) {
    return {
      ok: false,
      defect: 'UNSUPPORTED_TYPE',
      detail: `geometry type ${String(type)} is not one this adapter stores`,
      positions: 0,
    };
  }

  const checked = checkCoordinates(geometry['coordinates'], ringDepthOf(type));
  if (checked.defect !== undefined) {
    return {
      ok: false,
      defect: checked.defect,
      ...(checked.detail === undefined ? {} : { detail: checked.detail }),
      positions: checked.positions,
    };
  }
  if (checked.positions === 0) {
    return { ok: false, defect: 'BAD_COORDINATES', detail: 'no positions', positions: 0 };
  }
  return { ok: true, positions: checked.positions };
}
