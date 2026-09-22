/**
 * `buildMapFeatures` against real PostGIS: what the map draws, and that it draws it the way the
 * briefing describes it.
 *
 * The viewport SQL is tested on its own in `packages/db`; these tests are about assembly — which
 * member anchors an event, what a cluster's state is at a knowledge time, how two kinds of subject
 * share one cap — and every response is also parsed with the frozen runtime schema, whose
 * refinement ties `truncated` to `total`.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createCanonicalEvent,
  createCluster,
  createDb,
  generateFireClusterPublicId,
  insertClusterVersionIfChanged,
  linkRecord,
  type DB,
} from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { contentHash, seedObservation, stableUuid } from '@geonerva/db/testing/factories';
import {
  HAZARD_FAMILIES,
  mapFeaturesResponseSchema,
  type HazardFamily,
  type MapFeaturesResponse,
} from '@geonerva/domain';

import { buildMapFeatures } from './map-features.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const T0 = new Date('2026-09-19T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);
const hours = (n: number): Date => minutes(n * 60);

const MARRAKECH = { lat: 31.63, lon: -8.0 };
/** Around Marrakech. */
const MOROCCO = { west: -11.25, south: 28.125, east: -5.625, north: 33.75 };
/** North of `MOROCCO`, sharing its northern edge. */
const NORTH_OF_MOROCCO = { west: -11.25, south: 33.75, east: -5.625, north: 39.375 };
/** Around Suva, across the antimeridian. */
const FIJI = { west: 177.1875, south: -19.6875, east: -177.1875, north: -16.875 };

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

async function build(options: {
  readonly asOf: Date;
  readonly bbox?: typeof MOROCCO;
  readonly families?: readonly HazardFamily[];
  readonly cap?: number;
}): Promise<MapFeaturesResponse> {
  const response = await buildMapFeatures({
    db,
    bbox: options.bbox ?? MOROCCO,
    zoom: 6,
    families: options.families ?? HAZARD_FAMILIES,
    asOf: options.asOf,
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  });
  // Every response satisfies the frozen contract, including `truncated === total > features`.
  return mapFeaturesResponseSchema.parse(response);
}

async function linkedQuake(options: {
  readonly primaryKey: string;
  readonly centroid: { readonly lat: number; readonly lon: number };
  readonly at?: Date;
  readonly magnitude?: number;
  readonly lifecycleStatus?: 'ACTIVE' | 'ENDED' | 'UPDATED';
  readonly hazardType?: 'EARTHQUAKE' | 'WILDFIRE_EVENT';
  readonly sourceId?: string;
}): Promise<{ eventId: string; publicId: string; versionId: string; sourceRecordId: string }> {
  const at = options.at ?? T0;
  const hazardType = options.hazardType ?? 'EARTHQUAKE';
  const record = await seedObservation(db, {
    primaryKey: options.primaryKey,
    ingestedAt: at,
    observedAt: at,
    centroid: options.centroid,
    hazardType,
    magnitude: options.magnitude ?? (hazardType === 'EARTHQUAKE' ? 5.4 : null),
    providerStatus: 'reviewed',
    lifecycleStatus: options.lifecycleStatus ?? 'ACTIVE',
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
  });
  const event = await createCanonicalEvent(db, { hazardType, createdAt: at });
  await db.transaction().execute((trx) =>
    linkRecord(trx, {
      canonicalEventId: event.id,
      sourceRecordId: record.sourceRecordId,
      relation: 'PRIMARY',
      matchKind: 'SEED',
      algorithmVersion: 'test-1',
      linkedAt: at,
    }),
  );
  return {
    eventId: event.id,
    publicId: event.publicId,
    versionId: record.versionId,
    sourceRecordId: record.sourceRecordId,
  };
}

async function cluster(options: {
  readonly label: string;
  readonly lastDetectedAt: Date;
  readonly centroid?: { readonly lat: number; readonly lon: number };
  readonly nTotal?: number;
}): Promise<{ publicId: string }> {
  const id = stableUuid(options.label);
  const publicId = generateFireClusterPublicId(T0);
  await createCluster(db, { id, publicId, createdAt: T0, status: 'ACTIVE' });
  const centroid = options.centroid ?? { lat: 31.5, lon: -8.3 };
  await insertClusterVersionIfChanged(db, {
    clusterId: id,
    asOf: options.lastDetectedAt,
    nTotal: options.nTotal ?? 7,
    n24h: 3,
    overpasses24h: 2,
    firstDetectedAt: T0,
    lastDetectedAt: options.lastDetectedAt,
    frpSum24h: 12,
    frpMax: 6,
    maxConfidence: 'NOMINAL',
    productIds: [1],
    hullGeoJson: null,
    centroid,
    status: 'ACTIVE',
    contentSha256: contentHash(options.label, options.nTotal ?? 7),
  });
  return { publicId };
}

