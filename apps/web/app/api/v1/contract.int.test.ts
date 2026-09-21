/**
 * Contract tests: every real response parsed through the schema for its endpoint.
 *
 * This is the test that makes the frozen read models mean something at run time. `api.int.test.ts`
 * asserts individual fields; this asserts the **whole document** against its contract, which
 * catches the class of mistake a field assertion cannot:
 *
 *  - a field present with the wrong type, or `null` where the contract says a string;
 *  - a field the contract does not declare — a snake_case key from a row, say, which is exactly
 *    how `/evidence/{id}` was wrong before the frozen model was read properly;
 *  - a timestamp that is not the one ISO form read models use;
 *  - an invariant expressed as a refinement: I9 (every citation in the manifest), I10 (CRITICAL
 *    needs an authoritative basis), I11 (no items or count on a family that is not AVAILABLE),
 *    I15 (no coordinate past two decimals);
 *  - an error body that is not a well-formed problem document.
 *
 * `strict()` is applied before parsing, so an extra key is a failure rather than something Zod
 * quietly strips. Without it this file would test that the response is a *superset* of its
 * contract, which is the weaker and less useful claim.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadWebConfig } from '@geonerva/config';
import { createCanonicalEvent, createDb, linkRecord, type DB } from '@geonerva/db';
import type { DatabaseHandle } from '@geonerva/db/client';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation, seedRun } from '@geonerva/db/testing/factories';
import {
  PROBLEM_STATUS,
  evidenceDetailSchema,
  locationBriefingSchema,
  problemDetailsSchema,
  problemTypeUri,
  replayHorizonResponseSchema,
  sourceStatusSchema,
} from '@geonerva/domain';

import { setWebConfigForTesting } from '../../../lib/server/config.ts';
import { ENDPOINT_CONTRACTS, buildOpenApiDocument } from '../../../lib/server/contracts.ts';
import { setDatabaseForTesting } from '../../../lib/server/db.ts';
import { GET as briefing } from './briefing/route.ts';
import { GET as evidence } from './evidence/[id]/route.ts';
import { GET as replayHorizon } from './replay/horizon/route.ts';
import { GET as sourcesStatus } from './sources/status/route.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const NOW = new Date('2026-09-21T12:00:00.000Z');
const QUAKE_AT = new Date('2026-09-21T11:40:00.000Z');
const INGEST = new Date('2026-09-21T11:45:00.000Z');
const LAT = 31.63;
const LON = -8.0;
const USGS_PRODUCT = 'comcat';

const TEST_CONFIG = loadWebConfig({
  DATABASE_URL: 'postgresql://web:pw@127.0.0.1:54320/geonerva_test',
  RATE_LIMIT_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // gitleaks:allow
  NOMINATIM_CONTACT: 'https://example.org/geonerva-contact',
});

function testHandle(): DatabaseHandle {
  return { db, pool: testDb.pool, target: 'test', close: () => Promise.resolve() };
}

/** A fresh caller per request, so no test spends another's rate-limit window. */
let callerIndex = 0;
function request(path: string, init?: RequestInit): Request {
  callerIndex += 1;
  return new Request(`https://geonerva.test${path}`, {
    headers: new Headers({ 'x-forwarded-for': `203.1.${String(callerIndex % 250)}.42` }),
    ...init,
  });
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

async function productId(code: string): Promise<number> {
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = 'usgs' AND code = ${code}
  `.execute(db);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`no product usgs/${code} is seeded`);
  return id;
}

async function healthyRun(): Promise<string> {
  const { runId } = await seedRun(db, {
    sourceId: 'usgs',
    productId: await productId(USGS_PRODUCT),
    status: 'SUCCEEDED',
    startedAt: INGEST,
    newestObservedAt: QUAKE_AT,
  });
  return runId;
}

async function derivationRan(): Promise<void> {
  await sql`
    INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
    VALUES (gen_random_uuid(), 'CORRELATION', 'geonerva-1', ${INGEST}, ${INGEST}, 'SUCCEEDED')
  `.execute(db);
}

async function seedQuake(): Promise<{ versionId: string }> {
  const seeded = await seedObservation(db, {
    sourceId: 'usgs',
    productId: await productId(USGS_PRODUCT),
    primaryKey: 'us7000tikb',
    aliases: ['us7000tikb'],
    ingestedAt: INGEST,
    observedAt: QUAKE_AT,
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
  return { versionId: seeded.versionId };
}

/**
 * Parses a response body with a schema, failing with the schema's own message.
 *
 * The failure text matters more than usual here: "invalid_type at sources.0.health.lastSuccessAt"
 * names the field, the path and the expectation, which is the difference between a contract test
 * that is useful and one that says only that something is wrong.
 */
async function parsedBody<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw.slice(0, 400)).toBeLessThan(400);
  return schema.parse(JSON.parse(raw));
}

describe('every served endpoint satisfies its frozen contract', () => {
  it('GET /replay/horizon', async () => {
    const parsed = await parsedBody(
      await replayHorizon(request('/api/v1/replay/horizon')),
      replayHorizonResponseSchema,
    );
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.horizon.profile).toBe('lean');
  });

  it('GET /sources/status, with no data at all', async () => {
    const parsed = await parsedBody(
      await sourcesStatus(request('/api/v1/sources/status')),
      sourceStatusSchema,
    );
    expect(parsed.sources.length).toBeGreaterThan(0);
    /* The refinement in the schema: no runs means no rate, not a rate of zero. */
    for (const source of parsed.sources) expect(source.successRate24h).toBeNull();
  });

  it('GET /sources/status, with a committed run and a failed one', async () => {
    await healthyRun();
    await seedRun(db, {
      sourceId: 'emsc',
      productId: null,
      status: 'FAILED',
      startedAt: INGEST,
      errorClass: 'TIMEOUT',
    });
    await sql`
      INSERT INTO geonerva.worker_heartbeat (id, last_seen_at, version)
      VALUES (true, ${new Date(NOW.getTime() - 30_000)}, 'worker-test')
    `.execute(db);

    const parsed = await parsedBody(
      await sourcesStatus(request(`/api/v1/sources/status?as_of=${NOW.toISOString()}`)),
      sourceStatusSchema,
    );
    expect(parsed.worker?.isStale).toBe(false);
    expect(parsed.evidenceManifest.length).toBeGreaterThan(0);
  });

  /**
   * Invariant I15 through the contract, with a request that actually carries precision.
   *
   * The other briefing cases send `lat=31.63`, which is already rounded — so removing the
   * rounding from `params.ts` changed nothing and the schema's I15 refinement never fired. A
   * mutation run proved it. This asks for six decimals, which is the only input that exercises
   * both the parser and the contract.
   */
  it('GET /briefing with a precise coordinate rounds it before serving it', async () => {
    const response = await briefing(request('/api/v1/briefing?lat=31.629512&lon=-7.981084'));
    const raw = await response.text();
    expect(response.status, raw.slice(0, 300)).toBe(200);

    const parsed = locationBriefingSchema.parse(JSON.parse(raw));
    expect(parsed.location.lat).toBe(31.63);
    expect(parsed.location.lon).toBe(-7.98);
    expect(raw).not.toContain('629512');
  });

  it('GET /briefing, with nothing ingested', async () => {
    const parsed = await parsedBody(
      await briefing(request(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}`)),
      locationBriefingSchema,
    );
    expect(parsed.ai).toBeNull();
    expect(parsed.location.lat).toBe(LAT);
  });

  it('GET /briefing, with a linked earthquake and a healthy source', async () => {
    await healthyRun();
    await derivationRan();
    await seedQuake();

    const parsed = await parsedBody(
      await briefing(
        request(
          `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=${NOW.toISOString()}`,
        ),
      ),
      locationBriefingSchema,
    );
    expect(parsed.snapshot.families.EARTHQUAKES.items.length).toBeGreaterThan(0);
    expect(parsed.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each(['6h', '24h', '7d'])('GET /briefing with window=%s', async (window) => {
    await healthyRun();
    await derivationRan();
    await seedQuake();
    const parsed = await parsedBody(
      await briefing(
        request(
          `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&window=${window}&as_of=${NOW.toISOString()}`,
        ),
      ),
      locationBriefingSchema,
    );
    expect(parsed.window).toBe(window);
  });

  it('GET /evidence/{id} for an observation version', async () => {
    await healthyRun();
    const { versionId } = await seedQuake();
    const parsed = await parsedBody(
      await evidence(request(`/api/v1/evidence/EV:OBS:${versionId}?as_of=${NOW.toISOString()}`)),
      evidenceDetailSchema,
    );
    expect(parsed.detail.kind).toBe('OBS');
    expect(parsed.item.resolvable).toBe(true);
  });

  it('GET /evidence/{id} for an ingestion run', async () => {
    const runId = await healthyRun();
    const parsed = await parsedBody(
      await evidence(request(`/api/v1/evidence/EV:RUN:${runId}?as_of=${NOW.toISOString()}`)),
      evidenceDetailSchema,
    );
    expect(parsed.detail.kind).toBe('RUN');
  });

  it('GET /evidence/{id} for a correlation link', async () => {
    await healthyRun();
    await seedQuake();
    const links = await sql<{ id: string }>`
      SELECT id::text AS id FROM geonerva.canonical_links LIMIT 1
    `.execute(db);
    const linkId = links.rows[0]?.id;
    expect(linkId).toBeDefined();

    const parsed = await parsedBody(
      await evidence(
        request(`/api/v1/evidence/EV:COR:${linkId ?? '0'}?as_of=${NOW.toISOString()}`),
      ),
      evidenceDetailSchema,
    );
    expect(parsed.detail.kind).toBe('COR');
  });
});

describe('a response carries nothing its contract does not declare', () => {
  /**
   * `strict()` on the top level, which is what makes this different from the tests above.
   *
   * Zod strips unknown keys by default, so a response with a stray `source_id` alongside the
   * declared fields parses cleanly — and that is precisely the bug that shipped in the first
   * version of `/evidence/{id}`, which returned a database row. Strict parsing is the check that
   * would have caught it.
   */
  it('GET /sources/status has no undeclared top-level key', async () => {
    const response = await sourcesStatus(request('/api/v1/sources/status'));
    const body = (await response.json()) as Record<string, unknown>;
    expect(() => sourceStatusSchema.strict().parse(body)).not.toThrow();
  });

  it('GET /briefing has no undeclared top-level key', async () => {
    const response = await briefing(
      request(`/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}`),
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(() => locationBriefingSchema.strict().parse(body)).not.toThrow();
  });

  it('GET /replay/horizon has no undeclared top-level key', async () => {
    const response = await replayHorizon(request('/api/v1/replay/horizon'));
    const body = (await response.json()) as Record<string, unknown>;
    expect(() => replayHorizonResponseSchema.strict().parse(body)).not.toThrow();
  });

  it('GET /evidence/{id} has no undeclared top-level key, and no snake_case one', async () => {
    const runId = await healthyRun();
    const response = await evidence(
      request(`/api/v1/evidence/EV:RUN:${runId}?as_of=${NOW.toISOString()}`),
    );
    const raw = await response.text();
    expect(() => evidenceDetailSchema.strict().parse(JSON.parse(raw))).not.toThrow();
    /* A row shape leaks through its naming before it leaks through its fields. */
    expect(raw).not.toMatch(/"[a-z]+_[a-z]/u);
  });
});

describe('every error is a well-formed problem document', () => {
  it.each([
    ['a malformed coordinate', () => briefing(request('/api/v1/briefing?lat=NaN&lon=0'))],
    ['an unknown parameter', () => replayHorizon(request('/api/v1/replay/horizon?x=1'))],
    [
      'a future knowledge time',
      () => sourcesStatus(request('/api/v1/sources/status?as_of=2099-01-01T00:00:00Z')),
    ],
    ['a malformed evidence id', () => evidence(request('/api/v1/evidence/nonsense'))],
    ['an unresolvable evidence id', () => evidence(request('/api/v1/evidence/EV:OBS:999999'))],
    [
      'a knowledge time past the horizon',
      () =>
        briefing(
          request(
            `/api/v1/briefing?lat=${String(LAT)}&lon=${String(LON)}&as_of=2019-01-01T00:00:00Z`,
          ),
        ),
    ],
    [
      'a rejected method',
      () => sourcesStatus(request('/api/v1/sources/status', { method: 'POST' })),
    ],
    ['a place GeoNerva cannot resolve', () => briefing(request('/api/v1/briefing?place=p:1'))],
  ])('%s', async (_label, call) => {
    const response = await call();
    expect(response.status).toBeGreaterThanOrEqual(400);
    const parsed = problemDetailsSchema.strict().parse(await response.json());

    expect(parsed.status).toBe(response.status);
    /*
     * And the status the frozen table assigns the code. Comparing only to the HTTP status is
     * circular — `problemResponse` builds the HTTP status *from* this field, so the two agree
     * however wrong both are. The table is the independent reference.
     */
    expect(parsed.status).toBe(PROBLEM_STATUS[parsed.code]);
    expect(parsed.type).toBe(problemTypeUri(parsed.code));
    expect(parsed.title.length).toBeGreaterThan(0);
    expect(parsed.type).toContain('geonerva');
    /* The trace id is what links the response to a log line, so it must always be there. */
    expect(parsed.traceId).not.toBeNull();
  });

  it('never carries a stack trace, a path or a connection target', async () => {
    const bodies = await Promise.all(
      [
        await briefing(request('/api/v1/briefing?lat=91&lon=0')),
        await evidence(request('/api/v1/evidence/EV:OBS:999999')),
        await sourcesStatus(request('/api/v1/sources/status', { method: 'PUT' })),
      ].map(async (response) => response.text()),
    );

    for (const body of bodies) {
      expect(body).not.toContain('node_modules');
      expect(body).not.toContain('.ts:');
      expect(body).not.toContain('postgresql://');
      expect(body).not.toContain('54320');
      expect(body).not.toMatch(/\bat [A-Za-z]+ \(/u);
    }
  });
});

describe('the OpenAPI document describes what the API actually serves', () => {
  /**
   * The document's schema and the response are checked against **each other**.
   *
   * Generating a document from the schemas proves nothing on its own — the generator could emit
   * anything. This takes the schema the document was built from, parses a real response with it,
   * and so closes the loop: document, schema and response are one thing or the test fails.
   */
  it('parses a real response with the schema the document publishes', async () => {
    const contract = ENDPOINT_CONTRACTS.find((entry) => entry.path === '/api/v1/sources/status');
    expect(contract?.response).not.toBeNull();

    const response = await sourcesStatus(request('/api/v1/sources/status'));
    const body = (await response.json()) as unknown;
    expect(() => contract?.response?.parse(null)).toThrow();
    expect(() => contract?.response?.parse(body)).not.toThrow();
  });

  it('claims no endpoint the API does not serve', () => {
    const document = buildOpenApiDocument({ version: '0.0.0-test' });
    for (const contract of ENDPOINT_CONTRACTS) {
      const operation = (
        document.paths[contract.path] as { get: { responses: Record<string, unknown> } }
      ).get;
      if (contract.implemented) continue;
      /* A path with no handler must document a 501 and no 200, whatever its schema's state. */
      expect(operation.responses['200'], contract.path).toBeUndefined();
    }
  });
});
