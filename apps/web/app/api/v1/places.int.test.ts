/**
 * The place endpoints through the HTTP boundary, with a **recording fake geocoder**.
 *
 * No test here reaches Nominatim. The fake counts every call, so the obligations that protect
 * GeoNerva's standing with the provider are asserted as counts: type-ahead makes none, a cache hit
 * makes none, a refused request makes none, and a failed call is not cached.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadWebConfig } from '@geonerva/config';
import { createDb, upsertPlaces, type DB } from '@geonerva/db';
import type { DatabaseHandle } from '@geonerva/db/client';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import {
  PROBLEM_MEDIA_TYPE,
  locationBriefingSchema,
  placeSearchResponseSchema,
  placeSuggestResponseSchema,
  problemDetailsSchema,
  type LatLon,
} from '@geonerva/domain';
import {
  GeocoderError,
  searchCacheKey,
  type GeocodeResult,
  type Geocoder,
} from '@geonerva/geocoding';

import { setWebConfigForTesting } from '../../../lib/server/config.ts';
import { setDatabaseForTesting } from '../../../lib/server/db.ts';
import { setGeocoderForTesting } from '../../../lib/server/geocoder.ts';
import { GEONAMES_FIXTURE } from '../../../../../scripts/lib/geonames-fixture.ts';
import { parseGeonames } from '../../../../../scripts/lib/geonames.ts';
import { GET as briefing } from './briefing/route.ts';
import { GET as reverse } from './places/reverse/route.ts';
import { GET as search } from './places/search/route.ts';
import { GET as suggest } from './places/suggest/route.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const TEST_CONFIG = loadWebConfig({
  DATABASE_URL: 'postgresql://web:pw@127.0.0.1:54320/geonerva_test',
  RATE_LIMIT_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // gitleaks:allow
  NOMINATIM_CONTACT: 'https://example.org/geonerva-contact',
});

const MARRAKECH_RESULT: GeocodeResult = {
  osmType: 'R',
  osmId: '2799538',
  label: 'Marrakech, Maroc',
  countryCode: 'MA',
  admin1: 'Marrakech-Safi',
  lat: 31.63,
  lon: -7.99,
  kind: 'city',
};

/** A geocoder that records every call and answers from a script. */
class FakeGeocoder implements Geocoder {
  readonly provider = 'fake';
  readonly searches: string[] = [];
  readonly reverses: LatLon[] = [];
  failWith: GeocoderError | null = null;
  answer: readonly GeocodeResult[] = [MARRAKECH_RESULT];

  search(query: string): Promise<readonly GeocodeResult[]> {
    this.searches.push(query);
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return Promise.resolve(this.answer);
  }

  reverse(point: LatLon): Promise<GeocodeResult | null> {
    this.reverses.push(point);
    if (this.failWith !== null) return Promise.reject(this.failWith);
    return Promise.resolve(this.answer[0] ?? null);
  }
}

let fake: FakeGeocoder;

