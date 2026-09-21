/**
 * The endpoint table and the OpenAPI document it generates (IMPLEMENTATION_PLAN P8, task 5).
 *
 * The document is generated, so the interesting tests are not "does it have paths" but the two
 * properties that make a generated document worth having:
 *
 *  1. **It cannot describe a shape the API does not produce**, because the schema in the document
 *     is the same object the contract tests parse responses with.
 *  2. **It does not silently omit an endpoint.** §13.1 lists twelve; the table lists every one,
 *     including the ones that are specified and not yet served, with the reason.
 *
 * The response schemas themselves are exercised against real responses in
 * `apps/web/app/api/v1/contract.int.test.ts` — parsing fabricated objects here would only test
 * Zod.
 */

import { describe, expect, it } from 'vitest';

import {
  ENDPOINT_CONTRACTS,
  OPENAPI_VERSION,
  buildOpenApiDocument,
  contractFor,
  operationIdFor,
} from './contracts.ts';

/** §13.1's table, transcribed. `/replay/scenarios` is P1 and deliberately absent. */
const SPECIFIED_PATHS = [
  '/api/v1/places/suggest',
  '/api/v1/places/search',
  '/api/v1/places/reverse',
  '/api/v1/briefing',
  '/api/v1/events',
  '/api/v1/events/{publicId}',
  '/api/v1/fire-clusters/{publicId}',
  '/api/v1/history',
  '/api/v1/evidence/{id}',
  '/api/v1/sources/status',
  '/api/v1/replay/horizon',
];

