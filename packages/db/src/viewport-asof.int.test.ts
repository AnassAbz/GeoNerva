/**
 * The viewport as-of reads behind `GET /api/v1/events`, against real PostGIS (ARCHITECTURE §7.2,
 * §7.5; invariant I2).
 *
 * Every test here is a question a map user could ask and a way the SQL could plausibly answer it
 * wrongly: a Pacific viewport read as "the rest of the world", an epicentre revision that should
 * move a feature off the map, a correlation withdrawn after the knowledge time, a total that
 * stopped counting at the `LIMIT`.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalEventsInViewportAsOf, clustersInViewportAsOf, observationsAsOf } from './asof.ts';
import { createDb } from './client.ts';
import type { DB } from './generated/database.ts';
import {
  createCanonicalEvent,
  linkRecord,
  mergeCanonicalEvents,
  unlinkRecord,
} from './repositories/canonical.ts';
import { resolveSourceRecord } from './repositories/source-records.ts';
import {
  createCluster,
  insertClusterVersionIfChanged,
  mergeClusters,
} from './repositories/fire.ts';
import { setupTestDatabase, type TestDatabase } from './testing/test-database.ts';
import { PLACES, contentHash, seedObservation, stableUuid } from './testing/factories.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const T0 = new Date('2026-09-19T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const days = (n: number): Date => minutes(n * 24 * 60);

/** A box around Marrakech that excludes Montréal. */
const MOROCCO = { west: -11.25, south: 28.125, east: -5.625, north: 33.75 };
/** A Pacific box that crosses the antimeridian around Suva: `west > east`. */
const FIJI = { west: 177.1875, south: -19.6875, east: -177.1875, north: -16.875 };
/** The same numbers with the edges swapped: the ordinary box that is everything *except* Fiji. */
const NOT_FIJI = { west: -177.1875, south: -19.6875, east: 177.1875, north: -16.875 };

/** The earthquake window, as `buildMapFeatures` passes it for `EARTHQUAKES`. */
const quakes = (asOf: Date): { hazardType: string; observedSince: Date }[] => [
  { hazardType: 'EARTHQUAKE', observedSince: new Date(asOf.getTime() - 30 * 86_400_000) },
];

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

/** One record, one canonical event, one link — the smallest subject a map can draw. */
async function seedLinkedEvent(options: {
  readonly primaryKey: string;
  readonly centroid: { readonly lat: number; readonly lon: number };
  readonly ingestedAt?: Date;
  readonly observedAt?: Date;
  readonly linkedAt?: Date;
  readonly hazardType?: 'EARTHQUAKE' | 'WILDFIRE_EVENT' | 'FLOOD';
  readonly sourceId?: string;
}): Promise<{ eventId: string; publicId: string; sourceRecordId: string }> {
  const ingestedAt = options.ingestedAt ?? T0;
  const hazardType = options.hazardType ?? 'EARTHQUAKE';
  const record = await seedObservation(db, {
    primaryKey: options.primaryKey,
    ingestedAt,
    observedAt: options.observedAt ?? ingestedAt,
    centroid: options.centroid,
    hazardType,
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
  });
  const event = await createCanonicalEvent(db, { hazardType, createdAt: ingestedAt });
  await db.transaction().execute((trx) =>
    linkRecord(trx, {
      canonicalEventId: event.id,
      sourceRecordId: record.sourceRecordId,
      relation: 'PRIMARY',
      matchKind: 'SEED',
      algorithmVersion: 'test-1',
      linkedAt: options.linkedAt ?? ingestedAt,
    }),
  );
  return { eventId: event.id, publicId: event.publicId, sourceRecordId: record.sourceRecordId };
}

