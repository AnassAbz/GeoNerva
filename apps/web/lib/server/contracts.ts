/**
 * The endpoint → response-schema table, and the OpenAPI document generated from it.
 *
 * ### Why the table exists
 *
 * ARCHITECTURE §13.1 lists twelve endpoints and `packages/domain` freezes a response contract for
 * each. Nothing connected the two: which contract an endpoint serves lived in a route handler's
 * doc comment, which is not something a test can read. This table is the machine-readable form of
 * §13.1's first two columns, and it is what lets a contract test say "parse this response with the
 * schema for the endpoint that produced it" instead of repeating the pairing by hand.
 *
 * An endpoint that is specified but not yet served is listed with `implemented: false` rather than
 * omitted, so the gap is visible in the OpenAPI document and in the test that walks this table.
 * Leaving it out would make an unimplemented endpoint indistinguishable from a forgotten one.
 */

import {
  evidenceDetailSchema,
  locationBriefingSchema,
  mapFeaturesResponseSchema,
  problemDetailsSchema,
  replayHorizonResponseSchema,
  sourceStatusSchema,
} from '@geonerva/domain';
import { z } from 'zod';

import {
  CACHE_POLICIES,
  LIVE_BRIEFING_MAX_AGE_S,
  LIVE_BRIEFING_STALE_WHILE_REVALIDATE_S,
  LIVE_EVIDENCE_MAX_AGE_S,
  REPLAY_MAX_AGE_S,
} from './cache.ts';
import type { RateLimitName } from './rate-limit.ts';

export interface EndpointContract {
  /** The path template, exactly as §13.1 writes it. */
  readonly path: string;
  readonly summary: string;
  /** The response schema for a 200. `null` for an endpoint not yet served. */
  readonly response: z.ZodType | null;
  /** Which of §13.4's limits the handler declares. */
  readonly rateLimit: RateLimitName;
  /**
   * The `Cache-Control` values this endpoint can emit — more than one where the policy depends on
   * the knowledge time. Emitted as an `enum`, never as a sentence: see `buildOpenApiDocument`.
   */
  readonly cache: readonly string[];
  readonly implemented: boolean;
  /** Why not, for the ones that are not. Kept honest rather than left blank. */
  readonly blockedBy?: string;
}

