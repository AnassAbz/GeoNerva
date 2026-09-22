/**
 * The web process's one outbound dependency: a `Geocoder` for submit-time search and reverse
 * lookups (ADR-013, ADR-028).
 *
 * Built lazily from `NOMINATIM_CONTACT`, which the usage policy requires in the User-Agent, and
 * replaceable in tests so that **no test ever calls the real service** — the integration suite
 * installs a recording fake through `setGeocoderForTesting`.
 */

import type { Attribution } from '@geonerva/domain';
import { NominatimGeocoder, type Geocoder } from '@geonerva/geocoding';

import { webConfig } from './config.ts';

let instance: Geocoder | null = null;

export function geocoder(): Geocoder {
  instance ??= new NominatimGeocoder({ contact: webConfig().NOMINATIM_CONTACT });
  return instance;
}

/** Replaces the geocoder. Tests only. */
export function setGeocoderForTesting(replacement: Geocoder | null): void {
  instance = replacement;
}

/**
 * The attribution the place endpoints carry, in the words of DATA_SOURCES.md §9:
 * "Place search: © OpenStreetMap contributors (ODbL) via Nominatim; GeoNames (CC BY 4.0)".
 *
 * Constants rather than rows: neither is an ingestion source, so neither is in `sources`.
 */
export const GEONAMES_ATTRIBUTION: Attribution = {
  sourceId: 'geonames',
  name: 'GeoNames',
  homepage: 'https://www.geonames.org/',
  licence: 'CC BY 4.0',
  attributionText: 'Place names: GeoNames (CC BY 4.0).',
  termsUrl: 'https://creativecommons.org/licenses/by/4.0/',
  disclaimer: null,
};

export const OSM_ATTRIBUTION: Attribution = {
  sourceId: 'nominatim',
  name: 'OpenStreetMap via Nominatim',
  homepage: 'https://nominatim.openstreetmap.org/',
  licence: 'ODbL 1.0',
  attributionText: '© OpenStreetMap contributors (ODbL), via Nominatim.',
  termsUrl: 'https://www.openstreetmap.org/copyright',
  disclaimer: null,
};
