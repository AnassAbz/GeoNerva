import { describe, expect, it } from 'vitest';

import { FIXTURE_NOW, marrakechBriefing } from '../fixtures/index.ts';
import { ordinal } from './copy.ts';
import {
  formatAgo,
  formatDateTime,
  formatDistanceKm,
  formatDuration,
  formatFactValue,
  formatUtc,
} from './format.ts';
import { circleRing } from './geo.ts';
import { parseAsOfParam, parseWindowParam } from './query.ts';
import { locationKeyFromSlug, placeHref, placeSlug, subjectHref } from './routes.ts';
import { healthSentence, sourceName, unavailableStatement } from './sources.ts';

describe('formatFactValue', () => {
  it('keeps the decimals the value carries', () => {
    expect(formatFactValue({ kind: 'number', value: 5.3, unit: null, decimals: 2 })).toBe('5.30');
    expect(formatFactValue({ kind: 'number', value: 10, unit: 'km', decimals: 0 })).toBe('10 km');
  });

  it('renders an unavailable value as words, never as zero or blank', () => {
    expect(formatFactValue({ kind: 'unavailable', reason: 'SOURCE_UNAVAILABLE' })).toBe(
      'Source unavailable',
    );
    expect(formatFactValue({ kind: 'unavailable', reason: 'INSUFFICIENT_HISTORY' })).toBe(
      'Not enough history',
    );
  });

  it('keeps provider severity on its own scale', () => {
    expect(
      formatFactValue({ kind: 'severity', severity: { scheme: 'GDACS_ALERT', value: 'Orange' } }),
    ).toBe('GDACS Orange');
  });
});

describe('time formatting', () => {
  it('formats durations in the unit that reads naturally', () => {
    expect(formatDuration(5400)).toBe('90 min');
    expect(formatDuration(10_800)).toBe('3 h');
    expect(formatDuration(13_200)).toBe('3 h 40 min');
    expect(formatDuration(3 * 86_400)).toBe('3 d');
  });

  it('formats relative times against the given clock', () => {
    expect(formatAgo('2026-09-22T13:02:00.000Z', FIXTURE_NOW)).toBe('4 min ago');
    expect(formatAgo('2026-09-22T13:05:30.000Z', FIXTURE_NOW)).toBe('just now');
  });

  it('formats in the place’s time zone and in UTC for replay', () => {
    expect(formatDateTime('2026-09-22T13:06:00.000Z', 'Europe/Paris')).toBe('15:06, 22 Sep 2026');
    expect(formatUtc('2026-09-08T12:10:00.000Z')).toBe('12:10 UTC, 8 Sep 2026');
  });

  it('formats distances', () => {
    expect(formatDistanceKm(142.3)).toBe('142 km');
    expect(formatDistanceKm(3.44)).toBe('3.4 km');
  });

  it('writes ordinals correctly', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 91, 92, 113].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '91st',
      '92nd',
      '113th',
    ]);
  });
});

