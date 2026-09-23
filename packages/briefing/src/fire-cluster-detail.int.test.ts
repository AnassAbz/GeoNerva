/**
 * `buildFireClusterDetail` against real PostGIS.
 *
 * The property that matters most here is the one ADR-039 is about: the member detections are read
 * as of the summary version's own knowledge time, and they may be shown only when their count
 * agrees with its `n_total` — which, since ADR-039, says that the whole set is still held rather
 * than that it is the right set. A per-day breakdown missing the rows retention dropped, shown
 * against a total that counts them, would misdescribe when the fire burned.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assignDetectionsToCluster,
  bulkInsertDetections,
  createCluster,
  createDb,
  insertClusterVersionIfChanged,
  mergeClusters,
  type DB,
} from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { contentHash, stableUuid } from '@geonerva/db/testing/factories';
import {
  fireClusterDetailSchema,
  type FireClusterDetail,
  type LocationRef,
} from '@geonerva/domain';
import { THERMAL_DETECTION_CAVEAT } from '@geonerva/relevance';

import { buildFireClusterDetail } from './fire-cluster-detail.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const T0 = new Date('2026-09-19T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const hours = (n: number): Date => minutes(n * 60);

/*
 * When a cluster assignment became true (ADR-039). These helpers ingest at `minutes(35)` and
 * summarize shortly after, so the clustering run that assigned them ran at the same point; it is a
 * knowledge time, and a replay before it must not see the membership.
 */
const ASSIGNED_AT = minutes(35);

const CENTRE = { lat: 31.5, lon: -8.3 };
const MARRAKECH: LocationRef = {
  key: 'c:31.63,-8.00',
  label: '31.63, -8.00',
  lat: 31.63,
  lon: -8.0,
  timezone: 'Africa/Casablanca',
  countryCode: null,
  admin1: null,
};

