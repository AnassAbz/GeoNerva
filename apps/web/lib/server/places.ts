/**
 * `GET /api/v1/places/suggest`, `/places/search` and `/places/reverse` (ARCHITECTURE §13.1,
 * ADR-013, ADR-028).
 *
 * ### Two very different costs
 *
 * **Suggestions are free and local.** They are read from the GeoNames table, so a keystroke never
 * leaves the server — Nominatim's policy forbids autocomplete, and a type-ahead that proxied it
 * would get the deployment banned.
 *
 * **Search and reverse cost a call to a public service that can ban us.** Every such call goes
 * through the same three steps, in this order:
 *
 *  1. **The 30-day cache**, keyed by a hash of the normalized query, so the text itself is never
 *     stored. A hit calls nobody. An empty answer is cached too: "Nominatim has nothing for this"
 *     is an answer, and not caching it sends every repeat of a typo to the provider.
 *  2. **The global ceiling of one request per second**, shared by search and reverse, enforced in
 *     the database so every instance agrees, and **fail-closed**: if the counter cannot be read,
 *     the provider is not called.
 *  3. **One provider attempt**, never a retry. A failure is `UPSTREAM_UNAVAILABLE` and is not
 *     cached, so the next request may succeed.
 *
 * A cached answer is re-validated on read. The cache is data written by an earlier version of
 * this code, and a row it cannot read is treated as a miss rather than served.
 */

import {
  READ_MODEL_SCHEMA_VERSION,
  formatCoordinateKey,
  formatNominatimKey,
  formatPlaceKey,
  roundUserCoordinate,
  type PlaceSearchResponse,
  type PlaceSearchResult,
  type PlaceSuggestResponse,
} from '@geonerva/domain';
import {
  GeocoderError,
  providerQuery,
  reverseCacheKey,
  searchCacheKey,
  type GeocodeResult,
} from '@geonerva/geocoding';
import { z } from 'zod';

import { webConfig } from './config.ts';
import {
  cachedGeocodeResult,
  nearestPlaceTimezone,
  storeGeocodeResult,
  suggestPlaces,
  type Kysely,
} from './db.ts';
import { GEONAMES_ATTRIBUTION, OSM_ATTRIBUTION, geocoder } from './geocoder.ts';
import { ApiProblemError } from './problem.ts';
import { enforceRateLimit } from './rate-limit.ts';

/** How long a provider answer is reused (ADR-013, the OSMF policy's caching requirement). */
export const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** §13.1: `limit ≤ 10` for suggestions. */
export const MAX_SUGGESTIONS = 10;
export const DEFAULT_SUGGESTIONS = 5;

export async function getPlaceSuggestions(
  db: Kysely,
  request: { readonly query: string; readonly limit: number },
): Promise<PlaceSuggestResponse> {
  const rows = await suggestPlaces(db, { query: request.query, limit: request.limit });
  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    query: request.query,
    suggestions: rows.map((row) => ({
      key: formatPlaceKey(row.geonameid),
      label: row.country_code === null ? row.name : `${row.name}, ${row.country_code}`,
      countryCode: row.country_code,
      admin1: row.admin1,
      lat: row.lat,
      lon: row.lon,
      population: row.population,
      timezone: row.timezone,
    })),
    attribution: [GEONAMES_ATTRIBUTION],
  };
}

export interface ProviderRequest {
  readonly now: Date;
  /** Required by the limiter's signature; the ceiling itself is scoped to the deployment, not the caller. */
  readonly headers: Headers;
}

export async function searchPlaces(
  db: Kysely,
  request: ProviderRequest & { readonly query: string },
): Promise<PlaceSearchResponse> {
  const key = searchCacheKey(request.query);
  const { results, fromCache } = await throughCache(db, request, key, async () => [
    ...(await geocoder().search(providerQuery(request.query))),
  ]);
  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    query: request.query,
    results: await Promise.all(
      results.map(async (result) => ({
        key: formatNominatimKey(result.osmType, result.osmId),
        label: result.label,
        countryCode: result.countryCode,
        admin1: result.admin1,
        lat: result.lat,
        lon: result.lon,
        timezone: await timezoneNear(db, result),
        kind: result.kind,
      })),
    ),
    fromCache,
    attribution: [OSM_ATTRIBUTION],
  };
}

