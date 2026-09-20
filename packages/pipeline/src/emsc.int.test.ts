/**
 * EMSC through the real pipeline and a real PostGIS (docs/TESTING.md §4.9).
 *
 * The unit tests prove the adapter reads EMSC correctly. These prove the *system* stays honest
 * with a second source in it, which is a different question and the one G5 is actually about:
 *
 *  - a 204 must land as a successful observation of emptiness, not as a skipped poll and not as a
 *    broken feed, and it must not erase the digest the next poll compares against;
 *  - two sources describing the same physical earthquake must stay two records, because the only
 *    thing a second source is *for* is independent corroboration, and a merge would manufacture
 *    agreement out of one observation;
 *  - a run's counts must reconcile, and a second identical run must write nothing.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, findProductByCode, listRecentRuns, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import type { HttpClient } from '@geonerva/http';
import { createSourceClient, emscAdapter, usgsAdapter } from '@geonerva/sources';
import { readFixtureBytes } from '@geonerva/test-fixtures';

import { createMemoryLogger } from './logging.ts';
import { runIngestion, type RunOutcome } from './run.ts';

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
});

/** A client whose network is a function of the test, and whose everything else is real. */
function clientServing(responder: () => Response | Promise<Response>): HttpClient {
  return createSourceClient(emscAdapter.descriptor, {
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    jitter: () => 1,
    fetchImpl: (() => responder()) as unknown as typeof fetch,
  });
}