export const ENDPOINT_CONTRACTS: readonly EndpointContract[] = [
  {
    path: '/api/v1/briefing',
    summary: 'Full location briefing: snapshot, changes, deterministic copy and evidence manifest.',
    response: locationBriefingSchema,
    rateLimit: 'briefing',
    cache: [
      `s-maxage=${String(LIVE_BRIEFING_MAX_AGE_S)}, stale-while-revalidate=${String(LIVE_BRIEFING_STALE_WHILE_REVALIDATE_S)}`,
      `s-maxage=${String(REPLAY_MAX_AGE_S)}, immutable`,
    ],
    implemented: true,
  },
  {
    path: '/api/v1/events',
    summary: 'Map features for a viewport, quantized to a tile-aligned bbox.',
    response: mapFeaturesResponseSchema,
    rateLimit: 'default',
    cache: [CACHE_POLICIES.events],
    implemented: false,
    blockedBy:
      'needs a bbox as-of read; `observationsAsOf` and `clusterVersionsAsOf` take a point and a radius.',
  },
  {
    path: '/api/v1/events/{publicId}',
    summary: 'Canonical event detail: observations, version timeline, agreement, correlation.',
    response: null,
    rateLimit: 'default',
    cache: [CACHE_POLICIES.eventDetail],
    implemented: false,
    blockedBy: 'the `EventDetail` contract has no runtime schema yet.',
  },
  {
    path: '/api/v1/fire-clusters/{publicId}',
    summary: 'Fire-cluster detail, version history and detection summary.',
    response: null,
    rateLimit: 'default',
    cache: [CACHE_POLICIES.fireCluster],
    implemented: false,
    blockedBy: 'the `FireClusterDetail` contract has no runtime schema yet.',
  },
  {
    path: '/api/v1/history',
    summary: 'Baseline metrics and the time series behind the charts.',
    response: null,
    rateLimit: 'default',
    cache: [CACHE_POLICIES.history],
    implemented: false,
    blockedBy: '`packages/baselines` is an empty stub: there are no baseline metrics to serve.',
  },
  {
    path: '/api/v1/places/suggest',
    summary: 'Type-ahead from the local GeoNames table, so keystrokes never leave the server.',
    response: null,
    rateLimit: 'default',
    cache: [CACHE_POLICIES.places],
    implemented: false,
    blockedBy: '`packages/geocoding` is an empty stub and the GeoNames import has not been built.',
  },
  {
    path: '/api/v1/places/search',
    summary: 'Submit-time geocoding through Nominatim, server-side and cached.',
    response: null,
    rateLimit: 'placesSearch',
    cache: [CACHE_POLICIES.places],
    implemented: false,
    blockedBy: '`packages/geocoding` is an empty stub.',
  },
  {
    path: '/api/v1/places/reverse',
    summary: 'A label for a rounded coordinate pair.',
    response: null,
    rateLimit: 'placesSearch',
    cache: [CACHE_POLICIES.places],
    implemented: false,
    blockedBy: '`packages/geocoding` is an empty stub.',
  },
  {
    path: '/api/v1/evidence/{id}',
    summary: 'Resolve one primary evidence reference (OBS, FCV, RUN, COR).',
    response: evidenceDetailSchema,
    rateLimit: 'default',
    /* Two values: `immutable` only when the caller pinned a past knowledge time. */
    cache: [
      `s-maxage=${String(LIVE_EVIDENCE_MAX_AGE_S)}, stale-while-revalidate=${String(LIVE_BRIEFING_STALE_WHILE_REVALIDATE_S)}`,
      CACHE_POLICIES.evidence,
    ],
    implemented: true,
  },
  {
    path: '/api/v1/sources/status',
    summary: 'Per-source health, recent runs, policies and attribution.',
    response: sourceStatusSchema,
    rateLimit: 'default',
    cache: [CACHE_POLICIES.sourcesStatus],
    implemented: true,
  },
  {
    path: '/api/v1/replay/horizon',
    summary: 'The earliest replayable knowledge time, per hazard family.',
    response: replayHorizonResponseSchema,
    rateLimit: 'default',
    cache: [CACHE_POLICIES.replayHorizon],
    implemented: true,
  },
];

/** The contract for one path, or `undefined` when the path is not in §13.1. */
export function contractFor(path: string): EndpointContract | undefined {
  return ENDPOINT_CONTRACTS.find((contract) => contract.path === path);
}

/** The OpenAPI version the document declares. 3.1 is the one whose schema object *is* JSON Schema. */
export const OPENAPI_VERSION = '3.1.0';

/**
 * Builds the OpenAPI document from the schemas.
 *
 * Generated, never hand-written, which is the point: the response schema in the document is the
 * same object the contract tests parse responses with, so the document cannot describe a shape the
 * API does not produce. `z.toJSONSchema` is Zod 4's own conversion, so this adds no dependency.
 *
 * How each schema is converted — and why the conversion needs three options rather than none — is
 * documented on `jsonSchemaOf`.
 */
