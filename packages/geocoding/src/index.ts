/**
 * @geonerva/geocoding — place search behind a provider interface (ADR-013, ADR-028).
 *
 * The only package the web app may use to reach an external host (Nominatim). It depends on
 * @geonerva/http for the host allowlist, timeouts and size caps, and never on provider adapters.
 * It holds no database access: the cache and the global request ceiling belong to the caller.
 */

export { GEOCODER_FAILURES, GeocoderError } from './geocoder.ts';
export type { GeocodeResult, Geocoder, GeocoderFailure } from './geocoder.ts';

export { NOMINATIM_HOST, NOMINATIM_SEARCH_LIMIT, NominatimGeocoder } from './nominatim.ts';
export type { NominatimOptions } from './nominatim.ts';

export { normalizedQuery, providerQuery, reverseCacheKey, searchCacheKey } from './query.ts';
