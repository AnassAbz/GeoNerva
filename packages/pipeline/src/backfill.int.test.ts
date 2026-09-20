/**
 * The historical backfill, against real PostGIS (P4.7).
 *
 * The network is a function of the test; everything below it is real. That is deliberate: the
 * properties under test — idempotency across repeats and overlaps, crash recovery either side of
 * the checkpoint, and live ↔ historical reconciliation — are properties of the database and of
 * the shared normalize path, and a mock would only prove the mock was called.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireRunLease,
  backfillProgress,
  createDb,
  findProductByCode,
  findBackfillPlan,
  listRecentRuns,
  observationsAsOf,
} from '@geonerva/db';
import type { DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { createSourceClient, usgsAdapter, type WindowPlanOptions } from '@geonerva/sources';
import { readFixtureBytes } from '@geonerva/test-fixtures';

import { runBackfill, type BackfillOutcome } from './backfill.ts';
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

/** A day-sized plan, so a short range produces a handful of windows. */
const PLAN: WindowPlanOptions = { windowMs: 24 * 60 * 60 * 1000, minWindowMs: 60_000 };

const FROM = new Date('2026-09-15T00:00:00.000Z');
const TO = new Date('2026-09-18T00:00:00.000Z');

/** The captured feed, reused as every window's answer unless a test says otherwise. */
function feedBody(): Uint8Array {
  return readFixtureBytes('usgs', 'all_day.geojson');
}

/** An FDSN-shaped answer containing exactly these features. */
function fdsnBody(features: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: 'FeatureCollection',
      metadata: { generated: 1, url: 'x', title: 'FDSN', status: 200, api: '2.7.0', count: null },
      features,
    }),
  );
}

interface ServerOptions {
  /** Answers the query endpoint. Defaults to the captured feed. */
  readonly query?: (url: URL, call: number) => Response;
  /** Rows the count endpoint reports. Defaults to something comfortably under the limit. */
  readonly count?: (url: URL, call: number) => Response;
}

/**
 * A client whose network is scripted and whose everything else is real.
 *
 * The responder is given the parsed URL, so a test can assert that the window it was asked for is
 * the window the planner produced.
 */
function scriptedClient(options: ServerOptions = {}): {
  client: ReturnType<typeof createSourceClient>;
  queries: URL[];
  counts: URL[];
} {
  const queries: URL[] = [];
  const counts: URL[] = [];
  const client = createSourceClient(usgsAdapter.descriptor, {
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    jitter: () => 1,
    fetchImpl: ((input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/count')) {
        counts.push(url);
        const responder = options.count;
        return Promise.resolve(
          responder === undefined
            ? new Response(JSON.stringify({ count: 100, maxAllowed: 20_000 }), {
                headers: { 'content-type': 'application/json' },
              })
            : responder(url, counts.length),
        );
      }
      queries.push(url);
      const responder = options.query;
      return Promise.resolve(
        responder === undefined
          ? new Response(feedBody(), { headers: { 'content-type': 'application/json' } })
          : responder(url, queries.length),
      );
    }) as unknown as typeof fetch,
  });
  return { client, queries, counts };
}

async function backfill(
  client: ReturnType<typeof createSourceClient>,
  overrides: Partial<Parameters<typeof runBackfill>[0]> = {},
): Promise<BackfillOutcome> {
  return runBackfill({
    db,
    adapter: usgsAdapter,
    client,
    request: { from: FROM, to: TO },
    plan: PLAN,
    logger: createMemoryLogger(),
    ...overrides,
  });
}