let productId = 0;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
  const product = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = 'firms' AND code = 'VIIRS_NOAA20_NRT'
  `.execute(db);
  productId = product.rows[0]?.id ?? 0;
});

async function detailOf(
  publicId: string,
  asOf: Date,
  location: LocationRef | null = null,
): Promise<FireClusterDetail> {
  const result = await buildFireClusterDetail({ db, publicId, asOf, location });
  if (result.kind !== 'found') throw new Error(`expected a detail, got ${result.kind}`);
  return fireClusterDetailSchema.parse(result.detail);
}

/** A cluster, one summary version, and optionally the detections that version counted. */
async function cluster(options: {
  readonly label: string;
  readonly publicId: string;
  readonly nTotal: number;
  readonly detections: number;
  readonly asOf?: Date;
  readonly lastDetectedAt?: Date;
  readonly confidenceClass?: 'NOMINAL' | null;
}): Promise<string> {
  const id = stableUuid(options.label);
  await createCluster(db, { id, publicId: options.publicId, createdAt: T0, status: 'ACTIVE' });
  const last = options.lastDetectedAt ?? minutes(30);
  await insertClusterVersionIfChanged(db, {
    clusterId: id,
    asOf: options.asOf ?? minutes(40),
    nTotal: options.nTotal,
    n24h: options.nTotal,
    overpasses24h: 1,
    firstDetectedAt: T0,
    lastDetectedAt: last,
    frpSum24h: 10,
    frpMax: 5,
    maxConfidence: 'NOMINAL',
    productIds: [productId],
    hullGeoJson: null,
    centroid: CENTRE,
    status: 'ACTIVE',
    contentSha256: contentHash(options.label, options.nTotal),
  });
  if (options.detections > 0) {
    await bulkInsertDetections(
      db,
      Array.from({ length: options.detections }, (_, index) => ({
        productId,
        acquiredAt: minutes(index),
        lat: CENTRE.lat + index * 0.002,
        lon: CENTRE.lon,
        confidenceClass:
          options.confidenceClass === undefined ? ('NOMINAL' as const) : options.confidenceClass,
        confidenceRaw: 'n',
        frp: 2,
        brightTi4: 330,
        brightTi5: 290,
        scan: 0.4,
        track: 0.4,
        daynight: 'D' as const,
        providerVersion: '2.0NRT',
        ingestedAt: minutes(35),
      })),
    );
    const ids = await sql<{ id: string }>`
      SELECT id::text AS id FROM geonerva.fire_detections WHERE cluster_id IS NULL
    `.execute(db);
    await assignDetectionsToCluster(
      db,
      id,
      ids.rows.map((row) => row.id),
      ASSIGNED_AT,
    );
  }
  return id;
}

describe('buildFireClusterDetail: the cluster at a knowledge time', () => {
  it('shows the summary, the caveat and the verified detections', async () => {
    await cluster({ label: 'c1', publicId: 'FR-26-AAAAAA', nTotal: 3, detections: 3 });
    const detail = await detailOf('FR-26-AAAAAA', hours(2));

    expect(detail.subjectRef).toBe('FC:FR-26-AAAAAA');
    expect(detail.status).toBe('ACTIVE');
    expect(detail.mandatoryCaveat).toBe(THERMAL_DETECTION_CAVEAT);
    expect(detail.summary.detectionCountTotal).toBe(3);
    expect(detail.summary.sensors.map((sensor) => sensor.code)).toStrictEqual(['VIIRS_NOAA20_NRT']);
    expect(detail.detections).toMatchObject({ total: 3, truncated: false });
    expect(detail.detections.sample).toHaveLength(3);
    expect(detail.detections.byDay).toStrictEqual([
      { day: '2026-09-19', count: 3, frpSum: 6, hasSatelliteCoverage: true },
    ]);
    expect(detail.detections.evidenceId).toMatch(/^EV:FDS:\d+:3$/u);
    expect(detail.attribution.map((entry) => entry.sourceId)).toStrictEqual(['firms']);
    expect(detail.relevance).toBeNull();
  });

  it('withholds the detections when their count does not match the summary', async () => {
    // The version counted five; only three can be reconstructed. Showing three would be a set the
    // summary never described.
    await cluster({ label: 'c2', publicId: 'FR-26-BBBBBB', nTotal: 5, detections: 3 });
    const detail = await detailOf('FR-26-BBBBBB', hours(2));
    expect(detail.detections).toMatchObject({ total: 5, truncated: true, sample: [], byDay: [] });
    expect(detail.summary.detectionCountTotal).toBe(5);
  });

  it('leaves out a detection with no confidence class, and says so', async () => {
    await cluster({
      label: 'c3',
      publicId: 'FR-26-CCCCCC',
      nTotal: 2,
      detections: 2,
      confidenceClass: null,
    });
    const detail = await detailOf('FR-26-CCCCCC', hours(2));
    expect(detail.detections).toMatchObject({ total: 2, truncated: true, sample: [] });
  });

  it('marks a day FIRMS reported without satellite coverage', async () => {
    await cluster({ label: 'c4', publicId: 'FR-26-DDDDDD', nTotal: 2, detections: 2 });
    await sql`
      INSERT INTO geonerva.fire_missing_data_days (product_id, day, recorded_at)
      VALUES (${productId}, '2026-09-19', ${minutes(50)})
    `.execute(db);
    expect(
      (await detailOf('FR-26-DDDDDD', minutes(45))).detections.byDay[0]?.hasSatelliteCoverage,
    ).toBe(true);
    expect(
      (await detailOf('FR-26-DDDDDD', hours(2))).detections.byDay[0]?.hasSatelliteCoverage,
    ).toBe(false);
  });

  it('verifies against the members the summary knew, not ones assigned since', async () => {
    // Control: "the reconstruction sees detections ingested after the version". A fourth
    // detection, ingested after the version's knowledge time and assigned since, is not one it
    // counted: the three it did count still verify, and the sample is shown.
    const id = await cluster({ label: 'late', publicId: 'FR-26-PPPPPP', nTotal: 3, detections: 3 });
    await bulkInsertDetections(db, [
      {
        productId,
        acquiredAt: minutes(20),
        lat: CENTRE.lat,
        lon: CENTRE.lon + 0.01,
        confidenceClass: 'NOMINAL',
        confidenceRaw: 'n',
        frp: 2,
        brightTi4: 330,
        brightTi5: 290,
        scan: 0.4,
        track: 0.4,
        daynight: 'D',
        providerVersion: '2.0NRT',
        ingestedAt: minutes(50),
      },
    ]);
    const late = await sql<{ id: string }>`
      SELECT id::text AS id FROM geonerva.fire_detections WHERE cluster_id IS NULL
    `.execute(db);
    await assignDetectionsToCluster(
      db,
      id,
      late.rows.map((row) => row.id),
      ASSIGNED_AT,
    );
    const detail = await detailOf('FR-26-PPPPPP', hours(2));
    expect(detail.detections).toMatchObject({ total: 3, truncated: false });
    expect(detail.detections.sample).toHaveLength(3);
  });

  it('counts a day as covered while any of its satellites looked', async () => {
    // Control: "one product's gap is a coverage gap". NOAA-20 reported no data; NOAA-21 did look.
    const both = await sql<{ id: number }>`
      SELECT id FROM geonerva.source_products
      WHERE source_id = 'firms' AND code IN ('VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT')
      ORDER BY id
    `.execute(db);
    const [noaa20, noaa21] = both.rows.map((row) => row.id);
    const id = stableUuid('two-sensors');
    await createCluster(db, { id, publicId: 'FR-26-MMMMMM', createdAt: T0, status: 'ACTIVE' });
    await insertClusterVersionIfChanged(db, {
      clusterId: id,
      asOf: minutes(40),
      nTotal: 1,
      n24h: 1,
      overpasses24h: 1,
      firstDetectedAt: T0,
      lastDetectedAt: T0,
      frpSum24h: 2,
      frpMax: 2,
      maxConfidence: 'NOMINAL',
      productIds: [noaa20 ?? 0, noaa21 ?? 0],
      hullGeoJson: null,
      centroid: CENTRE,
      status: 'ACTIVE',
      contentSha256: contentHash('two-sensors'),
    });
    await bulkInsertDetections(db, [
      {
        productId: noaa21 ?? 0,
        acquiredAt: T0,
        lat: CENTRE.lat,
        lon: CENTRE.lon,
        confidenceClass: 'NOMINAL',
        confidenceRaw: 'n',
        frp: 2,
        brightTi4: 330,
        brightTi5: 290,
        scan: 0.4,
        track: 0.4,
        daynight: 'D',
        providerVersion: '2.0NRT',
        ingestedAt: minutes(5),
      },
    ]);
    const unassigned = await sql<{ id: string }>`
      SELECT id::text AS id FROM geonerva.fire_detections WHERE cluster_id IS NULL
    `.execute(db);
    await assignDetectionsToCluster(
      db,
      id,
      unassigned.rows.map((row) => row.id),
      ASSIGNED_AT,
    );
    await sql`
      INSERT INTO geonerva.fire_missing_data_days (product_id, day, recorded_at)
      VALUES (${noaa20 ?? 0}, '2026-09-19', ${minutes(10)})
    `.execute(db);
    expect(
      (await detailOf('FR-26-MMMMMM', hours(2))).detections.byDay[0]?.hasSatelliteCoverage,
    ).toBe(true);
  });

  it('derives its state at the knowledge time, never from the stored status', async () => {
    await cluster({ label: 'c5', publicId: 'FR-26-EEEEEE', nTotal: 1, detections: 1 });
    await sql`UPDATE geonerva.fire_clusters SET status = 'INACTIVE'`.execute(db);
    expect((await detailOf('FR-26-EEEEEE', hours(2))).status).toBe('ACTIVE');
    expect((await detailOf('FR-26-EEEEEE', hours(40))).status).toBe('COOLING');
  });

  it('assesses relevance and both distances only with a location', async () => {
    await cluster({ label: 'c6', publicId: 'FR-26-FFFFFF', nTotal: 3, detections: 3 });
    const detail = await detailOf('FR-26-FFFFFF', hours(2), MARRAKECH);
    expect(detail.relevance).not.toBeNull();
    expect(detail.distanceKm).not.toBeNull();
    expect(detail.nearestDetectionKm).not.toBeNull();
    // The nearest verified detection is no farther than the centroid is.
    expect(detail.nearestDetectionKm ?? 0).toBeLessThanOrEqual((detail.distanceKm ?? 0) + 0.1);
    expect(detail.relevance?.caveats).toContain(THERMAL_DETECTION_CAVEAT);
    expect(detail.relevance?.reasons.find((entry) => entry.code === 'DISTANCE')?.text).toMatch(
      /^The nearest detection is about \d+ km away\.$/u,
    );
  });

  it('does not report a nearest detection it could not verify (P8 review H3)', async () => {
    // Five counted, three stored, no hull: all that is known is the distance to the centre.
    await cluster({ label: 'c7', publicId: 'FR-26-HHHHHH', nTotal: 5, detections: 3 });
    const detail = await detailOf('FR-26-HHHHHH', hours(2), MARRAKECH);
    expect(detail.relevance).not.toBeNull();
    expect(detail.distanceKm).not.toBeNull();
    expect(detail.nearestDetectionKm).toBeNull();
    // The contract still refuses the converse: a nearest detection with no location to measure from.
    expect(() =>
      fireClusterDetailSchema.parse({
        ...detail,
        relevance: null,
        distanceKm: null,
        nearestDetectionKm: 1,
      }),
    ).toThrow(/nearest-detection distance exists only when a location was supplied/u);
    expect(detail.relevance?.reasons.find((entry) => entry.code === 'DISTANCE')?.text).toMatch(
      /^The centre of the cluster is about \d+ km away; the individual detections could not be checked\.$/u,
    );
  });
});

describe('buildFireClusterDetail: replay never sees the future (I2)', () => {
  it('shows the summary and history as they stood at T', async () => {
    const id = await cluster({ label: 'r1', publicId: 'FR-26-GGGGGG', nTotal: 3, detections: 3 });
    await insertClusterVersionIfChanged(db, {
      clusterId: id,
      asOf: minutes(90),
      nTotal: 3,
      n24h: 2,
      overpasses24h: 1,
      firstDetectedAt: T0,
      lastDetectedAt: minutes(30),
      frpSum24h: 8,
      frpMax: 5,
      maxConfidence: 'NOMINAL',
      productIds: [productId],
      hullGeoJson: null,
      centroid: CENTRE,
      status: 'ACTIVE',
      contentSha256: contentHash('r1', 'second'),
    });

    const early = await detailOf('FR-26-GGGGGG', minutes(60));
    expect(early.versions).toHaveLength(1);
    expect(early.summary.detectionCount24h).toBe(3);
    expect(early.versions[0]?.summary).toBe('First summary: 3 detections.');

    const late = await detailOf('FR-26-GGGGGG', hours(2));
    expect(late.versions.map((version) => version.detectionCount24h)).toStrictEqual([2, 3]);
    expect(late.versions[0]?.summary).toBe('Detections unchanged at 3; the 24-hour figures moved.');
  });

  it('does not exist before its first summary, nor before it was created', async () => {
    await cluster({
      label: 'r2',
      publicId: 'FR-26-HHHHHH',
      nTotal: 1,
      detections: 0,
      asOf: minutes(40),
    });
    expect(
      await buildFireClusterDetail({
        db,
        publicId: 'FR-26-HHHHHH',
        asOf: minutes(20),
        location: null,
      }),
    ).toStrictEqual({ kind: 'not_found', reason: 'NO_SUMMARY' });
    expect(
      await buildFireClusterDetail({
        db,
        publicId: 'FR-26-HHHHHH',
        asOf: new Date(T0.getTime() - 1),
        location: null,
      }),
    ).toStrictEqual({ kind: 'not_found', reason: 'UNKNOWN' });
  });

  it('is itself before a merge, redirects after it, and the survivor lists it', async () => {
    const survivor = await cluster({
      label: 'm1',
      publicId: 'FR-26-JJJJJJ',
      nTotal: 1,
      detections: 0,
    });
    const absorbed = await cluster({
      label: 'm2',
      publicId: 'FR-26-KKKKKK',
      nTotal: 1,
      detections: 0,
    });
    await db.transaction().execute((trx) => mergeClusters(trx, survivor, [absorbed], hours(1)));

    expect(
      (
        await buildFireClusterDetail({
          db,
          publicId: 'FR-26-KKKKKK',
          asOf: minutes(50),
          location: null,
        })
      ).kind,
    ).toBe('found');
    expect(
      await buildFireClusterDetail({
        db,
        publicId: 'FR-26-KKKKKK',
        asOf: hours(2),
        location: null,
      }),
    ).toStrictEqual({ kind: 'merged', survivorPublicId: 'FR-26-JJJJJJ' });
    expect((await detailOf('FR-26-JJJJJJ', minutes(50))).mergedFromPublicIds).toStrictEqual([]);
    expect((await detailOf('FR-26-JJJJJJ', hours(2))).mergedFromPublicIds).toStrictEqual([
      'FR-26-KKKKKK',
    ]);
  });
});
