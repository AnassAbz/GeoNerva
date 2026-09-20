/**
 * @geonerva/geo — Pure geodesy: distance, bearings, radius bounding boxes.
 *
 * Pure in the strict sense: no clock, no IO, no database. Everything here is a function of its
 * arguments, which is what lets a briefing's stated distance be re-derived from a stored row
 * years later, and what lets clustering compare thousands of pairs without thousands of round
 * trips.
 *
 * What is deliberately **not** here:
 *
 *  - **Indexed spatial queries.** `packages/db/src/spatial` owns those, because the GiST index is
 *    the point of them and an index lives in the database.
 *  - **Viewport handling.** `packages/db/src/spatial/viewport.ts` already splits an antimeridian
 *    map box into envelopes; a second implementation of the same idea would be a second place for
 *    it to be wrong.
 *  - **Coordinate validation and rounding.** `@geonerva/domain`'s `geography.ts` owns
 *    `isValidLatitude`, `isNormalizedLongitude` and `BoundingBox`, and the adapters own the
 *    four-decimal rounding that FIRMS identity depends on.
 *
 * See docs/ARCHITECTURE.md §3 for this package's responsibility and allowed dependencies.
 */

export {
  COMPASS_POINTS,
  compassPointFor,
  distanceMetersOrInfinity,
  initialBearingDegrees,
  statedKilometres,
  vincentyDistanceMeters,
} from './distance.ts';
export type { CompassPoint } from './distance.ts';

export {
  MAX_RADIUS_METERS,
  RadiusError,
  boundingBoxesForRadius,
  isWithinRadius,
} from './radius.ts';
