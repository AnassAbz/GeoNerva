/**
 * The three place endpoints, as the browser sees them (ARCHITECTURE §13.1, ADR-013).
 *
 * `/places/suggest` is free and local — a keystroke never leaves the server, because Nominatim's
 * policy forbids autocomplete. `/places/search` costs a provider call behind a 30-day cache and a
 * global one-per-second ceiling, so it is only ever reached from an explicit submit.
 *
 * Every answer is validated against the **frozen** read-model schema from `@geonerva/domain`
 * rather than a local restatement of it, so the UI either receives the contract's type or an
 * error, and a contract change cannot be absorbed silently by a hand-written interface here.
 */

import {
  formatCoordinateKey,
  placeSearchResponseSchema,
  placeSuggestResponseSchema,
  roundUserCoordinate,
  type PlaceSearchResponse,
  type PlaceSearchResult,
  type PlaceSuggestResponse,
  type PlaceSuggestion,
} from '@geonerva/domain';

import { placeSlug } from '../view/routes.ts';
import { apiGet, type ApiRequest } from './api-client.ts';
import { normalizeLongitude } from './coordinates.ts';

/** §13.1 caps suggestions at ten; eight is what the list shows without scrolling. */
export const SUGGEST_LIMIT = 8;

/** `params.ts`: "String params are length-capped." The input carries the same cap. */
export const MAX_QUERY_LENGTH = 64;

/** The shortest query the API accepts (`parseQuery`: "must be at least 2 characters"). */
export const MIN_QUERY_LENGTH = 2;

/** The seam the search box depends on. The default talks to the API; tests supply a double. */
export interface PlacesClient {
  suggest: (query: string, request?: ApiRequest) => Promise<PlaceSuggestResponse>;
  search: (query: string, request?: ApiRequest) => Promise<PlaceSearchResponse>;
}

export const places: PlacesClient = {
  suggest: (query, request) =>
    apiGet(
      `/api/v1/places/suggest?q=${encodeURIComponent(query)}&limit=${String(SUGGEST_LIMIT)}`,
      placeSuggestResponseSchema,
      request,
    ),
  search: (query, request) =>
    apiGet(
      `/api/v1/places/search?q=${encodeURIComponent(query)}`,
      placeSearchResponseSchema,
      request,
    ),
};

/** `/place/marrakech-ma-2542997` — a GeoNames suggestion carries the id the slug is built on. */
export function hrefForSuggestion(suggestion: PlaceSuggestion): string {
  return `/place/${placeSlug(suggestion)}`;
}

/**
 * `/place/@31.63,-8.00` — a geocoder result is addressed by its **rounded coordinates**, never
 * by its own key.
 *
 * This is not a shortcut. A `/places/search` result carries an `n:<osm type><osm id>` key, and
 * `n:` is a key nothing resolves: `parseLocation` accepts only `p:` and `c:`, and says so in its
 * own failure message. Worse, `placeSlug` does not special-case it, so `n:N12345` would be
 * written `paris-fr-N12345` and read back by `locationKeyFromSlug` as either nothing at all or —
 * for an all-digit OSM id — `p:12345`, a **different place** with that GeoNames id. Coordinates
 * are the one form that is both addressable and true, and the contract already guarantees they
 * arrive rounded (invariant I15). Rounding again here costs nothing and removes the assumption.
 */
export function hrefForSearchResult(result: PlaceSearchResult): string {
  return hrefForCoordinate(result.lat, result.lon);
}

/** The route for a position: the `@lat,lon` slug §6.1 defines, at two decimals and no more. */
export function hrefForCoordinate(lat: number, lon: number): string {
  const key = formatCoordinateKey({
    lat: roundUserCoordinate(lat),
    lon: normalizeLongitude(roundUserCoordinate(lon)),
  });
  return `/place/${placeSlug({ key, label: '', countryCode: null })}`;
}
