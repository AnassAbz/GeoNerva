/**
 * Spatial SQL against real PostGIS (docs/TESTING.md §4.5).
 *
 * The distances are checked against an **independent** Vincenty inverse solution computed in this
 * file, not against PostGIS's own answer — otherwise the test would only prove that PostGIS is
 * self-consistent. Vincenty on the WGS84 ellipsoid agrees with `ST_Distance(geography)` to well
 * under a metre, so a 0.1 % tolerance (docs/TESTING.md §4.5) is generous by three orders of
 * magnitude and would still catch the failures that matter: swapped lat/lon, a geometry cast that
 * silently turns metres into degrees, or an antimeridian box that selects the rest of the world.
 *
 * The reference places are the ones the product documents: Marrakech (the demo location),
 * Montréal, Suva (astride the antimeridian) and Longyearbyen (78° N, where planar maths breaks).
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LatLon } from '@geonerva/domain';

import { createDb } from '../client.ts';
import type { DB } from '../generated/database.ts';
import { bulkInsertDetections, createCluster } from '../repositories/fire.ts';
import { findProductByCode } from '../repositories/sources.ts';
import { PLACES, seedObservation, stableUuid } from '../testing/factories.ts';
import { setupTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import {
  buildClusterHull,
  distanceToGeometries,
  fireDetectionsInViewport,
  geometriesCoveringPoint,
  measureDistanceMeters,
  nearestDetections,
  nearestObservationVersions,
  observationsInViewport,
} from './queries.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const T0 = new Date('2026-09-19T10:00:00.000Z');

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
});

// ── An independent reference implementation ─────────────────────────────────

/**
 * Vincenty's inverse formula on the WGS84 ellipsoid, in metres.
 *
 * Written out here on purpose: it is a different algorithm, by a different author, from the one
 * PostGIS uses, so agreement between the two is evidence rather than tautology.
 */
function vincentyDistanceMeters(from: LatLon, to: LatLon): number {
  const a = 6_378_137;
  const f = 1 / 298.257223563;
  const b = (1 - f) * a;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const L = toRad(to.lon - from.lon);
  const U1 = Math.atan((1 - f) * Math.tan(toRad(from.lat)));
  const U2 = Math.atan((1 - f) * Math.tan(toRad(to.lat)));
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

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma +
          C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - previous) < 1e-12) break;
  }

  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));

  return b * A * (sigma - deltaSigma);
}

describe('the reference implementation itself', () => {
  it('agrees with the published Marrakech–Montréal distance', () => {
    // About 5,750 km. This only guards against a broken reference implementation.
    const km = vincentyDistanceMeters(PLACES.marrakech, PLACES.montreal) / 1000;
    expect(km).toBeGreaterThan(5_650);
    expect(km).toBeLessThan(5_850);
  });
});

describe('ST_Distance on geography', () => {
  it.each([
    ['Marrakech → Montréal', PLACES.marrakech, PLACES.montreal],
    ['Marrakech → Suva', PLACES.marrakech, PLACES.suva],
    ['Suva → across the antimeridian', PLACES.suva, PLACES.eastOfSuva],
    ['Longyearbyen → Marrakech', PLACES.longyearbyen, PLACES.marrakech],
    ['Longyearbyen → a point 10 km east', PLACES.longyearbyen, { lat: 78.2232, lon: 16.1 }],
  ])('%s matches Vincenty to within 0.1 %%', async (_name, from, to) => {
    const measured = await measureDistanceMeters(db, from, to);
    const reference = vincentyDistanceMeters(from, to);
    expect(Math.abs(measured - reference) / reference).toBeLessThan(0.001);
  });

  it('measures the short way across the antimeridian, not the long way round', async () => {
    // Suva at 178.44° E to 178.5° W is 3.06° apart across the dateline: about 320 km at 18° S.
    // Treating longitude as a plain number would give 356.9°, i.e. most of the planet — the
    // classic failure this whole design avoids.
    const measured = await measureDistanceMeters(db, PLACES.suva, PLACES.eastOfSuva);
    expect(measured).toBeLessThan(400_000);
    expect(measured).toBeCloseTo(vincentyDistanceMeters(PLACES.suva, PLACES.eastOfSuva), -1);

    const theLongWay = await measureDistanceMeters(db, PLACES.suva, { lat: -18.1416, lon: 0 });
    expect(theLongWay).toBeGreaterThan(10 * measured);
  });

  it('is zero for a point against itself, and symmetric', async () => {
    expect(await measureDistanceMeters(db, PLACES.marrakech, PLACES.marrakech)).toBe(0);
    const there = await measureDistanceMeters(db, PLACES.marrakech, PLACES.longyearbyen);
    const back = await measureDistanceMeters(db, PLACES.longyearbyen, PLACES.marrakech);
    expect(there).toBeCloseTo(back, 6);
  });

  it('does not degrade at high latitude', async () => {
    // One degree of longitude at 78° N is about 23 km, not 111 km. A planar calculation in
    // degrees would be out by a factor of five here.
    const measured = await measureDistanceMeters(db, PLACES.longyearbyen, {
      lat: 78.2232,
      lon: 16.6267,
    });
    expect(measured).toBeGreaterThan(20_000);
    expect(measured).toBeLessThan(25_000);
  });
});

