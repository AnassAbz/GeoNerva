/**
 * Geodesic distance on the WGS84 ellipsoid, computed in process.
 *
 * GeoNerva already measures distance in PostgreSQL, where `geography` does it spheroidally and a
 * GiST index does the narrowing — and that is what the read path uses, because the index is the
 * whole point. This module exists for the three places a round trip is the wrong tool:
 *
 *  - **Clustering.** Union-find over a 30-minute FIRMS batch compares thousands of pairs. Each
 *    one as a query would be thousands of round trips for arithmetic that takes microseconds.
 *  - **The briefing's stated distances.** A snapshot says "18 km north-east of Marrakech", and
 *    that number has to be reproducible from the stored row by anything that reads it, including
 *    a replay years later with no database of the same version.
 *  - **Tests.** A distance check that asks PostGIS what PostGIS thinks is self-consistent and
 *    proves nothing.
 *
 * **Vincenty's inverse formula, not haversine.** Haversine assumes a sphere and is wrong by up to
 * 0.5 % — about 100 m in 20 km, and 20 km across a continent. That is comfortably enough to move
 * an earthquake to the wrong side of a city boundary, and the product's central claim is that its
 * numbers are the providers' numbers and its derivations are honest. 0.5 % is not honest when
 * exact is available for thirty lines of arithmetic.
 *
 * Vincenty fails to converge for nearly-antipodal pairs, which is a real limitation and is
 * reported rather than hidden: `vincentyDistanceMeters` returns `null`, and the caller decides.
 * No hazard question GeoNerva asks involves antipodal points — "what is happening near here"
 * is bounded by a radius — so the case is a guard rather than a gap.
 */

import type { LatLon } from '@geonerva/domain';

/** WGS84 semi-major axis, metres. */
const A = 6_378_137;
/** WGS84 flattening. */
const F = 1 / 298.257_223_563;
/** WGS84 semi-minor axis, metres. */
const B = A * (1 - F);

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Iterations before Vincenty is declared non-convergent. The standard bound. */
const MAX_ITERATIONS = 200;
/** Convergence threshold on λ, in radians. ~0.06 mm at the equator. */
const CONVERGENCE = 1e-12;

/**
 * Vincenty's inverse solution, in metres.
 *
 * `null` when the pair is nearly antipodal and the iteration does not converge. Identical points
 * short-circuit to exactly `0`, because the general formula produces a NaN there rather than a
 * zero and "the distance from a place to itself" is not a case to leave to floating point.
 */
export function vincentyDistanceMeters(from: LatLon, to: LatLon): number | null {
  if (
    !Number.isFinite(from.lat) ||
    !Number.isFinite(from.lon) ||
    !Number.isFinite(to.lat) ||
    !Number.isFinite(to.lon)
  ) {
    return null;
  }
  if (from.lat === to.lat && from.lon === to.lon) return 0;

  const L = toRadians(to.lon - from.lon);
  const U1 = Math.atan((1 - F) * Math.tan(toRadians(from.lat)));
  const U2 = Math.atan((1 - F) * Math.tan(toRadians(to.lat)));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2SigmaM = 0;
  let cosSqAlpha = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    // Coincident after the ellipsoidal reduction — two points that differ only below the
    // precision this formula works at.
    if (sinSigma === 0) return 0;

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    // On an equatorial line `cosSqAlpha` is 0 and `cos2SigmaM` is undefined; the standard
    // treatment is to take it as 0, which the equatorial special case satisfies exactly.
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;

    const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

    if (Math.abs(lambda - previous) < CONVERGENCE) {
      const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
      const capA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
      const capB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
      const deltaSigma =
        capB *
        sinSigma *
        (cos2SigmaM +
          (capB / 4) *
            (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
              (capB / 6) *
                cos2SigmaM *
                (-3 + 4 * sinSigma * sinSigma) *
                (-3 + 4 * cos2SigmaM * cos2SigmaM)));
      return B * capA * (sigma - deltaSigma);
    }
  }

  // Nearly antipodal. Reported, not approximated: a wrong number here would be a very wrong one.
  return null;
}

/**
 * Distance in metres, or `Infinity` when it cannot be computed.
 *
 * For a caller whose question is "is this within R?", where a non-convergent antipodal pair is
 * certainly *not* within any radius GeoNerva uses. Anything that would *state* a distance must use
 * `vincentyDistanceMeters` and handle the `null`, rather than print `Infinity` at somebody.
 */
export function distanceMetersOrInfinity(from: LatLon, to: LatLon): number {
  return vincentyDistanceMeters(from, to) ?? Number.POSITIVE_INFINITY;
}

/**
 * Rounds a distance to the precision GeoNerva is willing to state.
 *
 * Whole kilometres above 10 km, one decimal below. Provider epicentres are located to a kilometre
 * at best and a VIIRS pixel is 375 m at nadir and twice that off-nadir, so "18.3274 km" claims a
 * precision no input has. A briefing that says "18 km" and a briefing that says "18.33 km" are
 * equally reproducible; only one of them is honest.
 */
export function statedKilometres(meters: number): number {
  if (!Number.isFinite(meters)) return Number.NaN;
  const km = meters / 1000;
  return km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
}

/** The eight-point compass bearing from one place to another, as a word. */
export const COMPASS_POINTS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

/**
 * Initial bearing, in degrees clockwise from north.
 *
 * The *initial* bearing, which is what "north-east of Marrakech" means for a nearby event. A
 * great-circle path's bearing changes along the way; over the tens of kilometres a briefing talks
 * about, the difference is not perceptible, and over larger distances the word is the wrong tool
 * anyway.
 */
export function initialBearingDegrees(from: LatLon, to: LatLon): number {
  const φ1 = toRadians(from.lat);
  const φ2 = toRadians(to.lat);
  const Δλ = toRadians(to.lon - from.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** The compass word for a bearing. `null` for a point that is not anywhere relative to itself. */
export function compassPointFor(from: LatLon, to: LatLon): CompassPoint | null {
  if (from.lat === to.lat && from.lon === to.lon) return null;
  const bearing = initialBearingDegrees(from, to);
  if (!Number.isFinite(bearing)) return null;
  // Each of the eight sectors is 45° wide and centred on its cardinal, so the boundary sits at
  // 22.5°: "north" runs from 337.5° to 22.5°, not from 0° to 45°.
  const index = Math.round(bearing / 45) % 8;
  return COMPASS_POINTS[index] ?? null;
}