describe('buildMapFeatures: a canonical event', () => {
  it('is drawn with the fields the briefing would give it', async () => {
    const quake = await linkedQuake({ primaryKey: 'us-1', centroid: MARRAKECH });
    const response = await build({ asOf: minutes(1) });

    expect(response.features).toHaveLength(1);
    const feature = response.features[0];
    expect(feature?.kind).toBe('canonical_event');
    expect(feature?.subjectRef).toBe(`CE:${quake.publicId}`);
    expect(feature?.publicId).toBe(quake.publicId);
    expect(feature?.href).toBe(`/events/${quake.publicId}`);
    expect(feature?.hazardType).toBe('EARTHQUAKE');
    expect(feature?.family).toBe('EARTHQUAKES');
    expect(feature?.label).toBe('M5.4 earthquake');
    expect(feature?.magnitudeValue).toBe(5.4);
    expect(feature?.isActive).toBe(true);
    expect(feature?.clusterStatus).toBeNull();
    expect(feature?.confidence).toBeNull();
    expect(feature?.observedAt).toBe(T0.toISOString());
    expect(feature?.geometry).toStrictEqual({
      type: 'Point',
      coordinates: [MARRAKECH.lon, MARRAKECH.lat],
    });
    expect(feature?.evidenceIds.some((id) => id === `EV:OBS:${quake.versionId}`)).toBe(true);
    expect(feature?.evidenceIds.some((id) => id.startsWith('EV:COR:'))).toBe(true);
    expect(response.attribution.map((entry) => entry.sourceId)).toStrictEqual(['usgs']);
    expect(response).toMatchObject({ total: 1, truncated: false, cap: 2000 });
  });

  it('is anchored and sized by all of its members, not by the ones on screen', async () => {
    // USGS reviewed at Marrakech; EMSC's own solution for the same event, 300 km north.
    const quake = await linkedQuake({ primaryKey: 'us-2', centroid: MARRAKECH, magnitude: 5.4 });
    const emsc = await seedObservation(db, {
      primaryKey: 'emsc-2',
      sourceId: 'emsc',
      ingestedAt: T0,
      observedAt: T0,
      centroid: { lat: 34.5, lon: -8.0 },
      magnitude: 5.1,
      magnitudeType: 'mb',
    });
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: quake.eventId,
        sourceRecordId: emsc.sourceRecordId,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'test-1',
        linkedAt: T0,
      }),
    );

    // Only the EMSC member is inside this viewport.
    const response = await build({ asOf: minutes(1), bbox: NORTH_OF_MOROCCO });
    const feature = response.features[0];
    expect(feature?.publicId).toBe(quake.publicId);
    expect(feature?.magnitudeValue).toBe(5.4);
    expect(feature?.geometry.coordinates).toStrictEqual([MARRAKECH.lon, MARRAKECH.lat]);
    expect(feature?.evidenceIds.filter((id) => id.startsWith('EV:OBS:'))).toHaveLength(2);
    expect(response.attribution.map((entry) => entry.sourceId)).toStrictEqual(['emsc', 'usgs']);
  });

  it('takes its magnitude and position from the headline member even when it is not the first', async () => {
    /*
     * Controls: "the anchor is the first member" and "the magnitude is the anchor row". EMSC is
     * seeded first, so its record sorts first; USGS reviewed still wins the precedence.
     */
    const emsc = await seedObservation(db, {
      primaryKey: 'emsc-first',
      sourceId: 'emsc',
      ingestedAt: T0,
      observedAt: T0,
      centroid: { lat: 31.5, lon: -8.2 },
      magnitude: 5.0,
      magnitudeType: 'mb',
    });
    const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: T0 });
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: emsc.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        algorithmVersion: 'test-1',
        linkedAt: T0,
      }),
    );
    const usgs = await seedObservation(db, {
      primaryKey: 'us-second',
      ingestedAt: T0,
      observedAt: T0,
      centroid: MARRAKECH,
      magnitude: 5.6,
      providerStatus: 'reviewed',
    });
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: usgs.sourceRecordId,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'test-1',
        linkedAt: T0,
      }),
    );
    expect(Number(emsc.sourceRecordId)).toBeLessThan(Number(usgs.sourceRecordId));

    const feature = (await build({ asOf: minutes(1) })).features[0];
    expect(feature?.magnitudeValue).toBe(5.6);
    expect(feature?.label).toBe('M5.6 earthquake');
    expect(feature?.geometry.coordinates).toStrictEqual([MARRAKECH.lon, MARRAKECH.lat]);
  });

  it('is active when its provider has updated it', async () => {
    // Control: "UPDATED is not live".
    await linkedQuake({ primaryKey: 'updated', centroid: MARRAKECH, lifecycleStatus: 'UPDATED' });
    expect((await build({ asOf: minutes(1) })).features[0]?.isActive).toBe(true);
  });

  it('is not drawn when its own version names a family the caller did not ask for', async () => {
    // The page is read by the record's hazard type; a version that disagrees is counted and not
    // drawn. The member filter in `describeEvents` is what enforces it — this test is its guard.
    const quake = await linkedQuake({ primaryKey: 'mislabelled', centroid: MARRAKECH });
    await sql`
      UPDATE geonerva.observation_versions SET hazard_type = 'VOLCANO'
      WHERE id = ${quake.versionId}::bigint
    `.execute(db);
    const response = await build({ asOf: minutes(1), families: ['EARTHQUAKES'] });
    expect(response).toMatchObject({ features: [], total: 1, truncated: true });
  });

  it('is not active once its provider has ended it', async () => {
    await linkedQuake({ primaryKey: 'ended', centroid: MARRAKECH, lifecycleStatus: 'ENDED' });
    const response = await build({ asOf: minutes(1) });
    expect(response.features[0]?.isActive).toBe(false);
  });

  it('is not drawn at a knowledge time before it was ingested', async () => {
    await linkedQuake({ primaryKey: 'later', centroid: MARRAKECH, at: minutes(30) });
    const response = await build({ asOf: minutes(10) });
    expect(response).toMatchObject({ features: [], total: 0, truncated: false, attribution: [] });
  });
});

