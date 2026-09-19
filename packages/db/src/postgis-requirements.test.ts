import { describe, expect, it } from 'vitest';

import {
  MAX_TARGET_POSTGIS_VERSION,
  MIN_SUPPORTED_POSTGIS_VERSION,
  REQUIRED_POSTGIS_FUNCTIONS,
  compareVersions,
  functionsBeyondTarget,
  isAtLeastVersion,
} from './postgis-requirements.ts';

describe('PostGIS version targeting (ADR-031)', () => {
  it('targets what Supabase ships, not what the local image happens to be', () => {
    expect(MIN_SUPPORTED_POSTGIS_VERSION).toBe('3.3');
    expect(MAX_TARGET_POSTGIS_VERSION).toBe('3.3');
  });

  it('uses no function that needs more than PostGIS 3.3', () => {
    expect(functionsBeyondTarget()).toStrictEqual([]);
  });

  it('documents what every listed function is for', () => {
    for (const requirement of REQUIRED_POSTGIS_FUNCTIONS) {
      expect(requirement.name).toMatch(/^[a-z_0-9]+$/);
      expect(requirement.usedFor.length).toBeGreaterThan(10);
      expect(requirement.since).toMatch(/^\d+\.\d+$/);
    }
  });

  it('would catch a function that needs a newer release', () => {
    // ST_GeomFromGeoJSON arrived in 2.0, so a 1.5 target must flag it. This proves the check has
    // teeth rather than being vacuously empty.
    const flagged = functionsBeyondTarget('1.5');
    expect(flagged.map((requirement) => requirement.name)).toContain('st_geomfromgeojson');
  });
});

describe('version comparison', () => {
  it.each([
    ['3.4', '3.3', 1],
    ['3.3', '3.4', -1],
    ['3.3', '3.3', 0],
    ['3.10', '3.9', 1],
    ['3.3.7', '3.3', 1],
  ])('compareVersions(%s, %s)', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });

  it('answers "is this server new enough?"', () => {
    expect(isAtLeastVersion('3.4.3', '3.3')).toBe(true);
    expect(isAtLeastVersion('3.3.7', '3.3')).toBe(true);
    expect(isAtLeastVersion('3.2.1', '3.3')).toBe(false);
  });
});