describe('canonicalEventsInViewportAsOf: which subjects are on the map', () => {
  it('returns an event inside the viewport and not one outside it', async () => {
    const inside = await seedLinkedEvent({ primaryKey: 'mar', centroid: PLACES.marrakech });
    await seedLinkedEvent({ primaryKey: 'mtl', centroid: PLACES.montreal });

    const page = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: MOROCCO,
      windows: quakes(minutes(1)),
      limit: 10,
    });
    expect(page.events.map((row) => row.public_id)).toStrictEqual([inside.publicId]);
    expect(page.total).toBe(1);
  });

  it('does not draw a record that no canonical event claims', async () => {
    await seedObservation(db, { primaryKey: 'orphan', ingestedAt: T0, centroid: PLACES.marrakech });
    const page = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: MOROCCO,
      windows: quakes(minutes(1)),
      limit: 10,
    });
    expect(page).toStrictEqual({ events: [], total: 0 });
  });

  it('includes a point exactly on the viewport edge', async () => {
    const edge = await seedLinkedEvent({
      primaryKey: 'edge',
      centroid: { lat: 30, lon: MOROCCO.west },
    });
    const page = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: MOROCCO,
      windows: quakes(minutes(1)),
      limit: 10,
    });
    expect(page.events.map((row) => row.public_id)).toStrictEqual([edge.publicId]);
  });

  it('draws both sides of the antimeridian for a Pacific viewport, and nothing else', async () => {
    const west = await seedLinkedEvent({ primaryKey: 'suva', centroid: PLACES.suva });
    const east = await seedLinkedEvent({ primaryKey: 'east', centroid: PLACES.eastOfSuva });
    await seedLinkedEvent({ primaryKey: 'mar', centroid: PLACES.marrakech });

    const fiji = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: FIJI,
      windows: quakes(minutes(1)),
      limit: 10,
    });
    expect(fiji.events.map((row) => row.public_id).sort()).toStrictEqual(
      [west.publicId, east.publicId].sort(),
    );
    expect(fiji.total).toBe(2);

    // The swapped box is the rest of the planet at that latitude band — and contains neither.
    const rest = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: NOT_FIJI,
      windows: quakes(minutes(1)),
      limit: 10,
    });
    expect(rest.total).toBe(0);
  });
});

