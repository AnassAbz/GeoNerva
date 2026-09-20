/**
 * Does the in-process geodesy agree with PostGIS?
 *
 * `packages/geo` and `geography` in PostgreSQL both measure on the WGS84 ellipsoid, and GeoNerva
 * uses each of them for different jobs: the database narrows candidates with a GiST index, and the
 * pure implementation states the distance a briefing prints and compares the thousands of pairs
 * clustering needs. Those two numbers appear side by side in the product — a map pin placed by the
 * database, a sentence written from the in-process figure — so a disagreement between them is a
 * disagreement the user can see.
 *
 * It lives in `packages/briefing` rather than in `packages/db`, and that is a layering decision
 * rather than a filing one: the architecture forbids `db → geo` outright, with no exception for
 * tests, and `briefing` is the layer that legitimately depends on both — it states a distance
 * from `geo` beside facts read through `db`, which is precisely the pair this test is about.
 *
 * This is the only place the two are compared. `spatial.int.test.ts` keeps its own Vincenty as an
 * oracle for PostGIS and deliberately does not import `packages/geo`, so that a bug in the
 * production geodesy cannot make that suite agree with itself. Here the coupling is the point.
 *
 * The bounding-box test below is **not** a duplicate of the property test in `packages/geo`, and
 * mutation testing showed why: dividing by the mean degree of latitude rather than the shortest
 * one fails here and passes there, because that test places its probes with a spherical formula
 * that cannot resolve a 0.7 % ellipsoidal shortfall. The reverse also holds — taking the longitude
 * delta at the centre's latitude fails there and passes here, because four centres never reach
 * the box corners. Each suite is the other's blind spot.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { boundingBoxesForRadius, vincentyDistanceMeters } from '@geonerva/geo';

import { createDb, measureDistanceMeters, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';

let testDb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

/** The four places the spatial suite already uses, chosen for where they sit on the map. */
const PLACES = {
  marrakech: { lat: 31.6295, lon: -7.9811 },
  montreal: { lat: 45.5019, lon: -73.5674 },
  /** 1.6° west of the antimeridian. */
  suva: { lat: -18.1416, lon: 178.4419 },
  /** 78° N, where a degree of longitude is 23 km. */
  longyearbyen: { lat: 78.2232, lon: 15.6267 },
  nearNorthPole: { lat: 89.5, lon: 0 },
  onAntimeridian: { lat: 0, lon: -180 },
} as const;

describe('the in-process geodesy against PostGIS', () => {
  it.each([
    ['a continental line', PLACES.marrakech, PLACES.montreal],
    ['across the antimeridian', PLACES.suva, { lat: -18.1416, lon: -179.8 }],
    ['at high latitude', PLACES.longyearbyen, { lat: 78.2232, lon: 16.6267 }],
    ['near the pole', PLACES.nearNorthPole, { lat: 89.5, lon: 180 }],
    ['on the antimeridian', PLACES.onAntimeridian, { lat: 0, lon: 179.5 }],
    ['a short urban hop', PLACES.marrakech, { lat: 31.64, lon: -8.0 }],
  ])('agrees within 1 m on %s', async (_name, from, to) => {
    const postgis = await measureDistanceMeters(db, from, to);
    const pure = vincentyDistanceMeters(from, to);

    expect(pure).not.toBeNull();
    /*
     * One metre, on distances up to 6,000 km. That is ~0.2 parts per million, which is the level
     * at which two correct ellipsoidal implementations differ — PostGIS uses Karney's method and
     * this uses Vincenty's, and they are not the same arithmetic. A tolerance of 0.1 % would pass
     * a haversine implementation too, and pass it silently.
     */
    expect(Math.abs((pure ?? 0) - postgis)).toBeLessThan(1);
  });

  it('agrees that a place is zero metres from itself', async () => {
    expect(await measureDistanceMeters(db, PLACES.suva, PLACES.suva)).toBeCloseTo(0, 6);
    expect(vincentyDistanceMeters(PLACES.suva, PLACES.suva)).toBe(0);
  });
});

describe('the radius bounding box against PostGIS', () => {
  it.each([
    ['Marrakech', PLACES.marrakech, 50_000],
    ['Suva, across the antimeridian', PLACES.suva, 200_000],
    ['Longyearbyen, at 78° N', PLACES.longyearbyen, 50_000],
    ['near the north pole', PLACES.nearNorthPole, 100_000],
  ])('contains everything ST_DWithin would accept, for %s', async (_name, center, radius) => {
    /*
     * The property the prefilter depends on, checked against the authority that would otherwise
     * disagree with it: for a ring of points at 99.9 % of the radius, PostGIS says each one is
     * within, and therefore every one must fall inside one of the boxes.
     *
     * 99.9 %, not 95 %, and every 5° rather than every 15°. At 95 % this test passed a version
     * that took the longitude delta at the *centre's* latitude rather than at the widest edge of
     * the band — a real bug that the unit property test caught and this one did not, because the
     * points it dropped were the ones nearest the corners of the box. A ring that never goes near
     * the corner cannot find a corner bug.
     *
     * A box that fails this drops hazards from a radius query *silently* — the exact `ST_DWithin`
     * runs afterwards and is correct, but it only ever sees what the box handed it. Nothing
     * downstream can tell a hazard that was excluded from a hazard that was not there.
     */
    const boxes = boundingBoxesForRadius(center, radius);
    for (const box of boxes) expect(box.west).toBeLessThanOrEqual(box.east);

    for (let bearing = 0; bearing < 360; bearing += 5) {
      const point = await destinationFromPostgis(db, center, radius * 0.999, bearing);
      const within = await isWithinPostgis(db, center, point, radius);
      if (!within) continue;

      const covered = boxes.some(
        (box) =>
          point.lat >= box.south &&
          point.lat <= box.north &&
          point.lon >= box.west &&
          point.lon <= box.east,
      );
      expect(
        covered,
        `bearing ${bearing}° -> (${point.lat}, ${point.lon}) is within ${radius} m but outside every box`,
      ).toBe(true);
    }
  });
});

/**
 * A destination point, computed by PostGIS.
 *
 * `ST_Project` on `geography` walks the ellipsoid, so the probe points are placed by the same
 * authority that is asked whether they are inside — which means a failure can only be the box's,
 * never the probe's.
 */
async function destinationFromPostgis(
  handle: Kysely<DB>,
  from: { lat: number; lon: number },
  meters: number,
  bearingDegrees: number,
): Promise<{ lat: number; lon: number }> {
  const result = await sql<{ lat: number; lon: number }>`
    WITH projected AS (
      SELECT ST_Project(
        ST_SetSRID(ST_MakePoint(${from.lon}, ${from.lat}), 4326)::geography,
        ${meters}::double precision,
        radians(${bearingDegrees}::double precision)
      ) AS p
    )
    SELECT ST_Y(p::geometry) AS lat, ST_X(p::geometry) AS lon FROM projected
  `.execute(handle);
  const row = result.rows[0];
  if (row === undefined) throw new Error('ST_Project returned nothing');
  return { lat: row.lat, lon: row.lon };
}

async function isWithinPostgis(
  handle: Kysely<DB>,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  meters: number,
): Promise<boolean> {
  const result = await sql<{ within: boolean }>`
    SELECT ST_DWithin(
      ST_SetSRID(ST_MakePoint(${from.lon}, ${from.lat}), 4326)::geography,
      ST_SetSRID(ST_MakePoint(${to.lon}, ${to.lat}), 4326)::geography,
      ${meters}::double precision
    ) AS within
  `.execute(handle);
  return result.rows[0]?.within ?? false;
}
