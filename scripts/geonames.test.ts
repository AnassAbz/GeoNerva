/**
 * `parseGeonames` — the 19-column GeoNames format, and the rule that a refused line is reported,
 * never skipped in silence.
 */

import { describe, expect, it } from 'vitest';

import { GEONAMES_FIXTURE, GEONAMES_FIXTURE_ROWS, geonamesLine } from './lib/geonames-fixture.ts';
import { GEONAMES_COLUMNS, parseGeonames } from './lib/geonames.ts';

describe('parseGeonames', () => {
  it('reads every row of the fixture, alternates included', () => {
    const { places, rejected } = parseGeonames(GEONAMES_FIXTURE);
    expect(rejected).toStrictEqual([]);
    expect(places).toHaveLength(Object.keys(GEONAMES_FIXTURE_ROWS).length);
    expect(places[0]).toStrictEqual({
      geonameid: 2542997,
      name: 'Marrakesh',
      asciiName: 'Marrakesh',
      altNames: 'Marakech,Marrakech,Marrakesch,Marrakesh,Marrakus',
      countryCode: 'MA',
      admin1: '07',
      lat: 31.63416,
      lon: -7.99994,
      population: 839296,
      timezone: 'Africa/Casablanca',
    });
  });

  it('keeps the accented name and the ASCII one apart', () => {
    const montreal = parseGeonames(GEONAMES_FIXTURE_ROWS.montreal).places[0];
    expect(montreal?.name).toBe('Montréal');
    expect(montreal?.asciiName).toBe('Montreal');
  });

  it('reads a CRLF file and ignores a trailing blank line', () => {
    const crlf = `${GEONAMES_FIXTURE_ROWS.paris}\r\n${GEONAMES_FIXTURE_ROWS.nice}\r\n`;
    expect(parseGeonames(crlf).places.map((place) => place.name)).toStrictEqual(['Paris', 'Nice']);
  });

  it('folds +180 onto -180, which the table requires', () => {
    const edge = geonamesLine({
      geonameid: '1',
      name: 'Edge',
      longitude: '180',
      timezone: 'Pacific/Fiji',
    });
    expect(parseGeonames(edge).places[0]?.lon).toBe(-180);
  });

  it('stores an empty population as unknown, never as zero', () => {
    const unknown = geonamesLine({ geonameid: '2', name: 'Unknown', population: '' });
    expect(parseGeonames(unknown).places[0]?.population).toBeNull();
  });

  it.each([
    [
      'a short row',
      GEONAMES_FIXTURE_ROWS.paris.split('\t').slice(0, 18).join('\t'),
      'has 18 columns, expected 19',
    ],
    [
      'a bad id',
      geonamesLine({ geonameid: 'x', name: 'A' }),
      'geonameid is not a positive integer',
    ],
    [
      'a zero id',
      geonamesLine({ geonameid: '0', name: 'A' }),
      'geonameid is not a positive integer',
    ],
    ['an empty name', geonamesLine({ geonameid: '3', name: '' }), 'name is empty'],
    [
      'a latitude past the pole',
      geonamesLine({ geonameid: '4', name: 'A', latitude: '91' }),
      'latitude is not within [-90, 90]',
    ],
    [
      'an empty longitude',
      geonamesLine({ geonameid: '5', name: 'A', longitude: '' }),
      'longitude is not within [-180, 180]',
    ],
    [
      'a feature that is not a place',
      geonamesLine({ geonameid: '6', name: 'A', featureClass: 'H' }),
      'feature class is not P (a populated place)',
    ],
    [
      'no time zone',
      geonamesLine({ geonameid: '7', name: 'A', timezone: '' }),
      'timezone is empty',
    ],
    [
      'a negative population',
      geonamesLine({ geonameid: '8', name: 'A', population: '-1' }),
      'population is not a non-negative integer',
    ],
  ])('refuses %s, naming the line and the reason', (_label, bad, reason) => {
    const text = `${GEONAMES_FIXTURE_ROWS.paris}\n${bad}\n`;
    const { places, rejected } = parseGeonames(text);
    expect(places.map((place) => place.name)).toStrictEqual(['Paris']);
    expect(rejected).toStrictEqual([{ line: 2, reason }]);
  });

  it('documents the format it reads', () => {
    expect(GEONAMES_COLUMNS).toBe(19);
  });
});
