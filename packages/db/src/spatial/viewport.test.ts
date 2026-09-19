import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ViewportError,
  isViewportWithinLimit,
  quantizationStepDegrees,
  quantizeViewport,
  splitViewport,
  viewportWidthDegrees,
} from './viewport.ts';

describe('splitViewport', () => {
  it('returns an ordinary box unchanged', () => {
    const bbox = { west: -10, south: 30, east: 5, north: 40 };
    expect(splitViewport(bbox)).toStrictEqual([bbox]);
  });

  it('splits a box crossing the antimeridian into two envelopes', () => {
    // Suva, Fiji: panning across ±180 is the everyday case this exists for.
    expect(splitViewport({ west: 170, south: -22, east: -175, north: -14 })).toStrictEqual([
      { west: 170, south: -22, east: 180, north: -14 },
      { west: -180, south: -22, east: -175, north: -14 },
    ]);
  });

  it('clamps latitudes past the poles', () => {
    expect(splitViewport({ west: 0, south: -95, east: 10, north: 95 })).toStrictEqual([
      { west: 0, south: -90, east: 10, north: 90 },
    ]);
  });

  it('refuses an inverted or non-finite box rather than returning nothing', () => {
    expect(() => splitViewport({ west: 0, south: 40, east: 10, north: 30 })).toThrow(ViewportError);
    expect(() => splitViewport({ west: Number.NaN, south: 0, east: 10, north: 10 })).toThrow(
      ViewportError,
    );
  });

  it('always produces envelopes with west <= east', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.double({ min: -85, max: 0, noNaN: true }),
        fc.double({ min: 0, max: 85, noNaN: true }),
        (west, east, south, north) => {
          for (const envelope of splitViewport({ west, south, east, north })) {
            expect(envelope.west).toBeLessThanOrEqual(envelope.east);
            expect(envelope.south).toBeLessThanOrEqual(envelope.north);
          }
        },
      ),
    );
  });
});

describe('viewportWidthDegrees', () => {
  it('measures an ordinary box directly', () => {
    expect(viewportWidthDegrees({ west: -10, south: 0, east: 5, north: 10 })).toBe(15);
  });

  it('measures an antimeridian box the short way round', () => {
    // 170 → −175 is 15° across the dateline, not 345° the other way.
    expect(viewportWidthDegrees({ west: 170, south: 0, east: -175, north: 10 })).toBe(15);
  });
});

describe('isViewportWithinLimit', () => {
  it('caps the box only at low zoom', () => {
    const huge = { west: -100, south: -40, east: 100, north: 40 };
    expect(isViewportWithinLimit(huge, 2)).toBe(false);
    expect(isViewportWithinLimit(huge, 4)).toBe(true);
  });

  it('accepts a 60° box at zoom 3 and rejects a wider one', () => {
    expect(isViewportWithinLimit({ west: 0, south: 0, east: 60, north: 10 }, 3)).toBe(true);
    expect(isViewportWithinLimit({ west: 0, south: 0, east: 60.1, north: 10 }, 3)).toBe(false);
  });
});

describe('quantizeViewport', () => {
  it('only ever grows the box, so nothing disappears from the map', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -170, max: 160, noNaN: true }),
        fc.double({ min: -80, max: 70, noNaN: true }),
        fc.integer({ min: 0, max: 14 }),
        (west, south, zoom) => {
          const bbox = { west, south, east: west + 5, north: south + 5 };
          const snapped = quantizeViewport(bbox, zoom);
          expect(snapped.west).toBeLessThanOrEqual(bbox.west);
          expect(snapped.south).toBeLessThanOrEqual(bbox.south);
          expect(snapped.east).toBeGreaterThanOrEqual(bbox.east);
          expect(snapped.north).toBeGreaterThanOrEqual(bbox.north);
        },
      ),
    );
  });

  it('shrinks the grid step as zoom increases', () => {
    expect(quantizationStepDegrees(0)).toBeGreaterThan(quantizationStepDegrees(8));
    expect(quantizationStepDegrees(8)).toBeGreaterThan(quantizationStepDegrees(14));
  });

  it('stays inside the world', () => {
    const snapped = quantizeViewport({ west: -179.9, south: -89.9, east: 179.9, north: 89.9 }, 1);
    expect(snapped.west).toBeGreaterThanOrEqual(-180);
    expect(snapped.east).toBeLessThanOrEqual(180);
    expect(snapped.south).toBeGreaterThanOrEqual(-90);
    expect(snapped.north).toBeLessThanOrEqual(90);
  });
});