describe('canonicalEventsInViewportAsOf: replay never sees the future (I2)', () => {
  it('withholds an event whose record was ingested after T', async () => {
    await seedLinkedEvent({
      primaryKey: 'later',
      centroid: PLACES.marrakech,
      ingestedAt: minutes(30),
    });
    const before = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(10),
      bbox: MOROCCO,
      windows: quakes(minutes(10)),
      limit: 10,
    });
    expect(before.total).toBe(0);
    const after = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(31),
      bbox: MOROCCO,
      windows: quakes(minutes(31)),
      limit: 10,
    });
    expect(after.total).toBe(1);
  });

  it('moves an event off the map at the knowledge time of the revision that moved it', async () => {
    await seedLinkedEvent({ primaryKey: 'moved', centroid: PLACES.marrakech });
    await seedObservation(db, {
      primaryKey: 'moved',
      ingestedAt: minutes(30),
      observedAt: T0,
      centroid: PLACES.montreal,
    });

    const ask = async (asOf: Date): Promise<number> =>
      (
        await canonicalEventsInViewportAsOf(db, {
          asOf,
          bbox: MOROCCO,
          windows: quakes(asOf),
          limit: 10,
        })
      ).total;
    expect(await ask(minutes(10))).toBe(1);
    // A candidate filter applied to *any* version would still find the first one here.
    expect(await ask(minutes(40))).toBe(0);
  });

  it('brings an event onto the map when a revision moves it in', async () => {
    await seedLinkedEvent({ primaryKey: 'arrived', centroid: PLACES.montreal });
    await seedObservation(db, {
      primaryKey: 'arrived',
      ingestedAt: minutes(30),
      observedAt: T0,
      centroid: PLACES.marrakech,
    });
    const ask = async (asOf: Date): Promise<number> =>
      (
        await canonicalEventsInViewportAsOf(db, {
          asOf,
          bbox: MOROCCO,
          windows: quakes(asOf),
          limit: 10,
        })
      ).total;
    expect(await ask(minutes(10))).toBe(0);
    expect(await ask(minutes(40))).toBe(1);
  });

  it('respects the link window: not before the link, not after the unlink', async () => {
    const seeded = await seedLinkedEvent({
      primaryKey: 'window',
      centroid: PLACES.marrakech,
      linkedAt: minutes(20),
    });
    await unlinkRecord(db, seeded.sourceRecordId, minutes(50), 'test');

    const ask = async (asOf: Date): Promise<number> =>
      (
        await canonicalEventsInViewportAsOf(db, {
          asOf,
          bbox: MOROCCO,
          windows: quakes(asOf),
          limit: 10,
        })
      ).total;
    expect(await ask(minutes(10))).toBe(0);
    expect(await ask(minutes(20))).toBe(1);
    expect(await ask(minutes(49))).toBe(1);
    // `unlinked_at` is exclusive: at the instant of the unlink the correlation is gone.
    expect(await ask(minutes(50))).toBe(0);
  });

  it('shows two events before a merge and one after it', async () => {
    const survivor = await seedLinkedEvent({ primaryKey: 'a', centroid: PLACES.marrakech });
    const absorbed = await seedLinkedEvent({
      primaryKey: 'b',
      centroid: { lat: 31.7, lon: -7.9 },
    });
    await db.transaction().execute((trx) =>
      mergeCanonicalEvents(trx, {
        survivorId: survivor.eventId,
        absorbedIds: [absorbed.eventId],
        mergedAt: minutes(60),
        algorithmVersion: 'test-1',
      }),
    );

    const ask = async (asOf: Date): Promise<string[]> =>
      (
        await canonicalEventsInViewportAsOf(db, {
          asOf,
          bbox: MOROCCO,
          windows: quakes(asOf),
          limit: 10,
        })
      ).events
        .map((row) => row.public_id)
        .sort();
    expect(await ask(minutes(30))).toStrictEqual([survivor.publicId, absorbed.publicId].sort());
    expect(await ask(minutes(90))).toStrictEqual([survivor.publicId]);
  });

  it('stops drawing a record merged into another from the moment of the merge', async () => {
    // Control: "events: a merged record is still drawn".
    await seedLinkedEvent({ primaryKey: 'us-m1', centroid: PLACES.marrakech });
    await seedLinkedEvent({ primaryKey: 'us-m2', centroid: { lat: 31.7, lon: -7.9 } });
    await db.transaction().execute((trx) =>
      resolveSourceRecord(trx, {
        sourceId: 'usgs',
        hazardType: 'EARTHQUAKE',
        primaryKey: 'us-m1',
        aliases: ['us-m1', 'us-m2'],
        firstIngestedAt: minutes(60),
      }),
    );
    const ask = async (asOf: Date): Promise<number> =>
      (
        await canonicalEventsInViewportAsOf(db, {
          asOf,
          bbox: MOROCCO,
          windows: quakes(asOf),
          limit: 10,
        })
      ).total;
    expect(await ask(minutes(30))).toBe(2);
    expect(await ask(minutes(90))).toBe(1);
  });

  it('does not draw a merged event even while its links are still open', async () => {
    /*
     * Control: "events: a merged event is still drawn". `mergeCanonicalEvents` also closes the
     * absorbed event's links, so through the writer the link window hides it first. The reader's
     * own rule must not depend on that: here the event is merged and its link left open.
     */
    const absorbed = await seedLinkedEvent({ primaryKey: 'orphaned', centroid: PLACES.marrakech });
    const survivor = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });
    await sql`
      UPDATE geonerva.canonical_events
      SET merged_into = ${survivor.id}::uuid, merged_at = ${minutes(60)}
      WHERE id = ${absorbed.eventId}::uuid
    `.execute(db);
    const ask = async (asOf: Date): Promise<number> =>
      (
        await canonicalEventsInViewportAsOf(db, {
          asOf,
          bbox: MOROCCO,
          windows: quakes(asOf),
          limit: 10,
        })
      ).total;
    expect(await ask(minutes(30))).toBe(1);
    expect(await ask(minutes(90))).toBe(0);
  });

  it('withholds a withdrawn record from the moment the tombstone is known', async () => {
    await seedLinkedEvent({ primaryKey: 'gone', centroid: PLACES.marrakech });
    await seedObservation(db, {
      primaryKey: 'gone',
      ingestedAt: minutes(30),
      centroid: PLACES.marrakech,
      lifecycleStatus: 'DELETED',
      contentSha256: contentHash('gone', 'deleted'),
    });
    const ask = async (asOf: Date): Promise<number> =>
      (
        await canonicalEventsInViewportAsOf(db, {
          asOf,
          bbox: MOROCCO,
          windows: quakes(asOf),
          limit: 10,
        })
      ).total;
    expect(await ask(minutes(10))).toBe(1);
    expect(await ask(minutes(40))).toBe(0);
  });
});

