/**
 * Nominatim (OSMF public instance), for submit-time search and reverse geocoding (ADR-013).
 *
 * The usage policy shapes every line here, because breaking it gets the whole deployment banned
 * (SECURITY.md H3):
 *
 *  - **An identifying User-Agent with a contact**, from `NOMINATIM_CONTACT`.
 *  - **One attempt, never a retry.** A retry storm against a public service is exactly the abuse
 *    the policy forbids, and the recorded 429 fixture says so: back off, serve the cache. The
 *    ≤ 1 request/s global ceiling and the 30-day cache live in the caller, which holds the
 *    database this package may not touch (ADR-028).
 *  - **No autocomplete.** This is called on submit only; type-ahead is local.
 *
 * The response is untrusted input. It is parsed with a schema, bounded in size by the HTTP client,
 * and reduced to the few fields GeoNerva shows, with coordinates rounded to two decimals before
 * they leave this module (invariant I15).
 */

import { OSM_TYPES, roundUserCoordinate, type LatLon, type OsmType } from '@geonerva/domain';
import { HttpClient, SourceFetchError, type HttpClientOptions } from '@geonerva/http';
import { z } from 'zod';

import { GeocoderError, type GeocodeResult, type Geocoder } from './geocoder.ts';

export const NOMINATIM_HOST = 'nominatim.openstreetmap.org';

/** Results per search. Enough to disambiguate a name; more would only be more to cache. */
export const NOMINATIM_SEARCH_LIMIT = 5;

/** A person is waiting on the other end of this call. */
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 256 * 1024;

export interface NominatimOptions {
  /** A URL or e-mail address for the operator, as the usage policy requires. */
  readonly contact: string;
  /** Injected for tests, so that nothing here ever calls the real service in a test run. */
  readonly fetchImpl?: HttpClientOptions['fetchImpl'];
  readonly resolveHost?: HttpClientOptions['resolveHost'];
}

/** The fields of a `format=jsonv2` item GeoNerva reads. Everything else is ignored. */
const itemSchema = z.object({
  osm_type: z.enum(['node', 'way', 'relation']),
  osm_id: z.number().int().positive(),
  lat: z.string().regex(/^-?\d{1,3}(?:\.\d+)?$/u),
  lon: z.string().regex(/^-?\d{1,3}(?:\.\d+)?$/u),
  name: z.string().nullable().optional(),
  display_name: z.string(),
  addresstype: z.string().nullable().optional(),
  address: z
    .object({
      country_code: z.string().optional(),
      state: z.string().optional(),
    })
    .partial()
    .optional(),
});

const OSM_TYPE: Readonly<Record<'node' | 'way' | 'relation', OsmType>> = {
  node: 'N',
  way: 'W',
  relation: 'R',
};

export class NominatimGeocoder implements Geocoder {
  readonly provider = 'nominatim';
  readonly #http: HttpClient;

  constructor(options: NominatimOptions) {
    if (options.contact.trim() === '') {
      throw new Error('NominatimGeocoder: a contact is required by the usage policy');
    }
    this.#http = new HttpClient({
      allowedHosts: [NOMINATIM_HOST],
      userAgent: `GeoNerva/0.1 (+${options.contact.trim()})`,
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      retry: { maxAttempts: 1 },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
    });
  }

  async search(query: string): Promise<readonly GeocodeResult[]> {
    const url = new URL(`https://${NOMINATIM_HOST}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(NOMINATIM_SEARCH_LIMIT));
    url.searchParams.set('addressdetails', '1');
    const body = await this.#get(url);
    if (!Array.isArray(body)) {
      throw new GeocoderError('INVALID_RESPONSE', 'Nominatim search did not return a list');
    }
    return body.map(toResult).filter((result): result is GeocodeResult => result !== null);
  }

  async reverse(point: LatLon): Promise<GeocodeResult | null> {
    const url = new URL(`https://${NOMINATIM_HOST}/reverse`);
    url.searchParams.set('lat', point.lat.toFixed(2));
    url.searchParams.set('lon', point.lon.toFixed(2));
    url.searchParams.set('format', 'jsonv2');
    // City level: a place name for a two-decimal cell, not a street address inside it.
    url.searchParams.set('zoom', '10');
    url.searchParams.set('addressdetails', '1');
    const body = await this.#get(url);
    // Nominatim answers a point with nothing there as `{ "error": "Unable to geocode" }`.
    if (typeof body === 'object' && body !== null && 'error' in body) return null;
    const result = toResult(body);
    if (result === null) {
      throw new GeocoderError('INVALID_RESPONSE', 'Nominatim reverse returned an unreadable place');
    }
    return result;
  }

  async #get(url: URL): Promise<unknown> {
    let text: string;
    try {
      const response = await this.#http.get(url.toString(), {
        headers: { accept: 'application/json' },
      });
      text = new TextDecoder().decode(response.body);
    } catch (error) {
      if (error instanceof SourceFetchError && error.errorClass === 'RATE_LIMITED') {
        throw new GeocoderError('RATE_LIMITED', 'Nominatim is throttling this deployment', {
          cause: error,
        });
      }
      throw new GeocoderError('UNAVAILABLE', 'Nominatim could not be reached', { cause: error });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new GeocoderError('INVALID_RESPONSE', 'Nominatim returned something that is not JSON', {
        cause: error,
      });
    }
  }
}

/**
 * One item, or `null` when it is not the shape GeoNerva reads. A malformed item is dropped
 * rather than failing the search: one odd result among five should not cost a person the other
 * four.
 */
function toResult(raw: unknown): GeocodeResult | null {
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const osmType = OSM_TYPE[item.osm_type];
  if (!(OSM_TYPES as readonly string[]).includes(osmType)) return null;
  const lat = roundUserCoordinate(Number(item.lat));
  const lon = roundUserCoordinate(Number(item.lon) === 180 ? -180 : Number(item.lon));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  const countryCode = item.address?.country_code;
  return {
    osmType,
    osmId: String(item.osm_id),
    label: labelOf(item),
    countryCode:
      countryCode !== undefined && /^[a-z]{2}$/iu.test(countryCode)
        ? countryCode.toUpperCase()
        : null,
    admin1: item.address?.state ?? null,
    lat,
    lon,
    kind: item.addresstype ?? null,
  };
}

/**
 * A readable label: the place's own name and its country, from the provider's display name.
 *
 * The full `display_name` runs to five administrative levels in three scripts, so it is cut to its
 * first and last components and capped. The provider's words are kept; GeoNerva adds none.
 */
function labelOf(item: z.infer<typeof itemSchema>): string {
  const parts = item.display_name
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const first =
    item.name !== undefined && item.name !== null && item.name !== '' ? item.name : parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const label = last === undefined || last === first ? (first ?? '') : `${first ?? ''}, ${last}`;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}
