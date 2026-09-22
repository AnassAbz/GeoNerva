/**
 * The provider interface (ADR-013): free-text search on submit, and reverse geocoding.
 *
 * Type-ahead is not here. It is served from the local GeoNames table so that keystrokes never
 * leave the server, and a provider that offered it would be one GeoNerva is not allowed to use for
 * it — Nominatim's usage policy forbids autocomplete outright.
 *
 * The interface is what lets a deployment swap Nominatim for paid OpenCage or a self-hosted
 * Photon without touching a caller.
 */

import type { LatLon, OsmType } from '@geonerva/domain';

/** One provider result, before GeoNerva gives it a location key. */
export interface GeocodeResult {
  readonly osmType: OsmType;
  readonly osmId: string;
  readonly label: string;
  /** ISO 3166-1 alpha-2, upper case, or `null` when the provider gave none. */
  readonly countryCode: string | null;
  readonly admin1: string | null;
  /** Rounded to two decimals (invariant I15) before it leaves this package. */
  readonly lat: number;
  readonly lon: number;
  /** The provider's own place classification, verbatim, e.g. `city`. */
  readonly kind: string | null;
}

export interface Geocoder {
  /** The provider's name, as the cache records it. */
  readonly provider: string;
  search(query: string): Promise<readonly GeocodeResult[]>;
  /** The place at a point, or `null` when the provider has none there (open ocean, say). */
  reverse(point: LatLon): Promise<GeocodeResult | null>;
}

/** Why a provider call failed, in the terms a caller acts on. */
export const GEOCODER_FAILURES = ['RATE_LIMITED', 'UNAVAILABLE', 'INVALID_RESPONSE'] as const;
export type GeocoderFailure = (typeof GEOCODER_FAILURES)[number];

/**
 * A failed provider call. The message never carries the query: a search term is something a
 * person typed, and it reaches logs through error messages more often than through anything else.
 */
export class GeocoderError extends Error {
  readonly failure: GeocoderFailure;

  constructor(failure: GeocoderFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GeocoderError';
    this.failure = failure;
  }
}
