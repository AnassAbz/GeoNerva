/**
 * Viewport handling, including the antimeridian (docs/ARCHITECTURE.md §7.2).
 *
 * A map viewport is the one place GeoNerva deals in rectangles rather than distances, and it is
 * the one place ±180 bites. When a user pans across the Pacific, MapLibre reports a box whose
 * western edge is larger than its eastern edge (for example `west = 170`, `east = −170`). Passed
 * to `ST_MakeEnvelope` unchanged, that box is *the rest of the world*: every feature except the
 * ones the user is looking at. So it is split into two envelopes, and the results are unioned.
 *
 * This module is pure: it computes envelopes, and `./queries.ts` runs them.
 */

import { crossesAntimeridian, type BoundingBox } from '@geonerva/domain';

/** An envelope that is safe to hand to `ST_MakeEnvelope`: `west <= east`. */
export type Envelope = BoundingBox;

/** Widest box accepted at low zoom, in degrees (docs/ARCHITECTURE.md §13.2). */
export const MAX_VIEWPORT_DEGREES = 60;

/** Raised when a viewport is unusable. */
export class ViewportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewportError';
  }
}

/**
 * Splits a viewport into one or two envelopes with `west <= east`.
 *
 *  - An ordinary box returns itself.
 *  - A box crossing the antimeridian returns `[west, 180]` and `[−180, east]`.
 *  - A degenerate box (`south > north`) is refused rather than silently returning nothing.
 *
 * Latitudes are clamped to ±90, because a map can be panned past the pole while the data cannot
 * exist there.
 */
export function splitViewport(bbox: BoundingBox): Envelope[] {
  if (bbox.south > bbox.north) {
    throw new ViewportError('viewport south edge is north of its north edge');
  }
  if (
    !Number.isFinite(bbox.west) ||
    !Number.isFinite(bbox.east) ||
    !Number.isFinite(bbox.south) ||
    !Number.isFinite(bbox.north)
  ) {
    throw new ViewportError('viewport edges must be finite');
  }

  const south = Math.max(-90, bbox.south);
  const north = Math.min(90, bbox.north);

  if (!crossesAntimeridian(bbox)) {
    return [{ west: bbox.west, south, east: bbox.east, north }];
  }

  return [
    { west: bbox.west, south, east: 180, north },
    { west: -180, south, east: bbox.east, north },
  ];
}

/**
 * The width of a viewport in degrees of longitude, measured the short way round — so an
 * antimeridian box reports its real width rather than 340°.
 */
export function viewportWidthDegrees(bbox: BoundingBox): number {
  return crossesAntimeridian(bbox) ? 180 - bbox.west + (bbox.east + 180) : bbox.east - bbox.west;
}

/** True when the viewport is within the size cap for a zoom level. */
export function isViewportWithinLimit(bbox: BoundingBox, zoom: number): boolean {
  if (zoom >= 4) return true;
  return (
    viewportWidthDegrees(bbox) <= MAX_VIEWPORT_DEGREES &&
    bbox.north - bbox.south <= MAX_VIEWPORT_DEGREES
  );
}

/**
 * Quantizes a viewport to a tile-aligned grid so that nearby pans share a CDN cache entry
 * (docs/ARCHITECTURE.md §7.5). The box is always grown, never shrunk, so the user never sees a
 * feature disappear because of rounding.
 */
export function quantizeViewport(bbox: BoundingBox, zoom: number): BoundingBox {
  const step = quantizationStepDegrees(zoom);
  // `Math.min`/`Math.max` against the original value guard the grow-only property against
  // floating-point error: `Math.floor(v / step) * step` can land a fraction of an ulp above `v`.
  const snapDown = (value: number): number => Math.min(value, Math.floor(value / step) * step);
  const snapUp = (value: number): number => Math.max(value, Math.ceil(value / step) * step);
  return {
    west: Math.max(-180, snapDown(bbox.west)),
    south: Math.max(-90, snapDown(bbox.south)),
    east: Math.min(180, snapUp(bbox.east)),
    north: Math.min(90, snapUp(bbox.north)),
  };
}

/** Grid step per zoom level: roughly a quarter of a tile, bounded so it never becomes absurd. */
export function quantizationStepDegrees(zoom: number): number {
  const clamped = Math.min(18, Math.max(0, Math.floor(zoom)));
  return 360 / 2 ** clamped / 4;
}
