/**
 * The deletion sweep, against real PostGIS and the real captured sweep.
 *
 * The fixture is what makes this worth having: 98 deletions of which 55 were stripped of every
 * identifier by the provider. A sweep written against the documentation rather than the data
 * would have failed all of them as schema drift.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, listRecentRuns, observationsAsOf } from '@geonerva/db';
import type { DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { createSourceClient, usgsAdapter } from '@geonerva/sources';
import { readFixtureBytes } from '@geonerva/test-fixtures';

import { runDeletionSweep } from './deletion-sweep.ts';
import { createMemoryLogger } from './logging.ts';
import { runIngestion } from './run.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const FROM = new Date('2026-09-10T00:00:00.000Z');
const TO = new Date('2026-09-20T00:00:00.000Z');

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

function client(body: () => Response): ReturnType<typeof createSourceClient> {
  return createSourceClient(usgsAdapter.descriptor, {
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    fetchImpl: () => Promise.resolve(body()),
  });
}

const sweepFixture = (): Response =>
  new Response(readFixtureBytes('usgs', 'fdsn-includedeleted-only.geojson'), {
    headers: { 'content-type': 'application/json' },
  });

function sweep(responder: () => Response = sweepFixture) {
  return runDeletionSweep({
    db,
    adapter: usgsAdapter,
    client: client(responder),
    from: FROM,
    to: TO,
    logger: createMemoryLogger(),
  });
}

/** Ingests the deleted events first, so the sweep has something to tombstone. */
async function ingestTheDeletedEvents(): Promise<string[]> {
  const raw = JSON.parse(
    readFixtureBytes('usgs', 'fdsn-includedeleted-only.geojson').toString('utf8'),
  ) as { features: { id: string; properties: Record<string, unknown> }[] };

  // Only the identifiable ones can be ingested; the rest have no id at all.
  const identifiable = raw.features.filter((feature) => feature.id.length > 0).slice(0, 5);
  const alive = identifiable.map((feature) => ({
    ...feature,
    properties: { ...feature.properties, status: 'reviewed', place: 'somewhere' },
  }));

  const body = new TextEncoder().encode(
    JSON.stringify({
      type: 'FeatureCollection',
      metadata: { count: alive.length },
      features: alive,
    }),
  );

  const outcome = await runIngestion({
    db,
    adapter: usgsAdapter,
    client: client(() => new Response(body)),
    trigger: 'MANUAL',
    logger: createMemoryLogger(),
    fetchOverride: () =>
      Promise.resolve({
        kind: 'FETCHED',
        body,
        httpStatus: 200,
        bytes: body.byteLength,
        payloadSha256: Buffer.alloc(32, 9),
        endpoint: 'earthquake.usgs.gov/feed',
        attempts: 1,
        durationMs: 1,
      }),
  });
  expect(outcome.status).toBe('SUCCEEDED');
  return identifiable.map((feature) => feature.id);
}

