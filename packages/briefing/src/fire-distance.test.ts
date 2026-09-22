/**
 * `fireDistanceOf` — which distance a fire card is given, and what it is called (P8 review H3).
 */

import { describe, expect, it } from 'vitest';

import { fireDistanceOf } from './snapshot.ts';

describe('fireDistanceOf', () => {
  it('is exact when the members were verified, whatever the hull says', () => {
    expect(
      fireDistanceOf({ verifiedNearestM: 3000, areaDistanceM: 1000, hasHull: true, nTotal: 4 }),
    ).toEqual({ meters: 3000, basis: 'NEAREST_DETECTION' });
  });

  it('is the hull bound, named as the area, when they were not', () => {
    expect(
      fireDistanceOf({ verifiedNearestM: null, areaDistanceM: 1000, hasHull: true, nTotal: 4 }),
    ).toEqual({ meters: 1000, basis: 'CLUSTER_AREA' });
  });

  it('is the centre, named as such, for a cluster of several with no hull', () => {
    expect(
      fireDistanceOf({ verifiedNearestM: null, areaDistanceM: 7000, hasHull: false, nTotal: 5 }),
    ).toEqual({ meters: 7000, basis: 'CLUSTER_CENTRE' });
  });

  it('is exact for a single detection with no hull, whose centroid is the detection', () => {
    expect(
      fireDistanceOf({ verifiedNearestM: null, areaDistanceM: 7000, hasHull: false, nTotal: 1 }),
    ).toEqual({ meters: 7000, basis: 'NEAREST_DETECTION' });
  });
});
