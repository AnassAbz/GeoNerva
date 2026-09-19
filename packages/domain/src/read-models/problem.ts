/**
 * `ProblemDetails` — the single error shape of the domain API (docs/ARCHITECTURE.md §13).
 *
 * Every error response is `application/problem+json` (RFC 9457) with a **stable machine-readable
 * `code`**, so that the frontend branches on `code` and never on `title` or HTTP status alone.
 *
 * Security rules that are part of this contract (docs/reviews/security-p1.md):
 *
 *  - `detail` is written by GeoNerva and is safe to display. It never contains a provider body, a
 *    stack trace, a connection string, an internal hostname or a file path.
 *  - `invalidParams[].reason` names the rule that failed; it never echoes the offending value,
 *    because the value may be attacker-controlled and would end up in logs and caches.
 *  - A problem response for a request carrying user coordinates never repeats them at more than
 *    two decimals (invariant I15).
 */

import type { HazardFamily } from '../enums.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';

/** The media type every error response is served with. */
export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** Base URI under which each `code` has a documented page. */
export const PROBLEM_TYPE_BASE = 'https://geonerva.org/problems/';

/** Stable error codes. Adding one is an additive change; removing one requires an ADR. */
export const PROBLEM_CODES = [
  /** A parameter failed validation. `invalidParams` says which and why. */
  'VALIDATION_FAILED',
  /** An unknown query parameter was supplied. Rejected so that cache keys stay canonical. */
  'UNKNOWN_PARAMETER',
  /** The place, event, cluster or evidence item does not exist. */
  'NOT_FOUND',
  /** A location string parsed but resolves to no known place. */
  'LOCATION_NOT_FOUND',
  /** `as_of` is earlier than the replay horizon for a requested family. */
  'AS_OF_BEFORE_HORIZON',
  /** `as_of` is in the future. Replay never sees the future (invariant I2). */
  'AS_OF_IN_FUTURE',
  /** The viewport is larger than the zoom level allows. */
  'BBOX_TOO_LARGE',
  /** The caller exceeded a rate-limit window; `retryAfterS` says when to come back. */
  'RATE_LIMITED',
  /** An upstream service GeoNerva proxies (only the geocoder) is unavailable. */
  'UPSTREAM_UNAVAILABLE',
  /** The method is not allowed on this resource. The API is read-only. */
  'METHOD_NOT_ALLOWED',
  /** Anything unexpected. The message is always generic. */
  'INTERNAL_ERROR',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** HTTP status per code, so that handlers cannot drift from the contract. */
export const PROBLEM_STATUS: Readonly<Record<ProblemCode, number>> = {
  VALIDATION_FAILED: 400,
  UNKNOWN_PARAMETER: 400,
  NOT_FOUND: 404,
  LOCATION_NOT_FOUND: 404,
  AS_OF_BEFORE_HORIZON: 400,
  AS_OF_IN_FUTURE: 400,
  BBOX_TOO_LARGE: 400,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
};

/** One parameter that failed validation. */
export interface InvalidParam {
  /** Parameter name, e.g. `lat`, `bbox`, `as_of`. */
  readonly name: string;
  /** The rule that failed, e.g. "must be within [-90, 90]". Never the submitted value. */
  readonly reason: string;
}

/** An RFC 9457 problem document, with GeoNerva's stable extensions. */
export interface ProblemDetails {
  /** Absolute URI identifying the problem type: `PROBLEM_TYPE_BASE` + lowercased code. */
  readonly type: string;
  /** Short, human-readable summary. Stable per `code`; safe to display. */
  readonly title: string;
  readonly status: number;
  /** Human-readable explanation of this occurrence, safe to display. */
  readonly detail: string | null;
  /** The request path this occurred on. Query strings are omitted. */
  readonly instance: string | null;

  // ── GeoNerva extensions ────────────────────────────────────────────────────
  /** The stable machine-readable code the frontend branches on. */
  readonly code: ProblemCode;
  readonly invalidParams: readonly InvalidParam[];
  /** For `RATE_LIMITED`, mirrored in the `Retry-After` header. */
  readonly retryAfterS: number | null;
  /** For `AS_OF_BEFORE_HORIZON`: the earliest replayable time, and for which families. */
  readonly earliestAsOf: IsoTimestamp | null;
  readonly affectedFamilies: readonly HazardFamily[];
  /** Correlates the response with server logs. Random per request; carries no user data. */
  readonly traceId: string | null;
}

/** Builds the canonical `type` URI for a code. */
export function problemTypeUri(code: ProblemCode): string {
  return `${PROBLEM_TYPE_BASE}${code.toLowerCase().replace(/_/g, '-')}`;
}
