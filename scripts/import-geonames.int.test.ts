/**
 * The GeoNames import and the place reads, against real PostgreSQL with `pg_trgm`.
 *
 * Type-ahead is judged by what a person types: "Marrakech" must find Marrakesh, "Montreal" must
 * find Montréal, a `%` must not match every city in the table, and an exact name must not be
 * buried under a larger town that merely starts the same way.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, upsertPlaces, type DB } from '@geonerva/db';
import {
  cachedGeocodeResult,
  nearestPlaceTimezone,
  placeByGeonameId,
  storeGeocodeResult,
  suggestPlaces,
} from '@geonerva/db/places';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';

import { GEONAMES_FIXTURE } from './lib/geonames-fixture.ts';
import { parseGeonames } from './lib/geonames.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
  await sql`TRUNCATE geonerva.places, geonerva.geocode_cache`.execute(db);
});

async function load(): Promise<number> {
  return await upsertPlaces(db, parseGeonames(GEONAMES_FIXTURE).places);
}

async function names(query: string, limit = 10): Promise<string[]> {
  return (await suggestPlaces(db, { query, limit })).map((row) => row.name);
}

describe('the import', () => {
  it('writes every parsed place, and a second run changes nothing', async () => {
    expect(await load()).toBe(7);
    await load();
    const count = await sql<{ n: number }>`SELECT count(*)::int AS n FROM geonerva.places`.execute(
      db,
    );
    expect(count.rows[0]?.n).toBe(7);
    expect((await placeByGeonameId(db, 2542997))?.timezone).toBe('Africa/Casablanca');
  });
});

describe('a newer file', () => {
  it('updates a place it already holds', async () => {
    await load();
    const newer = parseGeonames(GEONAMES_FIXTURE).places.map((place) =>
      place.geonameid === 2542997 ? { ...place, population: 900000 } : place,
    );
    await upsertPlaces(db, newer);
    expect((await placeByGeonameId(db, 2542997))?.population).toBe(900000);
  });
});

describe('suggestPlaces', () => {
  beforeEach(async () => {
    await load();
  });

  it('finds Marrakesh by the alternate most people type', async () => {
    expect(await names('Marrakech')).toStrictEqual(['Marrakesh']);
    expect(await names('marra')).toStrictEqual(['Marrakesh']);
  });

  it('finds a place by an alternate that is not the first one', async () => {
    expect(await names('Lutetia')).toStrictEqual(['Paris']);
  });

  it('finds Montréal with or without the accent', async () => {
    expect(await names('Montreal')).toStrictEqual(['Montréal']);
    expect(await names('Montréal')).toStrictEqual(['Montréal']);
  });

  it('completes a prefix, most populous first', async () => {
    expect(await names('par')).toStrictEqual(['Paris', 'Parramatta']);
  });

  it('puts an exact name above a larger town that only starts the same way', async () => {
    // Nicetown is fictional and larger; Nice is what was typed.
    expect(await names('Nice')).toStrictEqual(['Nice', 'Nicetown']);
  });

  it('matches a query as text, so a wildcard matches nothing', async () => {
    expect(await names('%')).toStrictEqual([]);
    expect(await names('_a')).toStrictEqual([]);
    expect(await names('Par%')).toStrictEqual([]);
  });

  it('does not match inside a name, only at its start', async () => {
    expect(await names('ris')).toStrictEqual([]);
  });

  it('honours the limit', async () => {
    expect(await names('p', 1)).toStrictEqual(['Paris']);
  });
});

describe('nearestPlaceTimezone', () => {
  it('answers across the antimeridian', async () => {
    await load();
    // 179.9° W is 0.47° from Suva across the date line, and half the world from everything else.
    expect(await nearestPlaceTimezone(db, { lat: -18.1, lon: -179.9 })).toBe('Pacific/Fiji');
  });

  it('invents nothing when no place is loaded', async () => {
    expect(await nearestPlaceTimezone(db, { lat: 31.63, lon: -8 })).toBeNull();
  });
});

describe('the geocode cache', () => {
  const key = Buffer.alloc(32, 7);
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('serves an answer until it expires, and replaces it on the next store', async () => {
    await storeGeocodeResult(db, {
      key,
      provider: 'nominatim',
      response: [{ a: 1 }],
      now,
      ttlMs: 60_000,
    });
    expect(
      (await cachedGeocodeResult(db, { key, now: new Date(now.getTime() + 59_000) }))?.response,
    ).toStrictEqual([{ a: 1 }]);
    expect(
      await cachedGeocodeResult(db, { key, now: new Date(now.getTime() + 60_000) }),
    ).toBeNull();

    const later = new Date(now.getTime() + 120_000);
    await storeGeocodeResult(db, {
      key,
      provider: 'nominatim',
      response: [],
      now: later,
      ttlMs: 60_000,
    });
    expect((await cachedGeocodeResult(db, { key, now: later }))?.response).toStrictEqual([]);
  });

  it('stores no query text, only its hash', async () => {
    await storeGeocodeResult(db, { key, provider: 'nominatim', response: [], now, ttlMs: 60_000 });
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'geonerva' AND table_name = 'geocode_cache'
      ORDER BY column_name
    `.execute(db);
    expect(columns.rows.map((row) => row.column_name)).toStrictEqual([
      'created_at',
      'expires_at',
      'provider',
      'query_sha256',
      'response',
    ]);
  });
});
