/**
 * The Nominatim adapter against recorded responses. **No test here reaches the real service**:
 * every request goes to an injected `fetch`, which also records what the adapter sent, so the
 * usage-policy obligations — identifying User-Agent, one attempt, no autocomplete parameters —
 * are asserted on the wire rather than assumed.
 */

import { readFixtureText } from '@geonerva/test-fixtures';
import { describe, expect, it } from 'vitest';

import { GeocoderError } from './geocoder.ts';
import { NominatimGeocoder } from './nominatim.ts';
import { normalizedQuery, providerQuery, reverseCacheKey, searchCacheKey } from './query.ts';

interface Sent {
  readonly url: URL;
  readonly userAgent: string | null;
}

function geocoder(respond: (url: URL) => Response, sent: Sent[] = []): NominatimGeocoder {
  return new NominatimGeocoder({
    contact: 'https://example.org/geonerva-contact',
    resolveHost: () => Promise.resolve(['130.117.76.9']),
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      );
      const headers = new Headers(init?.headers);
      sent.push({ url, userAgent: headers.get('user-agent') });
      return Promise.resolve(respond(url));
    },
  });
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('NominatimGeocoder.search', () => {
  it('reads the recorded Marrakech search, rounding every coordinate to two decimals', async () => {
    const sent: Sent[] = [];
    const results = await geocoder(
      () => json(readFixtureText('nominatim', 'search-marrakech.json')),
      sent,
    ).search('Marrakech');

    expect(results).toHaveLength(3);
    expect(results[0]).toStrictEqual({
      osmType: 'R',
      osmId: '2799538',
      label: 'Marrakech ⵎⵕⵕⴰⴽⵯⵛ مراكش, Maroc ⵍⵎⵖⵔⵉⴱ المغرب',
      countryCode: 'MA',
      admin1: 'Marrakech-Safi ⵎⵕⵕⴰⴽⵛ-ⴰⵙⴼⵉ مراكش-أسفي',
      lat: 31.63,
      lon: -7.99,
      kind: 'city',
    });
    for (const result of results) {
      expect(Number(result.lat.toFixed(2))).toBe(result.lat);
      expect(Number(result.lon.toFixed(2))).toBe(result.lon);
    }
  });

  it('identifies itself, asks for one page, and never for autocomplete', async () => {
    const sent: Sent[] = [];
    await geocoder(() => json('[]'), sent).search('Marrakech');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.userAgent).toBe('GeoNerva/0.1 (+https://example.org/geonerva-contact)');
    expect(sent[0]?.url.host).toBe('nominatim.openstreetmap.org');
    expect(Object.fromEntries(sent[0]?.url.searchParams ?? [])).toStrictEqual({
      q: 'Marrakech',
      format: 'jsonv2',
      limit: '5',
      addressdetails: '1',
    });
  });

  it('answers an empty search with no results', async () => {
    expect(
      await geocoder(() => json(readFixtureText('nominatim', 'search-empty.json'))).search('zzqxv'),
    ).toStrictEqual([]);
  });

  it('reports a 429 as RATE_LIMITED after exactly one attempt — never a retry storm', async () => {
    const sent: Sent[] = [];
    const call = geocoder(
      () =>
        new Response(readFixtureText('nominatim', 'error-429.html'), {
          status: 429,
          headers: { 'content-type': 'text/html' },
        }),
      sent,
    ).search('Marrakech');
    await expect(call).rejects.toMatchObject({ name: 'GeocoderError', failure: 'RATE_LIMITED' });
    expect(sent).toHaveLength(1);
  });

  it('reports a server error as UNAVAILABLE, and a non-list as INVALID_RESPONSE', async () => {
    await expect(geocoder(() => json('oops', 503)).search('x y')).rejects.toMatchObject({
      failure: 'UNAVAILABLE',
    });
    await expect(geocoder(() => json('{"a":1}')).search('x y')).rejects.toMatchObject({
      failure: 'INVALID_RESPONSE',
    });
    await expect(geocoder(() => json('not json')).search('x y')).rejects.toBeInstanceOf(
      GeocoderError,
    );
  });

  it('drops a malformed item rather than failing the whole search', async () => {
    const body = JSON.parse(readFixtureText('nominatim', 'search-marrakech.json')) as unknown[];
    const withBad = JSON.stringify([{ osm_type: 'relation', osm_id: -1 }, ...body]);
    expect(await geocoder(() => json(withBad)).search('Marrakech')).toHaveLength(3);
  });

  it('never puts the query in an error message', async () => {
    const error = await geocoder(() => json('oops', 503))
      .search('23 Rue de la Liberté, Marrakech')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GeocoderError);
    expect((error as Error).message).not.toContain('Liberté');
  });

  it('refuses to exist without a contact', () => {
    expect(() => new NominatimGeocoder({ contact: '  ' })).toThrow(/contact/u);
  });
});

describe('NominatimGeocoder.reverse', () => {
  /** SYNTHETIC: the shape of a `format=jsonv2` reverse answer, built from the recorded search item. */
  const REVERSE = JSON.stringify(
    (JSON.parse(readFixtureText('nominatim', 'search-marrakech.json')) as unknown[])[0],
  );

  it('sends the two-decimal cell, at city level, and reads the place', async () => {
    const sent: Sent[] = [];
    const result = await geocoder(() => json(REVERSE), sent).reverse({ lat: 31.63, lon: -8 });
    expect(Object.fromEntries(sent[0]?.url.searchParams ?? [])).toStrictEqual({
      lat: '31.63',
      lon: '-8.00',
      format: 'jsonv2',
      zoom: '10',
      addressdetails: '1',
    });
    expect(result).toMatchObject({ osmType: 'R', osmId: '2799538', lat: 31.63, lon: -7.99 });
  });

  it('answers a point with nothing there as null', async () => {
    expect(
      await geocoder(() => json('{"error":"Unable to geocode"}')).reverse({ lat: 0, lon: -30 }),
    ).toBeNull();
  });
});

describe('query normalization and cache keys', () => {
  it('makes spellings of one question into one cache key', () => {
    expect(normalizedQuery('  MARRAKECH ')).toBe('marrakech');
    expect(searchCacheKey('Marrakech')).toStrictEqual(searchCacheKey('  marrakech  '));
    expect(searchCacheKey('Marrakech')).not.toStrictEqual(searchCacheKey('Marrakesh'));
    expect(providerQuery('Rue   de\tla Paix')).toBe('Rue de la Paix');
  });

  it('keys a composed and a decomposed accent the same', () => {
    // Visually identical and byte-different: the first is U+00E9, the second `e` + U+0301.
    expect(searchCacheKey('Montréal')).toStrictEqual(searchCacheKey('Montréal'));
  });

  it('keeps search and reverse keys apart, and reverse keys at two decimals', () => {
    expect(reverseCacheKey({ lat: 31.63, lon: -8 })).toStrictEqual(
      reverseCacheKey({ lat: 31.63, lon: -8.0 }),
    );
    expect(reverseCacheKey({ lat: 31.63, lon: -8 })).not.toStrictEqual(
      searchCacheKey('31.63,-8.00'),
    );
    expect(searchCacheKey('x').length).toBe(32);
  });
});