describe('ST_DWithin radius search', () => {
  beforeEach(async () => {
    await seedObservation(db, {
      primaryKey: 'eq-10km',
      ingestedAt: T0,
      centroid: { lat: 31.72, lon: -8.0 },
    });
    await seedObservation(db, {
      primaryKey: 'eq-60km',
      ingestedAt: T0,
      centroid: { lat: 32.17, lon: -8.0 },
    });
    await seedObservation(db, {
      primaryKey: 'eq-antipodal',
      ingestedAt: T0,
      centroid: PLACES.suva,
    });
  });

  it('includes only what is genuinely within the radius', async () => {
    const result = await sql<{ primary_key: string }>`
      SELECT r.primary_key
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE ST_DWithin(v.centroid,
              ST_SetSRID(ST_MakePoint(${PLACES.marrakech.lon}, ${PLACES.marrakech.lat}), 4326)::geography,
              ${20_000})
      ORDER BY r.primary_key
    `.execute(db);
    expect(result.rows.map((row) => row.primary_key)).toStrictEqual(['eq-10km']);
  });

  it('agrees with the measured distance at the boundary', async () => {
    const exact = await measureDistanceMeters(db, PLACES.marrakech, { lat: 31.72, lon: -8.0 });
    const inside = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.observation_versions v
      WHERE ST_DWithin(v.centroid,
              ST_SetSRID(ST_MakePoint(${PLACES.marrakech.lon}, ${PLACES.marrakech.lat}), 4326)::geography,
              ${Math.ceil(exact)})
    `.execute(db);
    const outside = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.observation_versions v
      WHERE ST_DWithin(v.centroid,
              ST_SetSRID(ST_MakePoint(${PLACES.marrakech.lon}, ${PLACES.marrakech.lat}), 4326)::geography,
              ${Math.floor(exact) - 1})
    `.execute(db);
    expect(Number(inside.rows[0]?.n)).toBe(1);
    expect(Number(outside.rows[0]?.n)).toBe(0);
  });
});

describe('KNN ordering', () => {
  it('returns the nearest versions in order, with exact distances', async () => {
    for (const [key, lat] of [
      ['eq-a', 31.64],
      ['eq-b', 31.9],
      ['eq-c', 32.4],
    ] as const) {
      await seedObservation(db, { primaryKey: key, ingestedAt: T0, centroid: { lat, lon: -8.0 } });
    }

    const rows = await nearestObservationVersions(db, PLACES.marrakech, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.distance_m).toBeLessThan(rows[1]?.distance_m ?? Number.POSITIVE_INFINITY);
    expect(rows[0]?.distance_m).toBeCloseTo(
      vincentyDistanceMeters(PLACES.marrakech, { lat: 31.64, lon: -8.0 }),
      -1,
    );
  });
});