/** Everything the backfill writes, as one digest per table. */
async function factDigest(): Promise<Record<string, string>> {
  const result = await sql<{ table_name: string; digest: string }>`
    SELECT 'versions' AS table_name,
           COALESCE(md5(string_agg(t.row::text, '|' ORDER BY t.row::text)), 'empty') AS digest
    FROM (
      SELECT (v.source_record_id, v.version_seq, v.observed_at, v.content_sha256, v.magnitude) AS row
      FROM geonerva.observation_versions v
    ) t
    UNION ALL
    SELECT 'records',
           COALESCE(md5(string_agg(t.row::text, '|' ORDER BY t.row::text)), 'empty')
    FROM (SELECT (r.source_id, r.primary_key) AS row FROM geonerva.source_records r) t
    UNION ALL
    SELECT 'aliases',
           COALESCE(md5(string_agg(t.row::text, '|' ORDER BY t.row::text)), 'empty')
    FROM (SELECT (a.source_id, a.alias) AS row FROM geonerva.source_record_aliases a) t
    UNION ALL
    SELECT 'raw',
           COALESCE(md5(string_agg(t.row::text, '|' ORDER BY t.row::text)), 'empty')
    FROM (SELECT (w.source_id, w.payload_sha256) AS row FROM geonerva.raw_source_records w) t
  `.execute(db);
  return Object.fromEntries(result.rows.map((row) => [row.table_name, row.digest]));
}

async function countOf(table: 'observation_versions' | 'source_records'): Promise<number> {
  const result =
    table === 'observation_versions'
      ? await sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM geonerva.observation_versions`.execute(db)
      : await sql<{ n: string }>`SELECT count(*)::text AS n FROM geonerva.source_records`.execute(
          db,
        );
  return Number(result.rows[0]?.n ?? '0');
}

describe('a straightforward backfill', () => {
  it('walks every window and completes', async () => {
    const { client, queries, counts } = scriptedClient();
    const outcome = await backfill(client);

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.progress.pending).toBe(0);
    expect(outcome.progress.failed).toBe(0);
    // Three days, one window each.
    expect(outcome.intervalsProcessed).toBe(3);
    expect(queries).toHaveLength(3);
    expect(counts, 'every window is counted before it is paid for').toHaveLength(3);

    expect((await findBackfillPlan(db, outcome.planId))?.status).toBe('COMPLETED');
    expect(await countOf('source_records')).toBe(230);
  });

  it('asks for the windows the planner produced, in order', async () => {
    const { client, queries } = scriptedClient();
    await backfill(client);

    const starts = queries.map((url) => url.searchParams.get('starttime'));
    expect(starts).toStrictEqual([
      '2026-09-15T00:00:00.000Z',
      '2026-09-16T00:00:00.000Z',
      '2026-09-17T00:00:00.000Z',
    ]);
    // Half-open on our side, inclusive on theirs: the last millisecond of the day, never the
    // first of the next one, so adjacent windows cannot both claim a boundary event.
    expect(queries[0]?.searchParams.get('endtime')).toBe('2026-09-15T23:59:59.999Z');
  });

  it('records every window against an ingestion run', async () => {
    const { client } = scriptedClient();
    const outcome = await backfill(client);

    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.trigger === 'BACKFILL')).toBe(true);

    const linked = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.backfill_intervals
      WHERE plan_id = ${outcome.planId}::uuid AND ingestion_run_id IS NOT NULL
    `.execute(db);
    expect(linked.rows[0]?.n).toBe('3');
  });

  it('makes the backfilled facts visible through the as-of layer', async () => {
    const { client } = scriptedClient();
    await backfill(client);
    expect(await observationsAsOf(db, { asOf: new Date() })).toHaveLength(230);
  });
});

