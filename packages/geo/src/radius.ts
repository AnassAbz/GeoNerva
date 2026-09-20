/**
 * A radius, turned into something an index can use.
 *
 * "What is happening within 50 km of here?" is the product's central question, and
 * `ST_DWithin(geography, …)` answers it correctly — but only after a bounding box has narrowed the
 * candidates, because that is what the GiST index can search. Computing that box is where the
 * classic geographic bugs live, and all three of them bite at the edges of the map rather than in
 * the middle:
 *
 *  1. **Longitude degrees shrink towards the poles.** One degree of longitude is 111 km at the
 *     equator and 43 km at 67° N. A box built with a fixed degree-per-kilometre factor is too
 *     narrow everywhere but the equator, so a hazard inside the radius falls outside the
 *     prefilter and is never measured. The failure is silent and it is *worse the further north
 *     you go* — which for this product means it is worst exactly where the coverage claims are
 *     already weakest.
 *  2. **Near a pole the box has to be the whole world in longitude.** At 89.9° a 50 km radius
 *     spans every meridian. `1 / cos(lat)` diverges, and a naive computation produces a box
 *     narrower than the circle it is meant to contain.
 *  3. **The box can cross the antimeridian**, at which point `west > east` and a single
 *     `ST_MakeEnvelope` describes *the rest of the world*. Suva is 20 km from the 180th meridian.
 *
 * So the box is always computed to **contain** the circle, never to approximate it, and it is
 * returned as one or two boxes with `west <= east` so a caller cannot use it wrongly. The exact
 * `ST_DWithin` still runs afterwards; this only decides what it runs *on*, and growing the box is
 * free while shrinking it loses hazards.
 *
 * **The unit property test and the PostGIS ring test catch different bugs, and neither catches
 * both.** Verified by mutation:
 *
 *  - Taking the longitude delta at the *centre's* latitude instead of the widest edge of the band
 *    fails the unit test and **passes** the PostGIS one — the points it drops are nearest the box
 *    corners, and a 4-centre ring never goes there.
 *  - Dividing by the *mean* degree of latitude instead of the shortest fails the PostGIS test and
 *    **passes** the unit one — the shortfall is 0.7 %, and the unit test places its probes with a
 *    spherical formula that cannot resolve an ellipsoidal error that small.
 *
 * So they stay separate: 48 centres with a cheap probe, and 4 centres with an exact one.
 */

import type { BoundingBox, LatLon } from '@geonerva/domain';

/**
 * The **shortest** a degree can be, in metres, anywhere on the WGS84 ellipsoid.
 *
 * A degree of latitude is (π/180)·M, where M is the meridional radius of curvature; it is
 * shortest at the equator, where M = a(1−e²) = 6,335,439 m, giving **110,574 m**. It grows to
 * 111,694 m at the pole. A degree of longitude is (π/180)·N·cosφ with N ≥ a, so it is never
 * shorter than 111,319.5·cosφ — comfortably above 110,574·cosφ.
 *
 * Dividing by the shortest possible degree is what makes the box **contain** the circle rather
 * than approximate it. The first version of this file used 111,320 — the *mean* degree of
 * latitude, and the equatorial degree of *longitude* — which is 0.7 % too large near the equator,
 * so the box came out 0.7 % too short and dropped points at the very edge of the circle. The
 * tightened PostGIS ring test found it (probing at 99.9 % of the radius rather than 95 %), and it
 * is exactly the class of bug this module's header is about: silent, small, and worse at one end
 * of the map than the other.
 *
 * The cost of being conservative is a box under 1 % larger, which the exact `ST_DWithin` filters
 * out anyway. The cost of being optimistic is hazards that are never measured.
 */
const MIN_METERS_PER_DEGREE = 110_574;

/**
 * The largest radius a single query will accept, in metres.
 *
 * 500 km. Beyond it the flat-earth correction below stops being a *containing* box in any useful
 * sense (the latitude band alone would be 9° tall), and no question this product asks is
 * "what is happening within 2,000 km of here" — that is a different product. Refused rather than
 * clamped, so nobody gets a smaller answer than they asked for without being told.
 */