describe('ST_Covers: point in area', () => {
  /** A 1° square around Marrakech, as an adapter would deliver it. */
  const square = {
    type: 'Polygon',
    coordinates: [
      [
        [-8.5, 31.1],
        [-7.5, 31.1],
        [-7.5, 32.1],
        [-8.5, 32.1],
        [-8.5, 31.1],
      ],
    ],
  };

  beforeEach(async () => {
    await seedObservation(db, {
      sourceId: 'gdacs',
      primaryKey: 'FL-covers',
      hazardType: 'FLOOD',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
      attributes: { has_area_geometry: true },
      geometries: [{ role: 'affected_area', seq: 0, geoJson: square }],
    });
  });

  it('finds the area covering a point inside it', async () => {
    const covering = await geometriesCoveringPoint(db, PLACES.marrakech);
    expect(covering).toHaveLength(1);
    expect(covering[0]?.role).toBe('affected_area');
  });

  it('finds nothing for a point outside', async () => {
    expect(await geometriesCoveringPoint(db, PLACES.montreal)).toStrictEqual([]);
  });

  it('includes a point exactly on the boundary (ST_Covers, not ST_Contains)', async () => {
    // A place on the edge of a flood polygon is inside it as far as a user is concerned, which
    // is why the predicate is ST_Covers. A polygon vertex is the unambiguous boundary case.
    expect(await geometriesCoveringPoint(db, { lat: 31.1, lon: -8.5 })).toHaveLength(1);
  });

  it('treats polygon edges as geodesics, not as lines of constant latitude', async () => {
    // Worth stating explicitly, because it surprises people: on `geography`, the edge from
    // (−8.5, 31.1) to (−7.5, 31.1) is a great-circle arc, which bulges *north* of 31.1 between
    // its endpoints. A point at exactly (31.1, −8.0) therefore sits just outside the polygon —
    // by about 107 m here. Adapters that need a constant-latitude boundary must densify the
    // ring; GeoNerva's provider polygons already arrive densified.
    expect(await geometriesCoveringPoint(db, { lat: 31.1, lon: -8.0 })).toStrictEqual([]);
    const gap = await distanceToGeometries(db, { lat: 31.1, lon: -8.0 }, 1_000);
    expect(gap[0]?.distance_m).toBeGreaterThan(50);
    expect(gap[0]?.distance_m).toBeLessThan(200);
  });

  it('reports distance zero inside the area and a real distance outside', async () => {
    const inside = await distanceToGeometries(db, PLACES.marrakech, 500_000);
    expect(inside[0]?.distance_m).toBe(0);

    const outside = await distanceToGeometries(db, { lat: 30.0, lon: -8.0 }, 500_000);
    expect(outside[0]?.distance_m).toBeGreaterThan(100_000);
    expect(outside[0]?.distance_m).toBeLessThan(140_000);
  });

  it('respects the prefilter radius', async () => {
    expect(await distanceToGeometries(db, PLACES.montreal, 100_000)).toStrictEqual([]);
  });
});

describe('viewport queries', () => {
  beforeEach(async () => {
    await seedObservation(db, {
      primaryKey: 'vp-marrakech',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, { primaryKey: 'vp-suva', ingestedAt: T0, centroid: PLACES.suva });
    await seedObservation(db, {
      primaryKey: 'vp-east-of-suva',
      ingestedAt: T0,
      centroid: PLACES.eastOfSuva,
    });
    await seedObservation(db, {
      primaryKey: 'vp-montreal',
      ingestedAt: T0,
      centroid: PLACES.montreal,
    });
  });

  it('returns what is inside an ordinary box', async () => {
    const rows = await observationsInViewport(db, {
      west: -10,
      south: 30,
      east: -6,
      north: 33,
    });
    expect(rows).toHaveLength(1);
  });

  it('returns both sides of an antimeridian box, and nothing else', async () => {
    // west 177 → east −177 is a 6° window around the dateline. Unsplit, ST_MakeEnvelope would
    // build the complementary 354° box and return Marrakech and Montréal instead.
    const rows = await observationsInViewport(db, {
      west: 177,
      south: -20,
      east: -177,
      north: -16,
    });
    expect(rows).toHaveLength(2);
  });

  it('returns nothing for a box over empty ocean', async () => {
    expect(
      await observationsInViewport(db, { west: -40, south: -40, east: -30, north: -30 }),
    ).toStrictEqual([]);
  });

  it('applies the same split to detections', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const acquiredAt = new Date('2026-09-18T01:00:00.000Z');
    await bulkInsertDetections(db, [
      {
        productId: product?.id ?? 1,
        acquiredAt,
        lat: -18.14,
        lon: 179.9,
        confidenceClass: 'HIGH',
        confidenceRaw: 'high',
        frp: 5,
        brightTi4: null,
        brightTi5: null,
        scan: null,
        track: null,
        daynight: 'N',
        providerVersion: '2.0NRT',
        ingestedAt: T0,
      },
      {
        productId: product?.id ?? 1,
        acquiredAt,
        lat: -18.14,
        lon: -179.9,
        confidenceClass: 'HIGH',
        confidenceRaw: 'high',
        frp: 5,
        brightTi4: null,
        brightTi5: null,
        scan: null,
        track: null,
        daynight: 'N',
        providerVersion: '2.0NRT',
        ingestedAt: T0,
      },
    ]);

    const rows = await fireDetectionsInViewport(db, {
      west: 179,
      south: -19,
      east: -179,
      north: -17,
    });
    expect(rows).toHaveLength(2);
  });
});

