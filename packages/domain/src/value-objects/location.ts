/**
 * Location identity and coverage (docs/DOMAIN_MODEL.md §4.12, ADR-015).
 *
 * A location key is the cache key, the URL parameter and the database key for everything
 * location-scoped, so its spelling is canonical and total:
 *
 * ```text
 * p:<geonameid>            a GeoNames populated place            persistable
 * n:<osm_type><osm_id>     a Nominatim result (N/W/R + digits)   persistable
 * c:<lat>,<lon>            raw coordinates, 2 decimals exactly   NEVER persisted server-side
 * ```
 *
 * **Privacy rule (ADR-015):** `c:` keys — including "Use my location" — are never written to the
 * database and never logged at full precision. They are computed on demand and cached only in
 * HTTP caches, keyed by the already-rounded URL. Named places are public places, not personal
 * data, and may be persisted in `analysis_locations`. `isPersistableLocationKey` is the single
 * predicate the database layer checks before writing anything keyed by a location.
 */

import { z } from 'zod';

import { COVERAGE_LEVELS, type CoverageLevel, type HazardFamily } from '../enums.ts';
import { isNormalizedLongitude, isValidLatitude, type LatLon } from './geography.ts';
import { USER_COORDINATE_DECIMALS } from './geography.ts';

/** The three kinds of location identity. */
export const LOCATION_KEY_KINDS = ['place', 'nominatim', 'coordinates'] as const;
export type LocationKeyKind = (typeof LOCATION_KEY_KINDS)[number];

/** OSM element types, as Nominatim abbreviates them. */
export const OSM_TYPES = ['N', 'W', 'R'] as const;
export type OsmType = (typeof OSM_TYPES)[number];

export type ParsedLocationKey =
  | { readonly kind: 'place'; readonly geonameId: number }
  | { readonly kind: 'nominatim'; readonly osmType: OsmType; readonly osmId: string }
  | { readonly kind: 'coordinates'; readonly lat: number; readonly lon: number };

const PLACE_KEY_PATTERN = /^p:([1-9][0-9]{0,9})$/;
const NOMINATIM_KEY_PATTERN = /^n:([NWR])([1-9][0-9]{0,18})$/;
/** Exactly two decimals, so that `c:31.6,-8` and `c:31.630,-8.000` are not separate cache keys. */
const COORDINATE_KEY_PATTERN = /^c:(-?[0-9]{1,2}\.[0-9]{2}),(-?[0-9]{1,3}\.[0-9]{2})$/;

/** Longest legal key, so that an attacker cannot push a megabyte through a cache key. */
export const MAX_LOCATION_KEY_LENGTH = 32;

/** Parses a location key, returning `null` when it is not exactly canonical. */
export function parseLocationKey(key: string): ParsedLocationKey | null {
  if (key.length === 0 || key.length > MAX_LOCATION_KEY_LENGTH) return null;

  const place = PLACE_KEY_PATTERN.exec(key);
  if (place?.[1] !== undefined) return { kind: 'place', geonameId: Number(place[1]) };

  const osm = NOMINATIM_KEY_PATTERN.exec(key);
  if (osm?.[1] !== undefined && osm[2] !== undefined) {
    return { kind: 'nominatim', osmType: osm[1] as OsmType, osmId: osm[2] };
  }

  const coords = COORDINATE_KEY_PATTERN.exec(key);
  if (coords?.[1] !== undefined && coords[2] !== undefined) {
    const lat = Number(coords[1]);
    const lon = Number(coords[2]);
    if (!isValidLatitude(lat) || !isNormalizedLongitude(lon)) return null;
    return { kind: 'coordinates', lat, lon };
  }

  return null;
}

/** True for a canonical location key of any kind. */
export function isLocationKey(key: string): boolean {
  return parseLocationKey(key) !== null;
}

/** Formats a GeoNames place key. */
export function formatPlaceKey(geonameId: number): string {
  if (!Number.isInteger(geonameId) || geonameId <= 0) {
    throw new RangeError(`invalid geonameid: ${String(geonameId)}`);
  }
  return `p:${String(geonameId)}`;
}

/** Formats a Nominatim key from an OSM element type and id. */
export function formatNominatimKey(osmType: OsmType, osmId: string): string {
  const key = `n:${osmType}${osmId}`;
  if (!isLocationKey(key)) throw new RangeError('invalid nominatim location key');
  return key;
}

/**
 * Formats a raw-coordinate key. The input must already be rounded to
 * `USER_COORDINATE_DECIMALS`; rounding itself lives in `packages/geo`, so that there is exactly
 * one implementation of it. Passing finer coordinates is a programming error and throws, which is
 * how the privacy rule stays enforceable rather than advisory.
 */
export function formatCoordinateKey(point: LatLon): string {
  if (!isValidLatitude(point.lat) || !isNormalizedLongitude(point.lon)) {
    throw new RangeError('coordinates out of range');
  }
  for (const value of [point.lat, point.lon]) {
    const scaled = value * 10 ** USER_COORDINATE_DECIMALS;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
      throw new RangeError(
        `coordinates must be rounded to ${String(USER_COORDINATE_DECIMALS)} decimals before a key is made`,
      );
    }
  }
  // `-0` would otherwise render as "-0.00" and create a second key for the same place.
  const lat = (point.lat === 0 ? 0 : point.lat).toFixed(USER_COORDINATE_DECIMALS);
  const lon = (point.lon === 0 ? 0 : point.lon).toFixed(USER_COORDINATE_DECIMALS);
  return `c:${lat},${lon}`;
}

/** The kind of a location key, or `null` when malformed. */
export function locationKeyKind(key: string): LocationKeyKind | null {
  return parseLocationKey(key)?.kind ?? null;
}

/**
 * True when a location key may be written to the database. Raw-coordinate keys may not
 * (ADR-015). Every repository that stores a `location_key` asserts this.
 */
export function isPersistableLocationKey(key: string): boolean {
  const parsed = parseLocationKey(key);
  return parsed !== null && parsed.kind !== 'coordinates';
}

export const locationKeySchema = z
  .string()
  .max(MAX_LOCATION_KEY_LENGTH)
  .refine(isLocationKey, { message: 'must be a location key such as p:2542997 or c:31.63,-8.00' });

/** What GeoNerva can and cannot say about a place for one hazard family. */
export interface FamilyCoverage {
  readonly level: CoverageLevel;
  /**
   * A plain-language limitation, always present for `PARTIAL` and `NOT_COVERED`. Example:
   * "Earthquake coverage here is complete only from about M4.5."
   */
  readonly note: string | null;
}

export const familyCoverageSchema = z
  .object({
    level: z.enum(COVERAGE_LEVELS),
    note: z.string().trim().min(1).max(300).nullable(),
  })
  .refine((coverage) => coverage.level === 'COVERED' || coverage.note !== null, {
    message: 'PARTIAL and NOT_COVERED coverage must explain the limitation',
    path: ['note'],
  });

/** Coverage for every family at one location. Absence of a result is never silence (§3). */
export type CoverageByFamily = Readonly<Record<HazardFamily, FamilyCoverage>>;

/** A resolved location as the API returns it. Coordinates are always the rounded ones. */
export interface LocationRef {
  readonly key: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  /** IANA time zone, used for display; storage stays UTC. */
  readonly timezone: string;
  readonly countryCode: string | null;
  readonly admin1: string | null;
}