describe('canonicalEventsInViewportAsOf: windows, hazard types and the total', () => {
  it('applies each hazard type its own recency window', async () => {
    const asOf = days(10);
    // Both observed five days before the knowledge time.
    const quake = await seedLinkedEvent({
      primaryKey: 'eq',
      centroid: PLACES.marrakech,
      observedAt: days(5),
      ingestedAt: days(5),
    });
    await seedLinkedEvent({
      primaryKey: 'wf',
      centroid: { lat: 31.5, lon: -8.2 },
      observedAt: days(5),
      ingestedAt: days(5),
      hazardType: 'WILDFIRE_EVENT',
      sourceId: 'gdacs',
    });

    const page = await canonicalEventsInViewportAsOf(db, {
      asOf,
      bbox: MOROCCO,
      windows: [
        { hazardType: 'EARTHQUAKE', observedSince: days(-20) },
        // Three days: the wildfire event is two days too old.
        { hazardType: 'WILDFIRE_EVENT', observedSince: days(7) },
      ],
      limit: 10,
    });
    expect(page.events.map((row) => row.public_id)).toStrictEqual([quake.publicId]);
    expect(page.total).toBe(1);
  });

  it('reads only the hazard types it is given', async () => {
    await seedLinkedEvent({
      primaryKey: 'flood',
      centroid: PLACES.marrakech,
      hazardType: 'FLOOD',
      sourceId: 'gdacs',
    });
    const page = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: MOROCCO,
      windows: quakes(minutes(1)),
      limit: 10,
    });
    expect(page.total).toBe(0);
    expect(
      await canonicalEventsInViewportAsOf(db, {
        asOf: minutes(1),
        bbox: MOROCCO,
        windows: [],
        limit: 10,
      }),
    ).toStrictEqual({ events: [], total: 0 });
  });

  it('counts past the limit, newest first, so a cap is never presented as a total', async () => {
    const seeded = [];
    for (let index = 0; index < 5; index += 1) {
      seeded.push(
        await seedLinkedEvent({
          primaryKey: `n${String(index)}`,
          centroid: { lat: 31 + index / 10, lon: -8 },
          observedAt: minutes(index),
          ingestedAt: minutes(index),
        }),
      );
    }
    const page = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(10),
      bbox: MOROCCO,
      windows: quakes(minutes(10)),
      limit: 2,
    });
    expect(page.total).toBe(5);
    expect(page.events.map((row) => row.public_id)).toStrictEqual([
      seeded[4]?.publicId,
      seeded[3]?.publicId,
    ]);
    expect(page.events[0]?.newest_observed_at).toStrictEqual(minutes(4));
  });

  it('counts an event once however many of its members are on screen', async () => {
    const event = await seedLinkedEvent({ primaryKey: 'usgs-1', centroid: PLACES.marrakech });
    const second = await seedObservation(db, {
      primaryKey: 'emsc-1',
      sourceId: 'emsc',
      ingestedAt: T0,
      centroid: { lat: 31.65, lon: -8.02 },
    });
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: event.eventId,
        sourceRecordId: second.sourceRecordId,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'test-1',
        linkedAt: T0,
      }),
    );
    const page = await canonicalEventsInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: MOROCCO,
      windows: quakes(minutes(1)),
      limit: 10,
    });
    expect(page.total).toBe(1);
    expect(page.events).toHaveLength(1);
  });
});

