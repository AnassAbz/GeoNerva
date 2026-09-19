/**
 * The PostGIS surface GeoNerva depends on, and the version each function needs (ADR-031).
 *
 * Supabase ships **PostGIS 3.3.7**, and there is no `postgis/postgis:17-3.3` image, so local
 * development and CI run 3.4 while production runs 3.3. That gap is a trap: it is easy to write
 * SQL that works locally and fails in production, and a spatial query that fails in production
 * means the map goes blank for real users.
 *
 * This module makes the constraint checkable instead of aspirational. Every PostGIS function the
 * code base uses is listed here with the release that introduced it, and an integration test
 * asserts two things:
 *
 *  1. no listed function needs more than `MAX_TARGET_POSTGIS_VERSION`;
 *  2. every listed function actually exists on the connected server.
 *
 * Adding a function to the SQL without adding it here makes the second assertion vacuous, so the
 * test also prints `postgis_full_version()`, which keeps the mismatch visible in CI output.
 */

/** The oldest PostGIS GeoNerva must run on: what Supabase ships. */
export const MIN_SUPPORTED_POSTGIS_VERSION = '3.3';

/**
 * The newest version GeoNerva may *depend* on. Deliberately equal to the minimum: local may be
 * newer, but the SQL must not need it.
 */
export const MAX_TARGET_POSTGIS_VERSION = '3.3';

/** PostgreSQL floor (docs/DOMAIN_MODEL.md §6). */
export const MIN_SUPPORTED_POSTGRES_VERSION_NUM = 150_000;

export interface PostgisFunctionRequirement {
  /** Lowercase function name as `pg_proc` stores it. */
  readonly name: string;
  /** PostGIS release that introduced the signature GeoNerva uses. */
  readonly since: string;
  /** Where and why it is used. */
  readonly usedFor: string;
}

/**
 * Every PostGIS function used in migrations, repositories, the as-of layer and `spatial/`.
 *
 * All of them are long-standing 2.x/3.0 functions: GeoNerva's geospatial needs are radius,
 * distance, containment, envelopes, hulls and buffers, none of which required a recent release.
 * That is a deliberate design outcome rather than luck — the alternatives that would have needed
 * newer PostGIS (for example `ST_ClusterDBSCAN` tuning or H3 helpers) were rejected on their own
 * merits in ADR-011 and ARCHITECTURE §7.4.
 */
export const REQUIRED_POSTGIS_FUNCTIONS: readonly PostgisFunctionRequirement[] = [
  { name: 'st_setsrid', since: '1.5', usedFor: 'building geography points from lon/lat' },
  { name: 'st_makepoint', since: '1.5', usedFor: 'building geography points from lon/lat' },
  { name: 'st_dwithin', since: '1.5', usedFor: 'indexed radius search on geography (metres)' },
  { name: 'st_distance', since: '1.5', usedFor: 'spheroidal distance in metres' },
  { name: 'st_covers', since: '1.5', usedFor: 'point in area, boundary included' },
  { name: 'st_makeenvelope', since: '1.5', usedFor: 'viewport bounding boxes' },
  { name: 'st_collect', since: '1.5', usedFor: 'collecting detection points for a hull' },
  { name: 'st_convexhull', since: '1.5', usedFor: 'fire cluster hull (geometry only)' },
  { name: 'st_buffer', since: '1.5', usedFor: 'buffering the hull by half a pixel, in metres' },
  { name: 'st_centroid', since: '1.5', usedFor: 'cluster centroid' },
  { name: 'st_asgeojson', since: '1.5', usedFor: 'geometry output for the API' },
  { name: 'st_geomfromgeojson', since: '2.0', usedFor: 'storing adapter-normalized geometries' },
  { name: 'st_x', since: '1.5', usedFor: 'reading longitude back out of a stored point' },
  { name: 'st_y', since: '1.5', usedFor: 'reading latitude back out of a stored point' },
];

/** Compares dotted version strings numerically: `3.10` is newer than `3.9`. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const left = partsA[index] ?? 0;
    const right = partsB[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/** True when `version` is at least `minimum`. */
export function isAtLeastVersion(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

/**
 * Functions whose requirement exceeds the target version. Must always be empty; the integration
 * test fails with the offending names if it is not.
 */
export function functionsBeyondTarget(
  target: string = MAX_TARGET_POSTGIS_VERSION,
): readonly PostgisFunctionRequirement[] {
  return REQUIRED_POSTGIS_FUNCTIONS.filter(
    (requirement) => compareVersions(requirement.since, target) > 0,
  );
}