export const MAX_RADIUS_METERS = 500_000;

export class RadiusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RadiusError';
  }
}

/**
 * Boxes that together contain every point within `radiusMeters` of `center`.
 *
 * One box normally, two when the circle crosses the antimeridian, and one full-width box when it
 * reaches a pole. Every box satisfies `west <= east` and `-90 <= south <= north <= 90`, so it can
 * go straight to `ST_MakeEnvelope` without a caller having to know which case it got.
 */
export function boundingBoxesForRadius(
  center: LatLon,
  radiusMeters: number,
): readonly BoundingBox[] {
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
    throw new RadiusError('the centre is not a usable position');
  }
  if (center.lat < -90 || center.lat > 90) {
    throw new RadiusError(`latitude ${center.lat} is not a latitude`);
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new RadiusError(`radius ${radiusMeters} m is not a radius`);
  }
  if (radiusMeters > MAX_RADIUS_METERS) {
    throw new RadiusError(
      `radius ${Math.round(radiusMeters / 1000)} km is above the ${MAX_RADIUS_METERS / 1000} km limit`,
    );
  }

  const latDelta = radiusMeters / MIN_METERS_PER_DEGREE;
  const south = Math.max(-90, center.lat - latDelta);
  const north = Math.min(90, center.lat + latDelta);

  /*
   * The longitude delta is taken at whichever edge of the latitude band is **closer to a pole**,
   * because that is where a degree of longitude is shortest and the box therefore needs to be
   * widest. Using the centre's own latitude produces a box that is correct at the centre and too
   * narrow at the top — which drops hazards at the far corners of the very circle being asked
   * about.
   */
  const widestLat = Math.max(Math.abs(south), Math.abs(north));
  const cosWidest = Math.cos((widestLat * Math.PI) / 180);

  /*
   * A pole inside the circle means every meridian is inside it.
   *
   * `cos(90°)` is 6.1e-17 rather than 0 in IEEE-754, so a bare division would produce a colossal
   * but finite delta rather than an obvious one. The pole case is therefore decided by geometry —
   * does the band reach ±90 — and not by watching the arithmetic misbehave.
   */
  if (north >= 90 || south <= -90 || cosWidest <= 0) {
    return [{ west: -180, south, east: 180, north }];
  }

  const lonDelta = radiusMeters / (MIN_METERS_PER_DEGREE * cosWidest);
  if (lonDelta >= 180) {
    return [{ west: -180, south, east: 180, north }];
  }

  const west = center.lon - lonDelta;
  const east = center.lon + lonDelta;

  /*
   * Split rather than wrap.
   *
   * A box with `west = 170, east = -170` passed to `ST_MakeEnvelope` is every feature on Earth
   * *except* the ones being asked about — the exact inversion `splitViewport` exists to prevent
   * for map panning, and the same trap for a radius. Returning two boxes makes it impossible for
   * a caller to get this wrong by accident.
   */
  if (west < -180 && east > 180) {
    return [{ west: -180, south, east: 180, north }];
  }
  if (west < -180) {
    return [
      { west: -180, south, east, north },
      { west: west + 360, south, east: 180, north },
    ];
  }
  if (east > 180) {
    return [
      { west, south, east: 180, north },
      { west: -180, south, east: east - 360, north },
    ];
  }
  return [{ west, south, east, north }];
}

/**
 * True when `point` is within `radiusMeters` of `center`, measured on the spheroid.
 *
 * The *exact* answer, for a caller that has already narrowed its candidates and now needs to
 * decide. Kept beside the box deliberately: the two are a pair, and using one without the other
 * is either wrong (box alone admits the corners) or slow (measurement alone scans the table).
 */
export function isWithinRadius(
  center: LatLon,
  point: LatLon,
  radiusMeters: number,
  distance: (from: LatLon, to: LatLon) => number,
): boolean {
  return distance(center, point) <= radiusMeters;
}
