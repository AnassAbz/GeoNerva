import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  HAZARD_FAMILIES,
  HAZARD_TYPES,
  HAZARD_TYPES_BY_FAMILY,
  LIFECYCLE_STATUSES,
  RELEVANCE_LEVELS,
  RELEVANCE_RANK,
  familyOf,
  isTombstone,
} from '../enums.ts';
import {
  crossesAntimeridian,
  isNormalizedLongitude,
  isNullIsland,
  isValidLatitude,
} from './geography.ts';
import {
  PUBLIC_ID_PREFIX_BY_HAZARD,
  formatPublicId,
  hazardTypeOfPublicId,
  isDatabaseId,
  isPublicId,
  isSha256Hex,
  isUuid,
  parsePublicId,
  publicIdPrefixFor,
} from './ids.ts';
import {
  formatCoordinateKey,
  formatNominatimKey,
  formatPlaceKey,
  isLocationKey,
  isPersistableLocationKey,
  parseLocationKey,
} from './location.ts';
import {
  compareProviderSeverity,
  isElevatedSeverity,
  providerSeverityRank,
  severityScaleOf,
} from './provider-severity.ts';
import { formatSubjectRef, isSubjectRef, parseSubjectRef } from './subject-ref.ts';
import {
  FUTURE_OBSERVATION_TOLERANCE_MS,
  elapsedSeconds,
  isObservedAtAcceptable,
  isValidityIntervalOrdered,
  isWithinValidity,
  parseIsoTimestamp,
  toIsoTimestamp,
} from './time.ts';

