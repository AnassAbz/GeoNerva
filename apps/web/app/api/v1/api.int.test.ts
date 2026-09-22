/**
 * The `/api/v1` endpoints against a real PostGIS database, through the HTTP boundary.
 *
 * These call the exported route handlers with real `Request` objects, so everything between the
 * query string and the response bytes runs: validation, the service layer, the as-of reads, the
 * SQL, the read-model assembly, the cache headers. A test that called `getBriefing` directly would
 * skip the half of P8 that is the adapter.
 *
 * Five properties are asserted from the outside, and each of them is a claim the product makes:
 *
 *  1. **Replay never sees the future** (invariant I2). A knowledge time before a record was
 *     ingested must not show it — not in a briefing, not in a health status, not through the
 *     evidence endpoint.
 *  2. **An absence is never a zero** (invariant I11). "No relevant hazards" and "we cannot see"
 *     are different answers, and the second must never be rendered as the first.
 *  3. **Every citation resolves** (invariant I9). Every evidence ID in a response is in that
 *     response's manifest, and every primary one resolves through `/evidence/{id}`.
 *  4. **No user coordinate is served at more than two decimals** (invariant I15), anywhere in any
 *     response.
 *  5. **The process is read-only.** Every verb but GET and HEAD is a 405 in problem+json, and the
 *     read path holds no statement that writes a fact.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCanonicalEvent,
  createDb,
  linkRecord,
  upsertRawRecords,
  type DB,
} from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation, seedRun } from '@geonerva/db/testing/factories';
import { loadWebConfig } from '@geonerva/config';
import {
  PROBLEM_MEDIA_TYPE,
  READ_MODEL_SCHEMA_VERSION,
  evidenceDetailSchema,
} from '@geonerva/domain';

import { setWebConfigForTesting } from '../../../lib/server/config.ts';
import { setDatabaseForTesting } from '../../../lib/server/db.ts';
import { RATE_LIMITS, checkRateLimit } from '../../../lib/server/rate-limit.ts';
import type { DatabaseHandle } from '@geonerva/db/client';
import { GET as briefing } from './briefing/route.ts';
import { GET as evidence } from './evidence/[id]/route.ts';
import { GET as replayHorizon } from './replay/horizon/route.ts';
import { GET as sourcesStatus } from './sources/status/route.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

/*
 * A knowledge-time line the whole file shares. Everything is stated relative to `NOW` so that no
 * assertion depends on the wall clock: a test that seeds "an hour ago" and asserts freshness
 * against `new Date()` passes or fails by what time of day it runs, which is a lesson this
 * repository has already learned once (the FIRMS `acq_time` case at 00:07 UTC).
 */
const NOW = new Date('2026-09-21T12:00:00.000Z');
const QUAKE_AT = new Date('2026-09-21T11:40:00.000Z');
const INGEST = new Date('2026-09-21T11:45:00.000Z');
/** Before anything was ingested: the replay that must see nothing. */
const BEFORE = new Date('2026-09-21T11:00:00.000Z');

/** Marrakech, rounded to the two decimals the API serves. ECCC does not cover it. */
const LAT = 31.63;
const LON = -8.0;

/** The only USGS product the migrations seed. */
const USGS_PRODUCT = 'comcat';

/**
 * A validated configuration, so the rate limiter has a secret to derive keys from.
 *
 * Loaded through `loadWebConfig` rather than hand-written, because the limiter depends on the
 * secret passing the entropy and length checks in `packages/config` — a test that bypassed the
 * loader could pass against a secret production would refuse.
 */
const TEST_CONFIG = loadWebConfig({
  DATABASE_URL: 'postgresql://web:pw@127.0.0.1:54320/geonerva_test',
  RATE_LIMIT_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // gitleaks:allow
  NOMINATIM_CONTACT: 'https://example.org/geonerva-contact',
});

/**
 * A distinct caller per test, so one test's spent window is not another's.
 *
 * The bucket is keyed on an IP `/24`, so incrementing the third octet is what gives each test its
 * own budget. Sharing one address across the file would make the tests order-dependent — the
 * sixty-first briefing in the file would be refused wherever it happened to fall.
 */