/**
 * A label for a two-decimal cell. The result is keyed by the **requested** cell (`c:`) — the
 * question was "what is here", and the answer is about the cell the caller named, not about the
 * provider's centroid for the city around it.
 */
export async function reversePlace(
  db: Kysely,
  request: ProviderRequest & { readonly lat: number; readonly lon: number },
): Promise<PlaceSearchResponse> {
  const point = { lat: request.lat, lon: request.lon };
  const key = reverseCacheKey(point);
  const { results, fromCache } = await throughCache(db, request, key, async () => {
    const found = await geocoder().reverse(point);
    return found === null ? [] : [found];
  });
  const answers: PlaceSearchResult[] = await Promise.all(
    results.map(async (result) => ({
      key: formatCoordinateKey(point),
      label: result.label,
      countryCode: result.countryCode,
      admin1: result.admin1,
      lat: point.lat,
      lon: point.lon,
      timezone: await timezoneNear(db, point),
      kind: result.kind,
    })),
  );
  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    query: `${request.lat.toFixed(2)},${request.lon.toFixed(2)}`,
    results: answers,
    fromCache,
    attribution: [OSM_ATTRIBUTION],
  };
}

/** The shape stored in `geocode_cache.response`, re-validated when it is read back. */
const cachedResultsSchema = z.array(
  z.object({
    osmType: z.enum(['N', 'W', 'R']),
    osmId: z.string().regex(/^[1-9]\d{0,18}$/u),
    label: z.string().min(1),
    countryCode: z.string().nullable(),
    admin1: z.string().nullable(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    kind: z.string().nullable(),
  }),
);

async function throughCache(
  db: Kysely,
  request: ProviderRequest,
  key: Buffer,
  call: () => Promise<GeocodeResult[]>,
): Promise<{ results: GeocodeResult[]; fromCache: boolean }> {
  const cached = await cachedGeocodeResult(db, { key, now: request.now });
  if (cached !== null) {
    const parsed = cachedResultsSchema.safeParse(cached.response);
    if (parsed.success) return { results: parsed.data, fromCache: true };
  }

  await enforceRateLimit({
    db: () => db,
    headers: request.headers,
    now: request.now,
    name: 'placesSearchGlobal',
    secret: webConfig().RATE_LIMIT_SECRET,
    globalScope: 'nominatim',
    failClosed: true,
  });

  let results: GeocodeResult[];
  try {
    results = await call();
  } catch (error) {
    if (error instanceof GeocoderError) {
      throw new ApiProblemError({
        code: 'UPSTREAM_UNAVAILABLE',
        detail:
          error.failure === 'RATE_LIMITED'
            ? 'The place-search provider is asking GeoNerva to slow down. Try again in a minute.'
            : 'The place-search provider could not be reached. Suggestions from the local list still work.',
        retryAfterS: 60,
      });
    }
    throw error;
  }

  await storeGeocodeResult(db, {
    key,
    provider: geocoder().provider,
    response: results,
    now: request.now,
    ttlMs: GEOCODE_CACHE_TTL_MS,
  });
  return { results, fromCache: false };
}

/**
 * The time zone of the nearest GeoNames place — an approximation, right away from borders.
 * Nominatim gives none, and the contract requires one; an empty string says "unknown" when no
 * place is loaded, rather than naming a zone GeoNerva does not know.
 */
async function timezoneNear(
  db: Kysely,
  point: { readonly lat: number; readonly lon: number },
): Promise<string> {
  return (
    (await nearestPlaceTimezone(db, {
      lat: roundUserCoordinate(point.lat),
      lon: roundUserCoordinate(point.lon),
    })) ?? ''
  );
}
