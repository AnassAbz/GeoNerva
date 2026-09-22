/**
 * `GET /api/v1/events` against real PostGIS, through the HTTP boundary.
 *
 * The as-of SQL and the feature assembly have their own tests in `packages/db` and
 * `packages/briefing`. These assert what only the route can get wrong: validation, the horizon
 * rule, the cache policy, the contract of the whole document, and that every citation on the map
 * resolves through `/evidence/{id}` at the same knowledge time.
 *
 * ### The timeline is anchored to the wall clock, unlike the other API tests
 *
 * The other files pin a date, which is safe for them because the briefing's horizon guard only
 * fires when *every* family is beyond its horizon — five years for floods. This endpoint refuses
 * when *any* requested family is, and fire activity's horizon is three days, so a pinned date
 * would start failing three days after it was written. Everything here is relative to `NOW`,
 * taken from the clock when the file loads.
 */

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadWebConfig } from '@geonerva/config';
import {
  createCanonicalEvent,
  createCluster,
  createDb,
  generateFireClusterPublicId,
  insertClusterVersionIfChanged,
  linkRecord,
  type DB,
} from '@geonerva/db';
import type { DatabaseHandle } from '@geonerva/db/client';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { contentHash, seedObservation, stableUuid } from '@geonerva/db/testing/factories';
import {
  PROBLEM_MEDIA_TYPE,
  mapFeaturesResponseSchema,
  problemDetailsSchema,
  type MapFeaturesResponse,
} from '@geonerva/domain';

import { setWebConfigForTesting } from '../../../lib/server/config.ts';
import { setDatabaseForTesting } from '../../../lib/server/db.ts';
import { GET as evidence } from './evidence/[id]/route.ts';
import { GET as events } from './events/route.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

/** A minute before the file loaded, on a whole minute, so `as_of=NOW` is never in the future. */
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
const ago = (minutesAgo: number): Date => new Date(NOW.getTime() - minutesAgo * 60_000);

const MARRAKECH = { lat: 31.63, lon: -8.0 };
/** Grid-aligned at zoom 6 (step 1.40625°). */
const MOROCCO = 'bbox=-11.25,28.125,-5.625,33.75&zoom=6';
const FIJI = 'bbox=177.1875,-19.6875,-177.1875,-16.875&zoom=6';

const TEST_CONFIG = loadWebConfig({
  DATABASE_URL: 'postgresql://web:pw@127.0.0.1:54320/geonerva_test',
  RATE_LIMIT_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // gitleaks:allow
  NOMINATIM_CONTACT: 'https://example.org/geonerva-contact',
});

let callerIndex = 0;
function request(path: string, init?: RequestInit): Request {
  callerIndex += 1;
  return new Request(`https://geonerva.test${path}`, {
    headers: new Headers({ 'x-forwarded-for': `203.2.${String(callerIndex % 250)}.42` }),
    ...init,
  });
}

function testHandle(): DatabaseHandle {
  return { db, pool: testDb.pool, target: 'test', close: () => Promise.resolve() };
}

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
  setDatabaseForTesting(testHandle());
  setWebConfigForTesting(TEST_CONFIG);
}, 120_000);

afterAll(async () => {
  setDatabaseForTesting(null);
  setWebConfigForTesting(null);
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
});

async function seedQuake(options: {
  readonly primaryKey: string;
  readonly centroid?: { readonly lat: number; readonly lon: number };
  readonly ingestedAt?: Date;
}): Promise<{ publicId: string; versionId: string }> {
  const ingestedAt = options.ingestedAt ?? ago(15);
  const record = await seedObservation(db, {
    primaryKey: options.primaryKey,
    ingestedAt,
    observedAt: ingestedAt,
    centroid: options.centroid ?? MARRAKECH,
    magnitude: 5.4,
    providerStatus: 'reviewed',
  });
  const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: ingestedAt });
  await db.transaction().execute((trx) =>
    linkRecord(trx, {
      canonicalEventId: event.id,
      sourceRecordId: record.sourceRecordId,
      relation: 'PRIMARY',
      matchKind: 'SEED',
      algorithmVersion: 'test-1',
      linkedAt: ingestedAt,
    }),
  );
  return { publicId: event.publicId, versionId: record.versionId };
}

async function seedCluster(): Promise<{ publicId: string }> {
  const id = stableUuid('events-http-cluster');
  const publicId = generateFireClusterPublicId(NOW);
  await createCluster(db, { id, publicId, createdAt: ago(120), status: 'ACTIVE' });
  await insertClusterVersionIfChanged(db, {
    clusterId: id,
    asOf: ago(30),
    nTotal: 4,
    n24h: 4,
    overpasses24h: 1,
    firstDetectedAt: ago(120),
    lastDetectedAt: ago(30),
    frpSum24h: 8,
    frpMax: 4,
    maxConfidence: 'HIGH',
    productIds: [1],
    hullGeoJson: null,
    centroid: { lat: 31.4, lon: -8.4 },
    status: 'ACTIVE',
    contentSha256: contentHash('events-http-cluster'),
  });
  return { publicId };
}

