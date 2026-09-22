/**
 * Which runs may record coverage (ADR-041), through the real pipeline and the real adapters.
 *
 * A run records the window its adapter reports only when it followed the feed and read everything
 * it asked for: a **scheduled** run that `SUCCEEDED` or was `SKIPPED` (an unchanged answer is a
 * read), including a `NO_DATA` answer. A manual one-off, a `PARTIAL` batch and a failed fetch record
 * nothing — the fix-verification review showed each of them bridging months never read when the
 * coverage rule was derived from runs.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, listRecentRuns, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import type { HttpClient } from '@geonerva/http';
import { createSourceClient, emscAdapter, usgsAdapter } from '@geonerva/sources';
import { readFixtureBytes } from '@geonerva/test-fixtures';

import { createMemoryLogger } from './logging.ts';
import { runIngestion } from './run.ts';

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

function clientFor(
  descriptor: Parameters<typeof createSourceClient>[0],
  respond: () => Response,
): HttpClient {
  return createSourceClient(descriptor, {
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    jitter: () => 1,
    fetchImpl: () => Promise.resolve(respond()),
  });
}

function usgsFeed(bytes: Uint8Array = readFixtureBytes('usgs', 'all_day.geojson')): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } });
}

async function usgsRun(trigger: 'SCHEDULE' | 'MANUAL', respond: () => Response = () => usgsFeed()) {
  return runIngestion({
    db,
    adapter: usgsAdapter,
    client: clientFor(usgsAdapter.descriptor, respond),
    trigger,
    logger: createMemoryLogger(),
  });
}

async function coverage(source: string): Promise<{ hours: number; recordedAt: Date[] }> {
  const result = await sql<{ recorded_at: Date }>`
    SELECT h.recorded_at FROM geonerva.feed_coverage_hours h
    JOIN geonerva.source_products p ON p.id = h.product_id
    WHERE p.source_id = ${source}
  `.execute(db);
  return { hours: result.rows.length, recordedAt: result.rows.map((row) => row.recorded_at) };
}

describe('coverage from live polls', () => {
  it('records the whole hours a successful scheduled poll read, at its commit', async () => {
    const outcome = await usgsRun('SCHEDULE');
    expect(outcome.status).toBe('SUCCEEDED');

    const recorded = await coverage('usgs');
    // `all_day` less USGS's five-minute margin: 22 or 23 whole hours, depending on the minute.
    expect(recorded.hours).toBeGreaterThanOrEqual(22);
    expect(recorded.hours).toBeLessThanOrEqual(23);
    const runs = await listRecentRuns(db, { sourceId: 'usgs', limit: 1 });
    const committedAt = runs[0]?.committedAt?.getTime();
    expect(new Set(recorded.recordedAt.map((at) => at.getTime()))).toStrictEqual(
      new Set([committedAt]),
    );
  });

  it('records nothing for a manual one-off, which reads its look-back once', async () => {
    expect((await usgsRun('MANUAL')).status).toBe('SUCCEEDED');
    expect((await coverage('usgs')).hours).toBe(0);
  });

  it('records an unchanged answer, which is still a read', async () => {
    await usgsRun('MANUAL');
    const second = await usgsRun('SCHEDULE');
    expect(second.status, `${String(second.errorClass)}: ${String(second.detail)}`).toBe('SKIPPED');
    expect((await coverage('usgs')).hours).toBeGreaterThanOrEqual(22);
  });

  it('records nothing for a partial batch, which could not keep all it read', async () => {
    const feed = JSON.parse(
      new TextDecoder().decode(readFixtureBytes('usgs', 'all_day.geojson')),
    ) as { features: { geometry: { coordinates: number[] } }[] };
    const first = feed.features[0];
    if (first === undefined) throw new Error('fixture has no features');
    first.geometry.coordinates = [999, 999, 10];
    const outcome = await usgsRun('SCHEDULE', () =>
      usgsFeed(new TextEncoder().encode(JSON.stringify(feed))),
    );
    expect(outcome.status).toBe('PARTIAL');
    expect((await coverage('usgs')).hours).toBe(0);
  });

  it('records nothing when the fetch failed', async () => {
    const outcome = await usgsRun('SCHEDULE', () => new Response('boom', { status: 500 }));
    expect(outcome.status).toBe('FAILED');
    expect((await coverage('usgs')).hours).toBe(0);
  });

  it('treats "nothing revised in the window" as a read of that window', async () => {
    // EMSC answers 204 for an empty window. Fifteen minutes is no whole hour, so what records the
    // read is the frontier the next poll will join.
    const outcome = await runIngestion({
      db,
      adapter: emscAdapter,
      client: clientFor(emscAdapter.descriptor, () => new Response(null, { status: 204 })),
      trigger: 'SCHEDULE',
      logger: createMemoryLogger(),
    });
    expect(outcome.status, `${String(outcome.errorClass)}: ${String(outcome.detail)}`).toBe(
      'SUCCEEDED',
    );
    const frontier = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.feed_coverage_frontier f
      JOIN geonerva.source_products p ON p.id = f.product_id WHERE p.source_id = 'emsc'
    `.execute(db);
    expect(frontier.rows[0]?.n).toBe('1');
  });
});
