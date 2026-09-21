/**
 * `application/problem+json` responses (ARCHITECTURE §13, RFC 9457).
 *
 * The error shape is **frozen** in `packages/domain/src/read-models/problem.ts`, including the
 * stable `code` list and the HTTP status per code. Nothing here invents a shape; this module turns
 * a `ProblemCode` into a `Response` and enforces the three security rules the contract states:
 *
 *  - `detail` is written by GeoNerva. It never carries a provider body, a stack trace, a
 *    connection string, an internal hostname or a file path.
 *  - `invalidParams[].reason` names the **rule** that failed and never echoes the submitted
 *    value, because that value is attacker-controlled and would end up in logs and CDN caches.
 *  - a problem response for a request carrying user coordinates never repeats them at more than
 *    two decimals (invariant I15). The simplest way to guarantee that is the one taken here:
 *    `instance` is the path only, query strings are dropped, and no handler is given a way to
 *    interpolate a parameter value into `detail`.
 *
 * ### Why `INTERNAL_ERROR` is deliberately uninformative
 *
 * An unexpected failure returns a fixed sentence and a `traceId`. The operator correlates the id
 * with the server log, which holds the real error; the client learns nothing about the shape of
 * the system. That asymmetry is the whole point — a stack trace in an error body is a map of the
 * codebase, and a database error message frequently contains a table name or a connection target.
 */

import { randomUUID } from 'node:crypto';

import {
  PROBLEM_MEDIA_TYPE,
  PROBLEM_STATUS,
  problemTypeUri,
  type HazardFamily,
  type InvalidParam,
  type ProblemCode,
  type ProblemDetails,
} from '@geonerva/domain';

/** Fixed, displayable titles. Stable per code, because the frontend may show them verbatim. */
const TITLES: Readonly<Record<ProblemCode, string>> = {
  VALIDATION_FAILED: 'One or more parameters are invalid',
  UNKNOWN_PARAMETER: 'Unknown query parameter',
  NOT_FOUND: 'Not found',
  LOCATION_NOT_FOUND: 'Location not found',
  AS_OF_BEFORE_HORIZON: 'That time is outside the replayable window',
  AS_OF_IN_FUTURE: 'That time is in the future',
  BBOX_TOO_LARGE: 'The requested area is too large for this zoom level',
  RATE_LIMITED: 'Too many requests',
  UPSTREAM_UNAVAILABLE: 'An upstream service is unavailable',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  INTERNAL_ERROR: 'Something went wrong',
};

export interface ProblemOptions {
  readonly code: ProblemCode;
  /** Written by GeoNerva, safe to display. Never derived from a request value. */
  readonly detail?: string | null;
  /** The request **path**. The query string is stripped here, not by the caller. */
  readonly instance?: string | null;
  readonly invalidParams?: readonly InvalidParam[];
  readonly retryAfterS?: number | null;
  readonly earliestAsOf?: string | null;
  readonly affectedFamilies?: readonly HazardFamily[];
  /** Supplied when the caller already logged under this id; generated otherwise. */
  readonly traceId?: string;
}

/** A typed error a handler or service may throw, and the API layer turns into a response. */
export class ApiProblemError extends Error {
  readonly problem: ProblemOptions;

  constructor(problem: ProblemOptions) {
    super(`${problem.code}: ${problem.detail ?? TITLES[problem.code]}`);
    this.name = 'ApiProblemError';
    this.problem = problem;
  }
}

/** Builds the problem document. Pure, so the contract can be asserted without a `Response`. */
export function problemDocument(options: ProblemOptions): ProblemDetails {
  const code = options.code;
  return {
    type: problemTypeUri(code),
    title: TITLES[code],
    status: PROBLEM_STATUS[code],
    detail: options.detail ?? null,
    instance:
      options.instance === undefined || options.instance === null
        ? null
        : pathOnly(options.instance),
    code,
    invalidParams: options.invalidParams ?? [],
    retryAfterS: options.retryAfterS ?? null,
    earliestAsOf: options.earliestAsOf ?? null,
    affectedFamilies: options.affectedFamilies ?? [],
    traceId: options.traceId ?? randomUUID(),
  };
}

/**
 * Builds the HTTP response.
 *
 * `Cache-Control: no-store` on every problem. A cached 400 is a cache-poisoning primitive: one
 * malformed request would serve that error to everyone behind the same CDN key, and a cached 429
 * would extend one caller's rate limit to the whole edge. Errors are cheap to recompute.
 */
export function problemResponse(options: ProblemOptions): Response {
  const document = problemDocument(options);
  const headers = new Headers({
    'content-type': PROBLEM_MEDIA_TYPE,
    'cache-control': 'no-store',
  });
  if (document.retryAfterS !== null) {
    headers.set('retry-after', String(Math.max(0, Math.ceil(document.retryAfterS))));
  }
  return new Response(JSON.stringify(document), { status: document.status, headers });
}

/**
 * The path, without query or fragment.
 *
 * A query string is the one part of a URL that carries user input, so echoing it into `instance`
 * would reintroduce both the coordinate-precision leak (I15) and the reflected-value problem that
 * `invalidParams[].reason` is written to avoid. Relative inputs are handled without a base URL,
 * because `new URL('/api/v1/briefing')` throws.
 */
export function pathOnly(instance: string): string {
  const cut = instance.search(/[?#]/u);
  return cut === -1 ? instance : instance.slice(0, cut);
}

/**
 * Turns any thrown value into a response.
 *
 * An `ApiProblemError` keeps its code; **everything else becomes `INTERNAL_ERROR`** with a generic
 * sentence. The original is returned for the caller to log under the same `traceId`, so the
 * information is not lost — it is simply not sent to the client.
 */
export function toProblemResponse(
  error: unknown,
  instance: string,
): { readonly response: Response; readonly traceId: string; readonly cause: unknown } {
  const traceId = randomUUID();
  if (error instanceof ApiProblemError) {
    return {
      response: problemResponse({ ...error.problem, instance, traceId }),
      traceId,
      cause: null,
    };
  }
  return {
    response: problemResponse({
      code: 'INTERNAL_ERROR',
      detail: 'GeoNerva could not complete this request. The error has been recorded.',
      instance,
      traceId,
    }),
    traceId,
    cause: error,
  };
}