describe('hazard families', () => {
  it('assigns every hazard type to exactly one family', () => {
    const assigned = HAZARD_FAMILIES.flatMap((family) => HAZARD_TYPES_BY_FAMILY[family]);
    expect([...assigned].sort()).toStrictEqual([...HAZARD_TYPES].sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('maps thermal activity and official wildfire events to the same card', () => {
    expect(familyOf('THERMAL_ACTIVITY')).toBe('FIRE_ACTIVITY');
    expect(familyOf('WILDFIRE_EVENT')).toBe('FIRE_ACTIVITY');
  });

  it('ranks relevance levels in ascending order of attention', () => {
    const ranks = RELEVANCE_LEVELS.map((level) => RELEVANCE_RANK[level]);
    expect(ranks).toStrictEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('lifecycle statuses', () => {
  it('distinguishes an explicit deletion from an inferred disappearance', () => {
    expect(LIFECYCLE_STATUSES).toContain('DELETED');
    expect(LIFECYCLE_STATUSES).toContain('MISSING_FROM_SOURCE');
    expect(isTombstone('DELETED')).toBe(true);
    expect(isTombstone('MISSING_FROM_SOURCE')).toBe(true);
    expect(isTombstone('ACTIVE')).toBe(false);
    expect(isTombstone('EXPIRED')).toBe(false);
  });
});

describe('identifier validation', () => {
  it.each([
    ['1', true],
    ['9223372036854775807', true],
    ['9223372036854775808', false],
    ['0', false],
    ['01', false],
    ['-1', false],
    ['1.0', false],
    ['', false],
  ])('isDatabaseId(%s) → %s', (value, expected) => {
    expect(isDatabaseId(value)).toBe(expected);
  });

  it('accepts only lowercase canonical uuids and digests', () => {
    expect(isUuid('0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77')).toBe(true);
    expect(isUuid('0B6C5F1E-9A2D-4C37-8F11-6E2A9C0D4B77')).toBe(false);
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
  });

  it('round-trips public ids and excludes confusable letters', () => {
    const id = formatPublicId({ prefix: 'EQ', year: 2026, token: '7K3F9Q' });
    expect(id).toBe('EQ-26-7K3F9Q');
    expect(parsePublicId(id)).toStrictEqual({ prefix: 'EQ', year: 26, token: '7K3F9Q' });
    for (const confusable of ['I', 'L', 'O', 'U']) {
      expect(isPublicId(`EQ-26-7K3F9${confusable}`)).toBe(false);
    }
  });

  it('rejects malformed public ids', () => {
    for (const bad of ['EQ-26-7K3F9', 'eq-26-7K3F9Q', 'ZZ-26-7K3F9Q', 'EQ-2026-7K3F9Q', '']) {
      expect(isPublicId(bad)).toBe(false);
      expect(parsePublicId(bad)).toBeNull();
    }
  });
});

describe('location keys', () => {
  it('parses each kind', () => {
    expect(parseLocationKey('p:2542997')).toStrictEqual({ kind: 'place', geonameId: 2542997 });
    expect(parseLocationKey('n:R123456')).toStrictEqual({
      kind: 'nominatim',
      osmType: 'R',
      osmId: '123456',
    });
    expect(parseLocationKey('c:31.63,-8.00')).toStrictEqual({
      kind: 'coordinates',
      lat: 31.63,
      lon: -8,
    });
  });

  it('demands exactly two decimals on coordinate keys', () => {
    expect(isLocationKey('c:31.6,-8.00')).toBe(false);
    expect(isLocationKey('c:31.630,-8.00')).toBe(false);
    expect(isLocationKey('c:31.63,-8')).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    expect(isLocationKey('c:91.00,0.00')).toBe(false);
    expect(isLocationKey('c:0.00,180.00')).toBe(false);
    expect(isLocationKey('c:0.00,-180.00')).toBe(true);
  });

  it('never persists raw coordinates (ADR-015)', () => {
    expect(isPersistableLocationKey('p:2542997')).toBe(true);
    expect(isPersistableLocationKey('n:R123456')).toBe(true);
    expect(isPersistableLocationKey('c:31.63,-8.00')).toBe(false);
    expect(isPersistableLocationKey('garbage')).toBe(false);
  });

  it('refuses to build a key from unrounded coordinates', () => {
    expect(() => formatCoordinateKey({ lat: 31.6295, lon: -8.0 })).toThrow(RangeError);
    expect(formatCoordinateKey({ lat: 31.63, lon: -8 })).toBe('c:31.63,-8.00');
  });

  it('normalizes negative zero to a single spelling', () => {
    expect(formatCoordinateKey({ lat: -0, lon: -0 })).toBe('c:0.00,0.00');
  });

  it('formats place and nominatim keys', () => {
    expect(formatPlaceKey(2542997)).toBe('p:2542997');
    expect(formatNominatimKey('N', '42')).toBe('n:N42');
    expect(() => formatPlaceKey(0)).toThrow(RangeError);
  });

  it('rejects an over-long key without parsing it', () => {
    expect(isLocationKey(`p:${'9'.repeat(200)}`)).toBe(false);
  });
});

describe('subject references', () => {
  it('round-trips each kind', () => {
    const refs = [
      { kind: 'canonical_event', publicId: 'EQ-26-7K3F9Q' },
      { kind: 'fire_cluster', publicId: 'FR-26-ABCDEF' },
      { kind: 'source', sourceId: 'usgs' },
      { kind: 'metric', metricCode: 'EQ_COUNT_M_GE_MC_WITHIN_R' },
    ] as const;
    for (const ref of refs) {
      expect(parseSubjectRef(formatSubjectRef(ref))).toStrictEqual(ref);
    }
  });

  it('rejects malformed references', () => {
    for (const bad of ['', 'CE:', 'XX:EQ-26-7K3F9Q', 'SRC:USGS', 'MET:lower', 'CE:not-an-id']) {
      expect(isSubjectRef(bad)).toBe(false);
    }
  });
});

describe('provider severity', () => {
  it('orders values within a scheme and refuses to compare across schemes', () => {
    const green = { scheme: 'GDACS_ALERT', value: 'Green' } as const;
    const red = { scheme: 'GDACS_ALERT', value: 'Red' } as const;
    const pagerRed = { scheme: 'PAGER', value: 'red' } as const;
    expect(compareProviderSeverity(green, red)).toBeLessThan(0);
    expect(compareProviderSeverity(red, green)).toBeGreaterThan(0);
    expect(compareProviderSeverity(red, red)).toBe(0);
    expect(compareProviderSeverity(red, pagerRed)).toBeNull();
  });

  it('is case-insensitive about provider inconsistency', () => {
    expect(providerSeverityRank({ scheme: 'GDACS_ALERT', value: 'orange' })).toBe(
      providerSeverityRank({ scheme: 'GDACS_ALERT', value: 'Orange' }),
    );
  });

  it('returns null rather than guessing at an unknown value', () => {
    expect(providerSeverityRank({ scheme: 'GDACS_ALERT', value: 'Purple' })).toBeNull();
    expect(
      compareProviderSeverity(
        { scheme: 'GDACS_ALERT', value: 'Purple' },
        { scheme: 'GDACS_ALERT', value: 'Red' },
      ),
    ).toBeNull();
  });

  it('identifies elevated severity per scheme', () => {
    expect(isElevatedSeverity({ scheme: 'GDACS_ALERT', value: 'Orange' })).toBe(true);
    expect(isElevatedSeverity({ scheme: 'GDACS_ALERT', value: 'Green' })).toBe(false);
    expect(isElevatedSeverity({ scheme: 'PAGER', value: 'yellow' })).toBe(false);
    expect(isElevatedSeverity({ scheme: 'CAP_SEVERITY', value: 'Severe' })).toBe(true);
    expect(isElevatedSeverity({ scheme: 'CAP_SEVERITY', value: 'Moderate' })).toBe(false);
  });

  it('exposes each scale in ascending order', () => {
    expect(severityScaleOf('GDACS_ALERT')).toStrictEqual(['green', 'orange', 'red']);
  });
});

describe('time semantics', () => {
  const ingestedAt = new Date('2026-09-19T12:00:00.000Z');

  it('accepts an observation up to five minutes ahead of ingestion (I13)', () => {
    expect(
      isObservedAtAcceptable(
        new Date(ingestedAt.getTime() + FUTURE_OBSERVATION_TOLERANCE_MS),
        ingestedAt,
      ),
    ).toBe(true);
    expect(
      isObservedAtAcceptable(
        new Date(ingestedAt.getTime() + FUTURE_OBSERVATION_TOLERANCE_MS + 1),
        ingestedAt,
      ),
    ).toBe(false);
  });

  it('accepts any observation in the past', () => {
    expect(isObservedAtAcceptable(new Date('2000-01-01T00:00:00Z'), ingestedAt)).toBe(true);
  });

  it('validates validity intervals', () => {
    const from = new Date('2026-09-19T00:00:00Z');
    const to = new Date('2026-09-20T00:00:00Z');
    expect(isValidityIntervalOrdered({ validFrom: from, validTo: to })).toBe(true);
    expect(isValidityIntervalOrdered({ validFrom: to, validTo: from })).toBe(false);
    expect(isValidityIntervalOrdered({ validFrom: null, validTo: to })).toBe(true);
    expect(isWithinValidity({ validFrom: from, validTo: to }, ingestedAt)).toBe(true);
    expect(isWithinValidity({ validFrom: null, validTo: null }, ingestedAt)).toBe(true);
    expect(isWithinValidity({ validFrom: to, validTo: null }, ingestedAt)).toBe(false);
  });

  it('requires an explicit offset on transport timestamps', () => {
    expect(parseIsoTimestamp('2026-09-19T12:00:00Z')).toStrictEqual(ingestedAt);
    expect(parseIsoTimestamp('2026-09-19T14:00:00+02:00')).toStrictEqual(ingestedAt);
    // GDACS-style offsetless input must be given a zone in the adapter, not guessed at here.
    expect(parseIsoTimestamp('2026-09-19T12:00:00')).toBeNull();
    expect(parseIsoTimestamp('not a date')).toBeNull();
  });

  it('serializes to canonical UTC', () => {
    expect(toIsoTimestamp(ingestedAt)).toBe('2026-09-19T12:00:00.000Z');
    expect(() => toIsoTimestamp(new Date('nope'))).toThrow(RangeError);
  });

  it('never reports negative elapsed time', () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), fc.date({ noInvalidDate: true }), (a, b) => {
        expect(elapsedSeconds(a, b)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe('geography validation', () => {
  it('bounds latitude inclusively and longitude half-open', () => {
    expect(isValidLatitude(90)).toBe(true);
    expect(isValidLatitude(90.0001)).toBe(false);
    expect(isNormalizedLongitude(-180)).toBe(true);
    expect(isNormalizedLongitude(180)).toBe(false);
    expect(isValidLatitude(Number.NaN)).toBe(false);
    expect(isNormalizedLongitude(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('flags null island', () => {
    expect(isNullIsland({ lat: 0, lon: 0 })).toBe(true);
    expect(isNullIsland({ lat: 0.01, lon: 0 })).toBe(false);
  });

  it('detects an antimeridian-crossing viewport', () => {
    expect(crossesAntimeridian({ west: 170, south: -20, east: -170, north: -10 })).toBe(true);
    expect(crossesAntimeridian({ west: -10, south: -20, east: 10, north: -10 })).toBe(false);
  });
});

describe('hazardTypeOfPublicId', () => {
  it('reads back the hazard type every prefix was minted for', () => {
    for (const hazardType of HAZARD_TYPES) {
      const id = formatPublicId({
        prefix: publicIdPrefixFor(hazardType),
        year: 26,
        token: '7K3F9Q',
      });
      expect(hazardTypeOfPublicId(id), id).toBe(hazardType);
    }
  });

  it('gives every hazard type its own prefix, so the inverse is a function', () => {
    const prefixes = Object.values(PUBLIC_ID_PREFIX_BY_HAZARD);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('keeps the documented prefixes', () => {
    expect(publicIdPrefixFor('EARTHQUAKE')).toBe('EQ');
    expect(publicIdPrefixFor('THERMAL_ACTIVITY')).toBe('FR');
    expect(publicIdPrefixFor('WILDFIRE_EVENT')).toBe('WF');
  });

  it('refuses anything that is not a well-formed public id', () => {
    for (const bad of ['', 'EQ', 'EQ-26', 'XX-26-7K3F9Q', 'eq-26-7K3F9Q', 'EQ-26-7K3F9QX']) {
      expect(hazardTypeOfPublicId(bad), bad).toBeNull();
    }
  });
});
