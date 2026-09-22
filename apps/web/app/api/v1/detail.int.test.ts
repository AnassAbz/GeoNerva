/**
 * `GET /api/v1/events/{publicId}` and `GET /api/v1/fire-clusters/{publicId}` through the HTTP
 * boundary.
 *
 * The builders have their own tests; these are about what only an adapter can get wrong — the
 * path segment, the parameters §13.1 allows, the merge redirect, the horizon judged from the id's
 * own family, the cache policy, and the whole document against its contract. Anchored to the wall
 * clock, for the reason `events.int.test.ts` gives.
 */

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadWebConfig } from '@geonerva/config';
import {
  createCanonicalEvent,
  createCluster,
  createDb,
  insertClusterVersionIfChanged,
  linkRecord,
  mergeCanonicalEvents,
  mergeClusters,
  type DB,
} from '@geonerva/db';
import type { DatabaseHandle } from '@geonerva/db/client';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { contentHash, seedObservation, stableUuid } from '@geonerva/db/testing/factories';
import {
  PROBLEM_MEDIA_TYPE,
  eventDetailSchema,
  fireClusterDetailSchema,
  problemDetailsSchema,
} from '@geonerva/domain';

import { setWebConfigForTesting } from '../../../lib/server/config.ts';
import { setDatabaseForTesting } from '../../../lib/server/db.ts';
import { GET as eventDetail } from './events/[publicId]/route.ts';
import { GET as evidence } from './evidence/[id]/route.ts';
import { GET as fireClusterDetail } from './fire-clusters/[publicId]/route.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
const ago = (minutesAgo: number): Date => new Date(NOW.getTime() - minutesAgo * 60_000);

const TEST_CONFIG = loadWebConfig({
  DATABASE_URL: 'postgresql://web:pw@127.0.0.1:54320/geonerva_test',
  RATE_LIMIT_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // gitleaks:allow
  NOMINATIM_CONTACT: 'https://example.org/geonerva-contact',
});

let callerIndex = 0;
function request(path: string, init?: RequestInit): Request {
  callerIndex += 1;
  return new Request(`https://geonerva.test${path}`, {
    headers: new Headers({ 'x-forwarded-for': `203.3.${String(callerIndex % 250)}.42` }),
    ...init,
  });
}

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
  const handle: DatabaseHandle = {
    db,
    pool: testDb.pool,
    target: 'test',
    close: () => Promise.resolve(),
  };
  setDatabaseForTesting(handle);
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

async function seedEvent(primaryKey: string): Promise<{ id: string; publicId: string }> {
  const at = ago(20);
  const record = await seedObservation(db, {
    primaryKey,
    ingestedAt: at,
    observedAt: at,
    centroid: { lat: 31.1, lon: -8.4 },
    magnitude: 5.4,
    providerStatus: 'reviewed',
  });
  const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: at });
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
  return event;
}

async function seedCluster(label: string, publicId: string): Promise<string> {
  const id = stableUuid(label);
  await createCluster(db, { id, publicId, createdAt: ago(120), status: 'ACTIVE' });
  await insertClusterVersionIfChanged(db, {
    clusterId: id,
    asOf: ago(30),
    nTotal: 4,
    n24h: 4,
    overpasses24h: 1,
    firstDetectedAt: ago(120),
    lastDetectedAt: ago(40),
    frpSum24h: 8,
    frpMax: 4,
    maxConfidence: 'HIGH',
    productIds: [1],
    hullGeoJson: null,
    centroid: { lat: 31.4, lon: -8.4 },
    status: 'ACTIVE',
    contentSha256: contentHash(label),
  });
  return id;
}

async function problemOf(
  response: Response,
): Promise<ReturnType<typeof problemDetailsSchema.parse>> {
  expect(response.headers.get('content-type')).toContain(PROBLEM_MEDIA_TYPE);
  const body = problemDetailsSchema.strict().parse(await response.json());
  expect(body.status).toBe(response.status);
  return body;
}

