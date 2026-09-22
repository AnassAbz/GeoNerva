/**
 * The as-of read path against real PostGIS (docs/TESTING.md §4.6, §4.7, §4.8).
 *
 * This is the layer the whole replay story rests on, so the tests are written as questions a user
 * could ask: "what did GeoNerva know at 12:10?", "does the fast path agree with the slow one?",
 * "does a merge disappear when I look before it happened?".
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from './client.ts';
import type { DB } from './generated/database.ts';
import {
  clusterEvidenceAsOf,
  clusterVersionsAsOf,
  clusterVersionsNow,
  correlationEvidenceAsOf,
  healthAsOf,
  linksAsOf,
  observationEvidenceAsOf,
  observationsAsOf,
  observationsNow,
  runEvidenceAsOf,
  runSummariesAsOf,
  runTally24hAsOf,
  sourceCatalog,
  sourceCutoffsAsOf,
  workerHeartbeatAsOf,
} from './asof.ts';
import { createCanonicalEvent, linkRecord, unlinkRecord } from './repositories/canonical.ts';
import {
  bulkInsertDetections,
  createCluster,
  dropDetectionPartitionsBefore,
  insertClusterVersionIfChanged,
  listDetectionPartitionDays,
} from './repositories/fire.ts';
import { acquireRunLease } from './repositories/ingestion-runs.ts';
import { findProductByCode } from './repositories/sources.ts';
import { resolveSourceRecord } from './repositories/source-records.ts';
import { setupTestDatabase, type TestDatabase } from './testing/test-database.ts';
import { PLACES, contentHash, seedObservation, seedRun, stableUuid } from './testing/factories.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const T0 = new Date('2026-09-19T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const hours = (n: number): Date => minutes(n * 60);

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

describe('observationsAsOf: the latest version known at T', () => {
  beforeEach(async () => {
    await seedObservation(db, {
      primaryKey: 'us-asof',
      ingestedAt: T0,
      observedAt: T0,
      magnitude: 5.1,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, {
      primaryKey: 'us-asof',
      ingestedAt: minutes(30),
      observedAt: T0,
      magnitude: 5.3,
      centroid: PLACES.marrakech,
    });
  });

  it('returns the first version before the revision was ingested', async () => {
    const rows = await observationsAsOf(db, { asOf: minutes(10) });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.magnitude)).toBe(5.1);
    expect(rows[0]?.version_seq).toBe(1);
  });

  it('returns the revision once its batch has committed', async () => {
    const rows = await observationsAsOf(db, { asOf: minutes(31) });
    expect(Number(rows[0]?.magnitude)).toBe(5.3);
    expect(rows[0]?.version_seq).toBe(2);
  });

  it('returns nothing before the record was ever ingested', async () => {
    expect(await observationsAsOf(db, { asOf: new Date(T0.getTime() - 1) })).toStrictEqual([]);
  });

  it('includes a version ingested exactly at T (the bound is inclusive)', async () => {
    const rows = await observationsAsOf(db, { asOf: minutes(30) });
    expect(rows[0]?.version_seq).toBe(2);
  });

  it('exposes the centroid as plain coordinates', async () => {
    const rows = await observationsAsOf(db, { asOf: minutes(31) });
    expect(rows[0]?.lat).toBeCloseTo(PLACES.marrakech.lat, 5);
    expect(rows[0]?.lon).toBeCloseTo(PLACES.marrakech.lon, 5);
  });
});

describe('observationsAsOf: filters apply to the latest version, not to any version', () => {
  it('drops a record whose epicentre was revised out of the radius', async () => {
    // Inside the radius at first…
    await seedObservation(db, {
      primaryKey: 'us-moved',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
      magnitude: 4.5,
    });
    // …then relocated 600 km away by a revision.
    await seedObservation(db, {
      primaryKey: 'us-moved',
      ingestedAt: minutes(30),
      centroid: { lat: 36.8, lon: -3.0 },
      magnitude: 4.6,
    });

    const before = await observationsAsOf(db, {
      asOf: minutes(10),
      near: { point: PLACES.marrakech, radiusM: 50_000 },
    });
    expect(before).toHaveLength(1);

    const after = await observationsAsOf(db, {
      asOf: minutes(40),
      near: { point: PLACES.marrakech, radiusM: 50_000 },
    });
    // A naive pre-filter on "any version within the radius" would wrongly keep this row.
    expect(after).toStrictEqual([]);
  });

  it('picks up a record that was revised into the radius', async () => {
    await seedObservation(db, {
      primaryKey: 'us-arrived',
      ingestedAt: T0,
      centroid: { lat: 36.8, lon: -3.0 },
      magnitude: 4.5,
    });
    await seedObservation(db, {
      primaryKey: 'us-arrived',
      ingestedAt: minutes(30),
      centroid: PLACES.marrakech,
      magnitude: 4.6,
    });

    const after = await observationsAsOf(db, {
      asOf: minutes(40),
      near: { point: PLACES.marrakech, radiusM: 50_000 },
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.distance_m).toBeLessThan(1_000);
  });

  it('filters by hazard type and source', async () => {
    await seedObservation(db, {
      primaryKey: 'us-eq',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, {
      sourceId: 'gdacs',
      primaryKey: 'FL-2',
      hazardType: 'FLOOD',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
      attributes: { has_area_geometry: true },
    });

    expect(await observationsAsOf(db, { asOf: minutes(1), hazardTypes: ['FLOOD'] })).toHaveLength(
      1,
    );
    expect(await observationsAsOf(db, { asOf: minutes(1), sourceIds: ['usgs'] })).toHaveLength(1);
  });

  it('excludes tombstones by default and includes them on request', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'us-gone',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, {
      primaryKey: 'us-gone',
      ingestedAt: minutes(30),
      centroid: PLACES.marrakech,
      lifecycleStatus: 'DELETED',
      contentSha256: contentHash('us-gone', 'deleted'),
    });
    expect(record.inserted).toBe(true);

    expect(await observationsAsOf(db, { asOf: minutes(40) })).toStrictEqual([]);
    const withTombstones = await observationsAsOf(db, {
      asOf: minutes(40),
      excludeTombstones: false,
    });
    expect(withTombstones).toHaveLength(1);
    expect(withTombstones[0]?.lifecycle_status).toBe('DELETED');

    // Before the deletion was known, the record was simply there.
    expect(await observationsAsOf(db, { asOf: minutes(10) })).toHaveLength(1);
  });

  it('treats a merge as knowledge: both records exist before it happened', async () => {
    await seedObservation(db, {
      primaryKey: 'us-m1',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, {
      primaryKey: 'us-m2',
      ingestedAt: minutes(5),
      centroid: PLACES.marrakech,
    });

    await db.transaction().execute((trx) =>
      resolveSourceRecord(trx, {
        sourceId: 'usgs',
        hazardType: 'EARTHQUAKE',
        primaryKey: 'us-m1',
        aliases: ['us-m1', 'us-m2'],
        firstIngestedAt: minutes(60),
      }),
    );

    expect(await observationsAsOf(db, { asOf: minutes(30) })).toHaveLength(2);
    expect(await observationsAsOf(db, { asOf: minutes(90) })).toHaveLength(1);
  });

  it('orders by distance when asked', async () => {
    await seedObservation(db, {
      primaryKey: 'near',
      ingestedAt: T0,
      centroid: { lat: 31.64, lon: -8.0 },
    });
    await seedObservation(db, {
      primaryKey: 'far',
      ingestedAt: T0,
      centroid: { lat: 32.2, lon: -8.0 },
    });

    const rows = await observationsAsOf(db, {
      asOf: minutes(1),
      near: { point: PLACES.marrakech, radiusM: 200_000 },
      orderByDistance: true,
    });
    expect(rows.map((row) => row.primary_key)).toStrictEqual(['near', 'far']);
  });
});

describe('the "now" fast path agrees with the as-of path (ARCHITECTURE §5)', () => {
  beforeEach(async () => {
    for (let index = 0; index < 12; index += 1) {
      await seedObservation(db, {
        primaryKey: `us-eq-${String(index)}`,
        ingestedAt: minutes(index),
        observedAt: minutes(index),
        magnitude: 4 + index * 0.1,
        centroid: { lat: 31.5 + index * 0.02, lon: -8.1 + index * 0.02 },
      });
    }
    // A revision and a tombstone, so the comparison covers more than the trivial case.
    await seedObservation(db, {
      primaryKey: 'us-eq-3',
      ingestedAt: minutes(40),
      observedAt: minutes(3),
      magnitude: 5.9,
      centroid: { lat: 31.56, lon: -8.04 },
    });
    await seedObservation(db, {
      primaryKey: 'us-eq-7',
      ingestedAt: minutes(41),
      observedAt: minutes(7),
      centroid: { lat: 31.64, lon: -7.96 },
      lifecycleStatus: 'DELETED',
      contentSha256: contentHash('us-eq-7', 'deleted'),
    });
  });

  it('returns identical rows for T = now, unfiltered', async () => {
    const viaAsOf = await observationsAsOf(db, { asOf: hours(24) });
    const viaHeads = await observationsNow(db, {});
    expect(viaHeads.map((row) => row.version_id)).toStrictEqual(
      viaAsOf.map((row) => row.version_id),
    );
  });

  it('returns identical rows for a radius query', async () => {
    const near = { point: PLACES.marrakech, radiusM: 30_000 };
    const viaAsOf = await observationsAsOf(db, { asOf: hours(24), near, orderByDistance: true });
    const viaHeads = await observationsNow(db, { near, orderByDistance: true });
    expect(viaHeads.map((row) => row.version_id)).toStrictEqual(
      viaAsOf.map((row) => row.version_id),
    );
    expect(viaHeads.map((row) => Math.round(row.distance_m ?? 0))).toStrictEqual(
      viaAsOf.map((row) => Math.round(row.distance_m ?? 0)),
    );
  });

  it('agrees about tombstones and revisions', async () => {
    const viaAsOf = await observationsAsOf(db, { asOf: hours(24), excludeTombstones: false });
    const viaHeads = await observationsNow(db, { excludeTombstones: false });
    expect(viaHeads).toStrictEqual(viaAsOf);
  });
});

describe('linksAsOf', () => {
  it('returns only links active at T', async () => {
    const record = await seedObservation(db, {
      primaryKey: 'us-linked',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    const first = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });
    const second = await createCanonicalEvent(db, {
      hazardType: 'EARTHQUAKE',
      createdAt: minutes(1),
    });

    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: first.id,
        sourceRecordId: record.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        algorithmVersion: 'test-1',
        linkedAt: T0,
      }),
    );
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: second.id,
        sourceRecordId: record.sourceRecordId,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'test-1',
        linkedAt: minutes(30),
      }),
    );

    const early = await linksAsOf(db, { asOf: minutes(10) });
    expect(early).toHaveLength(1);
    expect(early[0]?.canonical_event_id).toBe(first.id);

    const late = await linksAsOf(db, { asOf: minutes(40) });
    expect(late).toHaveLength(1);
    expect(late[0]?.canonical_event_id).toBe(second.id);

    // Exactly at the boundary the old link has closed and the new one has opened.
    const atBoundary = await linksAsOf(db, { asOf: minutes(30) });
    expect(atBoundary).toHaveLength(1);
    expect(atBoundary[0]?.canonical_event_id).toBe(second.id);
  });
});

describe('clusterVersionsAsOf', () => {
  const clusterId = stableUuid('asof-cluster');

  beforeEach(async () => {
    await createCluster(db, {
      id: clusterId,
      publicId: 'FR-26-BBBBBB',
      createdAt: T0,
      status: 'ACTIVE',
    });
    const base = {
      clusterId,
      firstDetectedAt: T0,
      frpSum24h: 20,
      frpMax: 9,
      maxConfidence: 'NOMINAL' as const,
      productIds: [1],
      hullGeoJson: null,
      centroid: PLACES.marrakech,
      status: 'ACTIVE' as const,
    };
    await insertClusterVersionIfChanged(db, {
      ...base,
      asOf: T0,
      nTotal: 5,
      n24h: 5,
      overpasses24h: 1,
      lastDetectedAt: T0,
      contentSha256: contentHash('asof-cluster', 5),
    });
    await insertClusterVersionIfChanged(db, {
      ...base,
      asOf: minutes(60),
      nTotal: 22,
      n24h: 17,
      overpasses24h: 3,
      lastDetectedAt: minutes(55),
      contentSha256: contentHash('asof-cluster', 22),
    });
  });

  it('returns the summary as it stood at T', async () => {
    const early = await clusterVersionsAsOf(db, { asOf: minutes(30) });
    expect(early[0]?.n_total).toBe(5);
    const late = await clusterVersionsAsOf(db, { asOf: minutes(90) });
    expect(late[0]?.n_total).toBe(22);
  });

  it('agrees with the heads fast path at now', async () => {
    const viaAsOf = await clusterVersionsAsOf(db, { asOf: hours(24) });
    const viaHeads = await clusterVersionsNow(db);
    expect(viaHeads).toStrictEqual(viaAsOf);
  });

  it('selects by the cluster area on both paths, and they still agree', async () => {
    // A cluster whose centroid is ~160 km north of Marrakech but whose hull reaches to ~140 km.
    const stretched = stableUuid('asof-stretched-cluster');
    await createCluster(db, {
      id: stretched,
      publicId: 'FR-26-CCCCCC',
      createdAt: T0,
      status: 'ACTIVE',
    });
    const lat = (km: number): number => PLACES.marrakech.lat + km / 111.2;
    await insertClusterVersionIfChanged(db, {
      clusterId: stretched,
      asOf: minutes(30),
      nTotal: 3,
      n24h: 3,
      overpasses24h: 1,
      firstDetectedAt: T0,
      lastDetectedAt: minutes(20),
      frpSum24h: 5,
      frpMax: 2,
      maxConfidence: 'NOMINAL',
      productIds: [1],
      hullGeoJson: {
        type: 'Polygon',
        coordinates: [
          [
            [-8.05, lat(140)],
            [-7.95, lat(140)],
            [-7.95, lat(180)],
            [-8.05, lat(180)],
            [-8.05, lat(140)],
          ],
        ],
      },
      centroid: { lat: lat(160), lon: -8.0 },
      status: 'ACTIVE',
      contentSha256: contentHash('asof-stretched-cluster'),
    });
    const near = { point: PLACES.marrakech, radiusM: 150_000 };
    const viaAsOf = await clusterVersionsAsOf(db, { asOf: hours(24), near });
    const viaHeads = await clusterVersionsNow(db, { near });
    expect(viaAsOf.map((row) => row.public_id)).toContain('FR-26-CCCCCC');
    expect(viaHeads).toStrictEqual(viaAsOf);
    const row = viaAsOf.find((entry) => entry.public_id === 'FR-26-CCCCCC');
    expect((row?.area_distance_m ?? 0) / 1000).toBeCloseTo(140, 0);
    expect((row?.distance_m ?? 0) / 1000).toBeCloseTo(160, 0);
  });

  it('filters by radius', async () => {
    expect(
      await clusterVersionsAsOf(db, {
        asOf: hours(24),
        near: { point: PLACES.montreal, radiusM: 100_000 },
      }),
    ).toStrictEqual([]);
    expect(
      await clusterVersionsAsOf(db, {
        asOf: hours(24),
        near: { point: PLACES.marrakech, radiusM: 100_000 },
      }),
    ).toHaveLength(1);
  });
});

describe('healthAsOf (ADR-022)', () => {
  it('reports FRESH right after a successful poll and STALE much later', async () => {
    const product = await findProductByCode(db, 'usgs', 'comcat');
    await seedRun(db, { sourceId: 'usgs', productId: product?.id ?? null, startedAt: T0 });

    const fresh = await healthAsOf(db, { asOf: minutes(5), sourceIds: ['usgs'] });
    expect(fresh.byProduct[0]?.status).toBe('FRESH');

    const stale = await healthAsOf(db, { asOf: minutes(120), sourceIds: ['usgs'] });
    expect(stale.byProduct[0]?.status).toBe('STALE');
  });

  it('never sees a run committed after the knowledge time (I2)', async () => {
    const product = await findProductByCode(db, 'usgs', 'comcat');
    await seedRun(db, { sourceId: 'usgs', productId: product?.id ?? null, startedAt: T0 });
    await seedRun(db, {
      sourceId: 'usgs',
      productId: product?.id ?? null,
      startedAt: hours(5),
    });

    const atT = await healthAsOf(db, { asOf: hours(2), sourceIds: ['usgs'] });
    // The 15:00 poll has not happened yet from this knowledge time's point of view.
    expect(atT.byProduct[0]?.lastSuccessAt).toStrictEqual(T0);
    expect(atT.byProduct[0]?.status).toBe('STALE');

    const later = await healthAsOf(db, { asOf: hours(5.1), sourceIds: ['usgs'] });
    expect(later.byProduct[0]?.status).toBe('FRESH');
  });

  it('reports a source that has never run as UNAVAILABLE, not as quiet', async () => {
    const health = await healthAsOf(db, { asOf: T0, sourceIds: ['emsc'] });
    expect(health.bySource[0]?.status).toBe('UNAVAILABLE');
    expect(health.bySource[0]?.reasons).toContain('NEVER_SUCCEEDED');
  });

  it('reports a disabled source as UNAVAILABLE', async () => {
    const health = await healthAsOf(db, { asOf: T0, sourceIds: ['eccc'] });
    expect(health.byProduct[0]?.status).toBe('UNAVAILABLE');
    expect(health.byProduct[0]?.reasons).toContain('DISABLED');
  });

  it('rolls FIRMS up to the worst of its two sensors', async () => {
    const noaa20 = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await findProductByCode(db, 'firms', 'VIIRS_NOAA21_NRT');

    await seedRun(db, {
      sourceId: 'firms',
      productId: noaa20?.id ?? null,
      startedAt: minutes(-10),
      newestObservedAt: minutes(-120),
    });
    await seedRun(db, {
      sourceId: 'firms',
      productId: noaa21?.id ?? null,
      // More than 24 h without a successful poll: the sensor is not merely late, it is gone.
      startedAt: hours(-25),
      newestObservedAt: hours(-26),
    });

    const health = await healthAsOf(db, { asOf: T0, sourceIds: ['firms'] });
    const byCode = new Map(health.byProduct.map((entry) => [entry.productCode, entry.status]));
    expect(byCode.get('VIIRS_NOAA20_NRT')).toBe('FRESH');
    expect(byCode.get('VIIRS_NOAA21_NRT')).toBe('UNAVAILABLE');
    // A dashboard must not call FIRMS healthy while one satellite has stopped delivering.
    expect(health.bySource[0]?.status).toBe('UNAVAILABLE');
  });

  it('judges FIRMS data currency separately from poll freshness (ADR-009)', async () => {
    const noaa20 = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await findProductByCode(db, 'firms', 'VIIRS_NOAA21_NRT');
    await seedRun(db, {
      sourceId: 'firms',
      productId: noaa20?.id ?? null,
      startedAt: minutes(-10),
      // Polls fine, but the newest detection is seven hours old.
      newestObservedAt: hours(-7),
    });
    await seedRun(db, {
      sourceId: 'firms',
      productId: noaa21?.id ?? null,
      startedAt: minutes(-10),
      newestObservedAt: hours(-2),
    });

    const health = await healthAsOf(db, { asOf: T0, sourceIds: ['firms'] });
    const byCode = new Map(health.byProduct.map((entry) => [entry.productCode, entry]));
    expect(byCode.get('VIIRS_NOAA20_NRT')?.status).toBe('DEGRADED');
    expect(byCode.get('VIIRS_NOAA20_NRT')?.reasons).toContain('DATA_AGEING');
    expect(byCode.get('VIIRS_NOAA21_NRT')?.status).toBe('FRESH');
  });

  it('carries the evidence id of the run the judgement is based on', async () => {
    const product = await findProductByCode(db, 'usgs', 'comcat');
    const run = await seedRun(db, {
      sourceId: 'usgs',
      productId: product?.id ?? null,
      startedAt: T0,
    });
    const health = await healthAsOf(db, { asOf: minutes(1), sourceIds: ['usgs'] });
    expect(health.byProduct[0]?.evidenceId).toBe(`EV:RUN:${run.runId}`);
  });
});

describe('sourceCutoffsAsOf', () => {
  it('reports the last committed run per source at T, and null before any', async () => {
    await seedRun(db, { sourceId: 'usgs', startedAt: T0 });
    const cutoffs = await sourceCutoffsAsOf(db, minutes(5));
    expect(cutoffs['usgs']).toBeInstanceOf(Date);
    expect(cutoffs['emsc']).toBeNull();

    const before = await sourceCutoffsAsOf(db, new Date(T0.getTime() - 60_000));
    expect(before['usgs']).toBeNull();
  });
});

describe('retention (ADR-018)', () => {
  it('drops whole detection partitions and leaves newer days untouched', async () => {
    const product = await findProductByCode(db, 'firms', 'VIIRS_NOAA20_NRT');
    const old = new Date('2026-09-10T03:00:00.000Z');
    const recent = new Date('2026-09-18T03:00:00.000Z');

    await bulkInsertDetections(db, [
      {
        productId: product?.id ?? 1,
        acquiredAt: old,
        lat: 31.6,
        lon: -8.0,
        confidenceClass: 'HIGH',
        confidenceRaw: 'high',
        frp: 3,
        brightTi4: null,
        brightTi5: null,
        scan: null,
        track: null,
        daynight: 'D',
        providerVersion: '2.0NRT',
        ingestedAt: old,
      },
      {
        productId: product?.id ?? 1,
        acquiredAt: recent,
        lat: 31.7,
        lon: -8.1,
        confidenceClass: 'HIGH',
        confidenceRaw: 'high',
        frp: 3,
        brightTi4: null,
        brightTi5: null,
        scan: null,
        track: null,
        daynight: 'D',
        providerVersion: '2.0NRT',
        ingestedAt: recent,
      },
    ]);

    expect(await listDetectionPartitionDays(db)).toContain('20260910');

    const retention = await dropDetectionPartitionsBefore(db, new Date('2026-09-15T00:00:00.000Z'));
    expect(retention.dropped).toContain('fire_detections_20260910');
    expect(retention.deferred).toEqual([]);

    const remaining = await listDetectionPartitionDays(db);
    expect(remaining).not.toContain('20260910');
    expect(remaining).toContain('20260918');

    const left = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.fire_detections
    `.execute(db);
    expect(Number(left.rows[0]?.n)).toBe(1);
  });
});

/*
 * ── The reads P8 added ────────────────────────────────────────────────────────
 *
 * Each of these is tested here, at the read, rather than only through the endpoint that uses it.
 * The distinction is not pedantic: `GET /evidence/{id}` filters twice — once in the detail read and
 * once in the manifest resolver — so an endpoint test cannot tell which filter is doing the work,
 * and a mutation run proved it: deleting `ingested_at <= asOf` from `observationEvidenceAsOf` left
 * the whole API integration suite green. A read whose own knowledge-time filter is untested is a
 * read that will lose it silently.
 */

