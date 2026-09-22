/**
 * The three place endpoints as the browser calls them, and the routes their answers become.
 *
 * The second half is the interesting one. A `/places/search` answer cannot be addressed by its
 * own key — see `hrefForSearchResult` — and the guard test below is what keeps that from being
 * quietly "fixed" back into a broken link.
 */

import {
  READ_MODEL_SCHEMA_VERSION,
  type Attribution,
  type PlaceSearchResponse,
  type PlaceSearchResult,
  type PlaceSuggestResponse,
} from '@geonerva/domain';
import { describe, expect, it, vi } from 'vitest';

import { PLACE_SUGGESTIONS } from '../fixtures/index.ts';
import { locationKeyFromSlug, placeSlug } from '../view/routes.ts';
import { ApiClientError, type Transport } from './api-client.ts';
import {
  SUGGEST_LIMIT,
  hrefForCoordinate,
  hrefForSearchResult,
  hrefForSuggestion,
  places,
} from './places.ts';

const ATTRIBUTION: Attribution = {
  sourceId: 'geonames',
  name: 'GeoNames',
  homepage: null,
  licence: 'CC BY 4.0',
  attributionText: 'GeoNames',
  termsUrl: null,
  disclaimer: null,
};

const MARRAKECH = PLACE_SUGGESTIONS[0];
if (MARRAKECH === undefined) throw new Error('the suggestion fixture is empty');

const SUGGEST_ANSWER: PlaceSuggestResponse = {
  schemaVersion: READ_MODEL_SCHEMA_VERSION,
  query: 'Marr',
  suggestions: [MARRAKECH],
  attribution: [ATTRIBUTION],
};

const NOMINATIM_RESULT: PlaceSearchResult = {
  key: 'n:N12345',
  label: 'Marrakesh, Marrakesh-Safi, Morocco',
  countryCode: 'MA',
  admin1: 'Marrakesh-Safi',
  lat: 31.63,
  lon: -8,
  timezone: 'Africa/Casablanca',
  kind: 'city',
};

const SEARCH_ANSWER: PlaceSearchResponse = {
  schemaVersion: READ_MODEL_SCHEMA_VERSION,
  query: 'Marrakesh',
  results: [NOMINATIM_RESULT],
  fromCache: true,
  attribution: [ATTRIBUTION],
};

function answering(body: unknown): Transport {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ),
  );
}

function requestedPath(transport: Transport): string {
  return vi.mocked(transport).mock.calls[0]?.[0] ?? '';
}

describe('the places client', () => {
  it('asks the local type-ahead endpoint, with the query encoded and the limit the contract caps', async () => {
    const transport = answering(SUGGEST_ANSWER);
    await places.suggest('Marr', { transport });
    expect(requestedPath(transport)).toBe(
      `/api/v1/places/suggest?q=Marr&limit=${String(SUGGEST_LIMIT)}`,
    );
    expect(SUGGEST_LIMIT).toBeLessThanOrEqual(10);
  });

  it('encodes a query that would otherwise change the shape of the URL', async () => {
    const transport = answering(SUGGEST_ANSWER);
    await places.suggest('Saint-Louis du Nord&limit=99', { transport });
    expect(requestedPath(transport)).toBe(
      `/api/v1/places/suggest?q=Saint-Louis%20du%20Nord%26limit%3D99&limit=${String(SUGGEST_LIMIT)}`,
    );
  });

  it('asks the geocoding endpoint only by its own path', async () => {
    const transport = answering(SEARCH_ANSWER);
    const answer = await places.search('Marrakesh', { transport });
    expect(requestedPath(transport)).toBe('/api/v1/places/search?q=Marrakesh');
    expect(answer.results).toHaveLength(1);
  });

  it('refuses an answer that does not satisfy the frozen schema', async () => {
    const transport = answering({ ...SUGGEST_ANSWER, suggestions: [{ key: 'nonsense' }] });
    await expect(places.suggest('Marr', { transport })).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe('the route a place answer becomes', () => {
  it('sends a GeoNames suggestion to its named slug', () => {
    expect(hrefForSuggestion(MARRAKECH)).toBe('/place/marrakech-ma-2542997');
    expect(locationKeyFromSlug('marrakech-ma-2542997')).toBe(MARRAKECH.key);
  });

  it('sends a geocoder result to its rounded coordinates, which resolve', () => {
    const href = hrefForSearchResult(NOMINATIM_RESULT);
    expect(href).toBe('/place/@31.63,-8.00');
    expect(locationKeyFromSlug(href.slice('/place/'.length))).toBe('c:31.63,-8.00');
  });

  /*
   * The reason for the rule above. `n:` keys are accepted by `isLocationKey` and resolved by
   * nothing — `parseLocation` takes `p:` and `c:` — and a slug built from one either resolves to
   * nothing or, for an all-digit OSM id, reads back as a **GeoNames** id: a different place
   * entirely. `placeSlug` now refuses the key rather than writing a slug that lies, so this
   * asserts the refusal; `hrefForSearchResult` never reaches it, because it addresses a geocoder
   * result by its rounded coordinates.
   */
  it('never addresses a geocoder result by its own key, which does not round-trip', () => {
    expect(() => placeSlug(NOMINATIM_RESULT)).toThrow(/not an addressable location key/u);
    expect(() => placeSlug({ ...NOMINATIM_RESULT, key: 'n:12345' })).toThrow();
    // The route it does produce round-trips exactly.
    const href = hrefForSearchResult(NOMINATIM_RESULT);
    expect(locationKeyFromSlug(href.slice('/place/'.length))).toBe('c:31.63,-8.00');
  });

  it('rounds a coordinate before it reaches the URL (invariant I15)', () => {
    expect(hrefForCoordinate(31.6315, -8.0049)).toBe('/place/@31.63,-8.00');
    expect(hrefForCoordinate(48.856614, 2.352222)).toBe('/place/@48.86,2.35');
    expect(hrefForCoordinate(-0.001, -0.002)).toBe('/place/@0.00,0.00');
  });
});
