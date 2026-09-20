/**
 * The run lifecycle against a real PostGIS (docs/TESTING.md §4.9, docs/reviews/p3-plan.md §7).
 *
 * These use the real database on purpose. Idempotency, rollback, the run lease and the batch
 * timestamp are all properties of the *database*, and a mock would only assert that the mock was
 * called — which is precisely the class of bug this phase exists to prevent.
 *
 * The HTTP client is injected with a fake `fetch`, so the network is deterministic while
 * everything below it is real.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDb,
  findProductByCode,
  listRecentRuns,
  observationsAsOf,
  type DB,
} from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { INITIAL_FRESHNESS_POLICIES } from '@geonerva/domain';
import type { HttpClient } from '@geonerva/http';
import { createSourceClient, usgsAdapter } from '@geonerva/sources';
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

/**
 * Dropped before every test, not only after the one that adds it: a leftover trigger poisons the
 * whole file, and the first run of this suite proved exactly how confusing that is to diagnose.
 */
const dropFailureTrigger = async (): Promise<void> => {
  await sql`DROP TRIGGER IF EXISTS test_fail_versions ON geonerva.observation_versions`.execute(db);
};

beforeEach(async () => {
  await dropFailureTrigger();
  await testDb.truncate();
});

/**
 * A client whose network is a function of the test, and whose everything else is real.
 *
 * The responder receives the `RequestInit` so it can honour the abort signal. A double that
 * ignores it does not behave like `fetch`, and a test for timeouts written against it hangs
 * instead of failing — which is exactly what happened the first time this was written.
 */
function clientServing(
  responder: (init?: RequestInit) => Response | Promise<Response>,
  overrides: Partial<Parameters<typeof createSourceClient>[1]> = {},
): HttpClient {
  return createSourceClient(usgsAdapter.descriptor, {
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    jitter: () => 1,
    fetchImpl: ((_input: unknown, init?: RequestInit) =>
      responder(init)) as unknown as typeof fetch,
    ...overrides,
  });
}

/** A request that answers only when cancelled, the way a real hung connection does. */
function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => {
      const reason: unknown = init?.signal?.reason;
      reject(reason instanceof Error ? reason : new DOMException('aborted', 'AbortError'));
    };
    if (init?.signal?.aborted === true) {
      fail();
      return;
    }
    init?.signal?.addEventListener('abort', fail, { once: true });
  });
}