describe('runSummariesAsOf', () => {
  it('returns only runs committed at or before T', async () => {
    const early = await seedRun(db, { sourceId: 'usgs', startedAt: T0 });
    const late = await seedRun(db, { sourceId: 'usgs', startedAt: hours(2) });

    const atFive = await runSummariesAsOf(db, { asOf: minutes(5) });
    expect(atFive.map((run) => run.id)).toEqual([early.runId]);

    const atThree = await runSummariesAsOf(db, { asOf: hours(3) });
    expect(atThree.map((run) => run.id)).toEqual([late.runId, early.runId]);

    const before = await runSummariesAsOf(db, { asOf: new Date(T0.getTime() - 60_000) });
    expect(before).toEqual([]);
  });

  /*
   * A `RUNNING` run has produced no knowledge, and its `committed_at` is NULL — so it must be
   * invisible by construction rather than by a status filter. `acquireRunLease` leaves exactly
   * this state behind.
   */
  it('never returns a run that has not committed', async () => {
    await acquireRunLease(db, {
      sourceId: 'usgs',
      productId: null,
      trigger: 'SCHEDULE',
      startedAt: T0,
    });
    expect(await runSummariesAsOf(db, { asOf: hours(5) })).toEqual([]);
  });

  it('bounds the rows per source and keeps the newest', async () => {
    for (let index = 0; index < 6; index += 1) {
      await seedRun(db, { sourceId: 'usgs', startedAt: minutes(index) });
    }
    const rows = await runSummariesAsOf(db, { asOf: hours(1), perSource: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.committed_at.getTime()).toBeGreaterThan(rows[1]?.committed_at.getTime() ?? 0);
    expect(rows[0]?.committed_at).toEqual(minutes(5));
  });

  it('bounds each source independently rather than the result as a whole', async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedRun(db, { sourceId: 'usgs', startedAt: minutes(index) });
      await seedRun(db, { sourceId: 'emsc', startedAt: minutes(index) });
    }
    const rows = await runSummariesAsOf(db, { asOf: hours(1), perSource: 2 });
    expect(rows.filter((run) => run.source_id === 'usgs')).toHaveLength(2);
    expect(rows.filter((run) => run.source_id === 'emsc')).toHaveLength(2);
  });

  /**
   * The hard cap, exercised with more rows than the cap.
   *
   * The first version of this test seeded **one** run and asked for ten thousand, which returns
   * one row whether the cap exists or not — so removing `Math.min(…, 50)` left it green. A bound
   * can only be tested from above it.
   */
  it('caps perSource at fifty however many are asked for', async () => {
    for (let index = 0; index < 52; index += 1) {
      await seedRun(db, { sourceId: 'usgs', startedAt: minutes(index) });
    }
    expect(await runSummariesAsOf(db, { asOf: hours(2), perSource: 10_000 })).toHaveLength(50);
    expect(await runSummariesAsOf(db, { asOf: hours(2) })).toHaveLength(10);
    /* `Math.max(1, …)`: zero is a caller mistake, not a request for an empty page. */
    expect(await runSummariesAsOf(db, { asOf: hours(2), perSource: 0 })).toHaveLength(1);
  });
});

