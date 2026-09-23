/**
 * The geometry half of fire clustering (ARCHITECTURE §7.4).
 *
 * These tests fix the properties the *identity* layer depends on: the partition is a function of
 * the points alone, the output order is the input order, and the grid hash is a candidate filter
 * that never changes the answer. A bug in any of them would mint or merge cluster public ids that
 * users have already seen.
 */

import { describe, expect, it } from 'vitest';

import { vincentyDistanceMeters } from './distance.ts';
import { singleLinkage, type LinkablePoint } from './single-linkage.ts';

/** ARCHITECTURE §7.4: epsilon 1.5 km, 48 h, 0.02° grid. */
const OPTIONS = {
  epsilonMeters: 1_500,
  maxDeltaMs: 48 * 60 * 60 * 1000,
  cellDegrees: 0.02,
} as const;

const T0 = Date.parse('2026-09-20T08:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** A point `metresNorth` north of a base, using the shortest degree of latitude (WGS84). */
function north(
  base: LinkablePoint,
  id: string,
  metresNorth: number,
  atMs = base.atMs,
): LinkablePoint {
  return { id, lat: base.lat + metresNorth / 110_574, lon: base.lon, atMs };
}

const MARRAKECH: LinkablePoint = { id: 'a', lat: 31.6295, lon: -7.9811, atMs: T0 };

describe('singleLinkage', () => {
  it('puts two nearby, contemporaneous detections in one cluster', () => {
    const components = singleLinkage([MARRAKECH, north(MARRAKECH, 'b', 400)], OPTIONS);
    expect(components).toEqual([['a', 'b']]);
  });

  it('keeps spatially distant detections apart', () => {
    /* 5 km, comfortably outside the 1.5 km epsilon. */
    const components = singleLinkage([MARRAKECH, north(MARRAKECH, 'b', 5_000)], OPTIONS);
    expect(components).toEqual([['a'], ['b']]);
  });

  it('keeps temporally distant detections apart, however close they are', () => {
    /*
     * Same pixel, 72 h apart. Without the time predicate a fire that burned in one place last week
     * and again today would read as one continuous cluster, and its "first detected" would be a
     * week old — the difference between a fire that is still burning and one that came back.
     */
    const later = { ...MARRAKECH, id: 'b', atMs: T0 + 72 * HOUR };
    expect(singleLinkage([MARRAKECH, later], OPTIONS)).toEqual([['a'], ['b']]);
  });

  it('links transitively, because a fire front is a chain of pixels', () => {
    /*
     * a—b and b—c are each 1 km; a—c is 2 km and is **not** within epsilon. Single linkage joins
     * them anyway, which is the intended behaviour: the front is one fire, not two.
     */
    const b = north(MARRAKECH, 'b', 1_000);
    const c = north(MARRAKECH, 'c', 2_000);
    expect(singleLinkage([MARRAKECH, b, c], OPTIONS)).toEqual([['a', 'b', 'c']]);
  });

  it('is a partition of the input: every point appears exactly once', () => {
    const points = [
      MARRAKECH,
      north(MARRAKECH, 'b', 400),
      north(MARRAKECH, 'c', 30_000),
      { ...MARRAKECH, id: 'd', atMs: T0 + 96 * HOUR },
    ];
    const ids = singleLinkage(points, OPTIONS).flat().sort();
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns components and members in input order, so identity cannot wobble', () => {
    /*
     * The orchestration mints a public id for a component and inherits the oldest existing id.
     * Both depend on this order being the caller's `(acquired_at, id)` sort rather than whatever
     * order the grid happened to bucket things in.
     */
    const far = { id: 'z', lat: 10, lon: 10, atMs: T0 };
    const near = north(MARRAKECH, 'b', 300);
    const components = singleLinkage([far, MARRAKECH, near], OPTIONS);
    expect(components).toEqual([['z'], ['a', 'b']]);
  });

  it('gives the same partition whatever order the points arrive in', () => {
    const points = [
      MARRAKECH,
      north(MARRAKECH, 'b', 400),
      north(MARRAKECH, 'c', 800),
      north(MARRAKECH, 'd', 9_000),
    ];
    const forward = singleLinkage(points, OPTIONS).map((component) => [...component].sort());
    const reversed = singleLinkage([...points].reverse(), OPTIONS).map((component) =>
      [...component].sort(),
    );
    expect([...reversed].sort()).toEqual([...forward].sort());
  });

  it('links across the antimeridian', () => {
    /*
     * Fiji is a standing test coordinate here for exactly this reason. Two pixels 1 km apart with
     * longitudes 179.9995 and -179.9995 are neighbours; a grid that did not wrap would file them
     * in cells at opposite ends of the world and report two fires.
     */
    const west: LinkablePoint = { id: 'w', lat: -17.8, lon: 179.9955, atMs: T0 };
    const east: LinkablePoint = { id: 'e', lat: -17.8, lon: -179.9955, atMs: T0 };
    expect(singleLinkage([west, east], OPTIONS)).toEqual([['w', 'e']]);
  });

  it('links at high latitude, where a longitude cell is far narrower than epsilon', () => {
    /*
     * Svalbard. At 78° N a 0.02° longitude cell is ~460 m, so a fixed 3×3 window spans ~1.4 km of
     * longitude and would miss a neighbour at 1.2 km — splitting every high-latitude fire into
     * stripes while every test at mid-latitude still passed.
     */
    const base: LinkablePoint = { id: 'a', lat: 78.22, lon: 15.63, atMs: T0 };
    const metresPerLonDegree = 111_320 * Math.cos((base.lat * Math.PI) / 180);
    const east: LinkablePoint = {
      id: 'b',
      lat: base.lat,
      lon: base.lon + 1_200 / metresPerLonDegree,
      atMs: T0,
    };
    expect(singleLinkage([base, east], OPTIONS)).toEqual([['a', 'b']]);
  });

  it('does not link points that are close in cells but far in metres', () => {
    /*
     * The grid is generous on purpose — a 0.02° cell is 2.2 km tall — so without the exact geodesic
     * check two points in the same cell would link at any distance and clusters would be
     * grid-shaped. 2 km apart, same cell neighbourhood, must stay apart.
     */
    const components = singleLinkage([MARRAKECH, north(MARRAKECH, 'b', 2_000)], OPTIONS);
    expect(components).toEqual([['a'], ['b']]);
  });

  it('links just inside the epsilon and not just outside it', () => {
    /*
     * The pair is placed by true geodesic distance rather than by the `north` helper's nominal
     * metres: that helper divides by the *shortest* degree of latitude, so at 31.6° N a nominal
     * 1,499 m is really about 1,503 m and would sit outside epsilon. Asserting the real distance
     * here keeps the test about the algorithm's threshold instead of the fixture's arithmetic.
     */
    const inside = north(MARRAKECH, 'b', 1_400);
    const outside = north(MARRAKECH, 'b', 1_600);
    expect(
      vincentyDistanceMeters(
        { lat: MARRAKECH.lat, lon: MARRAKECH.lon },
        { lat: inside.lat, lon: inside.lon },
      ),
    ).toBeLessThan(OPTIONS.epsilonMeters);
    expect(
      vincentyDistanceMeters(
        { lat: MARRAKECH.lat, lon: MARRAKECH.lon },
        { lat: outside.lat, lon: outside.lon },
      ),
    ).toBeGreaterThan(OPTIONS.epsilonMeters);

    expect(singleLinkage([MARRAKECH, inside], OPTIONS)).toEqual([['a', 'b']]);
    expect(singleLinkage([MARRAKECH, outside], OPTIONS)).toEqual([['a'], ['b']]);
  });

  it('returns nothing for no points', () => {
    expect(singleLinkage([], OPTIONS)).toEqual([]);
  });

  it('handles a chain longer than any cell, which is what a fire front is', () => {
    /* Twenty pixels at 400 m spacing: 8 km end to end, every link inside epsilon. */
    const chain = Array.from({ length: 20 }, (_, index) =>
      north(MARRAKECH, `p${String(index)}`, index * 400),
    );
    const components = singleLinkage(chain, OPTIONS);
    expect(components).toHaveLength(1);
    expect(components[0]).toHaveLength(20);
  });
});
