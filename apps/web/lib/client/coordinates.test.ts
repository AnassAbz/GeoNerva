/**
 * Coordinate entry, and the differential check that keeps it honest.
 *
 * The client parser exists because invariant I15 obliges the *browser* to round — `params.ts`
 * says in its own header that a server cannot round a value the CDN has already keyed. But two
 * parsers for one rule is exactly the duplication this repository keeps refusing to write, and
 * the boundary scan (`lib/server/server-boundary.test.ts`) forbids a `'use client'` module from
 * importing the server's. A test is not a client module, so the agreement is asserted here: every
 * coordinate the client produces is fed to the server's own `parseLocation`, which must accept it
 * **unchanged**. If either side's idea of "rounded", "in range" or "normalized" drifts, this
 * fails.
 */

import { USER_COORDINATE_DECIMALS } from '@geonerva/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseLocation } from '../server/params.ts';
import { isCoordinateEntry, parseCoordinateEntry } from './coordinates.ts';

/** What the visitor typed, and the position GeoNerva is allowed to know. */
const TYPED: readonly (readonly [string, number, number])[] = [
  ['31.63, -8', 31.63, -8],
  ['31.63,-8', 31.63, -8],
  ['31.63 -8', 31.63, -8],
  ['31.63, -8.00', 31.63, -8],
  ['  31.63 ,  -8.00  ', 31.63, -8],
  ['31.63; -8', 31.63, -8],
  ['+31.63, -8', 31.63, -8],
  ['-33.87, 151.21', -33.87, 151.21],
  ['0, 0', 0, 0],
  ['31.63°, -8.00°', 31.63, -8],
  // Hemisphere letters, which Nominatim understands and people type.
  ['31.63 N, 8.00 W', 31.63, -8],
  ['31.63N, 8.00W', 31.63, -8],
  ['31.63n, 8w', 31.63, -8],
  ['N 31.63 W 8.00', 31.63, -8],
  // Letters say which is which, so longitude may come first.
  ['8.00 W, 31.63 N', 31.63, -8],
  ['31.63 S, 8.00 E', -31.63, 8],
];

describe('parseCoordinateEntry', () => {
  for (const [typed, lat, lon] of TYPED) {
    it(`reads ${JSON.stringify(typed)} as ${String(lat)}, ${String(lon)}`, () => {
      expect(parseCoordinateEntry(typed)).toEqual({
        kind: 'coordinate',
        lat,
        lon,
        wasRounded: false,
      });
    });
  }

  it('rounds a precise position to two decimals and says that it did', () => {
    expect(parseCoordinateEntry('48.856614, 2.352222')).toEqual({
      kind: 'coordinate',
      lat: 48.86,
      lon: 2.35,
      wasRounded: true,
    });
  });

  it('folds a negative zero, which would otherwise be a second spelling of one place', () => {
    const entry = parseCoordinateEntry('-0.001, -0.002');
    expect(entry).toEqual({ kind: 'coordinate', lat: 0, lon: 0, wasRounded: true });
    if (entry.kind === 'coordinate') {
      expect(Object.is(entry.lat, -0)).toBe(false);
      expect(Object.is(entry.lon, -0)).toBe(false);
    }
  });

  it('normalizes a longitude that rounds up onto the antimeridian', () => {
    // 179.999 rounds to exactly 180, which the domain refuses to key; −180 is the same meridian.
    expect(parseCoordinateEntry('0, 179.999')).toMatchObject({ lat: 0, lon: -180 });
  });

  it('refuses a pair that is not on the globe', () => {
    expect(parseCoordinateEntry('91, 0').kind).toBe('out-of-range');
    expect(parseCoordinateEntry('0, 181').kind).toBe('out-of-range');
    expect(parseCoordinateEntry('-91, 0').kind).toBe('out-of-range');
  });

  it('reports sexagesimal rather than guessing at it', () => {
    for (const typed of [
      '31°37\'48"N 8°00\'00"W',
      '31:37:48 N, 8:00:00 W',
      '31° 37.800 N, 8° 00.000 W',
      '31 37 48 N, 8 0 0 W',
      "31°37'N",
    ]) {
      expect(parseCoordinateEntry(typed).kind).toBe('sexagesimal');
    }
  });

  it('is not fooled by ordinary text', () => {
    for (const typed of [
      '',
      'Marrakech',
      'Marrakech, Morocco',
      '10 Downing Street',
      'Route 66',
      '31.63',
      '31.63,',
      '31.63-8',
      'Av. Paulista 1.578, 01310-200',
    ]) {
      expect(parseCoordinateEntry(typed).kind).not.toBe('coordinate');
    }
  });

  it('refuses a number that contradicts its own hemisphere letter', () => {
    expect(parseCoordinateEntry('-31.63 N, 8.00 W').kind).toBe('none');
  });

  it('refuses a half-lettered pair rather than half-guessing it', () => {
    expect(parseCoordinateEntry('31.63 N, 8.00').kind).toBe('none');
  });
});

describe('isCoordinateEntry — what the type-ahead must not send', () => {
  it('claims every half-typed position, so none of them reaches a request', () => {
    for (const typed of ['3', '31.6', '31.6315', '31.63,', '31.63, -', '48.856614, 2.352222']) {
      expect(isCoordinateEntry(typed)).toBe(true);
    }
  });

  it('leaves place names alone', () => {
    for (const typed of ['Marrakech', 'Nice', 'Sewell', '', '  ', 'A1']) {
      expect(isCoordinateEntry(typed)).toBe(false);
    }
  });

  it('claims everything the parser can read, so no coordinate escapes the suppression', () => {
    for (const [typed] of TYPED) expect(isCoordinateEntry(typed)).toBe(true);
  });
});

/*
 * ── The differential check ─────────────────────────────────────────────────────────────────
 */

/** Runs the server's own validation over the pair this parser produced. */
function serverAccepts(lat: number, lon: number): { lat: number; lon: number } {
  const search = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  const location = parseLocation(search);
  if (location.kind !== 'coordinates') throw new Error('expected the coordinate branch');
  return { lat: location.lat, lon: location.lon };
}

describe('the client parser and the API agree', () => {
  it('produces coordinates that lib/server/params.ts accepts unchanged', () => {
    for (const typed of [...TYPED.map(([text]) => text), '48.856614, 2.352222']) {
      const entry = parseCoordinateEntry(typed);
      expect(entry.kind).toBe('coordinate');
      if (entry.kind !== 'coordinate') continue;
      expect(serverAccepts(entry.lat, entry.lon)).toEqual({ lat: entry.lat, lon: entry.lon });
    }
  });

  it('produces an acceptable pair for any position a browser could report', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        (lat, lon) => {
          // `toFixed(6)` is the precision a geolocation API or a paste from a map carries.
          const entry = parseCoordinateEntry(`${lat.toFixed(6)}, ${lon.toFixed(6)}`);
          expect(entry.kind).toBe('coordinate');
          if (entry.kind !== 'coordinate') return;
          expect(serverAccepts(entry.lat, entry.lon)).toEqual({ lat: entry.lat, lon: entry.lon });
          const decimals = (text: string) => (text.split('.')[1] ?? '').length;
          expect(decimals(String(entry.lat))).toBeLessThanOrEqual(USER_COORDINATE_DECIMALS);
          expect(decimals(String(entry.lon))).toBeLessThanOrEqual(USER_COORDINATE_DECIMALS);
        },
      ),
      { numRuns: 300 },
    );
  });
});
