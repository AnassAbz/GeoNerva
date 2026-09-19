/**
 * Spatial SQL. Every PostGIS fragment in GeoNerva lives under this folder, which is also a
 * mandatory security-review surface (docs/IMPLEMENTATION_PLAN.md §2.3).
 */

export {
  SRID_WGS84,
  areaCoversPoint,
  asGeoJson,
  bufferedConvexHull,
  centroidOf,
  distanceMeters,
  distanceToArea,
  expressionAsGeoJson,
  geographyPoint,
  geometryIntersectsEnvelope,
  geometryPoint,
  intersectsEnvelope,
  knnDistance,
  withinRadius,
} from './fragments.ts';

export {
  MAX_VIEWPORT_DEGREES,
  ViewportError,
  isViewportWithinLimit,
  quantizationStepDegrees,
  quantizeViewport,
  splitViewport,
  viewportWidthDegrees,
} from './viewport.ts';
export type { Envelope } from './viewport.ts';

export {
  VIIRS_HALF_PIXEL_M,
  arePointsWithin,
  buildClusterHull,
  distanceToGeometries,
  fireDetectionsInViewport,
  geometriesCoveringPoint,
  measureDistanceMeters,
  nearestDetections,
  nearestObservationVersions,
  observationsInViewport,
} from './queries.ts';
export type { ClusterHullResult, ObservationDistanceRow, ViewportFeatureRow } from './queries.ts';
