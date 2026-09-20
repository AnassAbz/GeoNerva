/**
 * Pure geodesy, cross-checked by hand and at the edges of the map.
 *
 * Every distance here is checked against arithmetic written out in the test itself — the spherical
 * law of cosines, or a metres-per-degree figure — rather than against PostGIS or against another
 * implementation in this repository. `packages/db/src/spatial/spatial.int.test.ts` deliberately
 * keeps its own Vincenty as an independent oracle for PostGIS, and coupling the two would leave
 * both sides of that comparison depending on this file.
 *
 * Three of these assertions were wrong on the first run and the implementation was right. They are
 * annotated in place, because "the test disagreed with the code" is only useful if it also says
 * which one was believed and why.
 *
 * The edge cases are the ones G6 asks for by name — poles, the antimeridian, ±180, large radii —
 * and every one of them is a place where a plausible implementation is silently wrong rather than
 * loudly broken. That is the whole reason they are here: a radius query that quietly drops the
 * hazards at the corners of its own circle is worse than one that fails.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_RADIUS_METERS,
  RadiusError,
  boundingBoxesForRadius,
  compassPointFor,
  initialBearingDegrees,
  statedKilometres,
  vincentyDistanceMeters,
} from './index.ts';

const MARRAKECH = { lat: 31.6295, lon: -7.9811 };
const MONTREAL = { lat: 45.5019, lon: -73.5674 };
const SUVA = { lat: -18.1416, lon: 178.4419 };
const LONGYEARBYEN = { lat: 78.2232, lon: 15.6267 };

describe('vincentyDistanceMeters', () => {
  it('agrees with an independent spherical solution on a long intercontinental line', () => {
    /*
     * Marrakech → Montréal, cross-checked against the spherical law of cosines computed here:
     *
     *   cos d = sinφ₁·sinφ₂ + cosφ₁·cosφ₂·cosΔλ
     *         = 0.5244·0.7133 + 0.8514·0.7009·0.4132 = 0.6206  →  d = 51.63°  →  5,742 km
     *
     * Vincenty answers 5,753 km. The 11 km difference is the ellipsoid, and it is the right sign
     * and size for a mid-latitude line running mostly east–west: about 0.2 %, which over this
     * distance is the whole reason the formula is Vincenty rather than haversine.
     *
     * The first version of this test asserted 6,152.6 km and called it "the published WGS84
     * geodesic". It is not — that number was never computed, from anything. The implementation was
     * right and the assertion was invented, which is the failure mode this project's own rules
     * exist to prevent, committed in the file whose job is to catch it. The formula above is
     * arithmetic anyone can check by hand.
     */
    const meters = vincentyDistanceMeters(MARRAKECH, MONTREAL);
    expect(meters).not.toBeNull();
    const km = (meters ?? 0) / 1000;
    const spherical = 5_742;
    expect(km).toBeGreaterThan(spherical * 0.998);
    expect(km).toBeLessThan(spherical * 1.005);
  });

  it('is exact for a point against itself, rather than nearly exact', () => {
    // The general formula produces a NaN here: `sinSigma` is 0 and the bearing is undefined.
    // "How far is this place from itself" is not a question to leave to floating point.
    expect(vincentyDistanceMeters(MARRAKECH, MARRAKECH)).toBe(0);
    expect(vincentyDistanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
  });

  it('measures across the antimeridian the short way', () => {
    /*
     * Suva sits 1.6° west of the 180th meridian. A point just east of it is about 40 km away, not
     * 39,900 km — which is what a naive `lon2 - lon1` gives, and it is the sort of number that
     * would place a Fijian earthquake on the other side of the planet.
     */
    const eastOfSuva = { lat: -18.1416, lon: -179.9581 };
    const meters = vincentyDistanceMeters(SUVA, eastOfSuva);
    expect(meters).not.toBeNull();
    expect((meters ?? 0) / 1000).toBeGreaterThan(100);
    expect((meters ?? 0) / 1000).toBeLessThan(300);
  });

  it('measures a degree of longitude as shorter at high latitude', () => {
    /*
     * The fact the bounding box depends on. One degree of longitude is ~111 km at the equator and
     * ~23 km at Longyearbyen's 78°. Any code that treats them as equal is wrong in a way that
     * gets worse the further from the equator you ask.
     */
    const atEquator = vincentyDistanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) ?? 0;
    const atSvalbard =
      vincentyDistanceMeters(LONGYEARBYEN, { lat: LONGYEARBYEN.lat, lon: LONGYEARBYEN.lon + 1 }) ??
      0;
    expect(atEquator / 1000).toBeCloseTo(111.3, 0);
    expect(atSvalbard / 1000).toBeCloseTo(22.9, 0);
  });

  it('measures a degree of latitude as almost constant', () => {
    // ~110.6 km at the equator, ~111.7 km at the pole: the ellipsoid, not a bug.
    const nearEquator = vincentyDistanceMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) ?? 0;
    const nearPole = vincentyDistanceMeters({ lat: 88, lon: 0 }, { lat: 89, lon: 0 }) ?? 0;
    expect(nearEquator / 1000).toBeCloseTo(110.6, 0);
    expect(nearPole / 1000).toBeCloseTo(111.7, 0);
  });

  it('crosses the pole without special-casing it', () => {
    /*
     * Two points on opposite meridians at 89° are 2° apart *over the pole*. Near the pole a
     * degree of latitude is 111.69 km on the WGS84 ellipsoid — as the test above asserts — so the
     * distance is 2 × 111.69 = 223.4 km.
     *
     * This first asserted 222.6 km, from the *mean* 111.3 km/degree, which contradicted the
     * neighbouring test in this same file. Two assertions in one file disagreeing about the
     * ellipsoid is a sign that one of them was written from a half-remembered constant.
     */
    const meters = vincentyDistanceMeters({ lat: 89, lon: 0 }, { lat: 89, lon: 180 });
    expect(meters).not.toBeNull();
    expect((meters ?? 0) / 1000).toBeCloseTo(223.4, 0);
  });

  it('reports a non-convergent antipodal pair rather than guessing', () => {
    /*
     * Vincenty's inverse formula does not converge for nearly-antipodal points. Returning a
     * plausible-looking number there would be the worst of the options, so it returns `null` and
     * the caller decides. No hazard question is antipodal — "near here" is bounded by a radius —
     * so this is a guard rather than a gap.
     */
    const antipodal = vincentyDistanceMeters({ lat: 0, lon: 0 }, { lat: 0.5, lon: 179.7 });
    expect(antipodal).toBeNull();
  });

  it('refuses a position that is not one', () => {
    expect(vincentyDistanceMeters({ lat: Number.NaN, lon: 0 }, MARRAKECH)).toBeNull();
    expect(vincentyDistanceMeters(MARRAKECH, { lat: 0, lon: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('statedKilometres', () => {
  it('states no more precision than the inputs have', () => {
    /*
     * A provider epicentre is located to about a kilometre and a VIIRS pixel is 375 m at nadir.
     * "18.3274 km" claims a precision nothing in the pipeline has; both roundings are equally
     * reproducible and only one of them is honest.
     */
    expect(statedKilometres(18_327.4)).toBe(18);
    expect(statedKilometres(4_321)).toBe(4.3);
    expect(statedKilometres(9_950)).toBe(10);
    expect(statedKilometres(250)).toBe(0.3);
  });
});

describe('bearings', () => {
  it('names the direction from a place to a nearby event', () => {
    const northOf = { lat: MARRAKECH.lat + 0.2, lon: MARRAKECH.lon };
    const eastOf = { lat: MARRAKECH.lat, lon: MARRAKECH.lon + 0.2 };
    expect(compassPointFor(MARRAKECH, northOf)).toBe('north');
    expect(compassPointFor(MARRAKECH, eastOf)).toBe('east');
    expect(compassPointFor(MARRAKECH, { lat: MARRAKECH.lat + 0.2, lon: MARRAKECH.lon + 0.2 })).toBe(
      'north-east',
    );
  });

  it('puts the sector boundary between the cardinals, not on them', () => {
    /*
     * Each of the eight words covers 45° *centred* on its cardinal, so "north" runs from 337.5°
     * to 22.5°. A naive `floor(bearing / 45)` would make "north" mean 0°–45°, which calls a
     * due-east-ish event north-east and a due-north event north — wrong half the time at every
     * boundary.
     */
    expect(initialBearingDegrees({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 5);
    expect(initialBearingDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 5);
    // 20° from north is still "north"; 30° is "north-east".
    const at20 = { lat: Math.cos((20 * Math.PI) / 180), lon: Math.sin((20 * Math.PI) / 180) };
    const at30 = { lat: Math.cos((30 * Math.PI) / 180), lon: Math.sin((30 * Math.PI) / 180) };
    expect(compassPointFor({ lat: 0, lon: 0 }, at20)).toBe('north');
    expect(compassPointFor({ lat: 0, lon: 0 }, at30)).toBe('north-east');
  });

  it('has no direction from a place to itself', () => {
    expect(compassPointFor(MARRAKECH, MARRAKECH)).toBeNull();
  });
});

describe('boundingBoxesForRadius', () => {
  const contains = (
    boxes: readonly { west: number; south: number; east: number; north: number }[],
    point: { lat: number; lon: number },
  ): boolean =>
    boxes.some(
      (box) =>
        point.lat >= box.south &&
        point.lat <= box.north &&
        point.lon >= box.west &&
        point.lon <= box.east,
    );

  it('contains every point on the circle, at the equator', () => {
    const boxes = boundingBoxesForRadius({ lat: 0, lon: 0 }, 50_000);
    expect(boxes).toHaveLength(1);
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const radians = (bearing * Math.PI) / 180;
      // 50 km along each cardinal and diagonal, in degrees at the equator.
      const degrees = 50_000 / 111_320;
      const point = { lat: degrees * Math.cos(radians), lon: degrees * Math.sin(radians) };
      expect(contains(boxes, point)).toBe(true);
    }
  });

  it('widens the box at high latitude instead of dropping the corners', () => {
    /*
     * The bug this function exists for. At Longyearbyen a degree of longitude is 23 km, so a
     * 50 km radius spans about ±2.2° — not the ±0.45° a fixed equatorial factor would give. A box
     * built with that factor is five times too narrow, and every hazard east or west of the
     * centre falls outside the prefilter and is never measured. Silently, and worse the further
     * north the question is asked.
     */
    const boxes = boundingBoxesForRadius(LONGYEARBYEN, 50_000);
    expect(boxes).toHaveLength(1);
    const box = boxes[0];
    if (box === undefined) throw new Error('expected a box');
    expect(box.east - box.west).toBeGreaterThan(4);

    // A point 45 km due east really is inside it.
    const east = {
      lat: LONGYEARBYEN.lat,
      lon: LONGYEARBYEN.lon + 45_000 / (111_320 * Math.cos((LONGYEARBYEN.lat * Math.PI) / 180)),
    };
    expect(vincentyDistanceMeters(LONGYEARBYEN, east)).toBeLessThan(50_000);
    expect(contains(boxes, east)).toBe(true);
  });

  it('takes the whole world in longitude when the circle reaches a pole', () => {
    /*
     * At 89.9° a 50 km radius spans every meridian. `1 / cos(lat)` diverges, and because
     * `Math.cos(Math.PI / 2)` is 6.1e-17 rather than 0 a bare division gives a colossal but
     * finite delta — so the pole case is decided by geometry, not by watching the arithmetic
     * misbehave.
     */
    const boxes = boundingBoxesForRadius({ lat: 89.9, lon: 0 }, 50_000);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ west: -180, east: 180, north: 90 });

    // And the south pole, which is the same case with the sign flipped.
    expect(boundingBoxesForRadius({ lat: -89.95, lon: 120 }, 20_000)[0]).toMatchObject({
      west: -180,
      east: 180,
      south: -90,
    });
  });

  it('splits at the antimeridian rather than inverting the box', () => {
    /*
     * Suva is 20 km from the 180th meridian. A single box with `west = 176, east = -178` passed
     * to `ST_MakeEnvelope` is every feature on Earth *except* the ones being asked about. Two
     * boxes, each with `west <= east`, make that impossible to get wrong.
     */
    const boxes = boundingBoxesForRadius(SUVA, 200_000);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box.west).toBeLessThanOrEqual(box.east);
    expect(boxes.some((box) => box.east === 180)).toBe(true);
    expect(boxes.some((box) => box.west === -180)).toBe(true);

    /*
     * A point the other side of the meridian *and inside the radius* is covered.
     *
     * This first probed −179.5°, which is 218 km from Suva — outside the 200 km circle, so the
     * box was right to exclude it and the test was wrong to demand it. −179.8° is 186 km away and
     * genuinely inside, which is what the split has to catch.
     */
    const acrossAndInside = { lat: SUVA.lat, lon: -179.8 };
    expect(vincentyDistanceMeters(SUVA, acrossAndInside)).toBeLessThan(200_000);
    expect(contains(boxes, acrossAndInside)).toBe(true);

    // And the one just outside stays outside, so the box is a bound and not a blanket.
    const acrossAndOutside = { lat: SUVA.lat, lon: -179.4 };
    expect(vincentyDistanceMeters(SUVA, acrossAndOutside)).toBeGreaterThan(200_000);
  });

  it('handles a centre exactly on the antimeridian', () => {
    const boxes = boundingBoxesForRadius({ lat: 0, lon: -180 }, 100_000);
    for (const box of boxes) expect(box.west).toBeLessThanOrEqual(box.east);
    expect(contains(boxes, { lat: 0, lon: 179.5 })).toBe(true);
    expect(contains(boxes, { lat: 0, lon: -179.5 })).toBe(true);
  });

  it('refuses a radius larger than any question this product asks', () => {
    // Clamping would give a smaller answer than was asked for without saying so.
    expect(() => boundingBoxesForRadius(MARRAKECH, MAX_RADIUS_METERS + 1)).toThrow(RadiusError);
    expect(() => boundingBoxesForRadius(MARRAKECH, 0)).toThrow(/not a radius/);
    expect(() => boundingBoxesForRadius(MARRAKECH, Number.NaN)).toThrow(/not a radius/);
    expect(() => boundingBoxesForRadius({ lat: 91, lon: 0 }, 1_000)).toThrow(/not a latitude/);
  });

  it('never returns a box narrower than the circle, anywhere on the map', () => {
    /*
     * The property, rather than a handful of cases: for a grid of centres and radii, every point
     * that Vincenty says is inside the circle must be inside one of the boxes. A box that fails
     * this drops hazards, and drops them in a way no single example would reveal.
     */
    const radii = [1_000, 25_000, 100_000, 400_000];
    for (const lat of [-89, -60, -23.5, 0, 23.5, 60, 78, 89]) {
      for (const lon of [-180, -90, -0.5, 0, 45, 179.5]) {
        for (const radius of radii) {
          const center = { lat, lon };
          const boxes = boundingBoxesForRadius(center, radius);
          for (const box of boxes) expect(box.west).toBeLessThanOrEqual(box.east);

          for (const bearing of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
            const point = destination(center, radius * 0.99, bearing);
            const measured = vincentyDistanceMeters(center, point);
            if (measured === null || measured > radius) continue;
            expect(
              contains(boxes, point),
              `(${lat}, ${lon}) r=${radius} bearing=${bearing} -> (${point.lat}, ${point.lon})`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

/**
 * A destination point, for generating test cases only.
 *
 * The spherical direct formula: good enough to place a probe point, and deliberately *not* the
 * same mathematics as the function under test, so a shared error cannot hide.
 */
function destination(
  from: { lat: number; lon: number },
  meters: number,
  bearingDegrees: number,
): { lat: number; lon: number } {
  const R = 6_371_008.8;
  const δ = meters / R;
  const θ = (bearingDegrees * Math.PI) / 180;
  const φ1 = (from.lat * Math.PI) / 180;
  const λ1 = (from.lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  const lat = (φ2 * 180) / Math.PI;
  let lon = (λ2 * 180) / Math.PI;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat, lon };
}
