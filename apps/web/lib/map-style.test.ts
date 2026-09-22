import { describe, expect, it } from 'vitest';

import { DEFAULT_MAP_STYLE_URL, MapStyleUrlError, parseMapStyleUrl } from './map-style.ts';

describe('parseMapStyleUrl (F-16)', () => {
  it('defaults to the OpenFreeMap dark style', () => {
    expect(parseMapStyleUrl(undefined)).toEqual({
      url: DEFAULT_MAP_STYLE_URL,
      origin: 'https://tiles.openfreemap.org',
    });
    expect(parseMapStyleUrl('  ').origin).toBe('https://tiles.openfreemap.org');
  });

  it('keeps only the origin for the CSP', () => {
    expect(parseMapStyleUrl('https://tiles.example.org:8443/styles/dark.json').origin).toBe(
      'https://tiles.example.org:8443',
    );
  });

  it.each([
    ['a directive injection', 'https://tiles.example.org/s.json;script-src *'],
    ['a list separator', 'https://a.example.org,https://b.example.org'],
    ['whitespace', 'https://tiles.example.org/s.json script-src'],
    ['a quote', "https://tiles.example.org/'unsafe-inline'"],
    ['plain http', 'http://tiles.example.org/style.json'],
    ['credentials', 'https://user:pw@tiles.example.org/style.json'],
    ['not a URL', 'tiles.example.org/style.json'],
  ])('refuses %s', (_label, value) => {
    expect(() => parseMapStyleUrl(value)).toThrow(MapStyleUrlError);
  });
});