let callerIndex = 0;
function freshCaller(): Headers {
  callerIndex += 1;
  return new Headers({ 'x-forwarded-for': `203.0.${String(callerIndex)}.42` });
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

/** Builds the request the handler sees. `now` is not injectable, so `as_of` carries the timeline. */
function request(path: string, init?: RequestInit): Request {
  return new Request(`https://geonerva.test${path}`, {
    headers: freshCaller(),
    ...init,
  });
}

/** A request from a caller the test controls, for the rate-limit cases. */
function requestAs(path: string, headers: Headers, init?: RequestInit): Request {
  return new Request(`https://geonerva.test${path}`, { headers, ...init });
}

/**
 * The handle the route handlers will find.
 *
 * `close` does nothing on purpose: `afterAll` owns the pool, and a handler that closed it would
 * take the rest of the file with it.
 */
function testHandle(): DatabaseHandle {
  return {
    db,
    pool: testDb.pool,
    target: 'test',
    close: () => Promise.resolve(),
  };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * The response typed as the frozen contract, for the assertions that read into it.
 *
 * Deliberately **not** the real `SourceStatus` import: these tests assert what crossed the wire,
 * and typing the parsed JSON as the contract would make the compiler agree with a response that
 * actually shipped something else. This is a narrow structural view of the fields under test.
 */
interface StatusEntryView {
  readonly sourceId: string;
  readonly health: {
    readonly status: string;
    readonly lastAttemptAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly evidenceId: string | null;
  };
  readonly products: readonly {
    readonly id: number;
    readonly code: string;
    readonly health: { readonly status: string; readonly evidenceId: string | null };
  }[];
  readonly recentRuns: readonly {
    readonly status: string;
    readonly errorClass: string | null;
    readonly committedAt: string;
    readonly evidenceId: string;
  }[];
  readonly successRate24h: number | null;
  readonly runCount24h: number;
}

async function statusOf(query = ''): Promise<{
  readonly sources: readonly StatusEntryView[];
  readonly body: Record<string, unknown>;
}> {
  const response = await sourcesStatus(request(`/api/v1/sources/status${query}`));
  const body = (await response.json()) as Record<string, unknown>;
  const sources = body['sources'];
  if (!Array.isArray(sources)) {
    throw new Error(`expected a source list, got ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { sources: sources as readonly StatusEntryView[], body };
}

function sourceIn(sources: readonly StatusEntryView[], sourceId: string): StatusEntryView {
  const entry = sources.find((source) => source.sourceId === sourceId);
  if (entry === undefined) throw new Error(`the response omitted the source ${sourceId}`);
  return entry;
}

/** The product id of one source product, so a seeded run attaches to the right feed. */
async function productId(sourceId: string, code: string): Promise<number | null> {
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = ${sourceId} AND code = ${code}
  `.execute(db);
  return result.rows[0]?.id ?? null;
}

/**
 * A committed, successful run for one product, so that product is healthy at `at`.
 *
 * The `productId` lookup throwing rather than returning null is deliberate. It silently returned
 * null for a product code that does not exist, which seeded the run at the *source* level and left
 * the product with no runs — so the source rollup read `UNAVAILABLE`, correctly, and three tests
 * asserted `FRESH` against it. A fixture that cannot find what it was asked for must fail loudly.
 */
async function healthyRun(sourceId: string, code: string, at = INGEST): Promise<string> {
  const product = await productId(sourceId, code);
  if (product === null) throw new Error(`no product ${sourceId}/${code} is seeded`);
  const { runId } = await seedRun(db, {
    sourceId,
    productId: product,
    status: 'SUCCEEDED',
    startedAt: at,
    newestObservedAt: QUAKE_AT,
  });
  return runId;
}

/**
 * A finished derivation, so a family is not reported unavailable for never having been assessed.
 *
 * `resolveAvailability` has a derivation axis: a family whose analysis has never run is not
 * `AVAILABLE`, however healthy its sources are. Without this the earthquake card is empty for a
 * reason that has nothing to do with the earthquake.
 */
async function derivationRan(
  kind: 'CORRELATION' | 'CLUSTERING' | 'SEED',
  finishedAt = INGEST,
): Promise<void> {
  await sql`
    INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
    VALUES (gen_random_uuid(), ${kind}, 'geonerva-1', ${finishedAt}, ${finishedAt}, 'SUCCEEDED')
  `.execute(db);
}

/**
 * One earthquake near Marrakech, linked to its own canonical event.
 *
 * The link is not optional decoration: a family card lists **canonical events**, so an
 * unlinked observation is invisible to the briefing however well it scores. Correlation is the
 * worker's job, so a read-path test has to stand in for it.
 */
async function seedQuake(primaryKey = 'us7000tikb'): Promise<{
  readonly versionId: string;
  readonly publicId: string;
}> {
  const seeded = await seedObservation(db, {
    sourceId: 'usgs',
    productId: await productId('usgs', USGS_PRODUCT),
    primaryKey,
    aliases: [primaryKey],
    ingestedAt: INGEST,
    observedAt: QUAKE_AT,
    /* ~55 km north: inside the earthquake search radius and well above the noise floor. */
    centroid: { lat: LAT + 0.5, lon: LON },
    magnitude: 5.4,
    magnitudeType: 'mww',
    depthKm: 10,
    providerStatus: 'reviewed',
    contributor: 'us',
  });

  const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: INGEST });
  await db.transaction().execute(async (trx) => {
    await linkRecord(trx, {
      canonicalEventId: event.id,
      sourceRecordId: seeded.sourceRecordId,
      relation: 'PRIMARY',
      matchKind: 'SPATIOTEMPORAL',
      algorithmVersion: 'eq-corr-1',
      linkedAt: INGEST,
    });
  });

  return { versionId: seeded.versionId, publicId: event.publicId };
}

/** How many rows the counter table holds, which is the only thing the web role may write. */
async function bucketCount(): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM geonerva.rate_limit_buckets
  `.execute(db);
  return result.rows[0]?.n ?? 0;
}

/** Walks a response for every `lat`/`lon` value, wherever it is nested (invariant I15). */
function coordinatesIn(value: unknown, found: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const entry of value) coordinatesIn(entry, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'lat' || key === 'lon') && typeof entry === 'number') found.push(entry);
      else coordinatesIn(entry, found);
    }
  }
  return found;
}

function decimals(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

describe('GET /api/v1/replay/horizon', () => {
  it('returns the frozen ReplayHorizonResponse wrapper, not the bare horizon', async () => {
    const response = await replayHorizon(request('/api/v1/replay/horizon'));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'horizon', 'schemaVersion']);
    expect(body['schemaVersion']).toBe(READ_MODEL_SCHEMA_VERSION);
    expect((body['horizon'] as { profile: string }).profile).toBe('lean');
  });

  it('names an earliest replayable time for every family', async () => {
    const body = await bodyOf(await replayHorizon(request('/api/v1/replay/horizon')));
    const byFamily = (
      body['horizon'] as {
        byFamily: Record<string, { earliestAsOf: string; note: string } | undefined>;
      }
    ).byFamily;
    for (const family of [
      'EARTHQUAKES',
      'FIRE_ACTIVITY',
      'FLOODS',
      'CYCLONES',
      'WEATHER_ALERTS',
      'OTHER',
    ]) {
      expect(Number.isNaN(Date.parse(byFamily[family]?.earliestAsOf ?? ''))).toBe(false);
      expect((byFamily[family]?.note ?? '').length).toBeGreaterThan(0);
    }
  });

  it('carries §13.1s hour-long cache policy', async () => {
    const response = await replayHorizon(request('/api/v1/replay/horizon'));
    expect(response.headers.get('cache-control')).toBe(
      's-maxage=3600, stale-while-revalidate=3600',
    );
  });

  it('rejects a parameter it does not declare', async () => {
    const response = await replayHorizon(
      request('/api/v1/replay/horizon?as_of=2026-01-01T00:00:00Z'),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response))['code']).toBe('UNKNOWN_PARAMETER');
  });

  /**
   * It reads no facts, so it answers with no database — even though it is rate limited.
   *
   * The limiter needs the counter table, and acquiring the handle is what fails here. That failure
   * is a *limiter* outage rather than a request failure, so it fails open: the endpoint answers and
   * publishes no budget. An endpoint that 500ed on a counter it did not need would be the wrong
   * trade for the one endpoint a client calls to discover every other endpoint's bounds.
   */
  it('answers without touching the database, failing the limiter open', async () => {
    setDatabaseForTesting(null);
    const previous = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      const response = await replayHorizon(request('/api/v1/replay/horizon'));
      expect(response.status).toBe(200);
      /* Still the endpoint's own cache policy: a limiter outage must not change the answer. */
      expect(response.headers.get('cache-control')).toBe(
        's-maxage=3600, stale-while-revalidate=3600',
      );
    } finally {
      if (previous !== undefined) process.env['DATABASE_URL'] = previous;
      setDatabaseForTesting(testHandle());
    }
  });
});

describe('the API is read-only', () => {
  const handlers: readonly [string, (request: Request) => Promise<Response>, string][] = [
    ['briefing', briefing, `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}`],
    ['sources-status', sourcesStatus, '/api/v1/sources/status'],
    ['replay-horizon', replayHorizon, '/api/v1/replay/horizon'],
    ['evidence', evidence, '/api/v1/evidence/EV:OBS:1'],
  ];

  it.each(handlers)('%s refuses POST in problem+json', async (_name, handler, path) => {
    const response = await handler(request(path, { method: 'POST' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await bodyOf(response);
    expect(body['code']).toBe('METHOD_NOT_ALLOWED');
    expect(body['detail']).toContain('read-only');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('refuses %s', async (method) => {
    const response = await sourcesStatus(request('/api/v1/sources/status', { method }));
    expect(response.status).toBe(405);
  });

  /*
   * The method check runs before validation, so a malformed write attempt is refused as a write
   * rather than as a bad request. A 400 here would tell a prober that the verb was acceptable.
   */
  /**
   * A rejected verb produces a log line like any other outcome.
   *
   * The 405 returned before `logRequest`, which made "one structured line per request" false for
   * exactly the requests an operator most wants to see: an attempt to write to a read-only API.
   */
  it('logs a rejected method', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await sourcesStatus(request('/api/v1/sources/status', { method: 'POST' }));
    } finally {
      spy.mockRestore();
    }

    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = logged.find((line) => line['event'] === 'api.request');
    expect(entry).toMatchObject({ status: 405, path: '/api/v1/sources/status' });
  });

  it('refuses a write before validating its parameters', async () => {
    const response = await briefing(request('/api/v1/briefing?nonsense=1', { method: 'DELETE' }));
    expect((await bodyOf(response))['code']).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('GET /api/v1/sources/status', () => {
  it('reports every seeded source with its licence, in a canonical order', async () => {
    const { sources } = await statusOf();
    const withLicence = sources as readonly (StatusEntryView & { licence: string })[];
    expect(withLicence.length).toBeGreaterThan(0);
    for (const source of withLicence) expect(source.licence.length).toBeGreaterThan(0);
    expect(sources.map((source) => source.sourceId)).toEqual(
      [...sources.map((source) => source.sourceId)].sort(),
    );
  });

  /*
   * The false-green case, end to end. A truncated database has no runs at all, so no source may
   * report FRESH and none may report a success rate.
   */
  it('reports no source as FRESH when nothing has ever run', async () => {
    const { sources } = await statusOf();
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.health.status).not.toBe('FRESH');
      expect(source.successRate24h).toBeNull();
      expect(source.runCount24h).toBe(0);
    }
  });

  it('reports a source FRESH once a run has committed, with the rate and its denominator', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const { sources } = await statusOf(`?as_of=${NOW.toISOString()}`);
    const usgs = sourceIn(sources, 'usgs');

    expect(usgs.health.status).toBe('FRESH');
    expect(usgs.health.lastSuccessAt).toBe(INGEST.toISOString());
    expect(usgs.successRate24h).toBe(1);
    expect(usgs.runCount24h).toBe(1);
    expect(usgs.recentRuns).toHaveLength(1);
    expect(usgs.recentRuns[0]?.status).toBe('SUCCEEDED');
    /* The product carries its own judgement, and the rollup agrees when it is the only one. */
    expect(usgs.products.map((product) => product.health.status)).toEqual(['FRESH']);
  });

  /**
   * "Worst product wins", demonstrated across two sources rather than asserted about one.
   *
   * GDACS has six products and this seeds a run for one of them, so its rollup must **not** read
   * FRESH while five feeds have never delivered. This is the rule that stops a source with one
   * dead feed reading as "mostly fine", and it is the reason a rollup is not an average.
   */
  it('does not report a source FRESH while one of its products has never run', async () => {
    await healthyRun('gdacs', 'EQ');
    const { sources } = await statusOf(`?as_of=${NOW.toISOString()}`);
    const gdacs = sourceIn(sources, 'gdacs');

    const byCode = new Map(gdacs.products.map((product) => [product.code, product.health.status]));
    expect(byCode.get('EQ')).toBe('FRESH');
    expect(byCode.get('FL')).toBe('UNAVAILABLE');
    expect(gdacs.health.status).toBe('UNAVAILABLE');
  });

  /**
   * The degradation ladder, driven by the clock rather than by a status column.
   *
   * Health is derived (ADR-022), so the only way to produce `STALE` or `UNAVAILABLE` is to move
   * the knowledge time away from the last success. This walks one seeded run forward in time and
   * asserts the status worsens monotonically — which is the property the `/data-status` page
   * exists to show, and the one a stored status column could not have.
   */
  it('degrades from FRESH through to UNAVAILABLE as the last success recedes', async () => {
    /*
     * The **run** moves backwards, not the knowledge time forwards.
     *
     * Asking for a knowledge time 26 hours after a run seeded "now minus fifteen minutes" is
     * asking about tomorrow, which `parseAsOf` correctly refuses — so the first version of this
     * test was measuring `AS_OF_IN_FUTURE`, not degradation. Seeding the success further and
     * further in the past and asking at a fixed `asOf` states the same property and is always in
     * the past by construction.
     */
    const severity = { FRESH: 0, DEGRADED: 1, STALE: 2, UNAVAILABLE: 3 } as const;
    const statusAfter = async (ageMs: number): Promise<keyof typeof severity> => {
      await testDb.truncate();
      await healthyRun('usgs', USGS_PRODUCT, new Date(NOW.getTime() - ageMs));
      const { sources } = await statusOf(`?as_of=${NOW.toISOString()}`);
      return sourceIn(sources, 'usgs').health.status as keyof typeof severity;
    };

    const ladder = [
      await statusAfter(60_000),
      await statusAfter(2 * 60 * 60 * 1000),
      await statusAfter(26 * 60 * 60 * 1000),
    ];

    expect(ladder[0]).toBe('FRESH');
    expect(ladder[2]).toBe('UNAVAILABLE');
    expect(severity[ladder[0]!]).toBeLessThanOrEqual(severity[ladder[1]!]);
    expect(severity[ladder[1]!]).toBeLessThanOrEqual(severity[ladder[2]!]);
  });

  /*
   * Invariant I2 at the API boundary. A run committed at 11:45 must be invisible at 11:00 — not
   * reported as a failure, not reported at all.
   */
  it('does not show a run that had not committed at the requested knowledge time', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const { sources, body } = await statusOf(`?as_of=${BEFORE.toISOString()}`);
    const usgs = sourceIn(sources, 'usgs');

    expect(usgs.recentRuns).toEqual([]);
    expect(usgs.health.lastAttemptAt).toBeNull();
    expect(usgs.runCount24h).toBe(0);
    expect(body['asOfContext']).toMatchObject({ asOf: BEFORE.toISOString() });
  });

  it('reports a failed run with its error class and never its message', async () => {
    await seedRun(db, {
      sourceId: 'usgs',
      productId: await productId('usgs', USGS_PRODUCT),
      status: 'FAILED',
      startedAt: INGEST,
      errorClass: 'HTTP_5XX',
    });
    const raw = await (
      await sourcesStatus(request(`/api/v1/sources/status?as_of=${NOW.toISOString()}`))
    ).text();
    const parsed = JSON.parse(raw) as { sources: readonly StatusEntryView[] };
    const usgs = sourceIn(parsed.sources, 'usgs');

    expect(usgs.recentRuns[0]).toMatchObject({ status: 'FAILED', errorClass: 'HTTP_5XX' });
    expect(raw).not.toContain('errorMessage');
  });

  /*
   * A PARTIAL run did not do its job. Folding it into the success rate would hide exactly the
   * slow degradation this page exists to show.
   */
  it('does not count a PARTIAL run as a success', async () => {
    await seedRun(db, {
      sourceId: 'usgs',
      productId: await productId('usgs', USGS_PRODUCT),
      status: 'PARTIAL',
      startedAt: INGEST,
      newestObservedAt: QUAKE_AT,
    });
    const { sources } = await statusOf(`?as_of=${NOW.toISOString()}`);
    const usgs = sourceIn(sources, 'usgs');
    expect(usgs.successRate24h).toBe(0);
    expect(usgs.runCount24h).toBe(1);
  });

  /** Invariant I9 through the API: every id the response cites is in the response's manifest. */
  it('resolves every evidence id it cites', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const { sources, body } = await statusOf(`?as_of=${NOW.toISOString()}`);
    const manifest = new Set((body['evidenceManifest'] as { id: string }[]).map((item) => item.id));
    const cited = new Set<string>();
    for (const source of sources) {
      if (source.health.evidenceId !== null) cited.add(source.health.evidenceId);
      for (const product of source.products) {
        if (product.health.evidenceId !== null) cited.add(product.health.evidenceId);
      }
      for (const run of source.recentRuns) cited.add(run.evidenceId);
    }

    expect(cited.size).toBeGreaterThan(0);
    expect([...cited].filter((id) => !manifest.has(id))).toEqual([]);
  });

  /* The run list is bounded per source, so the response size cannot grow with uptime. */
  it('bounds the recent runs per source', async () => {
    for (let index = 0; index < 14; index += 1) {
      await seedRun(db, {
        sourceId: 'usgs',
        productId: await productId('usgs', USGS_PRODUCT),
        status: 'SUCCEEDED',
        startedAt: new Date(INGEST.getTime() - index * 60_000),
        newestObservedAt: QUAKE_AT,
      });
    }
    const { sources } = await statusOf(`?as_of=${NOW.toISOString()}`);
    const usgs = sourceIn(sources, 'usgs');
    expect(usgs.recentRuns).toHaveLength(10);
    expect(usgs.runCount24h).toBe(14);
  });

  it('lists the newest run first', async () => {
    for (const offset of [0, 60_000, 120_000]) {
      await seedRun(db, {
        sourceId: 'usgs',
        productId: await productId('usgs', USGS_PRODUCT),
        status: 'SUCCEEDED',
        startedAt: new Date(INGEST.getTime() - offset),
        newestObservedAt: QUAKE_AT,
      });
    }
    const { sources } = await statusOf(`?as_of=${NOW.toISOString()}`);
    const times = sourceIn(sources, 'usgs').recentRuns.map((run) => Date.parse(run.committedAt));
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });

  it('reports no worker heartbeat rather than a fabricated one', async () => {
    const body = await bodyOf(await sourcesStatus(request('/api/v1/sources/status')));
    expect(body['worker']).toBeNull();
  });

  it('reports a seeded heartbeat with its staleness judged at the knowledge time', async () => {
    await sql`
      INSERT INTO geonerva.worker_heartbeat (id, last_seen_at, version)
      VALUES (true, ${new Date(NOW.getTime() - 30_000)}, 'worker-test')
    `.execute(db);
    const body = await bodyOf(
      await sourcesStatus(request(`/api/v1/sources/status?as_of=${NOW.toISOString()}`)),
    );
    expect(body['worker']).toMatchObject({ version: 'worker-test', isStale: false });
  });

  /*
   * The heartbeat row is updated in place and has no history, so a replay cannot state worker
   * liveness — and must not answer with the *present* heartbeat instead. `null` here means
   * "GeoNerva cannot say", which is documented on `workerHeartbeatAsOf`.
   */
  it('withholds a heartbeat stamped after the requested knowledge time', async () => {
    await sql`
      INSERT INTO geonerva.worker_heartbeat (id, last_seen_at, version)
      VALUES (true, ${NOW}, 'worker-test')
    `.execute(db);
    const { body } = await statusOf(`?as_of=${BEFORE.toISOString()}`);
    expect(body['worker']).toBeNull();
  });

  it('reports no data-quality checks rather than fabricating passing ones', async () => {
    const body = await bodyOf(await sourcesStatus(request('/api/v1/sources/status')));
    expect(body['dataQuality']).toEqual([]);
  });

  it('carries §13.1s sixty-second cache policy', async () => {
    const response = await sourcesStatus(request('/api/v1/sources/status'));
    expect(response.headers.get('cache-control')).toBe('s-maxage=60, stale-while-revalidate=120');
  });

  it('refuses a future knowledge time', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await sourcesStatus(request(`/api/v1/sources/status?as_of=${future}`));
    expect(response.status).toBe(400);
    expect((await bodyOf(response))['code']).toBe('AS_OF_IN_FUTURE');
  });

  /*
   * A knowledge time past the retention horizon still has a true answer here — GeoNerva committed
   * no runs that long ago — so this endpoint must answer rather than refuse. Refusing would hide
   * the boundary the page exists to show.
   */
  it('answers for a knowledge time older than the replay horizon', async () => {
    const response = await sourcesStatus(
      request('/api/v1/sources/status?as_of=2019-01-01T00:00:00Z'),
    );
    expect(response.status).toBe(200);
  });
});

describe('GET /api/v1/briefing', () => {
  it('reports a seeded earthquake for a nearby location', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    await derivationRan('CORRELATION');
    await seedQuake();
    const response = await briefing(
      request(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${NOW.toISOString()}`),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body['schemaVersion']).toBe(READ_MODEL_SCHEMA_VERSION);
    const families = body['snapshot'] as { families: Record<string, { items: unknown[] }> };
    expect(families.families['EARTHQUAKES']?.items.length).toBeGreaterThan(0);
  });

  /**
   * Invariant I11 at the API boundary, in the direction that matters.
   *
   * At a knowledge time before any run committed, the earthquake card must not read "zero
   * earthquakes". It must report that GeoNerva could not look — a non-`AVAILABLE` availability
   * family, empty items, and no rendered count.
   */
  it('reports an unavailable family rather than a zero when no source had run', async () => {
    await seedQuake();
    const body = await bodyOf(
      await briefing(
        request(
          `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${BEFORE.toISOString()}`,
        ),
      ),
    );
    const card = (
      body['snapshot'] as {
        families: Record<
          string,
          { availability: string; items: unknown[]; itemsTotal: number } | undefined
        >;
      }
    ).families['EARTHQUAKES'];

    expect(card?.availability).not.toBe('AVAILABLE');
    expect(card?.items).toEqual([]);
    /*
     * Invariant I11's second half. `itemsTotal` is the number a UI would render, and for a
     * non-AVAILABLE family it must be 0 *and* never shown — the contract is that the card reports
     * why it cannot answer, so this asserts the API does not hand the UI a zero to display.
     */
    expect(card?.itemsTotal).toBe(0);
  });

  /*
   * Invariant I2. The quake was ingested at 11:45; a briefing for 11:00 must not contain it, and
   * must not contain its evidence id either.
   */
  it('does not show a record ingested after the requested knowledge time', async () => {
    await healthyRun('usgs', USGS_PRODUCT, BEFORE);
    const { versionId } = await seedQuake();
    const raw = await (
      await briefing(
        request(
          `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${BEFORE.toISOString()}`,
        ),
      )
    ).text();

    expect(raw).not.toContain(`EV:OBS:${versionId}`);
    expect(raw).not.toContain('us7000tikb');
  });

  /** Invariant I15, asserted over every coordinate anywhere in the response. */
  it('serves no coordinate at more than two decimals', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    await derivationRan('CORRELATION');
    await seedQuake();
    const body = await bodyOf(
      await briefing(
        request(
          `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${NOW.toISOString()}`,
        ),
      ),
    );
    const coordinates = coordinatesIn(body);
    expect(coordinates.length).toBeGreaterThan(0);
    for (const value of coordinates) expect(decimals(value)).toBeLessThanOrEqual(2);
  });

  /**
   * A precise coordinate is **refused**, not rounded.
   *
   * Rounding it on arrival made the response body clean — invariant I15 held there — and left the
   * caller's ~10 cm position as the CDN cache key and in the platform's own access log, which
   * `log.ts` cannot reach. ADR-015 says "before logging, caching or querying", and no server can
   * round before the URL reaches the edge, so the boundary requires a canonical coordinate instead.
   */
  it('refuses a precise request coordinate rather than rounding it', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const response = await briefing(
      request(`/api/v1/briefing?lat=31.629512&lon=-7.981084&as_of=${NOW.toISOString()}`),
    );
    const raw = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = JSON.parse(raw) as { code: string; invalidParams: { name: string }[] };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.invalidParams.map((entry) => entry.name)).toEqual(['lat', 'lon']);
    /* And the refusal must not echo the position it refused. */
    expect(raw).not.toContain('629512');
    expect(raw).not.toContain('981084');
  });

  it('serves a briefing for the rounded form of the same request', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const body = await bodyOf(
      await briefing(request(`/api/v1/briefing?lat=31.63&lon=-7.98&as_of=${NOW.toISOString()}`)),
    );
    expect(body['location'] as { lat: number; lon: number }).toMatchObject({
      lat: 31.63,
      lon: -7.98,
    });
  });

  /** Invariant I9: every id anywhere in the briefing is in the briefing's own manifest. */
  it('carries a manifest entry for every evidence id it cites', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    await derivationRan('CORRELATION');
    await seedQuake();
    const body = await bodyOf(
      await briefing(
        request(
          `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${NOW.toISOString()}`,
        ),
      ),
    );
    const manifest = new Set((body['evidenceManifest'] as { id: string }[]).map((item) => item.id));
    const cited = [...JSON.stringify(body).matchAll(/EV:[A-Z]{3}:[0-9a-f:.-]+/gu)].map(
      (match) => match[0],
    );

    expect(cited.length).toBeGreaterThan(0);
    expect([...new Set(cited)].filter((id) => !manifest.has(id))).toEqual([]);
  });

  it('never states that the user is safe', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const raw = await (
      await briefing(
        request(
          `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${NOW.toISOString()}`,
        ),
      )
    ).text();
    expect(raw.toLowerCase()).not.toMatch(/\byou (are|'re) safe\b/u);
    expect(raw.toLowerCase()).not.toContain('no danger');
  });

  it('runs with no AI and reports none', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const body = await bodyOf(
      await briefing(
        request(
          `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${NOW.toISOString()}`,
        ),
      ),
    );
    expect(body['ai']).toBeNull();
  });

  it('caches a live briefing for two minutes and a replay as immutable', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const live = await briefing(request(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}`));
    expect(live.headers.get('cache-control')).toBe('s-maxage=120, stale-while-revalidate=600');

    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const replay = await briefing(
      request(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${old}`),
    );
    expect(replay.headers.get('cache-control')).toBe('s-maxage=86400, immutable');
  });

  it('rejects a place key it cannot resolve rather than guessing a location', async () => {
    const response = await briefing(request('/api/v1/briefing?place=p:2542997'));
    expect(response.status).toBe(404);
    expect((await bodyOf(response))['code']).toBe('LOCATION_NOT_FOUND');
  });

  /**
   * A `c:` key is a coordinate pair, not a place.
   *
   * It is the exact form `formatCoordinateKey` mints, so `?place=c:31.63,-8.00` asks the same
   * question as `?lat=31.63&lon=-8.00`. It used to fall through to the place lookup and come back
   * `LOCATION_NOT_FOUND` blaming a missing GeoNames import — the wrong reason for a request that
   * needs no `places` table at all.
   */
  it('resolves a c: key as the coordinate pair it is', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const viaKey = await briefing(
      request(
        `/api/v1/briefing?place=c:${String(LAT)},${LON.toFixed(2)}&as_of=${NOW.toISOString()}`,
      ),
    );
    expect(viaKey.status).toBe(200);

    const body = (await viaKey.json()) as { location: { lat: number; lon: number } };
    expect(body.location).toMatchObject({ lat: LAT, lon: LON });
  });

  it('refuses a c: key carrying more precision than GeoNerva mints', async () => {
    const response = await briefing(request('/api/v1/briefing?place=c:31.629512,-7.981084'));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a since parameter it does not implement yet', async () => {
    const response = await briefing(
      request(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&since=2026-09-20T00:00:00Z`),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response))['code']).toBe('UNKNOWN_PARAMETER');
  });

  it.each([
    ['a NaN coordinate', `lat=NaN&lon=${String(LON)}`],
    ['an out-of-range latitude', `lat=91&lon=${String(LON)}`],
    ['an Infinite longitude', `lat=${String(LAT)}&lon=Infinity`],
    ['a coordinate with no pair', `lat=${String(LAT)}`],
    ['both a place and coordinates', `place=p:1&lat=${String(LAT)}&lon=${String(LON)}`],
  ])('refuses %s without touching the database', async (_label, query) => {
    const response = await briefing(request(`/api/v1/briefing?${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never echoes a rejected coordinate back into the error body', async () => {
    const raw = await (
      await briefing(request('/api/v1/briefing?lat=91.123456&lon=-7.981084'))
    ).text();
    expect(raw).not.toContain('91.123456');
    expect(raw).not.toContain('7.981084');
  });

  it('refuses a knowledge time older than every family horizon', async () => {
    const response = await briefing(
      request(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=2019-01-01T00:00:00Z`),
    );
    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    expect(body['code']).toBe('AS_OF_BEFORE_HORIZON');
    expect(body['earliestAsOf']).not.toBeNull();
    expect((body['affectedFamilies'] as string[]).length).toBeGreaterThan(0);
    /* Reported as a retention limit, never rendered as an absence of hazards (ADR-035). */
    expect(body['detail']).toContain('retention limit');
  });
});

describe('GET /api/v1/evidence/{id}', () => {
  it('resolves an observation version with its four time semantics kept apart', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const { versionId } = await seedQuake();
    const response = await evidence(
      request(`/api/v1/evidence/EV:OBS:${versionId}?as_of=${NOW.toISOString()}`),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body['schemaVersion']).toBe(READ_MODEL_SCHEMA_VERSION);
    expect(body['item']).toMatchObject({
      id: `EV:OBS:${versionId}`,
      kind: 'OBS',
      resolvable: true,
    });
    expect(body['detail']).toMatchObject({
      kind: 'OBS',
      sourceRecordPrimaryKey: 'us7000tikb',
      observedAt: QUAKE_AT.toISOString(),
      ingestedAt: INGEST.toISOString(),
      contributor: 'us',
    });
    expect((body['detail'] as { contentSha256: string }).contentSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  /**
   * ADR-038 (accepted): the raw payload's lifecycle and digest are served, its body never is.
   * A raw row is attached to the version the way the pipeline attaches one, then read back through
   * the endpoint as the web process reads it.
   */
  async function withRawRow(
    versionId: string,
    options: { readonly pruned: boolean },
  ): Promise<string> {
    const sha = Buffer.alloc(32, 7);
    const ids = await upsertRawRecords(db, [
      {
        sourceId: 'usgs',
        payloadSha256: sha,
        payload: { type: 'Feature', id: 'us7000tikb' },
        firstSeenAt: INGEST,
        pruned: options.pruned,
      },
    ]);
    await sql`
      UPDATE geonerva.observation_versions SET raw_record_id = ${ids.get(sha.toString('hex'))}::bigint
      WHERE id = ${versionId}::bigint
    `.execute(db);
    return sha.toString('hex');
  }

  it('describes a live raw payload without serving it', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const { versionId } = await seedQuake();
    const sha = await withRawRow(versionId, { pruned: false });
    const body = await bodyOf(
      await evidence(request(`/api/v1/evidence/EV:OBS:${versionId}?as_of=${NOW.toISOString()}`)),
    );
    const detail = evidenceDetailSchema.parse(body).detail;
    expect(detail).toMatchObject({
      rawExcerpt: null,
      rawPayloadSha256: sha,
      rawPayloadPruned: false,
      rawPayload: {
        state: 'AVAILABLE',
        sha256: sha,
        capturedAt: INGEST.toISOString(),
        retentionExpiresAt: new Date(INGEST.getTime() + 30 * 86_400_000).toISOString(),
      },
    });
    expect(JSON.stringify(body)).not.toContain('us7000tikb"}');
  });

  it('says a backfilled payload was never captured, and a version without one likewise', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    const { versionId } = await seedQuake();
    const withoutRow = evidenceDetailSchema.parse(
      await bodyOf(
        await evidence(request(`/api/v1/evidence/EV:OBS:${versionId}?as_of=${NOW.toISOString()}`)),
      ),
    ).detail;
    expect(withoutRow).toMatchObject({ rawPayload: { state: 'NOT_CAPTURED', sha256: null } });

    const sha = await withRawRow(versionId, { pruned: true });
    const backfilled = evidenceDetailSchema.parse(
      await bodyOf(
        await evidence(request(`/api/v1/evidence/EV:OBS:${versionId}?as_of=${NOW.toISOString()}`)),
      ),
    ).detail;
    expect(backfilled).toMatchObject({
      rawPayloadPruned: false,
      rawPayload: {
        state: 'NOT_CAPTURED',
        sha256: sha,
        capturedAt: null,
        retentionExpiresAt: null,
      },
    });
  });

  it('resolves an ingestion run with its counts', async () => {
    const runId = await healthyRun('usgs', USGS_PRODUCT);
    const body = await bodyOf(
      await evidence(request(`/api/v1/evidence/EV:RUN:${runId}?as_of=${NOW.toISOString()}`)),
    );
    expect(body['detail']).toMatchObject({ kind: 'RUN', runId, sourceId: 'usgs' });
    expect(body['attribution']).toHaveLength(1);
  });

  /* Invariant I2 through the evidence endpoint: the row exists, but not yet at this time. */
  it('does not resolve a version that had not been ingested at the knowledge time', async () => {
    const { versionId } = await seedQuake();
    const response = await evidence(
      request(`/api/v1/evidence/EV:OBS:${versionId}?as_of=${BEFORE.toISOString()}`),
    );
    expect(response.status).toBe(404);
    expect((await bodyOf(response))['code']).toBe('NOT_FOUND');
  });

  /**
   * The G7 hole, as an endpoint behaviour.
   *
   * `EV:FDS` names a detection set with no row of its own. It must be a `NOT_FOUND` that explains
   * where to look, not a 500 and not an empty 200 — and the explanation is what tells a client the
   * citation was never resolvable rather than temporarily missing.
   */
  it('refuses an EV:FDS id with an explanation rather than failing', async () => {
    const response = await evidence(request('/api/v1/evidence/EV:FDS:904:148'));
    expect(response.status).toBe(404);
    const body = await bodyOf(response);
    expect(body['code']).toBe('NOT_FOUND');
    expect(body['detail']).toContain('fire-cluster summary');
  });

  it.each(['BAS', 'REL', 'CHG'])(
    'refuses a content-addressed %s id, which has no record to fetch',
    async (kind) => {
      const response = await evidence(request(`/api/v1/evidence/EV:${kind}:${'a'.repeat(64)}`));
      expect(response.status).toBe(404);
      expect((await bodyOf(response))['detail']).toContain('hash of its own inputs');
    },
  );

  it.each([
    ['a non-canonical kind', 'EV:XXX:1'],
    ['a lowercase kind', 'EV:obs:1'],
    ['a leading zero', 'EV:OBS:01'],
    ['an uppercase uuid', 'EV:RUN:0B6C5F1E-9A2D-4C37-8F11-6E2A9C0D4B77'],
    ['a SQL fragment', "EV:OBS:1' OR '1'='1"],
    ['a bare number', '41'],
  ])('refuses %s as malformed', async (_label, id) => {
    const response = await evidence(request(`/api/v1/evidence/${encodeURIComponent(id)}`));
    expect(response.status).toBe(400);
    expect((await bodyOf(response))['code']).toBe('VALIDATION_FAILED');
  });

  /**
   * A malformed percent-escape is a 400, not a 500.
   *
   * `decodeURIComponent('%ZZ')` throws `URIError`, and an unhandled throw made
   * `GET /api/v1/evidence/%ZZ` a one-byte caller-triggerable 5xx with an error-level log line —
   * alert noise and log amplification for what is plainly a bad request.
   */
  it.each([
    ['an invalid escape', '%ZZ'],
    ['a truncated escape', '%E0%A4%A'],
    ['a bare percent', '%'],
  ])('refuses %s with a 400 rather than failing', async (_label, segment) => {
    const response = await evidence(request(`/api/v1/evidence/${segment}`));
    expect(response.status).toBe(400);
    expect((await bodyOf(response))['code']).toBe('VALIDATION_FAILED');
  });

  it('refuses an oversized path segment before parsing it', async () => {
    const response = await evidence(request(`/api/v1/evidence/EV:OBS:${'9'.repeat(500)}`));
    expect(response.status).toBe(400);
    expect((await bodyOf(response))['invalidParams']).toEqual([
      { name: 'id', reason: 'must be 1 to 80 characters' },
    ]);
  });

  it('never echoes the rejected identifier', async () => {
    const raw = await (
      await evidence(
        request(
          `/api/v1/evidence/${encodeURIComponent("EV:OBS:1'; DROP TABLE geonerva.sources;--")}`,
        ),
      )
    ).text();
    expect(raw).not.toContain('DROP TABLE');
  });

  it('reports a well-formed id for a row that does not exist as NOT_FOUND', async () => {
    const response = await evidence(request('/api/v1/evidence/EV:OBS:999999'));
    expect(response.status).toBe(404);
  });

  /**
   * `immutable` requires a **pinned past** knowledge time, and the two halves are separate tests
   * because the route supplies one of them and the policy the other.
   *
   * §13.1 says this endpoint is immutable, on the premise that every primary evidence kind is an
   * append-only row. Two of the four are not: `canonical_links` is updated in place when a link is
   * withdrawn, and `ingestion_runs` when a run finishes or its lease expires. A live lookup cached
   * for a year would keep reporting a withdrawn correlation as open, through a hard reload.
   */
  it('caches a pinned past lookup as immutable', async () => {
    const runId = await healthyRun('usgs', USGS_PRODUCT);
    const pinned = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const response = await evidence(request(`/api/v1/evidence/EV:RUN:${runId}?as_of=${pinned}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('s-maxage=31536000, immutable');
  });

  it('does not cache a live lookup as immutable, because the row can still change', async () => {
    const runId = await healthyRun('usgs', USGS_PRODUCT);
    const response = await evidence(request(`/api/v1/evidence/EV:RUN:${runId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('s-maxage=120, stale-while-revalidate=600');
  });

  /*
   * A knowledge time that is pinned but recent is not a fixed past either, so it is not immutable.
   * This is the case that distinguishes "the caller named a time" from "the answer cannot change".
   */
  it('does not cache a pinned but recent lookup as immutable', async () => {
    const runId = await healthyRun('usgs', USGS_PRODUCT);
    const recent = new Date(Date.now() - 60_000).toISOString();
    const response = await evidence(request(`/api/v1/evidence/EV:RUN:${runId}?as_of=${recent}`));
    expect(response.headers.get('cache-control')).not.toContain('immutable');
  });

  /**
   * The failure the whole change is about, demonstrated on a real withdrawal.
   *
   * The link is open at one knowledge time and closed at a later one, from the same URL shape —
   * so a response that reported it open must not have been cached as immutable.
   */
  it('reports a withdrawn correlation as withdrawn, and never caches the open answer forever', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    await seedQuake();
    const links = await sql<{ id: string; record: string }>`
      SELECT id::text AS id, source_record_id::text AS record FROM geonerva.canonical_links LIMIT 1
    `.execute(db);
    const link = links.rows[0];
    expect(link).toBeDefined();

    const whileOpen = await evidence(
      request(`/api/v1/evidence/EV:COR:${link?.id ?? '0'}?as_of=${NOW.toISOString()}`),
    );
    expect(
      ((await whileOpen.json()) as { detail: { unlinkedAt: null } }).detail.unlinkedAt,
    ).toBeNull();
    /*
     * No cache assertion here: `NOW` is hours behind the real clock, so this *is* a pinned past
     * lookup and `immutable` is correct for it. The three tests above cover the policy; this one
     * covers the fact that the same link reads differently on either side of its withdrawal,
     * which is what makes caching a live answer forever unsound.
     */

    await sql`
      UPDATE geonerva.canonical_links
      SET unlinked_at = ${new Date(NOW.getTime() + 60_000)}, unlink_reason = 'REVISED_SOLUTION'
      WHERE id = ${link?.id ?? '0'}::bigint
    `.execute(db);

    const afterClosure = await evidence(
      request(
        `/api/v1/evidence/EV:COR:${link?.id ?? '0'}?as_of=${new Date(NOW.getTime() + 120_000).toISOString()}`,
      ),
    );
    const closed = (await afterClosure.json()) as {
      detail: { unlinkedAt: string | null; unlinkReason: string | null };
    };
    expect(closed.detail.unlinkedAt).not.toBeNull();
    expect(closed.detail.unlinkReason).toBe('REVISED_SOLUTION');
  });

  it('carries the security headers on a successful response', async () => {
    const runId = await healthyRun('usgs', USGS_PRODUCT);
    const response = await evidence(
      request(`/api/v1/evidence/EV:RUN:${runId}?as_of=${NOW.toISOString()}`),
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
  });
});

describe('errors never leak the system', () => {
  /*
   * A handler whose database handle is missing raises a configuration error, which is the closest
   * thing to an unexpected failure a test can provoke deterministically. The body must be the
   * fixed sentence and a traceId — no variable name, no connection target, no stack.
   */
  it('turns an unexpected failure into a generic INTERNAL_ERROR', async () => {
    setDatabaseForTesting(null);
    const previous = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      const response = await sourcesStatus(request('/api/v1/sources/status'));
      const raw = await response.text();
      expect(response.status).toBe(500);
      expect(raw).not.toContain('DATABASE_URL');
      expect(raw).not.toContain('at ');
      const problem = JSON.parse(raw) as { code: string; detail: string; traceId: string };
      expect(problem.code).toBe('INTERNAL_ERROR');
      expect(problem.detail).toContain('could not complete this request');
      expect(problem.traceId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      if (previous !== undefined) process.env['DATABASE_URL'] = previous;
      setDatabaseForTesting(testHandle());
    }
  });

  it('reports the request path in instance and never the query string', async () => {
    const body = await bodyOf(await briefing(request('/api/v1/briefing?lat=91&lon=0')));
    expect(body['instance']).toBe('/api/v1/briefing');
  });
});

describe('rate limiting (ARCHITECTURE §13.4)', () => {
  /**
   * An allowed response carries **no** budget header.
   *
   * It used to. Those responses are publicly cacheable with `Vary: Accept-Encoding` alone, so the
   * CDN would serve one caller's `RateLimit-Remaining` to everyone behind that edge node for up to
   * a year — a number wrong for almost every reader, and bucket state that `rate-limit.ts` is
   * otherwise careful not to publish. The counter is still incremented; only the header is gone.
   */
  it('publishes no budget header on an allowed response', async () => {
    const caller = new Headers({ 'x-forwarded-for': '198.51.100.7' });
    const response = await replayHorizon(requestAs('/api/v1/replay/horizon', caller));

    expect(response.status).toBe(200);
    for (const header of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
      expect(response.headers.get(header), header).toBeNull();
    }
    expect(await bucketCount()).toBe(1);
  });

  /* On a refusal the response is `no-store`, so the budget is accurate for its one reader. */
  it('publishes the budget on a refusal, where it cannot be shared', async () => {
    const refused = await refuseBriefing(new Headers({ 'x-forwarded-for': '198.51.109.7' }));

    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(refused.headers.get('ratelimit-limit')).toBe(String(RATE_LIMITS.briefing.limit));
    expect(refused.headers.get('ratelimit-remaining')).toBe('0');
    expect(Number(refused.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
  });

  /**
   * Drives the caller until it is refused, rather than assuming a request count.
   *
   * The first version sent exactly `limit + 1` requests and asserted the last was a 429. Each
   * briefing is ~20 database round trips, so 61 of them take long enough that the fixed one-minute
   * window can roll over inside the loop, reset the counter, and let the final request through —
   * which is exactly what happened. The limit is 60 per minute, so 130 attempts must hit a refusal
   * however many windows they span.
   */
  async function refuseBriefing(caller: Headers): Promise<Response> {
    const attempts = RATE_LIMITS.briefing.limit * 2 + 10;
    for (let index = 0; index < attempts; index += 1) {
      const response = await briefing(
        requestAs(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}`, caller),
      );
      if (response.status === 429) return response;
    }
    throw new Error(`the limiter allowed ${String(attempts)} requests from one caller`);
  }

  it('refuses the request once the window is spent, with Retry-After', async () => {
    const refused = await refuseBriefing(new Headers({ 'x-forwarded-for': '198.51.101.7' }));

    expect(refused.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await bodyOf(refused);
    expect(body['code']).toBe('RATE_LIMITED');
    expect(body['retryAfterS']).toBeGreaterThan(0);
  });

  /**
   * The spoofing case, end to end.
   *
   * A caller who prepends addresses to `X-Forwarded-For` must not get a fresh budget: the proxy
   * appends the real peer last, so only the rightmost entry counts. If the limiter read the
   * leftmost, these two requests would land in two buckets and the second would report a full
   * budget — which is the failure this asserts against.
   */
  it('does not give a forged X-Forwarded-For prefix its own bucket', async () => {
    const real = '198.51.102.7';
    await replayHorizon(
      requestAs('/api/v1/replay/horizon', new Headers({ 'x-forwarded-for': real })),
    );
    await replayHorizon(
      requestAs(
        '/api/v1/replay/horizon',
        new Headers({ 'x-forwarded-for': `10.1.2.3, 10.4.5.6, ${real}` }),
      ),
    );

    /* One bucket, two requests. A leftmost read would have created two. */
    expect(await bucketCount()).toBe(1);
  });

  /**
   * An oversized header must not be a way into the shared `unknown` bucket.
   *
   * Refusing to parse it returned `null`, which lands in that bucket — so a caller could collect a
   * second full budget by prefixing 2 KB of junk, or saturate the shared bucket and refuse every
   * caller whose address the parser cannot read.
   */
  it('reads the real address out of an oversized header rather than sharing a bucket', async () => {
    const real = '198.51.108.7';
    await replayHorizon(
      requestAs('/api/v1/replay/horizon', new Headers({ 'x-forwarded-for': real })),
    );
    await replayHorizon(
      requestAs(
        '/api/v1/replay/horizon',
        new Headers({ 'x-forwarded-for': `${'203.0.113.9, '.repeat(200)}${real}` }),
      ),
    );

    expect(await bucketCount()).toBe(1);
  });

  it('puts two addresses in one /24 in the same bucket', async () => {
    const before = await bucketCount();
    await replayHorizon(
      requestAs('/api/v1/replay/horizon', new Headers({ 'x-forwarded-for': '198.51.103.7' })),
    );
    await replayHorizon(
      requestAs('/api/v1/replay/horizon', new Headers({ 'x-forwarded-for': '198.51.103.200' })),
    );
    expect(await bucketCount()).toBe(before + 1);
  });

  /* Fail closed by omission: a caller with no usable address is counted, not exempted. */
  it('counts a request with no address against a shared bucket', async () => {
    await replayHorizon(
      requestAs('/api/v1/replay/horizon', new Headers({ 'x-forwarded-for': 'not-an-address' })),
    );
    await replayHorizon(requestAs('/api/v1/replay/horizon', new Headers()));

    /* Both land in the one `unknown` bucket: counted collectively, never exempted. */
    expect(await bucketCount()).toBe(1);
  });

  it('gives each endpoint its own window for one caller', async () => {
    const caller = new Headers({ 'x-forwarded-for': '198.51.104.7' });
    await briefing(requestAs(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}`, caller));
    await replayHorizon(requestAs('/api/v1/replay/horizon', caller));

    /*
     * Two buckets for one caller. Without the scope in the key they would share a counter and the
     * smaller limit (60/min) would consume the larger (120/min).
     */
    expect(await bucketCount()).toBe(2);
  });

  /* A refused verb must not spend the budget for the verb the caller is allowed to use. */
  it('does not count a rejected method against the budget', async () => {
    const caller = new Headers({ 'x-forwarded-for': '198.51.105.7' });
    const refused = await replayHorizon(
      requestAs('/api/v1/replay/horizon', caller, { method: 'POST' }),
    );
    expect(refused.status).toBe(405);
    expect(await bucketCount()).toBe(0);

    await replayHorizon(requestAs('/api/v1/replay/horizon', caller));
    expect(await bucketCount()).toBe(1);
  });

  /* A refused *request* does consume its window: a fixed window gives no free retries. */
  /**
   * A refused *request* consumes its window, which is what a fixed window is for.
   *
   * Asserted through `checkRateLimit` rather than a header, because an allowed response no longer
   * publishes one. Two requests, one of them a 400, leave the counter at two.
   */
  it('counts a request refused by validation', async () => {
    const caller = new Headers({ 'x-forwarded-for': '198.51.106.7' });
    await briefing(requestAs('/api/v1/briefing?lat=91&lon=0', caller));
    await briefing(requestAs(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}`, caller));

    const counts = await sql<{ n: number }>`
      SELECT max(n)::int AS n FROM geonerva.rate_limit_buckets
    `.execute(db);
    expect(counts.rows[0]?.n).toBe(2);
  });

  /**
   * `checkRateLimit` is exported and reports a verdict rather than throwing, so its numbers are
   * part of the contract even though `enforceRateLimit` is what the handlers use.
   *
   * The clamp is the point. Past the limit, `limit - count` is negative, and a negative
   * `RateLimit-Remaining` is both meaningless to a client and a nonsense number to publish. This
   * is the only place the over-limit verdict is visible: the throwing wrapper never renders it.
   */
  it('reports a remainder of zero past the limit, never a negative one', async () => {
    const caller = new Headers({ 'x-forwarded-for': '198.51.110.7' });
    const now = new Date();
    const check = async () =>
      checkRateLimit({
        db: () => db,
        headers: caller,
        now,
        name: 'placesSearchGlobal',
        secret: TEST_CONFIG.RATE_LIMIT_SECRET,
      });

    const first = await check();
    expect(first).toMatchObject({ allowed: true, limit: 1, remaining: 0 });

    for (let index = 0; index < 4; index += 1) await check();
    const last = await check();

    expect(last.allowed).toBe(false);
    expect(last.remaining).toBe(0);
    expect(last.retryAfterS).toBeGreaterThan(0);
  });

  it('stores no address, only a 32-byte digest', async () => {
    await replayHorizon(
      requestAs('/api/v1/replay/horizon', new Headers({ 'x-forwarded-for': '198.51.107.42' })),
    );
    const rows = await sql<{ length: number; text: string }>`
      SELECT octet_length(bucket_key) AS length, encode(bucket_key, 'hex') AS text
      FROM geonerva.rate_limit_buckets
    `.execute(db);

    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.length).toBe(32);
      expect(row.text).not.toContain('198');
      expect(row.text).not.toContain('51107');
    }
  });

  /**
   * The counter table is the *only* thing a request writes.
   *
   * ARCHITECTURE §13 calls the web process read-only, and migration 0007 makes that precise: the
   * web role may write `rate_limit_buckets` and `geocode_cache` and nothing else. This asserts the
   * read path exercises exactly that: a briefing leaves the counter one row heavier and every fact
   * table untouched.
   */
  it('writes the counter and nothing else', async () => {
    await healthyRun('usgs', USGS_PRODUCT);
    await derivationRan('CORRELATION');
    await seedQuake();

    const census = async (): Promise<Record<string, number>> => {
      const result = await sql<{ table_name: string; n: number }>`
        SELECT 'observation_versions' AS table_name, count(*)::int AS n
          FROM geonerva.observation_versions
        UNION ALL SELECT 'source_records', count(*)::int FROM geonerva.source_records
        UNION ALL SELECT 'canonical_links', count(*)::int FROM geonerva.canonical_links
        UNION ALL SELECT 'ingestion_runs', count(*)::int FROM geonerva.ingestion_runs
        UNION ALL SELECT 'analysis_runs', count(*)::int FROM geonerva.analysis_runs
        UNION ALL SELECT 'location_snapshots', count(*)::int FROM geonerva.location_snapshots
        UNION ALL SELECT 'geocode_cache', count(*)::int FROM geonerva.geocode_cache
      `.execute(db);
      return Object.fromEntries(result.rows.map((row) => [row.table_name, row.n]));
    };

    const before = await census();
    const bucketsBefore = await bucketCount();

    await briefing(
      request(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${NOW.toISOString()}`),
    );

    expect(await census()).toEqual(before);
    expect(await bucketCount()).toBe(bucketsBefore + 1);
  });
});
