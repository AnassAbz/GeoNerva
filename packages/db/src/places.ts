/**
 * Place lookup and the geocode cache — the two tables the place endpoints use.
 *
 * **Neither is a fact store, so nothing here takes `as_of`.** `places` is the GeoNames reference
 * import (ADR-013), replaced wholesale by the import script and not versioned; `geocode_cache` is a
 * cache of a provider's answers with a 30-day lifetime. Neither participates in replay: a briefing
 * at a past knowledge time is about a *location*, and which name the location was looked up by
 * changes nothing GeoNerva knew about hazards there. Security finding S-9 asks every exported fact
 * reader to take `as_of` "or be provably not a fact reader"; this module is the second kind, and
 * `@geonerva/db/asof` does not re-export it.
 *
 * `storeGeocodeResult` is the web process's second and last write, beside the rate-limit counter.
 * Migration 0007 grants exactly those two (`INSERT, UPDATE` on `rate_limit_buckets` and
 * `geocode_cache`), and the key is a hash, so no query text is stored.
 */

import { sql, type Kysely } from 'kysely';

import type { LatLon } from '@geonerva/domain';

import type { DB } from './generated/database.ts';

export interface PlaceRow {
  readonly geonameid: number;
  readonly name: string;
  readonly country_code: string | null;
  readonly admin1: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly population: number | null;
  readonly timezone: string;
}

/** `\`, `%` and `_` escaped, so a query is matched as text rather than as a pattern. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

/**
 * Up to `limit` populated places whose name, ASCII name or one of whose alternates **starts with**
 * the query, most populous first.
 *
 * A prefix, not a substring: type-ahead completes what someone is typing, and a substring match
 * on "par" returns every Parramatta and Ciudad Paraíso before Paris. An exact name match ranks
 * first, so "Nice" is not buried under the Nicosias. Ties break on the id, so the order is total.
 */
export async function suggestPlaces(
  db: Kysely<DB>,
  options: { readonly query: string; readonly limit: number },
): Promise<PlaceRow[]> {
  const prefix = `${likeLiteral(options.query)}%`;
  const alternate = `%,${likeLiteral(options.query)}%`;
  const result = await sql<PlaceRow>`
    SELECT geonameid, name, country_code, admin1, lat, lon, population, timezone
    FROM geonerva.places
    WHERE name ILIKE ${prefix}
       OR ascii_name ILIKE ${prefix}
       OR alt_names ILIKE ${prefix}
       OR alt_names ILIKE ${alternate}
    ORDER BY (lower(name) = lower(${options.query}) OR lower(ascii_name) = lower(${options.query})) DESC,
             population DESC NULLS LAST,
             geonameid
    LIMIT ${options.limit}
  `.execute(db);
  return [...result.rows];
}

/** One place by its GeoNames id, or `null`. */
export async function placeByGeonameId(
  db: Kysely<DB>,
  geonameid: number,
): Promise<PlaceRow | null> {
  const result = await sql<PlaceRow>`
    SELECT geonameid, name, country_code, admin1, lat, lon, population, timezone
    FROM geonerva.places
    WHERE geonameid = ${geonameid}
  `.execute(db);
  return result.rows[0] ?? null;
}

/**
 * The time zone of the populated place nearest a point, or `null` when no place is loaded.
 *
 * Nominatim returns no time zone and the contract requires one. The nearest GeoNames place is an
 * approximation that is right away from borders and can be wrong within a few kilometres of one;
 * it is labelled as that where it is used, and it never invents a zone when the table is empty.
 */
export async function nearestPlaceTimezone(db: Kysely<DB>, point: LatLon): Promise<string | null> {
  const result = await sql<{ timezone: string }>`
    SELECT timezone
    FROM geonerva.places
    ORDER BY ST_Distance(
      ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
      ST_SetSRID(ST_MakePoint(${point.lon}, ${point.lat}), 4326)::geography
    ), geonameid
    LIMIT 1
  `.execute(db);
  return result.rows[0]?.timezone ?? null;
}

export interface CachedGeocode {
  readonly response: unknown;
  readonly created_at: Date;
}

/** A cached provider answer that has not expired at `now`, or `null`. */
export async function cachedGeocodeResult(
  db: Kysely<DB>,
  options: { readonly key: Buffer; readonly now: Date },
): Promise<CachedGeocode | null> {
  const result = await sql<CachedGeocode>`
    SELECT response, created_at
    FROM geonerva.geocode_cache
    WHERE query_sha256 = ${options.key}
      AND expires_at > ${options.now}
  `.execute(db);
  return result.rows[0] ?? null;
}

/**
 * Stores a provider answer for `ttlMs`, replacing an expired or older one for the same key.
 *
 * An empty answer is stored too. "Nominatim has nothing for this" is an answer, and not caching it
 * would send every repeat of a typo to the provider — the usage pattern the policy's caching rule
 * exists to stop.
 */
export async function storeGeocodeResult(
  db: Kysely<DB>,
  options: {
    readonly key: Buffer;
    readonly provider: string;
    readonly response: unknown;
    readonly now: Date;
    readonly ttlMs: number;
  },
): Promise<void> {
  const expiresAt = new Date(options.now.getTime() + options.ttlMs);
  await sql`
    INSERT INTO geonerva.geocode_cache (query_sha256, provider, response, created_at, expires_at)
    VALUES (${options.key}, ${options.provider}, ${JSON.stringify(options.response)}::jsonb,
            ${options.now}, ${expiresAt})
    ON CONFLICT (query_sha256) DO UPDATE
      SET provider = EXCLUDED.provider,
          response = EXCLUDED.response,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
  `.execute(db);
}