export function buildOpenApiDocument(options: { readonly version: string }): {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
  readonly paths: Record<string, unknown>;
  readonly components: { readonly schemas: Record<string, unknown> };
} {
  const paths: Record<string, unknown> = {};

  for (const contract of ENDPOINT_CONTRACTS) {
    const responses: Record<string, unknown> = {
      '400': problemResponseObject('The request did not satisfy ARCHITECTURE §13.2.'),
      '404': problemResponseObject(
        'The subject of the request does not exist at this knowledge time.',
      ),
      '405': problemResponseObject('The API is read-only: only GET and HEAD are supported.'),
      '429': problemResponseObject('The caller has spent its window (ARCHITECTURE §13.4).'),
      '500': problemResponseObject('An unexpected failure. The body names nothing but a trace id.'),
    };

    /*
     * Branching on `implemented`, not on `response !== null`.
     *
     * `/events` already has its schema — `MapFeaturesResponse` was frozen at G2 and its runtime
     * form is written — but no handler serves it yet. Documenting a 200 for a path that answers
     * 501 would make the document a description of intent rather than of the API, which is the one
     * thing a generated document is supposed to prevent.
     */
    /*
     * An unserved path documents **no success and no 501**.
     *
     * A 501 was documented, and nothing serves one: there is no route file, so the framework
     * answers with its own 404 HTML. A document whose stated purpose is that it cannot describe a
     * shape the API does not produce must not promise a status the API never returns. The `404`
     * already present is the truthful one, and the description says the path is not served.
     */
    if (!contract.implemented || contract.response === null) {
      /* No 200. The `404` below is what a caller actually receives. */
    } else {
      responses['200'] = {
        description: 'The response contract, as frozen in `packages/domain`.',
        headers: {
          /*
           * An `enum`, because two endpoints have a policy that depends on the knowledge time. The
           * first version emitted a `const` whose value was the *sentence* "varies: live
           * s-maxage=120, swr=600; …" — a header value no response has ever carried, which a
           * generated client or a contract validator would assert against.
           */
          'Cache-Control': { schema: { type: 'string', enum: [...contract.cache] } },
          'RateLimit-Limit': { schema: { type: 'string' } },
          'RateLimit-Remaining': { schema: { type: 'string' } },
          'RateLimit-Reset': { schema: { type: 'string' } },
        },
        content: {
          'application/json': {
            schema: jsonSchemaOf(contract.response),
          },
        },
      };
    }

    paths[contract.path] = {
      get: {
        summary: contract.summary,
        description: contract.implemented
          ? contract.summary
          : `**Not yet served.** ${contract.blockedBy ?? ''}`.trim(),
        operationId: operationIdFor(contract.path),
        responses,
      },
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'GeoNerva domain API',
      version: options.version,
      description:
        'Read-only hazard intelligence. Every response is parameterized by a knowledge time, ' +
        'every claim carries the evidence it came from, and an absence is always reported as an ' +
        'absence rather than as a zero. See docs/ARCHITECTURE.md §13.',
    },
    paths,
    components: {
      schemas: {
        ProblemDetails: jsonSchemaOf(problemDetailsSchema),
      },
    },
  };
}

/**
 * One response schema as JSON Schema.
 *
 * `reused: 'ref'` is not an optimisation. Inlining every occurrence produced a **964 KB**
 * document, because a briefing repeats `FamilyCard` once per family and each of those repeats
 * `SubjectSummary`, `RelevanceAssessment`, `Fact` and `BaselineMetricView` beneath it. A document
 * nobody can open is a document nobody reads; `$defs` with references says the same thing and can
 * be reviewed in a diff.
 *
 * `io: 'output'` matters too. A Zod schema describes an input and an output shape, and they differ
 * wherever a default or a transform appears; these are **response** contracts, so the document
 * must describe what the server emits.
 *
 * `unrepresentable: 'any'` lets the two things with no JSON Schema form through as `{}`: the
 * `z.unknown()` fields (a raw excerpt, a correlation reason bag) and the refinements that encode
 * invariants I9 to I15. Refusing to generate a document because an invariant cannot be expressed
 * in JSON Schema would trade a useful document for a purist one — those invariants are enforced by
 * the schema at run time and by the contract tests, which is where they belong.
 */
function jsonSchemaOf(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any', reused: 'ref' });
}

function problemResponseObject(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
    },
  };
}

/** `/api/v1/events/{publicId}` → `getEventsByPublicId`. Stable, so a client generator can rely on it. */
export function operationIdFor(path: string): string {
  const segments = path
    .replace(/^\/api\/v1\//u, '')
    .split('/')
    .filter((segment) => segment !== '');

  const words = segments.flatMap((segment) => {
    const parameter = /^\{(.+)\}$/u.exec(segment);
    if (parameter?.[1] !== undefined) return ['By', capitalize(parameter[1])];
    return segment.split('-').map(capitalize);
  });

  return `get${words.join('')}`;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
