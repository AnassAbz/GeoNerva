/**
 * Query normalization and cache keys.
 *
 * `geocode_cache` is keyed by a hash of the normalized query, "so the raw query is not stored"
 * (migration 0006): a search term is something a person typed, often their own town. Normalizing
 * before hashing is also what makes the cache useful — `Marrakech`, ` marrakech ` and `MARRAKECH`
 * are one question and must be one entry, both for the hit rate and for GeoNerva's standing under
 * the OSMF policy, which asks for exactly this caching.
 */

import { createHash } from 'node:crypto';

import type { LatLon } from '@geonerva/domain';

/** The spelling sent to the provider: trimmed, inner whitespace collapsed, Unicode NFC. */
export function providerQuery(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** The spelling the cache is keyed on: the provider spelling, case-folded. */
export function normalizedQuery(raw: string): string {
  return providerQuery(raw).toLocaleLowerCase('und');
}

/** The cache key for a free-text search. */
export function searchCacheKey(raw: string): Buffer {
  return sha256(`search\u0000${normalizedQuery(raw)}`);
}

/**
 * The cache key for a reverse lookup of an already-rounded point.
 *
 * Fixed to two decimals, so the key is the same two-decimal cell the request was allowed to name
 * and can never carry more precision than the caller was allowed to send (ADR-015).
 */
export function reverseCacheKey(point: LatLon): Buffer {
  return sha256(`reverse\u0000${point.lat.toFixed(2)},${point.lon.toFixed(2)}`);
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