describe('GET /api/v1/events/{publicId}', () => {
  it('serves the frozen contract with nothing undeclared, cached for two minutes', async () => {
    const event = await seedEvent('us-http-detail');
    const response = await eventDetail(request(`/api/v1/events/${event.publicId}`));
    const raw = await response.text();
    expect(response.status, raw.slice(0, 300)).toBe(200);
    expect(() => eventDetailSchema.strict().parse(JSON.parse(raw))).not.toThrow();
    expect(response.headers.get('cache-control')).toBe('s-maxage=120, stale-while-revalidate=600');
    const keys = [...raw.matchAll(/"([A-Za-z0-9_]+)":/gu)].map((match) => match[1] ?? '');
    expect(keys.filter((key) => /^[a-z0-9]+(?:_[a-z0-9]+)+$/u.test(key))).toStrictEqual([]);
  });

  it('adds relevance for a rounded location, and refuses a precise one', async () => {
    const event = await seedEvent('us-http-rel');
    const withLocation = await eventDetail(
      request(`/api/v1/events/${event.publicId}?lat=31.63&lon=-8`),
    );
    const body = eventDetailSchema.parse(await withLocation.json());
    expect(body.relevance).not.toBeNull();
    const precise = await eventDetail(
      request(`/api/v1/events/${event.publicId}?lat=31.6295&lon=-8.0081`),
    );
    expect((await problemOf(precise)).code).toBe('VALIDATION_FAILED');
  });

  it('redirects a merged id to its survivor, keeping the query', async () => {
    const survivor = await seedEvent('us-survivor');
    const absorbed = await seedEvent('us-absorbed');
    await db.transaction().execute((trx) =>
      mergeCanonicalEvents(trx, {
        survivorId: survivor.id,
        absorbedIds: [absorbed.id],
        mergedAt: ago(10),
        algorithmVersion: 'test-1',
      }),
    );
    const asOf = ago(1).toISOString();
    const response = await eventDetail(
      request(`/api/v1/events/${absorbed.publicId}?as_of=${asOf}`),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(
      `/api/v1/events/${survivor.publicId}?as_of=${asOf}`,
    );
    // Before the merge the absorbed id is still an event of its own.
    const before = await eventDetail(
      request(`/api/v1/events/${absorbed.publicId}?as_of=${ago(15).toISOString()}`),
    );
    expect(before.status).toBe(200);
  });

  it('resolves every primary citation it makes through /evidence at the same knowledge time', async () => {
    const event = await seedEvent('us-http-cite');
    const asOf = NOW.toISOString();
    const body = eventDetailSchema.parse(
      await (await eventDetail(request(`/api/v1/events/${event.publicId}?as_of=${asOf}`))).json(),
    );
    const primary = body.evidenceManifest.filter((item) => item.resolvable).map((item) => item.id);
    expect(primary.length).toBeGreaterThan(0);
    for (const id of primary) {
      expect((await evidence(request(`/api/v1/evidence/${id}?as_of=${asOf}`))).status, id).toBe(
        200,
      );
    }
  });

  it.each([
    ['a fire-cluster id', '/api/v1/events/FR-26-7K3F9Q', 400],
    ['a malformed id', '/api/v1/events/nonsense', 400],
    ['an undecodable segment', '/api/v1/events/%ZZ', 400],
    ['an unknown parameter', '/api/v1/events/EQ-26-7K3F9Q?place=p:1', 400],
    ['an id GeoNerva never issued', '/api/v1/events/EQ-26-7K3F9Q', 404],
  ])('answers %s with a problem document', async (_label, path, status) => {
    const response = await eventDetail(request(path));
    expect(response.status).toBe(status);
    await problemOf(response);
  });

  it('refuses a knowledge time past its own family’s horizon', async () => {
    const event = await seedEvent('us-http-horizon');
    const response = await eventDetail(
      request(`/api/v1/events/${event.publicId}?as_of=${ago(40 * 24 * 60).toISOString()}`),
    );
    const problem = await problemOf(response);
    expect(problem.code).toBe('AS_OF_BEFORE_HORIZON');
    expect(problem.affectedFamilies).toStrictEqual(['EARTHQUAKES']);
  });

  it('is read-only', async () => {
    const response = await eventDetail(
      request('/api/v1/events/EQ-26-7K3F9Q', { method: 'DELETE' }),
    );
    expect(response.status).toBe(405);
  });
});

describe('GET /api/v1/fire-clusters/{publicId}', () => {
  it('serves the frozen contract with nothing undeclared, cached for five minutes', async () => {
    await seedCluster('http-fc', 'FR-26-AAAAAA');
    const response = await fireClusterDetail(request('/api/v1/fire-clusters/FR-26-AAAAAA'));
    const raw = await response.text();
    expect(response.status, raw.slice(0, 300)).toBe(200);
    const body = fireClusterDetailSchema.strict().parse(JSON.parse(raw));
    expect(body.mandatoryCaveat).toContain('not confirmed wildfires');
    expect(response.headers.get('cache-control')).toBe('s-maxage=300, stale-while-revalidate=600');
  });

  it('takes no location: §13.1 gives it none', async () => {
    await seedCluster('http-fc-loc', 'FR-26-BBBBBB');
    const response = await fireClusterDetail(
      request('/api/v1/fire-clusters/FR-26-BBBBBB?lat=31.63&lon=-8'),
    );
    expect((await problemOf(response)).code).toBe('UNKNOWN_PARAMETER');
  });

  it('redirects a merged cluster to its survivor', async () => {
    const survivor = await seedCluster('http-fc-s', 'FR-26-CCCCCC');
    const absorbed = await seedCluster('http-fc-a', 'FR-26-DDDDDD');
    await db.transaction().execute((trx) => mergeClusters(trx, survivor, [absorbed], ago(10)));
    const response = await fireClusterDetail(request('/api/v1/fire-clusters/FR-26-DDDDDD'));
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/api/v1/fire-clusters/FR-26-CCCCCC');
  });

  it('refuses a knowledge time past fire activity’s three-day horizon', async () => {
    await seedCluster('http-fc-h', 'FR-26-EEEEEE');
    const response = await fireClusterDetail(
      request(`/api/v1/fire-clusters/FR-26-EEEEEE?as_of=${ago(5 * 24 * 60).toISOString()}`),
    );
    const problem = await problemOf(response);
    expect(problem.code).toBe('AS_OF_BEFORE_HORIZON');
    expect(problem.affectedFamilies).toStrictEqual(['FIRE_ACTIVITY']);
  });

  it.each([
    ['an event id', '/api/v1/fire-clusters/EQ-26-7K3F9Q', 400],
    ['an id GeoNerva never issued', '/api/v1/fire-clusters/FR-26-7K3F9Q', 404],
  ])('answers %s with a problem document', async (_label, path, status) => {
    const response = await fireClusterDetail(request(path));
    expect(response.status).toBe(status);
    await problemOf(response);
  });
});