describe('the real sweep', () => {
  it('counts what it cannot identify instead of failing or skipping it', async () => {
    const outcome = await sweep();

    expect(outcome.status).toBe('SUCCEEDED');
    // 55 of 98 were stripped by the provider. Not drift, not a skip: counted and recorded.
    expect(outcome.unidentifiable).toBe(55);
    // Nothing was ingested first, so the 43 identifiable ones are for events we never held.
    expect(outcome.unknownToUs).toBe(43);
    expect(outcome.tombstoned).toBe(0);

    const rejects = await sql<{ reason_code: string; n: string }>`
      SELECT reason_code, count(*)::text AS n FROM geonerva.ingestion_rejects GROUP BY reason_code
    `.execute(db);
    expect(rejects.rows).toStrictEqual([{ reason_code: 'MISSING_IDENTITY', n: '55' }]);
  });

  it('does not invent a record for a deletion of an event it never held', async () => {
    await sweep();
    const records = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.source_records
    `.execute(db);
    // Creating one would produce a record whose only version says it was deleted — a fact
    // GeoNerva made up.
    expect(records.rows[0]?.n).toBe('0');
  });

  it('records the sweep as a RECONCILE run, with the counts on it', async () => {
    const outcome = await sweep();
    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: outcome.runId,
      trigger: 'RECONCILE',
      status: 'SUCCEEDED',
      counts: { received: 98, rejected: 55 },
    });
  });
});

describe('tombstoning', () => {
  it('tombstones the events it holds, and leaves the rest alone', async () => {
    const ingested = await ingestTheDeletedEvents();
    expect(ingested.length).toBeGreaterThan(0);

    const outcome = await sweep();

    expect(outcome.tombstoned).toBe(ingested.length);
    expect(outcome.unknownToUs).toBe(43 - ingested.length);
    expect(outcome.unidentifiable).toBe(55);

    const tombstones = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.observation_versions
      WHERE lifecycle_status = 'DELETED'
    `.execute(db);
    expect(tombstones.rows[0]?.n).toBe(String(ingested.length));
  });

  it('keeps the record and its history: a tombstone is a version, not a delete', async () => {
    const ingested = await ingestTheDeletedEvents();
    await sweep();

    const versions = await sql<{ primary_key: string; version_seq: number; status: string }>`
      SELECT r.primary_key, v.version_seq, v.lifecycle_status AS status
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE r.primary_key = ${ingested[0]}
      ORDER BY v.version_seq
    `.execute(db);

    // The live version is still there; the deletion is appended. A replay before the sweep must
    // still show the event as it was.
    expect(versions.rows.map((row) => row.status)).toStrictEqual(['ACTIVE', 'DELETED']);
    expect(versions.rows.map((row) => row.version_seq)).toStrictEqual([1, 2]);
  });

  it('is idempotent: a second sweep writes no second tombstone', async () => {
    await ingestTheDeletedEvents();
    const first = await sweep();
    const second = await sweep();

    expect(second.tombstoned, 'nothing new to tombstone').toBe(0);
    expect(second.alreadyTombstoned).toBe(first.tombstoned);

    const tombstones = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.observation_versions
      WHERE lifecycle_status = 'DELETED'
    `.execute(db);
    expect(tombstones.rows[0]?.n).toBe(String(first.tombstoned));
  });

  it('removes the event from the current view while replay still sees it', async () => {
    const ingested = await ingestTheDeletedEvents();
    const beforeSweep = new Date();
    await sweep();

    // The default view excludes tombstones, so a deleted event simply stops being current.
    const now = await observationsAsOf(db, { asOf: new Date() });
    expect(now.find((row) => row.primary_key === ingested[0])).toBeUndefined();

    // Asking for them explicitly shows the tombstone rather than nothing, so a caller that needs
    // to say "this was withdrawn" can.
    const withTombstones = await observationsAsOf(db, {
      asOf: new Date(),
      excludeTombstones: false,
    });
    expect(withTombstones.find((row) => row.primary_key === ingested[0])?.lifecycle_status).toBe(
      'DELETED',
    );

    // And a replay from before the sweep still shows the event as it was. A tombstone is a
    // version, so deleting is something that happened at a time, not something that erases.
    const earlier = await observationsAsOf(db, { asOf: beforeSweep });
    expect(earlier.find((row) => row.primary_key === ingested[0])?.lifecycle_status).toBe('ACTIVE');
  });
});

describe('failure handling', () => {
  it('fails as SCHEMA_DRIFT when no deletion in a non-empty sweep is identifiable', async () => {
    // Being blind to every deletion is worth failing over; reporting "0 tombstones" would look
    // exactly like there having been none.
    const body = new TextEncoder().encode(
      JSON.stringify({
        type: 'FeatureCollection',
        metadata: { count: 2 },
        features: [0, 1].map(() => ({
          type: 'Feature',
          id: '',
          properties: { time: 1, updated: null, ids: null, status: 'deleted' },
        })),
      }),
    );
    const outcome = await sweep(() => new Response(body));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('SCHEMA_DRIFT');
  });

  it('records a provider outage as a failed run rather than losing it', async () => {
    const outcome = await sweep(() => new Response('nope', { status: 503 }));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('HTTP_5XX');

    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs[0]).toMatchObject({ status: 'FAILED', errorClass: 'HTTP_5XX' });
  });

  it('accepts an empty sweep as a real answer', async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ type: 'FeatureCollection', metadata: { count: 0 }, features: [] }),
    );
    const outcome = await sweep(() => new Response(body));
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.tombstoned).toBe(0);
    expect(outcome.unidentifiable).toBe(0);
  });
});
