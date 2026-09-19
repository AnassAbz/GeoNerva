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
  clusterVersionsAsOf,
  clusterVersionsNow,
  healthAsOf,
  linksAsOf,
  observationsAsOf,
  observationsNow,
  sourceCutoffsAsOf,
} from './asof.ts';
import { createCanonicalEvent, linkRecord } from './repositories/canonical.ts';
import {
  bulkInsertDetections,
  createCluster,
  dropDetectionPartitionsBefore,
  insertClusterVersionIfChanged,
  listDetectionPartitionDays,
} from './repositories/fire.ts';
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