describe('ADR-033: a backfill keeps the digest, not the body', () => {
  it('stores raw rows with a null payload and the pruned flag set', async () => {
    const { client } = scriptedClient();
    await backfill(client);

    const raw = await sql<{ total: string; with_body: string; pruned: string }>`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE payload IS NOT NULL)::text AS with_body,
             count(*) FILTER (WHERE payload_pruned)::text      AS pruned
      FROM geonerva.raw_source_records
    `.execute(db);

    expect(Number(raw.rows[0]?.total)).toBe(230);
    expect(raw.rows[0]?.with_body, 'no backfilled payload bodies').toBe('0');
    expect(raw.rows[0]?.pruned, 'and the absence is recorded, not implied').toBe('230');
  });

  it('still attaches every version to its raw row, so provenance survives', async () => {
    const { client } = scriptedClient();
    await backfill(client);
    const orphaned = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.observation_versions WHERE raw_record_id IS NULL
    `.execute(db);
    expect(orphaned.rows[0]?.n).toBe('0');
  });

  it('keeps the payload body for a live poll', async () => {
    // The asymmetry ADR-033 turns on: live bytes are a snapshot the provider will not serve again.
    const { client } = scriptedClient();
    await runIngestion({
      db,
      adapter: usgsAdapter,
      client,
      trigger: 'MANUAL',
      logger: createMemoryLogger(),
      fetchOverride: () =>
        Promise.resolve({
          kind: 'FETCHED',
          body: feedBody(),
          httpStatus: 200,
          bytes: feedBody().byteLength,
          payloadSha256: Buffer.alloc(32, 7),
          endpoint: 'earthquake.usgs.gov/feed',
          attempts: 1,
          durationMs: 1,
        }),
    });

    const raw = await sql<{ with_body: string }>`
      SELECT count(*) FILTER (WHERE payload IS NOT NULL)::text AS with_body
      FROM geonerva.raw_source_records
    `.execute(db);
    expect(Number(raw.rows[0]?.with_body)).toBeGreaterThan(0);
  });
});

describe('idempotency', () => {
  it('writes nothing new when the same range is backfilled twice', async () => {
    const first = await backfill(scriptedClient().client);
    const digest = await factDigest();

    const second = await backfill(scriptedClient().client);

    expect(second.planId, 'the same request resumes the same plan').toBe(first.planId);
    expect(second.status).toBe('COMPLETED');
    expect(second.newVersions, 'nothing changed upstream, so nothing is a revision').toBe(0);
    expect(await factDigest(), 'a repeat is a no-op in every table').toStrictEqual(digest);
  });

  it('does not re-fetch windows a previous run already completed', async () => {
    await backfill(scriptedClient().client);
    const { client, queries } = scriptedClient();
    const second = await backfill(client);

    // Every interval is DONE, so a resume has nothing to claim.
    expect(queries, 'completed windows are not walked again').toHaveLength(0);
    expect(second.intervalsProcessed).toBe(0);
    expect(second.status).toBe('COMPLETED');
  });

  it('refuses to re-plan an existing range with a different window size', async () => {
    /*
     * Without this, re-running a 30-day plan with 7-day windows adds thirteen fresh PENDING
     * intervals overlapping four already DONE. The facts would survive - the content hash sees
     * to that - but the plan would describe a shape nobody asked for and would re-walk finished
     * work, while its progress counts became meaningless.
     */
    await backfill(scriptedClient().client, { maxIntervals: 1 });

    await expect(
      backfill(scriptedClient().client, {
        plan: { windowMs: 12 * 60 * 60 * 1000, minWindowMs: 60_000 },
      }),
    ).rejects.toThrow(/already planned with 1-day windows/);

    // And the original plan is untouched.
    const plans = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.backfill_intervals
    `.execute(db);
    expect(plans.rows[0]?.n).toBe('3');
  });

  it('writes no duplicate facts when two ranges overlap', async () => {
    await backfill(scriptedClient().client);
    const digest = await factDigest();
    const records = await countOf('source_records');

    // A different request, so a different plan — overlapping the first by two days.
    const overlapping = await backfill(scriptedClient().client, {
      request: {
        from: new Date('2026-09-16T00:00:00.000Z'),
        to: new Date('2026-09-19T00:00:00.000Z'),
      },
    });

    expect(overlapping.planId).not.toBe('');
    expect(overlapping.status).toBe('COMPLETED');
    expect(await countOf('source_records'), 'overlap creates no second record').toBe(records);
    expect(await factDigest(), 'the content hash is what makes an overlap safe').toStrictEqual(
      digest,
    );
  });
});