describe('observationsAsOf: sourceRecordIds', () => {
  it('restricts the read to the given records', async () => {
    const kept = await seedObservation(db, {
      primaryKey: 'kept',
      ingestedAt: T0,
      centroid: PLACES.marrakech,
    });
    await seedObservation(db, { primaryKey: 'other', ingestedAt: T0, centroid: PLACES.marrakech });
    const rows = await observationsAsOf(db, {
      asOf: minutes(1),
      sourceRecordIds: [kept.sourceRecordId],
    });
    expect(rows.map((row) => row.primary_key)).toStrictEqual(['kept']);
  });
});

describe('clustersInViewportAsOf', () => {
  const clusterId = stableUuid('viewport-cluster');

  async function seedCluster(options: {
    readonly id?: string;
    readonly publicId?: string;
    readonly status?: 'ACTIVE' | 'COOLING' | 'INACTIVE';
    readonly asOf?: Date;
    readonly lastDetectedAt?: Date;
    readonly centroid?: { readonly lat: number; readonly lon: number };
    readonly nTotal?: number;
    readonly create?: boolean;
  }): Promise<void> {
    const id = options.id ?? clusterId;
    if (options.create !== false) {
      await createCluster(db, {
        id,
        publicId: options.publicId ?? 'FR-26-VPVPVP',
        createdAt: T0,
        status: options.status ?? 'ACTIVE',
      });
    }
    const nTotal = options.nTotal ?? 5;
    const centroid = options.centroid ?? PLACES.marrakech;
    await insertClusterVersionIfChanged(db, {
      clusterId: id,
      asOf: options.asOf ?? T0,
      nTotal,
      n24h: nTotal,
      overpasses24h: 1,
      firstDetectedAt: T0,
      lastDetectedAt: options.lastDetectedAt ?? T0,
      frpSum24h: 10,
      frpMax: 5,
      maxConfidence: 'NOMINAL',
      productIds: [1],
      hullGeoJson: null,
      centroid,
      status: 'ACTIVE',
      contentSha256: contentHash(id, nTotal, centroid.lat, centroid.lon),
    });
  }

  it('returns a cluster whose centroid is inside, and not one outside', async () => {
    await seedCluster({});
    await seedCluster({
      id: stableUuid('mtl-cluster'),
      publicId: 'FR-26-MTLMTL',
      centroid: PLACES.montreal,
    });
    const page = await clustersInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: MOROCCO,
      lastDetectedSince: days(-3),
      limit: 10,
    });
    expect(page.clusters.map((row) => row.public_id)).toStrictEqual(['FR-26-VPVPVP']);
    expect(page.total).toBe(1);
  });

  it('returns the summary as it stood at T, and moves with a revised centroid', async () => {
    await seedCluster({});
    await seedCluster({
      create: false,
      asOf: minutes(60),
      nTotal: 9,
      lastDetectedAt: minutes(55),
      centroid: PLACES.montreal,
    });
    const early = await clustersInViewportAsOf(db, {
      asOf: minutes(30),
      bbox: MOROCCO,
      lastDetectedSince: days(-3),
      limit: 10,
    });
    expect(early.clusters.map((row) => row.n_total)).toStrictEqual([5]);
    const late = await clustersInViewportAsOf(db, {
      asOf: minutes(90),
      bbox: MOROCCO,
      lastDetectedSince: days(-3),
      limit: 10,
    });
    expect(late.total).toBe(0);
  });

  it('withholds a cluster computed after T', async () => {
    await seedCluster({ asOf: minutes(30) });
    const page = await clustersInViewportAsOf(db, {
      asOf: minutes(10),
      bbox: MOROCCO,
      lastDetectedSince: days(-3),
      limit: 10,
    });
    expect(page.total).toBe(0);
  });

  it('drops a cluster whose newest detection is older than the window', async () => {
    await seedCluster({ lastDetectedAt: T0 });
    const inside = await clustersInViewportAsOf(db, {
      asOf: days(2),
      bbox: MOROCCO,
      lastDetectedSince: days(-1),
      limit: 10,
    });
    expect(inside.total).toBe(1);
    const outside = await clustersInViewportAsOf(db, {
      asOf: days(4),
      bbox: MOROCCO,
      lastDetectedSince: days(1),
      limit: 10,
    });
    expect(outside.total).toBe(0);
  });

  it('judges recency on the latest version, not on any version', async () => {
    // Control: "clusters: recency not re-applied to the latest version". Real histories only move
    // `last_detected_at` forward; the reader's rule must not rely on that. The later version here
    // moves it back (still no earlier than `first_detected_at`, which the table's CHECK requires),
    // and the window falls between the two.
    await seedCluster({ asOf: minutes(10), lastDetectedAt: minutes(10) });
    await seedCluster({ create: false, asOf: minutes(20), lastDetectedAt: T0, nTotal: 6 });
    const page = await clustersInViewportAsOf(db, {
      asOf: minutes(30),
      bbox: MOROCCO,
      lastDetectedSince: minutes(5),
      limit: 10,
    });
    expect(page.total).toBe(0);
  });

  it('never consults the in-place status column', async () => {
    // `fire_clusters.status` says INACTIVE; at this knowledge time the version is fresh.
    await seedCluster({ status: 'INACTIVE' });
    const page = await clustersInViewportAsOf(db, {
      asOf: minutes(1),
      bbox: MOROCCO,
      lastDetectedSince: days(-3),
      limit: 10,
    });
    expect(page.total).toBe(1);
  });

  it('shows an absorbed cluster before the merge and not after it', async () => {
    await seedCluster({});
    const absorbedId = stableUuid('absorbed-cluster');
    await seedCluster({
      id: absorbedId,
      publicId: 'FR-26-ABSABS',
      centroid: { lat: 31.7, lon: -7.9 },
    });
    await db
      .transaction()
      .execute((trx) => mergeClusters(trx, clusterId, [absorbedId], minutes(60)));
    const ask = async (asOf: Date): Promise<string[]> =>
      (
        await clustersInViewportAsOf(db, {
          asOf,
          bbox: MOROCCO,
          lastDetectedSince: days(-3),
          limit: 10,
        })
      ).clusters
        .map((row) => row.public_id)
        .sort();
    expect(await ask(minutes(30))).toStrictEqual(['FR-26-ABSABS', 'FR-26-VPVPVP']);
    expect(await ask(minutes(90))).toStrictEqual(['FR-26-VPVPVP']);
  });

  it('crosses the antimeridian, and counts past the limit', async () => {
    await seedCluster({ centroid: PLACES.suva });
    await seedCluster({
      id: stableUuid('east-cluster'),
      publicId: 'FR-26-EASTEA',
      centroid: PLACES.eastOfSuva,
      lastDetectedAt: minutes(5),
      asOf: minutes(5),
    });
    const page = await clustersInViewportAsOf(db, {
      asOf: minutes(10),
      bbox: FIJI,
      lastDetectedSince: days(-3),
      limit: 1,
    });
    expect(page.total).toBe(2);
    expect(page.clusters.map((row) => row.public_id)).toStrictEqual(['FR-26-EASTEA']);
    const rest = await clustersInViewportAsOf(db, {
      asOf: minutes(10),
      bbox: NOT_FIJI,
      lastDetectedSince: days(-3),
      limit: 10,
    });
    expect(rest.total).toBe(0);
  });
});
