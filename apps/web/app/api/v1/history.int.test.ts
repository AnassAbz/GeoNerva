/**
 * `GET /api/v1/history` through the HTTP boundary.
 *
 * The builder has its own tests; these are about what only the adapter can get wrong — the
 * parameters §13.1 allows (and `as_of`, which it does not), the location forms, the cache policy,
 * and the whole document against its contract. Anchored to the wall clock, because §13.1 gives
 * this endpoint no `as_of` and so the answer is always for the present.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadWebConfig } from '@geonerva/config';
import { createCanonicalEvent, createDb, linkRecord, type DB } from '@geonerva/db';
import type { DatabaseHandle } from '@geonerva/db/client';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation, seedRun } from '@geonerva/db/testing/factories';
import { PROBLEM_MEDIA_TYPE, historyResponseSchema, problemDetailsSchema } from '@geonerva/domain';

import { CACHE_POLICIES } from '../../../lib/server/cache.ts';
import { setWebConfigForTesting } from '../../../lib/server/config.ts';
import { setDatabaseForTesting } from '../../../lib/server/db.ts';
import { GET as historyRoute } from './history/route.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const LAT = 31.63;
const LON = -7.98;

const TEST_CONFIG = loadWebConfig({
  DATABASE_URL: 'postgresql://web:pw@127.0.0.1:54320/geonerva_test',
  RATE_LIMIT_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // gitleaks:allow
  NOMINATIM_CONTACT: 'https://example.org/geonerva-contact',
});

let callerIndex = 0;
function request(path: string): Request {
  callerIndex += 1;
  return new Request(`https://geonerva.test${path}`, {
    headers: new Headers({ 'x-forwarded-for': `203.4.${String(callerIndex % 250)}.42` }),
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

async function earthquakesRead(): Promise<void> {
  // Coverage the baseline can trust: a completed backfill of the last 62 weeks, then live polling.
  await sql`
    WITH plan AS (
      INSERT INTO geonerva.backfill_plans
        (id, source_id, mode, range_from, range_to, window_ms, min_window_ms, status, finished_at)
      VALUES (gen_random_uuid(), 'usgs', 'HISTORICAL', ${daysAgo(62 * 7)}, ${daysAgo(0.01)},
              ${DAY}, ${DAY}, 'COMPLETED', ${daysAgo(0.01)})
      RETURNING id
    )
    INSERT INTO geonerva.backfill_intervals (plan_id, interval_from, interval_to, status, completed_at)
    SELECT id, ${daysAgo(62 * 7)}, ${daysAgo(0.01)}, 'DONE', ${daysAgo(0.01)} FROM plan
  `.execute(db);
  await seedRun(db, { sourceId: 'usgs', status: 'SUCCEEDED', startedAt: daysAgo(0.01) });
  await sql`
    INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
    VALUES (gen_random_uuid(), 'CORRELATION', 'geonerva-1', ${daysAgo(0.01)}, ${daysAgo(0.01)}, 'SUCCEEDED')
  `.execute(db);
}

async function quake(observedAt: Date, primaryKey: string): Promise<void> {
  const ingestedAt = new Date(observedAt.getTime() + 60_000);
  const seeded = await seedObservation(db, {
    sourceId: 'usgs',
    primaryKey,
    ingestedAt,
    observedAt,
    centroid: { lat: LAT + 0.2, lon: LON },
    magnitude: 5.0,
    depthKm: 10,
  });
  const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: ingestedAt });
  await db.transaction().execute((trx) =>
    linkRecord(trx, {
      canonicalEventId: event.id,
      sourceRecordId: seeded.sourceRecordId,
      relation: 'PRIMARY',
      matchKind: 'SEED',
      algorithmVersion: 'test-1',
      linkedAt: ingestedAt,
    }),
  );
}

async function problemOf(
  response: Response,
): Promise<ReturnType<typeof problemDetailsSchema.parse>> {
  expect(response.headers.get('content-type')).toContain(PROBLEM_MEDIA_TYPE);
  const body = problemDetailsSchema.strict().parse(await response.json());
  expect(body.status).toBe(response.status);
  return body;
}

describe('GET /api/v1/history', () => {
  it('serves a baseline for the present that satisfies its contract, cached for an hour', async () => {
    await earthquakesRead();
    for (let week = 1; week <= 60; week += 1)
      await quake(daysAgo(7 * week + 3), `ref${String(week)}`);
    await quake(daysAgo(1), 'current');

    const response = await historyRoute(
      request(`/api/v1/history?lat=${String(LAT)}&lon=${String(LON)}&family=EARTHQUAKES`),
    );
    const raw = await response.text();
    expect(response.status, raw.slice(0, 300)).toBe(200);
    expect(response.headers.get('cache-control')).toBe(CACHE_POLICIES.history);

    const body = historyResponseSchema.parse(JSON.parse(raw));
    expect(body.metricCode).toBe('EQ_COUNT_7D');
    expect(body.metric.status).toBe('OK');
    expect(body.metric.params).toMatchObject({ radiusKm: 150, windowDays: 7 });
    expect(body.metric.observedValue).toEqual({ kind: 'count', value: 1 });
    expect(body.location).toMatchObject({ lat: LAT, lon: LON });
    expect(body.asOfContext.isReplay).toBe(false);
  });

  it('passes the metric and radius through', async () => {
    await earthquakesRead();
    const response = await historyRoute(
      request(
        `/api/v1/history?lat=${String(LAT)}&lon=${String(LON)}&family=EARTHQUAKES&metric=EQ_COUNT_30D&radius_km=300`,
      ),
    );
    expect(response.status).toBe(200);
    const body = historyResponseSchema.parse(await response.json());
    expect(body.metricCode).toBe('EQ_COUNT_30D');
    expect(body.metric.params).toMatchObject({ radiusKm: 300, windowDays: 30 });
  });

  it('answers a family with no inputs honestly rather than with a zero', async () => {
    const response = await historyRoute(
      request(`/api/v1/history?lat=${String(LAT)}&lon=${String(LON)}&family=FIRE_ACTIVITY`),
    );
    expect(response.status).toBe(200);
    const body = historyResponseSchema.parse(await response.json());
    expect(body.metric.status).toBe('INSUFFICIENT_COVERAGE');
    expect(body.metric.observedValue.kind).toBe('unavailable');
  });

  it('refuses as_of, which §13.1 does not give this endpoint', async () => {
    const response = await historyRoute(
      request(
        `/api/v1/history?lat=${String(LAT)}&lon=${String(LON)}&family=EARTHQUAKES&as_of=${NOW.toISOString()}`,
      ),
    );
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('UNKNOWN_PARAMETER');
  });

  it('refuses a missing family and an uncalibrated radius', async () => {
    const noFamily = await historyRoute(
      request(`/api/v1/history?lat=${String(LAT)}&lon=${String(LON)}`),
    );
    expect(noFamily.status).toBe(400);
    expect((await problemOf(noFamily)).invalidParams[0]?.name).toBe('family');

    const badRadius = await historyRoute(
      request(
        `/api/v1/history?lat=${String(LAT)}&lon=${String(LON)}&family=EARTHQUAKES&radius_km=100`,
      ),
    );
    expect(badRadius.status).toBe(400);
    expect((await problemOf(badRadius)).invalidParams[0]?.name).toBe('radius_km');
  });

  it('refuses a precise coordinate without echoing it (I15)', async () => {
    const response = await historyRoute(
      request('/api/v1/history?lat=31.629512&lon=-7.981084&family=EARTHQUAKES'),
    );
    const raw = await response.text();
    expect(response.status).toBe(400);
    expect(raw).not.toContain('629512');
  });

  it('answers an unknown place as not found', async () => {
    const response = await historyRoute(
      request('/api/v1/history?place=p:99999999&family=EARTHQUAKES'),
    );
    expect(response.status).toBe(404);
    expect((await problemOf(response)).code).toBe('LOCATION_NOT_FOUND');
  });
});