describe('routes', () => {
  it('maps subject references to the product routes, not the API hrefs', () => {
    expect(subjectHref('CE:EQ-26-7K3F9Q')).toBe('/event/EQ-26-7K3F9Q');
    expect(subjectHref('FC:FR-26-4HX2MB', 'marrakech-ma-2542997')).toBe(
      '/fire/FR-26-4HX2MB?place=marrakech-ma-2542997',
    );
    expect(subjectHref('SRC:firms')).toBeNull();
  });

  it('builds and parses place slugs', () => {
    expect(placeSlug({ key: 'p:2542997', label: 'Marrakech, Morocco', countryCode: 'MA' })).toBe(
      'marrakech-ma-2542997',
    );
    expect(placeSlug({ key: 'p:6077243', label: 'Montréal, Canada', countryCode: 'CA' })).toBe(
      'montreal-ca-6077243',
    );
    expect(locationKeyFromSlug('marrakech-ma-2542997')).toBe('p:2542997');
    expect(locationKeyFromSlug('@31.63,-8.00')).toBe('c:31.63,-8.00');
    expect(locationKeyFromSlug('%4031.63%2C-8.00')).toBe('c:31.63,-8.00');
    expect(locationKeyFromSlug('@31.6312,-8')).toBeNull();
    expect(locationKeyFromSlug('%E0%A4%A')).toBeNull();
    expect(locationKeyFromSlug('marrakech')).toBeNull();

    /*
     * A key of a third kind is refused rather than written. The geocoder mints `n:<osm type><osm
     * id>`, and an all-digit one would be written `paris-fr-12345` and read straight back as
     * `p:12345` — a different place, with nothing at the call site to show for it.
     */
    expect(() => placeSlug({ key: 'n:12345', label: 'Paris', countryCode: 'FR' })).toThrow(
      /not an addressable location key/u,
    );
    expect(() => placeSlug({ key: 'n:N12345', label: 'Paris', countryCode: 'FR' })).toThrow();
  });

  it('keeps the default window out of the URL and carries as_of', () => {
    expect(placeHref('marrakech-ma-2542997')).toBe('/place/marrakech-ma-2542997');
    expect(placeHref('x-ma-1', { window: '7d', asOf: '2026-09-22T10:10:00.000Z' })).toBe(
      '/place/x-ma-1?window=7d&as_of=2026-09-22T10%3A10%3A00.000Z',
    );
  });
});

describe('query parameters', () => {
  it('accepts only the page windows and defaults to 24 h', () => {
    expect(parseWindowParam('6h')).toBe('6h');
    expect(parseWindowParam('since')).toBe('24h');
    expect(parseWindowParam(['7d', '6h'])).toBe('7d');
    expect(parseWindowParam(undefined)).toBe('24h');
  });

  it('accepts an as_of in the past only, normalized', () => {
    expect(parseAsOfParam('2026-09-22T10:10:00Z', FIXTURE_NOW)).toBe('2026-09-22T10:10:00.000Z');
    expect(parseAsOfParam('2026-09-23T10:10:00Z', FIXTURE_NOW)).toBeUndefined();
    expect(parseAsOfParam('yesterday', FIXTURE_NOW)).toBeUndefined();
  });
});

describe('source health words', () => {
  it('names sources and states lateness against the expectation', () => {
    expect(sourceName('firms')).toBe('NASA FIRMS');
    const firms = marrakechBriefing({ scenario: 'firms-stale' }).snapshot.families.FIRE_ACTIVITY
      .sourceHealth;
    expect(healthSentence(firms[0] ?? (undefined as never), FIXTURE_NOW)).toBe(
      'NASA FIRMS last updated 5 h ago (expected ≤ 3 h)',
    );
    expect(unavailableStatement('FIRE_ACTIVITY', firms, FIXTURE_NOW)).toEqual({
      title: 'Fire activity data unavailable — NASA FIRMS last updated 5 h ago (expected ≤ 3 h).',
      detail: 'Absence of thermal detections cannot be confirmed.',
    });
  });

  it('uses the data-currency form when observations, not polls, are late', () => {
    const base = marrakechBriefing().snapshot.families.FIRE_ACTIVITY.sourceHealth[0];
    if (base === undefined) throw new Error('fixture has FIRMS health');
    expect(
      healthSentence(
        {
          ...base,
          status: 'STALE',
          reasons: ['DATA_STALE'],
          newestObservedAt: '2026-09-21T13:06:00.000Z',
        },
        FIXTURE_NOW,
      ),
    ).toBe('NASA FIRMS newest observation 24 h ago (expected ≤ 12 h)');
  });
});

describe('circleRing', () => {
  it('draws a closed ring at the requested great-circle radius', () => {
    const ring = circleRing(31.63, -7.99, 150);
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring[64]);
    const north = ring[0] ?? [0, 0];
    expect(north[1] - 31.63).toBeCloseTo(150 / 111.2, 1);
  });
});