describe('runTally24hAsOf', () => {
  it('counts only committed runs inside the 24 h before T', async () => {
    await seedRun(db, { sourceId: 'usgs', startedAt: T0, status: 'SUCCEEDED' });
    await seedRun(db, { sourceId: 'usgs', startedAt: hours(30), status: 'SUCCEEDED' });

    const tally = await runTally24hAsOf(db, hours(31));
    expect(tally).toEqual([{ source_id: 'usgs', total: 1, succeeded: 1 }]);
  });

  /*
   * `PARTIAL` committed some records and rejected others; it did not do its job. Counting it as a
   * success would hide the slow degradation `/data-status` exists to show.
   */
  it('does not count PARTIAL or FAILED as successes', async () => {
    await seedRun(db, { sourceId: 'usgs', startedAt: T0, status: 'SUCCEEDED' });
    await seedRun(db, { sourceId: 'usgs', startedAt: minutes(1), status: 'PARTIAL' });
    await seedRun(db, { sourceId: 'usgs', startedAt: minutes(2), status: 'FAILED' });
    await seedRun(db, { sourceId: 'usgs', startedAt: minutes(3), status: 'SKIPPED' });

    expect(await runTally24hAsOf(db, hours(1))).toEqual([
      { source_id: 'usgs', total: 4, succeeded: 1 },
    ]);
  });

  it('omits a source with no runs in the window rather than reporting a zero rate', async () => {
    await seedRun(db, { sourceId: 'usgs', startedAt: T0 });
    const tally = await runTally24hAsOf(db, hours(1));
    expect(tally.map((row) => row.source_id)).toEqual(['usgs']);
  });
});

