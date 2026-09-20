/**
 * The error taxonomy for outbound fetches (ARCHITECTURE.md §4.2).
 *
 * Classification is the point. A run's `error_class` is what `/data-status` shows and what
 * source health is derived from, so "it failed" is never an acceptable answer: a timeout, a
 * rate limit and a schema change are three different operational stories and must be told apart
 * without reading a stack trace.
 */

/** Failure classes shared by every source. Stored verbatim in `ingestion_runs.error_class`. */
export const FETCH_ERROR_CLASSES = [
  'HTTP_4XX',
  'HTTP_5XX',
  'RATE_LIMITED',
  'TIMEOUT',
  'TOO_LARGE',
  'NETWORK',
  'CONFIG_ERROR',
  'ABORTED',
] as const;
export type FetchErrorClass = (typeof FETCH_ERROR_CLASSES)[number];

/**
 * Classes worth retrying: the condition is plausibly temporary.
 *
 * `ABORTED` is deliberately absent. A cancellation is the *caller* telling us to stop — usually a
 * worker handling SIGTERM — so retrying it would ignore the instruction and hold the process open
 * past its shutdown deadline. It is also why an abort is not folded into `TIMEOUT`: an operator
 * reading `/data-status` must be able to tell "we shut the worker down" from "the provider was
 * slow", and those two have opposite remedies.
 */
const TRANSIENT: ReadonlySet<FetchErrorClass> = new Set<FetchErrorClass>([
  'HTTP_5XX',
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK',
]);

export function isTransient(errorClass: FetchErrorClass): boolean {
  return TRANSIENT.has(errorClass);
}

export interface FetchErrorContext {
  /** Never the full URL: a connection string or key can hide in a query string. */
  readonly host: string;
  readonly path?: string;
  readonly status?: number;
  readonly attempt?: number;
  readonly bytesRead?: number;
  readonly retryAfterMs?: number;
}

/**
 * A fetch that failed, with the class the pipeline records and enough context to debug without
 * exposing credentials. `cause` keeps the original error for local debugging; it is never logged
 * verbatim (see `packages/pipeline/logging.ts`).
 */
export class SourceFetchError extends Error {
  readonly errorClass: FetchErrorClass;
  readonly context: FetchErrorContext;
  readonly transient: boolean;

  constructor(
    errorClass: FetchErrorClass,
    message: string,
    context: FetchErrorContext,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SourceFetchError';
    this.errorClass = errorClass;
    this.context = context;
    this.transient = isTransient(errorClass);
  }

  /** A one-line description safe to log: class, host, path and status only. */
  describe(): string {
    const parts = [this.errorClass, this.context.host];
    if (this.context.path !== undefined) parts.push(this.context.path);
    if (this.context.status !== undefined) parts.push(`status=${this.context.status}`);
    if (this.context.attempt !== undefined) parts.push(`attempt=${this.context.attempt}`);
    return parts.join(' ');
  }
}

/** Maps an HTTP status to its class. 429 is separated because it is a rate limit, not a 4xx bug. */
export function classifyStatus(status: number): FetchErrorClass {
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'HTTP_5XX';
  return 'HTTP_4XX';
}

/**
 * Maps a thrown transport error to its class.
 *
 * `AbortError` and `TimeoutError` are both raised by an aborted fetch and the name alone does not
 * say who aborted it, so callers that know (the client does: it owns the timeout) should decide
 * between `TIMEOUT` and `ABORTED` themselves. This is the fallback for when nobody knows.
 */
export function classifyTransportError(error: unknown): FetchErrorClass {
  if (error instanceof SourceFetchError) return error.errorClass;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return 'TIMEOUT';
  if (name === 'AbortError') return 'ABORTED';
  return 'NETWORK';
}