describe('buildMapFeatures: a fire cluster', () => {
  it('is drawn at its centroid with its state derived at the knowledge time', async () => {
    const seeded = await cluster({ label: 'c1', lastDetectedAt: T0, nTotal: 11 });

    const fresh = await build({ asOf: hours(2) });
    const feature = fresh.features[0];
    expect(feature?.kind).toBe('fire_cluster');
    expect(feature?.subjectRef).toBe(`FC:${seeded.publicId}`);
    expect(feature?.href).toBe(`/fires/${seeded.publicId}`);
    expect(feature?.hazardType).toBe('THERMAL_ACTIVITY');
    expect(feature?.family).toBe('FIRE_ACTIVITY');
    expect(feature?.label).toBe('Fire activity');
    expect(feature?.magnitudeValue).toBe(11);
    expect(feature?.clusterStatus).toBe('ACTIVE');
    expect(feature?.isActive).toBe(true);
    expect(feature?.confidence).toStrictEqual({ class: 'NOMINAL', raw: null });
    expect(feature?.providerSeverity).toBeNull();
    expect(feature?.geometry).toStrictEqual({ type: 'Point', coordinates: [-8.3, 31.5] });
    expect(feature?.evidenceIds.map((id) => id.split(':')[1])).toStrictEqual(['FCV', 'FDS']);
    expect(fresh.attribution.map((entry) => entry.sourceId)).toStrictEqual(['firms']);

    // Thirty hours later the same version describes a cooling cluster.
    const later = await build({ asOf: hours(30) });
    expect(later.features[0]?.clusterStatus).toBe('COOLING');
    expect(later.features[0]?.isActive).toBe(false);
  });

  it('is left out when fire activity is not requested', async () => {
    await cluster({ label: 'c2', lastDetectedAt: T0 });
    const quake = await linkedQuake({ primaryKey: 'us-3', centroid: MARRAKECH });

    const quakesOnly = await build({ asOf: minutes(1), families: ['EARTHQUAKES'] });
    expect(quakesOnly.features.map((feature) => feature.publicId)).toStrictEqual([quake.publicId]);
    expect(quakesOnly.total).toBe(1);

    const firesOnly = await build({ asOf: minutes(1), families: ['FIRE_ACTIVITY'] });
    expect(firesOnly.features.map((feature) => feature.kind)).toStrictEqual(['fire_cluster']);
    expect(firesOnly.families).toStrictEqual(['FIRE_ACTIVITY']);
  });

  it('draws a GDACS wildfire event under fire activity, as the briefing lists it', async () => {
    const event = await linkedQuake({
      primaryKey: 'wf-1',
      centroid: MARRAKECH,
      hazardType: 'WILDFIRE_EVENT',
      sourceId: 'gdacs',
    });
    const response = await build({ asOf: minutes(1), families: ['FIRE_ACTIVITY'] });
    expect(response.features.map((feature) => feature.publicId)).toStrictEqual([event.publicId]);
    expect(response.features[0]?.family).toBe('FIRE_ACTIVITY');
    expect(response.features[0]?.magnitudeValue).toBeNull();
  });
});