describe('workerHeartbeatAsOf', () => {
  it('returns null when the worker has never reported', async () => {
    expect(await workerHeartbeatAsOf(db, hours(1))).toBeNull();
  });

  it('returns the heartbeat once it is in the past', async () => {
    await sql`
      INSERT INTO geonerva.worker_heartbeat (id, last_seen_at, version)
      VALUES (true, ${T0}, 'worker-1')
    `.execute(db);
    expect(await workerHeartbeatAsOf(db, minutes(1))).toMatchObject({ version: 'worker-1' });
  });

  /*
   * The row is updated in place and has no history, so a heartbeat stamped meaningfully after T is
   * future knowledge and is withheld. The consequence — a replay cannot state worker liveness — is
   * documented on the function; what must never happen is the present leaking into the past.
   */
  it('withholds a heartbeat stamped after T', async () => {
    await sql`
      INSERT INTO geonerva.worker_heartbeat (id, last_seen_at, version)
      VALUES (true, ${hours(2)}, 'worker-1')
    `.execute(db);
    expect(await workerHeartbeatAsOf(db, minutes(1))).toBeNull();
  });

  /**
   * A few seconds of clock skew must not read as "the worker has never reported in".
   *
   * `last_seen_at` comes from the **database** clock and `asOf` for a live request from the **web**
   * process's. If the database leads by even a second, a strict `<=` nulls the heartbeat for that
   * window after every minute's write — and the read model can only render `null` as "never
   * reported in", which is a false statement about a healthy system.
   */
  it('tolerates a heartbeat a few seconds ahead of the knowledge time', async () => {
    await sql`
      INSERT INTO geonerva.worker_heartbeat (id, last_seen_at, version)
      VALUES (true, ${new Date(T0.getTime() + 3_000)}, 'worker-1')
    `.execute(db);
    expect(await workerHeartbeatAsOf(db, T0)).toMatchObject({ version: 'worker-1' });
  });

  it('still withholds one a minute ahead, which is not skew', async () => {
    await sql`
      INSERT INTO geonerva.worker_heartbeat (id, last_seen_at, version)
      VALUES (true, ${new Date(T0.getTime() + 60_000)}, 'worker-1')
    `.execute(db);
    expect(await workerHeartbeatAsOf(db, T0)).toBeNull();
  });
});