function feedResponse(file: string): Response {
  const bytes = readFixtureBytes('usgs', file);
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function ingest(
  client: HttpClient,
  options: { signal?: AbortSignal } = {},
): Promise<RunOutcome> {
  return runIngestion({
    db,
    adapter: usgsAdapter,
    client,
    trigger: 'MANUAL',
    logger: createMemoryLogger(),
    ...options,
  });
}

/**
 * A digest of everything the ingestion writes.
 *
 * Comparing whole-table digests rather than a few counts is the point: a second run that changes
 * *anything* — an extra alias row, a re-inserted raw payload, a version with a new seq — shows up
 * here, and counting rows would not catch a replaced row.
 */
async function factDigest(): Promise<Record<string, string>> {
  const result = await sql<{ table_name: string; digest: string }>`
    SELECT 'versions' AS table_name,
           COALESCE(md5(string_agg(t.row::text, '|' ORDER BY t.row::text)), 'empty') AS digest
    FROM (
      SELECT (v.source_record_id, v.version_seq, v.observed_at, v.ingested_at, v.content_sha256,
              v.lifecycle_status, v.magnitude, v.depth_km, v.attributes) AS row
      FROM geonerva.observation_versions v
    ) t
    UNION ALL
    SELECT 'records',
           COALESCE(md5(string_agg(t.row::text, '|' ORDER BY t.row::text)), 'empty')
    FROM (
      SELECT (r.source_id, r.primary_key, r.hazard_type) AS row
      FROM geonerva.source_records r
    ) t
    UNION ALL
    SELECT 'aliases',
           COALESCE(md5(string_agg(t.row::text, '|' ORDER BY t.row::text)), 'empty')
    FROM (
      SELECT (a.source_id, a.alias) AS row FROM geonerva.source_record_aliases a
    ) t
    UNION ALL
    SELECT 'raw',
           COALESCE(md5(string_agg(t.row::text, '|' ORDER BY t.row::text)), 'empty')
    FROM (
      SELECT (w.source_id, w.payload_sha256) AS row FROM geonerva.raw_source_records w
    ) t
  `.execute(db);
  return Object.fromEntries(result.rows.map((row) => [row.table_name, row.digest]));
}

/**
 * Row counts, one literal query per table.
 *
 * The table name is never interpolated: `sql.raw` is banned outright (SECURITY.md C3), and a test
 * helper is not a good enough reason to make an exception to a rule about SQL injection.
 */
const COUNTS = {
  observation_versions: () =>
    sql<{ n: string }>`SELECT count(*)::text AS n FROM geonerva.observation_versions`,
  source_records: () => sql<{ n: string }>`SELECT count(*)::text AS n FROM geonerva.source_records`,
  raw_source_records: () =>
    sql<{ n: string }>`SELECT count(*)::text AS n FROM geonerva.raw_source_records`,
} as const;

async function countOf(table: keyof typeof COUNTS): Promise<number> {
  const result = await COUNTS[table]().execute(db);
  return Number(result.rows[0]?.n ?? '0');
}

describe('the descriptor matches what the database was seeded with', () => {
  it('names a product that exists, with a policy that exists', async () => {
    // Without this, a typo in `productCode` surfaces as CONFIG_ERROR at 03:00 rather than here.
    const product = await findProductByCode(
      db,
      usgsAdapter.descriptor.sourceId,
      usgsAdapter.descriptor.productCode,
    );
    expect(product, `no seeded product ${usgsAdapter.descriptor.productCode}`).not.toBeNull();
    expect(product?.hazardTypes).toContain(usgsAdapter.descriptor.hazardType);
    expect(Object.keys(INITIAL_FRESHNESS_POLICIES)).toContain(usgsAdapter.descriptor.policyKey);
    // Every capability the adapter claims must be one the seeded product actually has.
    for (const capability of usgsAdapter.descriptor.capabilities) {
      expect(product?.capabilities, `product does not declare ${capability}`).toContain(capability);
    }
  });
});

describe('a successful run', () => {
  it('ingests the captured feed and makes it visible through the as-of layer', async () => {
    const outcome = await ingest(clientServing(() => feedResponse('all_day.geojson')));

    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.counts).toMatchObject({
      received: 230,
      accepted: 230,
      rejected: 0,
      newRecords: 230,
      newVersions: 230,
      unchanged: 0,
    });
    expect(await countOf('observation_versions')).toBe(230);

    // The facts are only real if the one legitimate reader can see them.
    const visible = await observationsAsOf(db, { asOf: new Date() });
    expect(visible).toHaveLength(230);
  });

  it('stamps every version with the run’s committed_at, exactly', async () => {
    // observationsAsOf filters on ingested_at alone. If the batch stamp and committed_at could
    // drift apart there would be an instant where facts are visible but their run is not.
    await ingest(clientServing(() => feedResponse('all_day.geojson')));

    const mismatch = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM geonerva.observation_versions v
      JOIN geonerva.ingestion_runs r ON r.id = v.ingestion_run_id
      WHERE v.ingested_at <> r.committed_at
    `.execute(db);
    expect(mismatch.rows[0]?.n).toBe('0');

    const distinct = await sql<{ n: string }>`
      SELECT count(DISTINCT ingested_at)::text AS n FROM geonerva.observation_versions
    `.execute(db);
    expect(distinct.rows[0]?.n, 'one batch is one instant').toBe('1');
  });

  it('records the run as evidence even though nothing failed', async () => {
    const outcome = await ingest(clientServing(() => feedResponse('all_day.geojson')));
    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: outcome.runId,
      status: 'SUCCEEDED',
      counts: { received: 230, newRecords: 230, newVersions: 230, unchanged: 0, rejected: 0 },
    });
    expect(runs[0]?.newestObservedAt).not.toBeNull();
  });
});

describe('idempotency', () => {
  it('writes nothing new when the same feed is ingested twice', async () => {
    // The second run sees a byte-identical body, so it never even parses it.
    const client = clientServing(() => feedResponse('all_day.geojson'));
    await ingest(client);
    const digestAfterFirst = await factDigest();

    const second = await ingest(client);
    expect(second.status).toBe('SKIPPED');
    expect(await factDigest()).toStrictEqual(digestAfterFirst);
  });

  it('writes nothing new when an identical batch is re-parsed', async () => {
    // The harder case: force the body past the digest short-circuit by changing a byte the
    // adapter does not read, so every record really is re-normalized and re-persisted.
    const original = readFixtureBytes('usgs', 'all_day.geojson').toString('utf8');
    const parsedBody = JSON.parse(original) as { metadata: Record<string, unknown> };
    await ingest(clientServing(() => feedResponse('all_day.geojson')));
    const digestAfterFirst = await factDigest();

    parsedBody.metadata['generated'] = 1_789_999_999_999;
    const second = await ingest(
      clientServing(
        () =>
          new Response(JSON.stringify(parsedBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    expect(second.status).toBe('SUCCEEDED');
    expect(second.counts).toMatchObject({
      accepted: 230,
      newRecords: 0,
      newVersions: 0,
      unchanged: 230,
    });
    expect(await factDigest(), 'a re-run must be a no-op in every table').toStrictEqual(
      digestAfterFirst,
    );
  });

  it('writes nothing when the provider re-stamps updated without changing anything', async () => {
    /*
     * The realistic case, and the one a negative control showed was untested end to end: USGS
     * re-stamps `updated` on events whose content did not change. If the content hash included
     * it, every poll would manufacture 230 revisions, and "What Changed?" would fill with
     * changes that never happened (ADR-029).
     *
     * The test above only perturbs feed metadata, so it never exercises this. Here every
     * feature's own `updated` moves.
     */
    await ingest(clientServing(() => feedResponse('all_day.geojson')));
    const digestAfterFirst = await factDigest();

    const body = JSON.parse(readFixtureBytes('usgs', 'all_day.geojson').toString('utf8')) as {
      features: { properties: { updated: number } }[];
    };
    for (const feature of body.features) feature.properties.updated += 60_000;

    const second = await ingest(
      clientServing(
        () =>
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      ),
    );

    expect(second.status).toBe('SUCCEEDED');
    expect(second.counts).toMatchObject({ accepted: 230, newVersions: 0, unchanged: 230 });
    expect(await factDigest(), 'a re-stamp is not a revision').toStrictEqual(digestAfterFirst);
  });

  it('adds one version, and only one, for a real revision', async () => {
    await ingest(clientServing(() => feedResponse('revision-t0.geojson')));
    const afterFirst = await countOf('observation_versions');

    const second = await ingest(clientServing(() => feedResponse('revision-t1.geojson')));
    expect(second.status).toBe('SUCCEEDED');
    // Both captured events really did change between the two polls (both automatic → reviewed,
    // both with a new magnitude and position), so both earn exactly one new version — and no
    // record is duplicated, which is the property being tested.
    expect(second.counts.newVersions).toBe(2);
    expect(second.counts.unchanged).toBe(0);
    expect(second.counts.newRecords, 'a revision is not a new record').toBe(0);
    expect(await countOf('observation_versions')).toBe(afterFirst + 2);

    const versions = await sql<{ version_seq: number; provider_status: string }>`
      SELECT v.version_seq, v.provider_status
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE r.primary_key = 'hv75040342'
      ORDER BY v.version_seq
    `.execute(db);
    expect(versions.rows.map((row) => row.provider_status)).toStrictEqual([
      'automatic',
      'reviewed',
    ]);
    expect(
      versions.rows.map((row) => row.version_seq),
      'seq is gap-free',
    ).toStrictEqual([1, 2]);
  });

  it('keeps one record when a later feed uses a different preferred id', async () => {
    // The identity case that would otherwise double-count a single earthquake as two sources.
    const t0 = JSON.parse(readFixtureBytes('usgs', 'revision-t0.geojson').toString('utf8')) as {
      features: { id: string; properties: { ids: string } }[];
    };
    const first = t0.features[0];
    if (first === undefined) throw new Error('fixture should have a feature');
    const originalId = first.id;

    await ingest(
      clientServing(
        () => new Response(JSON.stringify(t0), { headers: { 'content-type': 'application/json' } }),
      ),
    );
    expect(await countOf('source_records')).toBe(t0.features.length);

    // USGS re-associates the event under a new preferred id, carrying the old one in `ids`.
    first.id = 'us9999renamed';
    first.properties.ids = `,${originalId},us9999renamed,`;
    const second = await ingest(
      clientServing(
        () => new Response(JSON.stringify(t0), { headers: { 'content-type': 'application/json' } }),
      ),
    );

    expect(second.status).toBe('SUCCEEDED');
    expect(second.counts.newRecords, 'the renamed event is not a new record').toBe(0);
    expect(await countOf('source_records')).toBe(t0.features.length);
    const aliases = await sql<{ alias: string }>`
      SELECT alias FROM geonerva.source_record_aliases WHERE alias IN (${originalId}, 'us9999renamed')
    `.execute(db);
    expect(aliases.rows).toHaveLength(2);
  });
});

describe('time semantics', () => {
  it('records an out-of-order arrival as knowledge, not as a correction', async () => {
    /*
     * A cached or replayed response can deliver *older* content after newer content. The
     * bitemporal model has a definite answer: observed_at is when the earthquake happened,
     * ingested_at is when we learned it, and the head is what the provider last told us. So the
     * stale body does create a version — refusing it would mean silently discarding something a
     * provider said, which is the one thing this pipeline must never do.
     */
    await ingest(clientServing(() => feedResponse('revision-t1.geojson')));
    const afterNewer = await sql<{ n: string; status: string }>`
      SELECT count(*)::text AS n, max(v.provider_status) AS status
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE r.primary_key = 'hv75040342'
    `.execute(db);
    expect(afterNewer.rows[0]?.status).toBe('reviewed');

    const late = await ingest(clientServing(() => feedResponse('revision-t0.geojson')));
    expect(late.status).toBe('SUCCEEDED');
    expect(late.counts.newVersions, 'the older content is still news to us').toBe(2);

    const versions = await sql<{ version_seq: number; provider_status: string; ingested_at: Date }>`
      SELECT v.version_seq, v.provider_status, v.ingested_at
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE r.primary_key = 'hv75040342'
      ORDER BY v.version_seq
    `.execute(db);
    expect(versions.rows.map((row) => row.provider_status)).toStrictEqual([
      'reviewed',
      'automatic',
    ]);
    // Knowledge time moves forward even though the content moved backwards.
    const [first, second] = versions.rows;
    expect(second?.ingested_at.getTime()).toBeGreaterThan(first?.ingested_at.getTime() ?? 0);

    // And replay still answers "what did we believe at T?" correctly for both instants.
    const atFirst = await observationsAsOf(db, { asOf: first?.ingested_at ?? new Date() });
    expect(atFirst.find((row) => row.primary_key === 'hv75040342')?.provider_status).toBe(
      'reviewed',
    );
    const atSecond = await observationsAsOf(db, { asOf: second?.ingested_at ?? new Date() });
    expect(atSecond.find((row) => row.primary_key === 'hv75040342')?.provider_status).toBe(
      'automatic',
    );
  });

  it('stores the same instants whatever the server timezone is set to', async () => {
    // A session TimeZone leaking into a timestamptz is how P2's partition bounds broke. The same
    // class of bug here would shift every observed_at by the server's offset.
    await sql`SET SESSION TimeZone = 'America/New_York'`.execute(db);
    try {
      await ingest(clientServing(() => feedResponse('all_day.geojson')));
      const row = await sql<{ observed_ms: string; primary_key: string }>`
        SELECT (extract(epoch FROM v.observed_at) * 1000)::bigint::text AS observed_ms,
               r.primary_key
        FROM geonerva.observation_versions v
        JOIN geonerva.source_records r ON r.id = v.source_record_id
        WHERE r.primary_key = 'nc75438582'
      `.execute(db);
      // The exact epoch millisecond from the captured feed, unshifted.
      expect(row.rows[0]?.observed_ms).toBe('1789850640280');
    } finally {
      await sql`SET SESSION TimeZone = 'UTC'`.execute(db);
    }
  });
});

describe('two features in one batch that are the same event', () => {
  it('collapses them into one record instead of inventing a second source', async () => {
    /*
     * USGS identity is the alias set, so two features whose `ids` intersect *are* one event —
     * ComCat associated them. The adapter cannot see that (it dedupes on the preferred id), so
     * the collapse happens at identity resolution, inside the batch, with both versions sharing
     * the batch stamp.
     *
     * The failure this guards against is the expensive one: two records for one earthquake would
     * later read as two independent sources agreeing, which is precisely the false confidence the
     * independence rule exists to prevent (ADR-030).
     */
    const t0 = JSON.parse(readFixtureBytes('usgs', 'revision-t0.geojson').toString('utf8')) as {
      features: { id: string; properties: { ids: string } }[];
    };
    const [first, second] = t0.features;
    if (first === undefined || second === undefined) throw new Error('fixture needs two features');

    // The second feature is re-associated with the first: different preferred id, shared alias.
    second.properties.ids = `,${second.id},${first.id},`;

    const outcome = await ingest(
      clientServing(
        () => new Response(JSON.stringify(t0), { headers: { 'content-type': 'application/json' } }),
      ),
    );

    expect(outcome.status).toBe('SUCCEEDED');
    expect(await countOf('source_records'), 'one event, one record').toBe(1);

    const aliases = await sql<{ alias: string }>`
      SELECT alias FROM geonerva.source_record_aliases ORDER BY alias
    `.execute(db);
    expect(
      aliases.rows.map((row) => row.alias).sort(),
      'every identifier still resolves to that record',
    ).toStrictEqual([first.id, second.id].sort());

    // Both statements are kept as versions of the one record, sharing the batch stamp.
    const distinctStamps = await sql<{ n: string }>`
      SELECT count(DISTINCT ingested_at)::text AS n FROM geonerva.observation_versions
    `.execute(db);
    expect(distinctStamps.rows[0]?.n).toBe('1');
  });
});

describe('failures are recorded, not swallowed', () => {
  it.each([
    [404, 'HTTP_4XX'],
    [500, 'HTTP_5XX'],
    [429, 'RATE_LIMITED'],
  ])('records an HTTP %s as %s', async (status, errorClass) => {
    const outcome = await ingest(clientServing(() => new Response('nope', { status })));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe(errorClass);

    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs[0]).toMatchObject({ status: 'FAILED', errorClass });
    expect(await countOf('observation_versions'), 'a failure writes no facts').toBe(0);
  });

  it('records a timeout without blaming the schema', async () => {
    const outcome = await ingest(clientServing(neverAnswers, { timeoutMs: 10 }));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('TIMEOUT');
  });

  it('records a cancellation as ABORTED, which is about us and not the source', async () => {
    const controller = new AbortController();
    const client = clientServing((init) => {
      controller.abort();
      return neverAnswers(init);
    });
    const outcome = await ingest(client, { signal: controller.signal });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('ABORTED');

    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs[0]?.errorClass, 'the run still commits, so the lease is released').toBe('ABORTED');
  });

  it.each([
    ['drift-truncated.json', 'SCHEMA_DRIFT'],
    ['drift-html-200.html', 'SCHEMA_DRIFT'],
    ['drift-empty-collection.json', 'EMPTY_SUSPICIOUS'],
  ])('fails the batch for %s and writes nothing', async (file, errorClass) => {
    const outcome = await ingest(clientServing(() => feedResponse(file)));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe(errorClass);
    expect(await countOf('observation_versions')).toBe(0);
    expect(await countOf('source_records')).toBe(0);
    expect(await countOf('raw_source_records')).toBe(0);
  });

  it('keeps a good batch that contains one bad record, and says so', async () => {
    const outcome = await ingest(clientServing(() => feedResponse('drift-missing-required.json')));
    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.counts).toMatchObject({ accepted: 229, rejected: 1 });
    expect(await countOf('observation_versions')).toBe(229);

    const rejects = await sql<{ reason_code: string }>`
      SELECT reason_code FROM geonerva.ingestion_rejects
    `.execute(db);
    expect(rejects.rows.map((row) => row.reason_code)).toStrictEqual(['SCHEMA_INVALID']);
  });
});

describe('a misconfigured deployment', () => {
  it('fails as CONFIG_ERROR and writes no run row at all', async () => {
    /*
     * An adapter naming a product the database has never heard of. Guessing a product id would
     * attach real facts to the wrong feed, so the run refuses to start.
     *
     * Nothing is written, which is the part worth pinning: this failure is invisible in source
     * health precisely because there is no run row and no product to hang one on. The operator's
     * only signal is the log line and the worker's non-zero exit code (see exitCodeFor), and
     * that is why CONFIG_ERROR is the one class the CLI does not treat as routine.
     */
    const misconfigured = {
      ...usgsAdapter,
      descriptor: { ...usgsAdapter.descriptor, productCode: 'does-not-exist' },
    };

    const outcome = await runIngestion({
      db,
      adapter: misconfigured,
      client: clientServing(() => feedResponse('all_day.geojson')),
      trigger: 'MANUAL',
      logger: createMemoryLogger(),
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('CONFIG_ERROR');
    expect(outcome.runId).toBeNull();
    expect(await listRecentRuns(db, { sourceId: 'usgs' })).toHaveLength(0);
    expect(await countOf('observation_versions')).toBe(0);
  });
});

describe('the lease', () => {
  it('refuses a second concurrent run without writing a row', async () => {
    const client = clientServing(() => feedResponse('all_day.geojson'));
    const [first, second] = await Promise.all([ingest(client), ingest(client)]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toStrictEqual(['LEASE_HELD', 'SUCCEEDED']);
    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs, 'the refused attempt is not a run').toHaveLength(1);
  });
});

describe('a database failure mid-persist', () => {
  /**
   * Breaks the *second* statement of the persist transaction, after raw payloads are inserted.
   * A trigger is the only honest way to do this: it fails inside the real transaction, exactly
   * where a disk error or a constraint violation would, and lets the rollback be observed.
   */
  async function breakVersionInserts(): Promise<void> {
    await sql`
      CREATE OR REPLACE FUNCTION geonerva.test_fail_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure during persistence';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS test_fail_versions ON geonerva.observation_versions;
      CREATE TRIGGER test_fail_versions BEFORE INSERT ON geonerva.observation_versions
        FOR EACH ROW EXECUTE FUNCTION geonerva.test_fail_insert();
    `.execute(db);
  }

  it('rolls the whole batch back, closes the run, and recovers on the next poll', async () => {
    const client = clientServing(() => feedResponse('all_day.geojson'));
    await breakVersionInserts();

    const failed = await ingest(client).finally(() => undefined);
    expect(failed.status).toBe('FAILED');
    expect(failed.errorClass).toBe('DB_ERROR');

    // Nothing survives the rollback — not the raw payloads written earlier in the transaction.
    expect(await countOf('observation_versions')).toBe(0);
    expect(await countOf('source_records')).toBe(0);
    expect(await countOf('raw_source_records')).toBe(0);

    // The run row is committed outside the failed transaction, so the product is not left leased.
    const runs = await listRecentRuns(db, { sourceId: 'usgs' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'FAILED', errorClass: 'DB_ERROR' });

    await dropFailureTrigger();

    // The payload digest of a failed run is never stored, so the next poll re-ingests the body
    // rather than mistaking it for "nothing changed" — the recovery that matters.
    const recovered = await ingest(client);
    expect(recovered.status).toBe('SUCCEEDED');
    expect(recovered.counts.newVersions).toBe(230);
    expect(await countOf('observation_versions')).toBe(230);
  });
});
