/**
 * App routes (docs/PRODUCT.md §6.1) and the mapping from read-model references to them.
 *
 * The API's `href` fields point at `/events/…` and `/fires/…`, while the product routes are
 * `/event/[publicId]` and `/fire/[publicId]`. The UI therefore builds links from the subject
 * reference rather than trusting `href` verbatim, so a link never leads to a route that does not
 * exist. (Reported to the orchestrator for P9b: either the API's `href` changes or this stays.)
 */

import type { ChangeWindow, LocationRef } from '@geonerva/domain';

/** `/event/EQ-26-7K3F9Q` for `CE:…`, `/fire/FR-26-4HX2MB` for `FC:…`, `null` otherwise. */
export function subjectHref(subjectRef: string, place?: string): string | null {
  const separator = subjectRef.indexOf(':');
  const tag = subjectRef.slice(0, separator);
  const id = subjectRef.slice(separator + 1);
  const query = place === undefined ? '' : `?place=${encodeURIComponent(place)}`;
  if (tag === 'CE') return `/event/${encodeURIComponent(id)}${query}`;
  if (tag === 'FC') return `/fire/${encodeURIComponent(id)}${query}`;
  return null;
}

/** `marrakech-ma-2542997` for a GeoNames place; `@31.63,-8.00` for coordinates. */
export function placeSlug(location: Pick<LocationRef, 'key' | 'label' | 'countryCode'>): string {
  if (location.key.startsWith('c:')) return `@${location.key.slice(2)}`;
  const name = (location.label.split(',')[0] ?? location.label)
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
  const country = (location.countryCode ?? 'xx').toLowerCase();
  const id = location.key.slice(location.key.indexOf(':') + 1);
  return `${name}-${country}-${id}`;
}

/**
 * The location key a slug names, or `null` when it is malformed. The trailing number of a named
 * slug is the GeoNames id; the name part is decoration and is not trusted.
 */
export function locationKeyFromSlug(slug: string): string | null {
  const decoded = safeDecode(slug);
  if (decoded === null) return null;
  const coordinates = /^@(-?\d{1,2}\.\d{2}),(-?\d{1,3}\.\d{2})$/u.exec(decoded);
  if (coordinates !== null) return `c:${coordinates[1] ?? ''},${coordinates[2] ?? ''}`;
  const named = /^[a-z0-9-]+-[a-z]{2}-([1-9]\d{0,9})$/u.exec(decoded);
  if (named !== null) return `p:${named[1] ?? ''}`;
  return null;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export interface PlaceQuery {
  readonly window?: ChangeWindow;
  readonly asOf?: string;
}

export function placeHref(slug: string, query: PlaceQuery = {}): string {
  const params = new URLSearchParams();
  if (query.window !== undefined && query.window !== '24h') params.set('window', query.window);
  if (query.asOf !== undefined) params.set('as_of', query.asOf);
  const search = params.toString();
  return `/place/${slug}${search === '' ? '' : `?${search}`}`;
}