function serving(file: string): HttpClient {
  return clientServing(
    () =>
      new Response(readFixtureBytes('emsc', file), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

/** What EMSC really sends when nothing matched: 204, and not one byte of body. */
function servingNoData(): HttpClient {
  return clientServing(() => new Response(null, { status: 204 }));
}

async function ingest(client: HttpClient): Promise<RunOutcome> {
  return runIngestion({
    db,
    adapter: emscAdapter,
    client,
    trigger: 'MANUAL',
    logger: createMemoryLogger(),
  });
}

/**
 * Counts in the two tables these tests reason about.
 *
 * Written out rather than parameterized by table name: `sql.raw` interpolates verbatim
 * (SECURITY.md C3), and a lint rule refuses it even in a test, which is the right place for the
 * rule to be uncompromising.
 */
async function counts(): Promise<{ records: number; versions: number }> {
  const result = await sql<{ records: string; versions: string }>`
    SELECT (SELECT count(*) FROM geonerva.source_records)::text AS records,
           (SELECT count(*) FROM geonerva.observation_versions)::text AS versions
  `.execute(db);
  return {
    records: Number(result.rows[0]?.records ?? '0'),
    versions: Number(result.rows[0]?.versions ?? '0'),
  };
}

describe('a live EMSC poll', () => {
  it('ingests a captured page and reconciles its counts', async () => {
    const outcome = await ingest(serving('json-page.json'));

    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.counts.received).toBe(200);
    expect(outcome.counts.accepted).toBe(200);
    expect(outcome.counts.rejected).toBe(0);
    expect(outcome.counts.newRecords).toBe(200);
    expect(outcome.counts.newVersions).toBe(200);
    expect((await counts()).records).toBe(200);
    expect((await counts()).versions).toBe(200);
  });

  it('writes nothing the second time, because the content hash has not moved', async () => {
    await ingest(serving('json-page.json'));
    // A different client instance, so the run is a genuine second fetch rather than a 304.
    const second = await ingest(serving('json-page.json'));

    // The bytes are identical, so this is caught at the digest before anything is parsed.
    expect(second.status).toBe('SKIPPED');
    expect((await counts()).records).toBe(200);
    expect((await counts()).versions).toBe(200);
  });

  it('records a revision when EMSC revises, and only for the records that changed', async () => {
    const first = await ingest(serving('revision-t0.json'));
    const second = await ingest(serving('revision-t1.json'));

    expect(first.counts.newRecords).toBe(2);
    expect(second.counts.newRecords).toBe(0);
    // The pair was captured because both events were revised between the two polls.
    expect(second.counts.newVersions).toBe(2);
    expect((await counts()).records).toBe(2);
    expect((await counts()).versions).toBe(4);
  });
});

describe('HTTP 204', () => {
  it('is a successful observation of emptiness, not a skipped poll', async () => {
    /*
     * The three cases the contract keeps apart, and this is the middle one:
     *   UNCHANGED  — "the same bytes you already have" (SKIPPED)
     *   NO_DATA    — "I looked; there is nothing there" (SUCCEEDED, received 0)
     *   FETCHED, 0 records — a body that should never be empty (EMPTY_SUSPICIOUS)
     * Collapsing the middle into either of the others loses the only one that is a statement
     * about the world.
     */
    const outcome = await ingest(servingNoData());

    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.errorClass).toBeNull();
    expect(outcome.counts.received).toBe(0);

    const runs = await listRecentRuns(db, { sourceId: 'emsc', limit: 1 });
    expect(runs[0]?.status).toBe('SUCCEEDED');
    expect(runs[0]?.counts.received).toBe(0);
    // The status is what says *why* it was empty, so it has to reach the row.
    const stored = await sql<{ http_status: number | null }>`
      SELECT http_status FROM geonerva.ingestion_runs WHERE source_id = 'emsc'
    `.execute(db);
    expect(stored.rows[0]?.http_status).toBe(204);
  });

  it('does not erase the digest the next poll compares against', async () => {
    /*
     * The 304 lesson, in a second place. Writing sha256("") for an empty body replaces the last
     * real digest, and the *next* poll of the unchanged catalogue then looks changed — an
     * invented revision of every record in it. A quiet period is exactly when this happens.
     */
    await ingest(serving('json-page.json'));
    const before = await lastDigest();

    await ingest(servingNoData());
    expect(await lastDigest()).toBe(before);

    // And the proof that it matters: the same page again is still recognised as unchanged.
    const third = await ingest(serving('json-page.json'));
    expect(third.status).toBe('SKIPPED');
    expect((await counts()).versions).toBe(200);
  });

  it('still leaves health evidence, so a quiet source is not a silent one', async () => {
    await ingest(servingNoData());
    const runs = await listRecentRuns(db, { sourceId: 'emsc', limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.finishedAt).not.toBeNull();
  });
});

async function lastDigest(): Promise<string | null> {
  const result = await sql<{ digest: string | null }>`
    SELECT encode(payload_sha256, 'hex') AS digest
    FROM geonerva.ingestion_runs
    WHERE source_id = 'emsc' AND payload_sha256 IS NOT NULL
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `.execute(db);
  return result.rows[0]?.digest ?? null;
}

describe('two sources, one earthquake', () => {
  it('keeps them as two records, because that is the whole point of a second source', async () => {
    /*
     * USGS `us6000thv7` and EMSC `20260803_0000324` are the same Morocco M4.7 of 2026-08-03
     * (DATA_SOURCES §6.2) — a real cross-source match, confirmed live in P0.
     *
     * They must stay two `source_records`. Merging them at ingest would destroy the only thing
     * that makes EMSC worth having: two independent observations, which correlation may later
     * decide are one event, with the evidence for that decision preserved. A merge here would
     * present one observation as two sources agreeing.
     */
    const usgsClient = createSourceClient(usgsAdapter.descriptor, {
      userAgent: 'GeoNerva-test/0.1',
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      sleep: () => Promise.resolve(),
      jitter: () => 1,
      fetchImpl: (() =>
        new Response(readFixtureBytes('usgs', 'all_day.geojson'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    await runIngestion({
      db,
      adapter: usgsAdapter,
      client: usgsClient,
      trigger: 'MANUAL',
      logger: createMemoryLogger(),
    });
    await ingest(serving('eventid-morocco.json'));

    const products = await sql<{ source_id: string; n: string }>`
      SELECT r.source_id, count(*)::text AS n
      FROM geonerva.source_records r
      GROUP BY r.source_id
    `.execute(db);
    const bySource = new Map(products.rows.map((row) => [row.source_id, Number(row.n)]));
    expect(bySource.get('emsc')).toBe(1);
    expect((bySource.get('usgs') ?? 0) > 0).toBe(true);

    // The EMSC record is keyed by unid, and carries no USGS alias — EMSC publishes none, and
    // inventing one would be GeoNerva asserting a match the provider never made.
    const aliases = await sql<{ alias: string }>`
      SELECT a.alias
      FROM geonerva.source_record_aliases a
      JOIN geonerva.source_records r ON r.id = a.source_record_id
      WHERE r.source_id = 'emsc'
    `.execute(db);
    expect(aliases.rows.map((row) => row.alias)).toStrictEqual(['20260803_0000324']);
  });
});

describe('the seeded product', () => {
  it('matches the descriptor, including what it does not claim', async () => {
    // Code and database disagreeing about capabilities was a HIGH finding in G4, for USGS.
    const product = await findProductByCode(db, 'emsc', 'rts');
    expect(product).not.toBeNull();
    expect([...(product?.capabilities ?? [])].sort()).toStrictEqual(
      [...emscAdapter.descriptor.capabilities].sort(),
    );
    expect(product?.capabilities).not.toContain('DELETIONS');
  });
});