describe('ENDPOINT_CONTRACTS', () => {
  it('covers every endpoint §13.1 specifies for P0, and no others', () => {
    expect([...ENDPOINT_CONTRACTS.map((contract) => contract.path)].sort()).toEqual(
      [...SPECIFIED_PATHS].sort(),
    );
  });

  it('lists each path once', () => {
    const paths = ENDPOINT_CONTRACTS.map((contract) => contract.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  /*
   * An endpoint with no schema must say why. The alternative — a blank `blockedBy` — makes an
   * unimplemented endpoint indistinguishable from a forgotten one, which is the state this table
   * was written to end.
   */
  it('explains every endpoint it does not serve', () => {
    for (const contract of ENDPOINT_CONTRACTS) {
      if (contract.implemented) continue;
      expect(contract.blockedBy, contract.path).toBeDefined();
      expect((contract.blockedBy ?? '').length, contract.path).toBeGreaterThan(20);
    }
  });

  it('gives every served endpoint a response schema, and no unserved one', () => {
    for (const contract of ENDPOINT_CONTRACTS) {
      if (contract.implemented) expect(contract.response, contract.path).not.toBeNull();
    }
    const served = ENDPOINT_CONTRACTS.filter((contract) => contract.implemented).map(
      (contract) => contract.path,
    );
    expect(served.sort()).toEqual([
      '/api/v1/briefing',
      '/api/v1/evidence/{id}',
      '/api/v1/replay/horizon',
      '/api/v1/sources/status',
    ]);
  });

  /** §13.4: `places/search` is the only endpoint with a limit below the 120/min default. */
  it('assigns each endpoint the limit §13.4 gives it', () => {
    expect(contractFor('/api/v1/briefing')?.rateLimit).toBe('briefing');
    expect(contractFor('/api/v1/places/search')?.rateLimit).toBe('placesSearch');
    expect(contractFor('/api/v1/sources/status')?.rateLimit).toBe('default');
    expect(contractFor('/api/v1/evidence/{id}')?.rateLimit).toBe('default');
  });

  it('returns undefined for a path outside §13.1', () => {
    expect(contractFor('/api/v1/admin')).toBeUndefined();
    expect(contractFor('/api/ingest/usgs')).toBeUndefined();
  });

  /* ADR-010: there is no public ingestion endpoint, and the table is one place to assert it. */
  it('exposes no write endpoint', () => {
    for (const contract of ENDPOINT_CONTRACTS) {
      expect(contract.path).not.toContain('ingest');
      expect(contract.path).not.toContain('trigger');
    }
  });
});

describe('operationIdFor', () => {
  it.each([
    ['/api/v1/briefing', 'getBriefing'],
    ['/api/v1/sources/status', 'getSourcesStatus'],
    ['/api/v1/replay/horizon', 'getReplayHorizon'],
    ['/api/v1/evidence/{id}', 'getEvidenceById'],
    ['/api/v1/events/{publicId}', 'getEventsByPublicId'],
    ['/api/v1/fire-clusters/{publicId}', 'getFireClustersByPublicId'],
    ['/api/v1/places/suggest', 'getPlacesSuggest'],
  ])('%s -> %s', (path, expected) => {
    expect(operationIdFor(path)).toBe(expected);
  });

  /* A generated client keys methods on these, so two endpoints sharing one would collide. */
  it('is unique across the table', () => {
    const ids = ENDPOINT_CONTRACTS.map((contract) => operationIdFor(contract.path));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildOpenApiDocument', () => {
  const document = buildOpenApiDocument({ version: '1.0.0-test' });

  it('declares OpenAPI 3.1, whose schema object is JSON Schema', () => {
    expect(document.openapi).toBe(OPENAPI_VERSION);
    expect(document.openapi).toBe('3.1.0');
  });

  it('describes every endpoint in the table', () => {
    expect(Object.keys(document.paths).sort()).toEqual([...SPECIFIED_PATHS].sort());
  });

  it('gives every path a GET and nothing else', () => {
    for (const [path, operations] of Object.entries(document.paths)) {
      expect(Object.keys(operations as object), path).toEqual(['get']);
    }
  });

  it('documents a 200 only for the endpoints that are served', () => {
    for (const contract of ENDPOINT_CONTRACTS) {
      const responses = (
        document.paths[contract.path] as { get: { responses: Record<string, unknown> } }
      ).get.responses;
      if (contract.implemented) {
        expect(responses['200'], contract.path).toBeDefined();
        expect(responses['501'], contract.path).toBeUndefined();
      } else {
        expect(responses['200'], contract.path).toBeUndefined();
        expect(responses['501'], contract.path).toBeDefined();
      }
    }
  });

  /*
   * Every endpoint can refuse, and the refusal shape is the same everywhere. A document that
   * described only the happy path would leave a client with no reason to parse `problem+json`.
   */
  it('documents the problem shape on every error status of every endpoint', () => {
    for (const path of Object.keys(document.paths)) {
      const responses = (document.paths[path] as { get: { responses: Record<string, unknown> } })
        .get.responses;
      for (const status of ['400', '404', '405', '429', '500']) {
        const response = responses[status] as
          { content: Record<string, { schema: { $ref: string } }> } | undefined;
        expect(response, `${path} ${status}`).toBeDefined();
        expect(
          response?.content['application/problem+json']?.schema.$ref,
          `${path} ${status}`,
        ).toBe('#/components/schemas/ProblemDetails');
      }
    }
  });

  it('carries the referenced ProblemDetails schema', () => {
    const problem = document.components.schemas['ProblemDetails'] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(problem.properties).sort()).toContain('traceId');
    expect(problem.required).toContain('code');
    expect(problem.required).toContain('status');
  });

  /**
   * The generated schema must be the real one, not a placeholder.
   *
   * This is the assertion that makes the whole approach worth anything: the document's schema for
   * `/sources/status` has to contain the fields the frozen contract declares. A generator that
   * emitted `{}` for everything would satisfy every other test in this file.
   */
  it('generates the real response schema, field by field', () => {
    const schema = (
      document.paths['/api/v1/sources/status'] as {
        get: {
          responses: {
            '200': {
              content: Record<string, { schema: { properties: Record<string, unknown> } }>;
            };
          };
        };
      }
    ).get.responses['200'].content['application/json']?.schema;

    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      'asOfContext',
      'attribution',
      'dataQuality',
      'evidenceManifest',
      'generatedAt',
      'schemaVersion',
      'sources',
      'worker',
    ]);
  });

  it('describes the briefing response as an object with its top-level fields', () => {
    const schema = (
      document.paths['/api/v1/briefing'] as {
        get: {
          responses: {
            '200': {
              content: Record<string, { schema: { properties?: Record<string, unknown> } }>;
            };
          };
        };
      }
    ).get.responses['200'].content['application/json']?.schema;

    const properties = Object.keys(schema?.properties ?? {});
    expect(properties).toContain('snapshot');
    expect(properties).toContain('evidenceManifest');
    expect(properties).toContain('asOfContext');
  });

  it('publishes the cache policy each endpoint promises', () => {
    const headers = (
      document.paths['/api/v1/replay/horizon'] as {
        get: {
          responses: {
            '200': { headers: Record<string, { schema: { const: string } }> };
          };
        };
      }
    ).get.responses['200'].headers;
    expect(headers['Cache-Control']?.schema.const).toBe(
      's-maxage=3600, stale-while-revalidate=3600',
    );
  });

  it('is serializable, which is the only form a document is useful in', () => {
    expect(() => JSON.stringify(document)).not.toThrow();
    expect(JSON.stringify(document).length).toBeGreaterThan(5000);
  });

  it('names the version it was asked for', () => {
    expect(buildOpenApiDocument({ version: '9.9.9' }).info.version).toBe('9.9.9');
  });
});