let callerIndex = 0;
function request(path: string, caller?: string): Request {
  callerIndex += 1;
  return new Request(`https://geonerva.test${path}`, {
    headers: new Headers({
      'x-forwarded-for': caller ?? `203.4.${String(callerIndex % 250)}.42`,
    }),
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
  setGeocoderForTesting(null);
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
  await sql`TRUNCATE geonerva.places, geonerva.geocode_cache`.execute(db);
  await upsertPlaces(db, parseGeonames(GEONAMES_FIXTURE).places);
  fake = new FakeGeocoder();
  setGeocoderForTesting(fake);
});

async function problemOf(
  response: Response,
): Promise<ReturnType<typeof problemDetailsSchema.parse>> {
  expect(response.headers.get('content-type')).toContain(PROBLEM_MEDIA_TYPE);
  const body = problemDetailsSchema.strict().parse(await response.json());
  expect(body.status).toBe(response.status);
  return body;
}

describe('GET /api/v1/places/suggest', () => {
  it('finds Marrakesh by "Marrakech", from the local table, calling no provider', async () => {
    const response = await suggest(request('/api/v1/places/suggest?q=Marrakech'));
    const raw = await response.text();
    expect(response.status, raw.slice(0, 300)).toBe(200);
    const body = placeSuggestResponseSchema.strict().parse(JSON.parse(raw));
    expect(body.suggestions[0]).toMatchObject({
      key: 'p:2542997',
      label: 'Marrakesh, MA',
      timezone: 'Africa/Casablanca',
    });
    expect(body.attribution.map((entry) => entry.sourceId)).toStrictEqual(['geonames']);
    expect(response.headers.get('cache-control')).toBe(
      's-maxage=86400, stale-while-revalidate=86400',
    );
    expect(fake.searches).toStrictEqual([]);
    expect(fake.reverses).toStrictEqual([]);
  });

  it('honours the limit and refuses one above ten', async () => {
    const one = placeSuggestResponseSchema.parse(
      await (await suggest(request('/api/v1/places/suggest?q=pa&limit=1'))).json(),
    );
    expect(one.suggestions).toHaveLength(1);
    expect(
      (await problemOf(await suggest(request('/api/v1/places/suggest?q=pa&limit=11')))).code,
    ).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['a one-letter query', '/api/v1/places/suggest?q=p'],
    ['no query', '/api/v1/places/suggest'],
    ['an unknown parameter', '/api/v1/places/suggest?q=paris&country=FR'],
  ])('refuses %s', async (_label, path) => {
    expect((await suggest(request(path))).status).toBe(400);
  });
});

describe('GET /api/v1/places/search', () => {
  it('calls the provider once, then answers the same question from the cache', async () => {
    const first = await search(request('/api/v1/places/search?q=Marrakech'));
    const firstBody = placeSearchResponseSchema.strict().parse(await first.json());
    expect(firstBody.fromCache).toBe(false);
    expect(firstBody.results[0]).toMatchObject({
      key: 'n:R2799538',
      lat: 31.63,
      lon: -7.99,
      timezone: 'Africa/Casablanca',
    });
    expect(firstBody.attribution.map((entry) => entry.sourceId)).toStrictEqual(['nominatim']);

    // Another spelling of the same question.
    const second = placeSearchResponseSchema.parse(
      await (await search(request('/api/v1/places/search?q=%20MARRAKECH%20'))).json(),
    );
    expect(second.fromCache).toBe(true);
    expect(second.results).toStrictEqual(firstBody.results);
    expect(fake.searches).toStrictEqual(['Marrakech']);
  });

  it('treats a cache row it cannot read as a miss, never serving it', async () => {
    // A row an earlier version wrote in another shape — or one someone edited by hand.
    await sql`
      INSERT INTO geonerva.geocode_cache (query_sha256, provider, response, created_at, expires_at)
      VALUES (${searchCacheKey('Marrakech')}, 'nominatim', '[{"osmType":"X","label":42}]'::jsonb,
              now(), now() + interval '1 day')
    `.execute(db);
    const body = placeSearchResponseSchema.parse(
      await (await search(request('/api/v1/places/search?q=Marrakech'))).json(),
    );
    expect(body.fromCache).toBe(false);
    expect(body.results[0]?.key).toBe('n:R2799538');
    expect(fake.searches).toStrictEqual(['Marrakech']);
  });

  it('caches an empty answer, so a repeated typo does not reach the provider again', async () => {
    fake.answer = [];
    await search(request('/api/v1/places/search?q=zzqxv'));
    const again = placeSearchResponseSchema.parse(
      await (await search(request('/api/v1/places/search?q=zzqxv'))).json(),
    );
    expect(again).toMatchObject({ results: [], fromCache: true });
    expect(fake.searches).toHaveLength(1);
  });

  it('answers a provider failure with 503, and does not cache it', async () => {
    fake.failWith = new GeocoderError('RATE_LIMITED', 'throttled');
    const failed = await search(request('/api/v1/places/search?q=Montreal'));
    expect(failed.status).toBe(503);
    const problem = await problemOf(failed);
    expect(problem.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(problem.retryAfterS).toBe(60);

    fake.failWith = null;
    // The failed call reached the provider, so it spent this second's global budget; the retry
    // waits for the next window rather than being refused by the ceiling it is not testing.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const recovered = placeSearchResponseSchema.parse(
      await (await search(request('/api/v1/places/search?q=Montreal'))).json(),
    );
    expect(recovered.fromCache).toBe(false);
    expect(fake.searches).toHaveLength(2);
  });

  it('holds the provider to one call per second across all callers', async () => {
    /*
     * Distinct queries, so every one is a cache miss, each from its own caller so no per-key limit
     * interferes. The loop stops at the first refusal instead of assuming two requests land in the
     * same second — a window can roll over between any two of them.
     */
    let refused = 0;
    let sent = 0;
    for (let index = 0; index < 20 && refused === 0; index += 1) {
      const response = await search(
        request(`/api/v1/places/search?q=town${String(index)}`, `198.51.${String(index)}.7`),
      );
      sent += 1;
      if (response.status === 429) refused += 1;
    }
    expect(refused).toBe(1);
    // Every allowed request made exactly one provider call, and the refused one made none.
    expect(fake.searches).toHaveLength(sent - 1);
  });

  it('limits one caller to ten searches a minute, cache hits included', async () => {
    const caller = '192.0.2.99';
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      statuses.push((await search(request('/api/v1/places/search?q=Marrakech', caller))).status);
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(1);
    expect(fake.searches.length).toBeLessThanOrEqual(1);
  });

  it('never echoes the query into an error', async () => {
    fake.failWith = new GeocoderError('UNAVAILABLE', 'down');
    const response = await search(request('/api/v1/places/search?q=12%20Rue%20Secrete'));
    expect(await response.text()).not.toContain('Secrete');
  });
});

describe('GET /api/v1/places/reverse', () => {
  it('labels a rounded cell, keyed by that cell, and caches the answer', async () => {
    const first = placeSearchResponseSchema
      .strict()
      .parse(await (await reverse(request('/api/v1/places/reverse?lat=31.63&lon=-8'))).json());
    expect(first).toMatchObject({ query: '31.63,-8.00', fromCache: false });
    expect(first.results[0]).toMatchObject({
      key: 'c:31.63,-8.00',
      label: 'Marrakech, Maroc',
      lat: 31.63,
      lon: -8,
    });
    const second = placeSearchResponseSchema.parse(
      await (await reverse(request('/api/v1/places/reverse?lat=31.63&lon=-8.00'))).json(),
    );
    expect(second.fromCache).toBe(true);
    expect(fake.reverses).toStrictEqual([{ lat: 31.63, lon: -8 }]);
  });

  it('calls no provider when it cannot count against the global ceiling', async () => {
    /*
     * The ceiling fails closed: with its counter table unavailable, the provider must not be
     * called. `/places/reverse`'s own per-caller limit fails open, so the request does reach the
     * ceiling — which is the rule under test.
     */
    await sql`ALTER TABLE geonerva.rate_limit_buckets RENAME TO rate_limit_buckets_away`.execute(
      db,
    );
    try {
      const response = await reverse(request('/api/v1/places/reverse?lat=31.63&lon=-8'));
      expect(response.status).toBe(503);
      expect((await problemOf(response)).code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      await sql`ALTER TABLE geonerva.rate_limit_buckets_away RENAME TO rate_limit_buckets`.execute(
        db,
      );
    }
    expect(fake.reverses).toStrictEqual([]);
  });

  it('refuses a precise coordinate without calling anyone', async () => {
    const response = await reverse(request('/api/v1/places/reverse?lat=31.6295&lon=-8.0081'));
    expect((await problemOf(response)).code).toBe('VALIDATION_FAILED');
    expect(fake.reverses).toStrictEqual([]);
  });

  it('answers a point with nothing there as no results, and caches that', async () => {
    fake.answer = [];
    await reverse(request('/api/v1/places/reverse?lat=0&lon=-30'));
    const again = placeSearchResponseSchema.parse(
      await (await reverse(request('/api/v1/places/reverse?lat=0&lon=-30'))).json(),
    );
    expect(again).toMatchObject({ results: [], fromCache: true });
    expect(fake.reverses).toHaveLength(1);
  });

  it('holds one caller to ten provider calls a minute, so it cannot hold the global ceiling alone', async () => {
    /*
     * Reverse is metered at the 120/min default, but every miss spends the deployment's single
     * Nominatim call per second. Eleven fresh cells from one caller, a second apart so the global
     * ceiling is never what refuses: the eleventh is refused by the caller's own miss budget, and
     * the provider saw ten.
     */
    const caller = '192.0.2.150';
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1_050));
      const lat = (10 + index).toFixed(2);
      statuses.push(
        (await reverse(request(`/api/v1/places/reverse?lat=${lat}&lon=20`, caller))).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(fake.reverses).toHaveLength(10);

    // A cached cell costs the caller nothing, and another caller is unaffected.
    expect((await reverse(request('/api/v1/places/reverse?lat=10.00&lon=20', caller))).status).toBe(
      200,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect((await reverse(request('/api/v1/places/reverse?lat=40.00&lon=20'))).status).toBe(200);
  }, 30_000);
});

describe('a p: key in a briefing', () => {
  it('resolves to the GeoNames place, rounded', async () => {
    const response = await briefing(request('/api/v1/briefing?place=p:2542997'));
    const raw = await response.text();
    expect(response.status, raw.slice(0, 300)).toBe(200);
    const body = locationBriefingSchema.parse(JSON.parse(raw));
    expect(body.location).toMatchObject({
      key: 'p:2542997',
      label: 'Marrakesh',
      lat: 31.63,
      lon: -8,
      timezone: 'Africa/Casablanca',
    });
  });

  it('answers an id that is not loaded as LOCATION_NOT_FOUND', async () => {
    const problem = await problemOf(await briefing(request('/api/v1/briefing?place=p:1')));
    expect(problem.code).toBe('LOCATION_NOT_FOUND');
  });
});