describe('buildMapFeatures: one cap across both kinds of subject', () => {
  it('keeps the newest subjects of either kind and says it dropped the rest', async () => {
    const q1 = await linkedQuake({ primaryKey: 'q1', centroid: MARRAKECH, at: minutes(10) });
    const c1 = await cluster({ label: 'k1', lastDetectedAt: minutes(20) });
    const q2 = await linkedQuake({ primaryKey: 'q2', centroid: MARRAKECH, at: minutes(30) });
    const c2 = await cluster({ label: 'k2', lastDetectedAt: minutes(40) });
    await linkedQuake({ primaryKey: 'q0', centroid: MARRAKECH, at: minutes(5) });

    const response = await build({ asOf: minutes(60), cap: 3 });
    expect(response.features.map((feature) => feature.publicId)).toStrictEqual([
      c2.publicId,
      q2.publicId,
      c1.publicId,
    ]);
    expect(response).toMatchObject({ total: 5, truncated: true, cap: 3 });
    expect(q1.publicId).not.toBe(q2.publicId);
    // Attribution follows what is drawn: both kinds are on the map.
    expect(response.attribution.map((entry) => entry.sourceId)).toStrictEqual(['firms', 'usgs']);
  });

  it('gives a wildfire event its own three-day window, not the earthquake one', async () => {
    // Control: "every family gets the earthquake window".
    await linkedQuake({
      primaryKey: 'wf-old',
      centroid: MARRAKECH,
      hazardType: 'WILDFIRE_EVENT',
      sourceId: 'gdacs',
      at: hours(-5 * 24),
    });
    const response = await build({ asOf: minutes(1) });
    expect(response.total).toBe(0);
  });

  it('does not let another family’s wider window admit a stale member', async () => {
    // Control: "a member outside its own type window is admitted". Earthquakes are requested too,
    // so the member read reaches back 30 days; the wildfire member five days old must still drop.
    const recent = await linkedQuake({
      primaryKey: 'wf-recent',
      centroid: MARRAKECH,
      hazardType: 'WILDFIRE_EVENT',
      sourceId: 'gdacs',
      at: hours(-24),
    });
    const stale = await seedObservation(db, {
      primaryKey: 'wf-stale',
      sourceId: 'gdacs',
      hazardType: 'WILDFIRE_EVENT',
      ingestedAt: hours(-5 * 24),
      observedAt: hours(-5 * 24),
      centroid: { lat: 31.6, lon: -8.1 },
    });
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: recent.eventId,
        sourceRecordId: stale.sourceRecordId,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'test-1',
        linkedAt: hours(-24),
      }),
    );
    const feature = (await build({ asOf: minutes(1) })).features[0];
    expect(feature?.evidenceIds).toContain(`EV:OBS:${recent.versionId}`);
    expect(feature?.evidenceIds).not.toContain(`EV:OBS:${stale.versionId}`);
  });

  it('does not credit FIRMS when the cap left every cluster off the map', async () => {
    // Control: "firms is attributed whenever a cluster was read".
    await cluster({ label: 'k-old', lastDetectedAt: minutes(5) });
    await linkedQuake({ primaryKey: 'q-new', centroid: MARRAKECH, at: minutes(40) });
    const response = await build({ asOf: minutes(60), cap: 1 });
    expect(response.features.map((feature) => feature.kind)).toStrictEqual(['canonical_event']);
    expect(response.attribution.map((entry) => entry.sourceId)).toStrictEqual(['usgs']);
  });

  it('names only the providers whose subjects survived the cap', async () => {
    await linkedQuake({ primaryKey: 'q-old', centroid: MARRAKECH, at: minutes(5) });
    await cluster({ label: 'k-new', lastDetectedAt: minutes(40) });
    const response = await build({ asOf: minutes(60), cap: 1 });
    expect(response.features.map((feature) => feature.kind)).toStrictEqual(['fire_cluster']);
    expect(response.attribution.map((entry) => entry.sourceId)).toStrictEqual(['firms']);
  });
});

describe('buildMapFeatures: the viewport', () => {
  it('reports two envelopes for a box across the antimeridian and one otherwise', async () => {
    const fiji = await build({ asOf: minutes(1), bbox: FIJI });
    expect(fiji.bbox).toStrictEqual(FIJI);
    expect(fiji.bboxParts).toStrictEqual([
      { west: FIJI.west, south: FIJI.south, east: 180, north: FIJI.north },
      { west: -180, south: FIJI.south, east: FIJI.east, north: FIJI.north },
    ]);
    const morocco = await build({ asOf: minutes(1) });
    expect(morocco.bboxParts).toStrictEqual([MOROCCO]);
  });

  it('draws subjects on both sides of the antimeridian', async () => {
    const west = await linkedQuake({ primaryKey: 'fj-w', centroid: { lat: -18.14, lon: 178.44 } });
    const east = await linkedQuake({ primaryKey: 'fj-e', centroid: { lat: -18.14, lon: -178.5 } });
    const response = await build({ asOf: minutes(1), bbox: FIJI });
    expect(response.features.map((feature) => feature.publicId).sort()).toStrictEqual(
      [west.publicId, east.publicId].sort(),
    );
  });
});