describe('fire hull construction', () => {
  const clusterId = stableUuid('hull-cluster');

  it('builds a buffered convex hull over the member detections', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    await createCluster(db, {
      id: clusterId,
      publicId: 'FR-26-HULLAA',
      createdAt: T0,
      status: 'ACTIVE',
    });

    const acquiredAt = new Date('2026-09-18T02:00:00.000Z');
    await bulkInsertDetections(
      db,
      [
        { lat: 31.6, lon: -8.0 },
        { lat: 31.62, lon: -8.0 },
        { lat: 31.61, lon: -7.98 },
        { lat: 31.6, lon: -7.98 },
      ].map((point) => ({
        productId: product?.id ?? 1,
        acquiredAt,
        lat: point.lat,
        lon: point.lon,
        confidenceClass: 'NOMINAL' as const,
        confidenceRaw: 'nominal',
        frp: 3,
        brightTi4: null,
        brightTi5: null,
        scan: null,
        track: null,
        daynight: 'D' as const,
        providerVersion: '2.0NRT',
        ingestedAt: T0,
      })),
    );
    await sql`UPDATE geonerva.fire_detections SET cluster_id = ${clusterId}::uuid`.execute(db);

    const hull = await buildClusterHull(db, clusterId);
    expect(hull.detectionCount).toBe(4);
    expect(hull.hullGeoJson).not.toBeNull();

    const parsed = JSON.parse(hull.hullGeoJson ?? '{}') as { type: string };
    expect(parsed.type).toBe('Polygon');

    // The hull is buffered by half a pixel, so it is strictly larger than the raw hull.
    const areas = await sql<{ buffered: number; raw: number }>`
      SELECT ST_Area(ST_GeomFromGeoJSON(${hull.hullGeoJson})::geography) AS buffered,
             ST_Area(ST_ConvexHull(ST_Collect(d.geog::geometry))::geography) AS raw
      FROM geonerva.fire_detections d
      WHERE d.cluster_id = ${clusterId}::uuid
    `.execute(db);
    expect(areas.rows[0]?.buffered).toBeGreaterThan(areas.rows[0]?.raw ?? 0);
  });

  it('produces a circle for a single detection rather than failing', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const single = stableUuid('hull-single');
    await createCluster(db, {
      id: single,
      publicId: 'FR-26-HULLBB',
      createdAt: T0,
      status: 'ACTIVE',
    });
    await bulkInsertDetections(db, [
      {
        productId: product?.id ?? 1,
        acquiredAt: new Date('2026-09-18T04:00:00.000Z'),
        lat: 45.5,
        lon: -73.6,
        confidenceClass: 'LOW',
        confidenceRaw: 'low',
        frp: 1,
        brightTi4: null,
        brightTi5: null,
        scan: null,
        track: null,
        daynight: 'D',
        providerVersion: '2.0NRT',
        ingestedAt: T0,
      },
    ]);
    await sql`UPDATE geonerva.fire_detections SET cluster_id = ${single}::uuid`.execute(db);

    const hull = await buildClusterHull(db, single);
    expect(hull.detectionCount).toBe(1);
    const area = await sql<{ area: number }>`
      SELECT ST_Area(ST_GeomFromGeoJSON(${hull.hullGeoJson})::geography) AS area
    `.execute(db);
    // A 188 m radius circle is about 111,000 m².
    expect(area.rows[0]?.area).toBeGreaterThan(50_000);
    expect(area.rows[0]?.area).toBeLessThan(200_000);
  });

  it('orders detections by distance from a point', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const acquiredAt = new Date('2026-09-18T06:00:00.000Z');
    await bulkInsertDetections(
      db,
      [
        { lat: 31.7, lon: -8.0 },
        { lat: 31.64, lon: -8.0 },
        { lat: 32.0, lon: -8.0 },
      ].map((point) => ({
        productId: product?.id ?? 1,
        acquiredAt,
        lat: point.lat,
        lon: point.lon,
        confidenceClass: 'NOMINAL' as const,
        confidenceRaw: 'nominal',
        frp: 2,
        brightTi4: null,
        brightTi5: null,
        scan: null,
        track: null,
        daynight: 'D' as const,
        providerVersion: '2.0NRT',
        ingestedAt: T0,
      })),
    );

    const nearest = await nearestDetections(db, PLACES.marrakech, 3);
    const distances = nearest.map((row) => row.distance_m);
    expect(distances).toStrictEqual([...distances].sort((a, b) => a - b));
    expect(distances[0]).toBeCloseTo(
      vincentyDistanceMeters(PLACES.marrakech, { lat: 31.64, lon: -8.0 }),
      -1,
    );
  });
});