async function mapAt(query: string): Promise<{ response: Response; body: MapFeaturesResponse }> {
  const response = await events(request(`/api/v1/events?${query}`));
  const raw = await response.text();
  expect(response.status, raw.slice(0, 400)).toBe(200);
  return {
    response,
    body: mapFeaturesResponseSchema.parse(JSON.parse(raw)),
  };
}

async function problemAt(query: string): Promise<ReturnType<typeof problemDetailsSchema.parse>> {
  const response = await events(request(`/api/v1/events?${query}`));
  expect(response.headers.get('content-type')).toContain(PROBLEM_MEDIA_TYPE);
  const body = problemDetailsSchema.strict().parse(await response.json());
  expect(body.status).toBe(response.status);
  return body;
}

describe('GET /api/v1/events: what the map shows', () => {
  it('draws a linked earthquake and a fire cluster in the viewport', async () => {
    const quake = await seedQuake({ primaryKey: 'us-http' });
    const cluster = await seedCluster();

    const { body } = await mapAt(MOROCCO);
    expect(body.features.map((feature) => feature.publicId).sort()).toStrictEqual(
      [quake.publicId, cluster.publicId].sort(),
    );
    expect(body).toMatchObject({ zoom: 6, total: 2, truncated: false, cap: 2000 });
    expect(body.bbox).toStrictEqual({ west: -11.25, south: 28.125, east: -5.625, north: 33.75 });
    expect(body.asOfContext.isReplay).toBe(false);
    expect(body.attribution.map((entry) => entry.sourceId)).toStrictEqual(['firms', 'usgs']);
  });

  it('satisfies its contract with nothing undeclared at the top level, and no snake_case', async () => {
    await seedQuake({ primaryKey: 'us-strict' });
    const response = await events(request(`/api/v1/events?${MOROCCO}`));
    const raw = await response.text();
    expect(() => mapFeaturesResponseSchema.strict().parse(JSON.parse(raw))).not.toThrow();
    const keys = [...raw.matchAll(/"([A-Za-z0-9_]+)":/gu)].map((match) => match[1] ?? '');
    expect(keys.filter((key) => /^[a-z0-9]+(?:_[a-z0-9]+)+$/u.test(key))).toStrictEqual([]);
  });

  it('draws both sides of the antimeridian', async () => {
    const west = await seedQuake({ primaryKey: 'fj-w', centroid: { lat: -18.14, lon: 178.44 } });
    const east = await seedQuake({ primaryKey: 'fj-e', centroid: { lat: -18.14, lon: -178.5 } });
    await seedQuake({ primaryKey: 'mar' });

    const { body } = await mapAt(FIJI);
    expect(body.features.map((feature) => feature.publicId).sort()).toStrictEqual(
      [west.publicId, east.publicId].sort(),
    );
    expect(body.bboxParts).toHaveLength(2);
  });

  it('does not show a record ingested after the requested knowledge time (I2)', async () => {
    await seedQuake({ primaryKey: 'later', ingestedAt: ago(5) });
    const { body } = await mapAt(`${MOROCCO}&as_of=${ago(10).toISOString()}`);
    expect(body.features).toStrictEqual([]);
    expect(body.total).toBe(0);
    const { body: now } = await mapAt(MOROCCO);
    expect(now.total).toBe(1);
  });

  it('draws only the requested families, and reports them in canonical order', async () => {
    await seedQuake({ primaryKey: 'us-fam' });
    await seedCluster();
    const { body } = await mapAt(`${MOROCCO}&families=FIRE_ACTIVITY&families=EARTHQUAKES`);
    expect(body.families).toStrictEqual(['EARTHQUAKES', 'FIRE_ACTIVITY']);
    const { body: fires } = await mapAt(`${MOROCCO}&families=FIRE_ACTIVITY`);
    expect(fires.features.map((feature) => feature.kind)).toStrictEqual(['fire_cluster']);
  });

  it('resolves every primary citation on the map through /evidence at the same knowledge time', async () => {
    await seedQuake({ primaryKey: 'us-cite' });
    await seedCluster();
    const asOf = NOW.toISOString();
    const { body } = await mapAt(`${MOROCCO}&as_of=${asOf}`);

    const cited = body.features.flatMap((feature) => feature.evidenceIds);
    const primary = cited.filter((id) => !id.startsWith('EV:FDS:'));
    expect(primary.map((id) => id.split(':')[1]).sort()).toStrictEqual(['COR', 'FCV', 'OBS']);
    for (const id of primary) {
      const response = await evidence(request(`/api/v1/evidence/${id}?as_of=${asOf}`));
      expect(response.status, id).toBe(200);
    }
  });

  it('carries §13.1s two-minute cache policy and the security headers', async () => {
    const { response } = await mapAt(MOROCCO);
    expect(response.headers.get('cache-control')).toBe('s-maxage=120, stale-while-revalidate=600');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // A replay gets the same policy: §13.1 gives this endpoint no replay row.
    const { response: replay } = await mapAt(`${MOROCCO}&as_of=${ago(120).toISOString()}`);
    expect(replay.headers.get('cache-control')).toBe('s-maxage=120, stale-while-revalidate=600');
  });
});