describe('sourceCatalog', () => {
  it('lists the seeded sources and products, in a canonical order', async () => {
    const catalog = await sourceCatalog(db);
    expect(catalog.sources.map((source) => source.source_id)).toEqual(
      [...catalog.sources.map((source) => source.source_id)].sort(),
    );
    expect(catalog.products.length).toBeGreaterThan(catalog.sources.length);
    for (const product of catalog.products) {
      expect(catalog.sources.some((source) => source.source_id === product.source_id)).toBe(true);
    }
  });

  /*
   * `not.toContain('coordinates')` was in this test and could not fail: the only coverage field is
   * a boolean named `coverage_geometry_available`. What can fail is the field's *type* and the
   * absence of any geometry-shaped value, so that is what is checked. ECCC carries a coverage
   * polygon in the seed data, which makes the `true` case real rather than hypothetical.
   */
  it('reports coverage as a boolean rather than shipping the polygon', async () => {
    const catalog = await sourceCatalog(db);
    for (const source of catalog.sources) {
      expect(typeof source.coverage_geometry_available).toBe('boolean');
    }
    /*
     * Every seeded source is global — verified against the database, all five have
     * `coverage IS NULL` — so the `false` branch is the one this exercises. The `true` branch is
     * unreachable until a source with a coverage polygon exists, and saying so is better than an
     * assertion that would have to be deleted when one does.
     */
    expect(catalog.sources.every((source) => !source.coverage_geometry_available)).toBe(true);

    /*
     * No geometry in any spelling — anchored on the *syntax*, after two looser patterns matched
     * things that are not geometry. A coordinate-pair regex matched prose in a `coverage_note`,
     * and a bare `POLYGON` matched `POLYGONS`, which is a legitimate `SourceCapability`. WKT always
     * has its opening parenthesis and GeoJSON always has its `coordinates` key.
     */
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toMatch(
      /(?:MULTI)?(?:POLYGON|LINESTRING|POINT)\s*\(|"coordinates"\s*:/u,
    );
  });

  it('reports the sensor lifecycle dates as plain date strings', async () => {
    const catalog = await sourceCatalog(db);
    for (const product of catalog.products) {
      if (product.active_from !== null) expect(product.active_from).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });
});

describe('the evidence-detail reads', () => {
  /** One observation version, with a second revision ingested an hour later. */
  async function seedRevisedQuake(): Promise<{ first: string; second: string }> {
    const first = await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'us7000tikb',
      aliases: ['us7000tikb'],
      ingestedAt: T0,
      observedAt: minutes(-5),
      sourceUpdatedAt: minutes(-2),
      centroid: PLACES.marrakech,
      magnitude: 5.2,
      depthKm: 10,
      contributor: 'us',
    });
    const second = await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'us7000tikb',
      aliases: ['us7000tikb'],
      ingestedAt: hours(1),
      observedAt: minutes(-5),
      sourceUpdatedAt: minutes(55),
      centroid: PLACES.marrakech,
      magnitude: 5.4,
      depthKm: 10,
      contributor: 'us',
    });
    return { first: first.versionId, second: second.versionId };
  }

  it('resolves an observation version and keeps its four times apart', async () => {
    const { first } = await seedRevisedQuake();
    const row = await observationEvidenceAsOf(db, { asOf: minutes(5), versionId: first });

    expect(row).not.toBeNull();
    expect(row?.observed_at).toEqual(minutes(-5));
    expect(row?.source_updated_at).toEqual(minutes(-2));
    expect(row?.ingested_at).toEqual(T0);
    expect(row?.primary_key).toBe('us7000tikb');
    expect(row?.content_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  /** I2 at the read. The row exists; it was not knowledge yet. */
  it('withholds a version ingested after T', async () => {
    const { second } = await seedRevisedQuake();
    expect(await observationEvidenceAsOf(db, { asOf: minutes(5), versionId: second })).toBeNull();
    expect(await observationEvidenceAsOf(db, { asOf: hours(2), versionId: second })).not.toBeNull();
  });

  /*
   * A revision does not retract its predecessor. An evidence id cited in an earlier response must
   * keep resolving, or the citation rots — which is the one thing an append-only store prevents.
   */
  it('still resolves an older version after a revision superseded it', async () => {
    const { first } = await seedRevisedQuake();
    expect(await observationEvidenceAsOf(db, { asOf: hours(5), versionId: first })).not.toBeNull();
  });

  it('reports whether a raw payload row exists without reading it (ADR-038)', async () => {
    const { first } = await seedRevisedQuake();
    const row = await observationEvidenceAsOf(db, { asOf: hours(5), versionId: first });
    expect(typeof row?.raw_record_present).toBe('boolean');
    expect(Object.keys(row ?? {})).not.toContain('payload');
  });

  it('resolves an ingestion run only once it has committed at or before T', async () => {
    const run = await seedRun(db, { sourceId: 'usgs', startedAt: hours(1) });

    expect(await runEvidenceAsOf(db, { asOf: minutes(5), runId: run.runId })).toBeNull();
    const row = await runEvidenceAsOf(db, { asOf: hours(2), runId: run.runId });
    expect(row).toMatchObject({ run_id: run.runId, source_id: 'usgs', status: 'SUCCEEDED' });
  });

  it('resolves a correlation link only once it was made', async () => {
    const seeded = await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'us7000tikc',
      aliases: ['us7000tikc'],
      ingestedAt: T0,
      centroid: PLACES.marrakech,
      magnitude: 5,
    });
    const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });
    const link = await db.transaction().execute(async (trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: seeded.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'eq-corr-1',
        linkedAt: hours(1),
      }),
    );

    expect(await correlationEvidenceAsOf(db, { asOf: minutes(5), linkId: link.linkId })).toBeNull();
    const row = await correlationEvidenceAsOf(db, { asOf: hours(2), linkId: link.linkId });
    expect(row).toMatchObject({
      link_id: link.linkId,
      canonical_event_public_id: event.publicId,
      source_record_primary_key: 'us7000tikc',
      relation: 'PRIMARY',
    });
    expect(row?.unlinked_at).toBeNull();
  });

  /**
   * A withdrawn link resolves, and says when it closed — but not before it closed.
   *
   * Both halves matter. Filtering closed links out would make an old citation unresolvable;
   * reporting the closure at a knowledge time before it happened would be future knowledge in the
   * one endpoint whose job is proving what was known when.
   */
  it('reports a link closure only from the moment it happened', async () => {
    const seeded = await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'us7000tikd',
      aliases: ['us7000tikd'],
      ingestedAt: T0,
      centroid: PLACES.marrakech,
      magnitude: 5,
    });
    const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });
    const link = await db.transaction().execute(async (trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: seeded.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'eq-corr-1',
        linkedAt: T0,
      }),
    );
    await db
      .transaction()
      .execute(async (trx) =>
        unlinkRecord(trx, seeded.sourceRecordId, hours(2), 'REVISED_SOLUTION_MOVED_OUT_OF_MISFIT'),
      );

    const stillOpen = await correlationEvidenceAsOf(db, { asOf: hours(1), linkId: link.linkId });
    expect(stillOpen?.unlinked_at).toBeNull();
    expect(stillOpen?.unlink_reason).toBeNull();

    const closed = await correlationEvidenceAsOf(db, { asOf: hours(3), linkId: link.linkId });
    expect(closed?.unlinked_at).toEqual(hours(2));
    expect(closed?.unlink_reason).toBe('REVISED_SOLUTION_MOVED_OUT_OF_MISFIT');
  });

  it('resolves a fire-cluster version only from its own as_of', async () => {
    const clusterId = await createCluster(db, {
      id: stableUuid('asof-evidence-cluster'),
      publicId: 'FR-26-TESTAA',
      createdAt: T0,
      status: 'ACTIVE',
    });
    const version = await insertClusterVersionIfChanged(db, {
      clusterId,
      asOf: hours(1),
      nTotal: 12,
      n24h: 5,
      overpasses24h: 2,
      firstDetectedAt: T0,
      lastDetectedAt: minutes(30),
      frpSum24h: 42.5,
      frpMax: 11.25,
      maxConfidence: 'HIGH',
      productIds: [9],
      hullGeoJson: null,
      centroid: PLACES.marrakech,
      contentSha256: contentHash('cluster', 12, 5, 31.6, -8, 'HIGH'),
      status: 'ACTIVE',
    });

    const versionId = version.clusterVersionId;
    expect(
      await clusterEvidenceAsOf(db, { asOf: minutes(5), clusterVersionId: versionId }),
    ).toBeNull();
    const row = await clusterEvidenceAsOf(db, { asOf: hours(2), clusterVersionId: versionId });
    expect(row).toMatchObject({
      cluster_public_id: 'FR-26-TESTAA',
      n_total: 12,
      n_24h: 5,
      overpasses_24h: 2,
      max_confidence: 'HIGH',
    });
  });

  it('returns null for an id that does not exist rather than throwing', async () => {
    expect(await observationEvidenceAsOf(db, { asOf: hours(1), versionId: '999999' })).toBeNull();
    expect(
      await runEvidenceAsOf(db, {
        asOf: hours(1),
        runId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toBeNull();
    expect(await correlationEvidenceAsOf(db, { asOf: hours(1), linkId: '999999' })).toBeNull();
    expect(
      await clusterEvidenceAsOf(db, { asOf: hours(1), clusterVersionId: '999999' }),
    ).toBeNull();
  });
});