describe('window splitting', () => {
  it('splits a window the count endpoint reports as over the limit', async () => {
    let over = true;
    const { client, queries } = scriptedClient({
      count: () => {
        // The first window is too large; once split, every child fits.
        const body = over
          ? { count: 101_674, maxAllowed: 20_000, error: 'exceeds search limit of 20000' }
          : { count: 10, maxAllowed: 20_000 };
        over = false;
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const outcome = await backfill(client);

    expect(outcome.intervalsSplit).toBe(1);
    expect(outcome.status).toBe('COMPLETED');
    // The split parent is never fetched; its two children are.
    expect(queries).toHaveLength(4);

    const split = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.backfill_intervals
      WHERE plan_id = ${outcome.planId}::uuid AND status = 'SPLIT'
    `.execute(db);
    expect(split.rows[0]?.n).toBe('1');
  });

  it('splits on the real 400 body when the count endpoint disagreed', async () => {
    // The count said it would fit and the query refused. Splitting on the answer we actually got
    // is what stops a disagreement becoming a stuck backfill.
    let refused = false;
    const { client } = scriptedClient({
      query: () => {
        if (refused)
          return new Response(feedBody(), { headers: { 'content-type': 'application/json' } });
        refused = true;
        return new Response(
          'Error 400: Bad Request\n\n101674 matching events exceeds search limit of 20000.',
          { status: 400 },
        );
      },
    });

    const outcome = await backfill(client);
    expect(outcome.intervalsSplit).toBeGreaterThanOrEqual(1);
    expect(outcome.progress.split).toBeGreaterThanOrEqual(1);
  });

  it('records a failure rather than splitting forever at the floor', async () => {
    // A minute that still will not fit is a real condition, and it has to be reported.
    const { client } = scriptedClient({
      count: () =>
        new Response(
          JSON.stringify({ count: 999_999, maxAllowed: 20_000, error: 'exceeds search limit' }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });

    const outcome = await backfill(client, {
      request: { from: FROM, to: new Date(FROM.getTime() + 4 * 60_000) },
      plan: { windowMs: 4 * 60_000, minWindowMs: 60_000 },
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.progress.failed).toBeGreaterThan(0);
    expect((await findBackfillPlan(db, outcome.planId))?.status).toBe('FAILED');
  });
});

describe('crash recovery', () => {
  it('resumes where it stopped when the process is bounded mid-plan', async () => {
    // `maxIntervals` is the same shape as a crash from the plan's point of view: some intervals
    // are DONE, the rest are PENDING, and nothing in memory says which.
    const partial = await backfill(scriptedClient().client, { maxIntervals: 1 });
    expect(partial.status).toBe('INCOMPLETE');
    expect(partial.progress.done).toBe(1);
    expect(partial.progress.pending).toBe(2);

    const resumed = await backfill(scriptedClient().client);
    expect(resumed.planId).toBe(partial.planId);
    expect(resumed.intervalsProcessed, 'only the outstanding windows').toBe(2);
    expect(resumed.status).toBe('COMPLETED');
  });

  it('leaves no checkpoint behind when the batch fails, and recovers next pass', async () => {
    /*
     * The crash P4.2 asks about, from the dangerous side: facts committed, checkpoint lost. It
     * cannot happen here — the checkpoint is written inside the same transaction — so this proves
     * the other half: a window whose persist fails leaves *neither* facts nor checkpoint, and the
     * next pass redoes it cleanly.
     */
    await sql`
      CREATE OR REPLACE FUNCTION geonerva.test_fail_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure during persistence'; END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS test_fail_versions ON geonerva.observation_versions;
      CREATE TRIGGER test_fail_versions BEFORE INSERT ON geonerva.observation_versions
        FOR EACH ROW EXECUTE FUNCTION geonerva.test_fail_insert();
    `.execute(db);

    let broken: BackfillOutcome;
    try {
      broken = await backfill(scriptedClient().client, { maxIntervals: 1 });
      expect(await countOf('observation_versions'), 'the batch rolled back').toBe(0);
      const progress = await backfillProgress(db, broken.planId);
      expect(progress.done, 'and so did its checkpoint').toBe(0);
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_fail_versions ON geonerva.observation_versions`.execute(
        db,
      );
    }

    const recovered = await backfill(scriptedClient().client);
    expect(recovered.status).toBe('COMPLETED');
    expect(await countOf('observation_versions')).toBe(230);
  });

  it('stops instead of spinning when another worker holds the lease', async () => {
    /*
     * A LEASE_HELD outcome means nothing was fetched and nothing was written, so `beforeCommit`
     * never ran and the interval is still PENDING. Claiming again hands back the *same* interval,
     * so without this the loop spins on it for as long as the other worker holds the lease.
     */
    const held = await acquireRunLease(db, {
      sourceId: usgsAdapter.descriptor.sourceId,
      productId: (await findProductByCode(db, 'usgs', 'comcat'))?.id ?? null,
      trigger: 'SCHEDULE',
    });
    expect(held.acquired).toBe(true);

    const { client, queries } = scriptedClient();
    const outcome = await backfill(client);

    expect(outcome.status).toBe('INCOMPLETE');
    expect(outcome.detail).toMatch(/another run holds this product/);
    expect(queries.length, 'it stops rather than re-fetching the same window').toBeLessThanOrEqual(
      1,
    );
    expect(outcome.progress.pending, 'every window is still there to resume').toBe(3);
  });

  it('stops cleanly when cancelled and leaves the plan resumable', async () => {
    const controller = new AbortController();
    const { client } = scriptedClient({
      query: () => {
        controller.abort();
        return new Response(feedBody(), { headers: { 'content-type': 'application/json' } });
      },
    });

    const cancelled = await backfill(client, { signal: controller.signal });
    expect(cancelled.status).toBe('INCOMPLETE');
    expect(cancelled.detail).toMatch(/cancelled/);
    expect((await findBackfillPlan(db, cancelled.planId))?.status).toBe('RUNNING');
  });
});

describe('live and historical are the same earthquake', () => {
  /** One feature from the captured feed, as FDSN would return it. */
  function oneFeature(): unknown {
    const feed = JSON.parse(readFixtureBytes('usgs', 'all_day.geojson').toString('utf8')) as {
      features: unknown[];
    };
    const feature = feed.features[0];
    if (feature === undefined) throw new Error('fixture should have a feature');
    return feature;
  }

  async function ingestLive(body: Uint8Array): Promise<void> {
    const { client } = scriptedClient();
    const outcome = await runIngestion({
      db,
      adapter: usgsAdapter,
      client,
      trigger: 'MANUAL',
      logger: createMemoryLogger(),
      fetchOverride: () =>
        Promise.resolve({
          kind: 'FETCHED',
          body,
          httpStatus: 200,
          bytes: body.byteLength,
          payloadSha256: Buffer.from(
            [...body.slice(0, 32)].concat(Array<number>(32).fill(0)).slice(0, 32),
          ),
          endpoint: 'earthquake.usgs.gov/feed',
          attempts: 1,
          durationMs: 1,
        }),
    });
    expect(outcome.status).toBe('SUCCEEDED');
  }

  it('historical first, then live: one record, no second version', async () => {
    const feature = oneFeature();
    const { client } = scriptedClient({ query: () => new Response(fdsnBody([feature])) });
    await backfill(client, { request: { from: FROM, to: new Date(FROM.getTime() + 86_400_000) } });

    expect(await countOf('source_records')).toBe(1);
    const afterBackfill = await countOf('observation_versions');

    await ingestLive(fdsnBody([feature]));

    expect(await countOf('source_records'), 'the same earthquake, not a second one').toBe(1);
    expect(
      await countOf('observation_versions'),
      'the content hash matches, so the live sighting is not a revision',
    ).toBe(afterBackfill);
  });

  it('live first, then historical: one record, no second version', async () => {
    const feature = oneFeature();
    await ingestLive(fdsnBody([feature]));
    const afterLive = await countOf('observation_versions');

    const { client } = scriptedClient({ query: () => new Response(fdsnBody([feature])) });
    await backfill(client, { request: { from: FROM, to: new Date(FROM.getTime() + 86_400_000) } });

    expect(await countOf('source_records')).toBe(1);
    expect(await countOf('observation_versions')).toBe(afterLive);
  });

  it('reconciles an event whose preferred id changed between the two interfaces', async () => {
    /*
     * The case P0 actually observed: FDSN answers a query for `us7000tiar` under the preferred id
     * `pr2026261000`. Identity is the alias set, so both are one record — if it were keyed on
     * `id`, the same earthquake would become two "independent" sources agreeing with each other.
     */
    const feature = JSON.parse(
      readFixtureBytes('usgs', 'fdsn-eventid-by-alias.geojson').toString('utf8'),
    ) as { id: string; properties: { ids: string } };

    const live = structuredClone(feature);
    live.id = 'us7000tiar';
    live.properties.ids = ',us7000tiar,';
    await ingestLive(fdsnBody([live]));
    expect(await countOf('source_records')).toBe(1);

    const { client } = scriptedClient({ query: () => new Response(fdsnBody([feature])) });
    await backfill(client, { request: { from: FROM, to: new Date(FROM.getTime() + 86_400_000) } });

    expect(await countOf('source_records'), 'one earthquake, two interfaces').toBe(1);
    const aliases = await sql<{ alias: string }>`
      SELECT alias FROM geonerva.source_record_aliases ORDER BY alias
    `.execute(db);
    expect(aliases.rows.map((row) => row.alias)).toContain('us7000tiar');
    expect(aliases.rows.map((row) => row.alias)).toContain('pr2026261000');
  });

  it('records a genuine revision once, whichever interface saw it first', async () => {
    const before = JSON.parse(readFixtureBytes('usgs', 'revision-t0.geojson').toString('utf8')) as {
      features: { id: string }[];
    };
    const after = JSON.parse(readFixtureBytes('usgs', 'revision-t1.geojson').toString('utf8')) as {
      features: { id: string }[];
    };
    const target = before.features[0]?.id;
    const revisedFeature = after.features.find((feature) => feature.id === target);
    expect(revisedFeature).toBeDefined();

    await ingestLive(fdsnBody([before.features[0]]));
    const { client } = scriptedClient({ query: () => new Response(fdsnBody([revisedFeature])) });
    await backfill(client, { request: { from: FROM, to: new Date(FROM.getTime() + 86_400_000) } });

    const versions = await sql<{ version_seq: number; provider_status: string }>`
      SELECT v.version_seq, v.provider_status
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE r.primary_key = ${target}
      ORDER BY v.version_seq
    `.execute(db);

    expect(versions.rows.map((row) => row.version_seq)).toStrictEqual([1, 2]);
    expect(versions.rows.map((row) => row.provider_status)).toStrictEqual([
      'automatic',
      'reviewed',
    ]);
  });
});

describe('an empty range is a real answer', () => {
  it('completes with no facts when the catalogue is quiet', async () => {
    const { client } = scriptedClient({
      query: () => new Response(fdsnBody([])),
      count: () =>
        new Response(JSON.stringify({ count: 0, maxAllowed: 20_000 }), {
          headers: { 'content-type': 'application/json' },
        }),
    });

    /*
     * A historical window with no events is ordinary — a quiet day in a narrow magnitude band —
     * unlike an empty *live* feed, which means the feed broke. So the backfill completes rather
     * than failing EMPTY_SUSPICIOUS, and the run rows say zero received rather than saying
     * nothing at all.
     */
    const outcome = await backfill(client);
    expect(outcome.status).toBe('COMPLETED');
    expect(await countOf('observation_versions')).toBe(0);

    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs.length, 'the empty windows are still recorded as evidence').toBeGreaterThan(0);
  });
});