describe('GET /api/v1/events: the horizon is judged per requested family', () => {
  it('refuses a knowledge time past fire activity’s horizon, naming only that family', async () => {
    const fiveDaysAgo = ago(5 * 24 * 60).toISOString();
    const problem = await problemAt(`${MOROCCO}&as_of=${fiveDaysAgo}`);
    expect(problem.code).toBe('AS_OF_BEFORE_HORIZON');
    expect(problem.affectedFamilies).toStrictEqual(['FIRE_ACTIVITY']);
    expect(problem.earliestAsOf).not.toBeNull();
    // The earliest time from which the request *as asked* can be answered: fire's horizon.
    expect(Date.parse(problem.earliestAsOf ?? '')).toBeGreaterThan(Date.parse(fiveDaysAgo));
  });

  it('answers the same knowledge time once fire activity is not requested', async () => {
    const fiveDaysAgo = ago(5 * 24 * 60).toISOString();
    const { body } = await mapAt(`${MOROCCO}&as_of=${fiveDaysAgo}&families=EARTHQUAKES`);
    expect(body.families).toStrictEqual(['EARTHQUAKES']);
  });

  it('names every requested family that is past its horizon, and the latest of their horizons', async () => {
    const fortyDaysAgo = ago(40 * 24 * 60).toISOString();
    const problem = await problemAt(
      `${MOROCCO}&as_of=${fortyDaysAgo}&families=EARTHQUAKES,FIRE_ACTIVITY,FLOODS`,
    );
    expect(problem.affectedFamilies).toStrictEqual(['EARTHQUAKES', 'FIRE_ACTIVITY']);
    // Fire's three days is the later of the two horizons, so it is the time to ask from.
    const threeDaysAgo = ago(3 * 24 * 60).getTime();
    expect(Math.abs(Date.parse(problem.earliestAsOf ?? '') - threeDaysAgo)).toBeLessThan(
      5 * 60_000,
    );
  });

  it('refuses a future knowledge time', async () => {
    const problem = await problemAt(`${MOROCCO}&as_of=2099-01-01T00:00:00Z`);
    expect(problem.code).toBe('AS_OF_IN_FUTURE');
  });
});

describe('GET /api/v1/events: validation', () => {
  it.each([
    ['no bbox', 'zoom=6', 'VALIDATION_FAILED'],
    ['no zoom', 'bbox=-11.25,28.125,-5.625,33.75', 'VALIDATION_FAILED'],
    ['an edge off the grid', 'bbox=-8.07,28.125,-5.625,33.75&zoom=6', 'VALIDATION_FAILED'],
    ['a box too large for its zoom', 'bbox=-45,0,22.5,45&zoom=2', 'BBOX_TOO_LARGE'],
    ['an unknown parameter', `${MOROCCO}&cachebust=1`, 'UNKNOWN_PARAMETER'],
    ['a repeated bbox', `${MOROCCO}&bbox=-11.25,28.125,-5.625,33.75`, 'VALIDATION_FAILED'],
    ['an unknown family', `${MOROCCO}&families=TORNADOES`, 'VALIDATION_FAILED'],
  ])('refuses %s', async (_label, query, code) => {
    const problem = await problemAt(query);
    expect(problem.code).toBe(code);
    expect(problem.status).toBe(400);
  });

  it('never echoes a rejected viewport', async () => {
    const response = await events(request('/api/v1/events?bbox=-8.0712,31.5890,-7.9,31.7&zoom=6'));
    const text = await response.text();
    expect(text).not.toContain('8.0712');
    expect(text).not.toContain('31.589');
  });

  it('is read-only', async () => {
    const response = await events(request(`/api/v1/events?${MOROCCO}`, { method: 'POST' }));
    expect(response.status).toBe(405);
  });
});
