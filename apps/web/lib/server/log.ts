/**
 * The API layer's structured log, and the **only** module in `apps/web` that writes to the
 * console.
 *
 * `no-console` is an error repository-wide, and the only exemption in `apps/web` is the two-line
 * `write` below, disabled inline rather than by a file-wide override in `eslint.config.js` — an
 * override would let a future edit print from anywhere in this module. The point is not the lint
 * rule: a log line from the read path is a place user input can escape, so there should be exactly
 * one function that can emit one, and it should be short enough to read in full.
 *
 * ### What may be logged
 *
 * The fields are chosen so that **no combination of them reconstructs user input**: the request
 * path without its query string, the outcome, the duration, and the `traceId` that also went to
 * the client. A location appears only as its already-rounded key, which is a 1.1 km cell
 * (ADR-015, invariant I15).
 *
 * The query string is never logged, because that is where the coordinates are. ARCHITECTURE §14
 * states the same rule from the other direction — "precise user coordinates are never logged: the
 * logger has a redaction path for `lat`/`lon`/`q` fields outside the worker" — and the strongest
 * form of that redaction is a logger those fields cannot reach.
 *
 * ### What may never be logged
 *
 * A stack trace. In principle a stack is fine; in practice these lines are shipped, a `pg` error's
 * message routinely carries a connection target and its stack carries absolute paths. The
 * `traceId` is what links a log line to the client's copy of the problem document, so nothing is
 * lost by omitting the stack — an operator who needs one reads it from the process, not the feed.
 */

/** One request, as one line. `traceId` is present exactly when a problem document carried one. */
export interface RequestLogFields {
  readonly endpoint: string;
  /** The path. Never the query string. */
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly traceId?: string;
  readonly error?: string;
}

export function logRequest(fields: RequestLogFields): void {
  write(fields.status >= 500 ? 'error' : 'warn', { event: 'api.request', ...fields });
}

/** A named event that is not a request outcome, e.g. an unresolvable evidence citation. */
export function logEvent(
  level: 'warn' | 'error',
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  write(level, { event, ...fields });
}

function write(level: 'warn' | 'error', line: Readonly<Record<string, unknown>>): void {
  const serialized = JSON.stringify(line);
  /* eslint-disable no-console -- the one place in apps/web that may print; see the header. */
  if (level === 'error') console.error(serialized);
  else console.warn(serialized);
  /* eslint-enable no-console */
}

/**
 * A bounded, single-line description of an error.
 *
 * The constructor name and the message, whitespace folded and capped — never the stack. The cap is
 * on the message because an error message is the one part of this that an attacker can influence:
 * a 4 MB provider body quoted into a `SyntaxError` would otherwise be one log line.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message.replace(/\s+/gu, ' ').slice(0, 300)}`;
  }
  return `NonError: ${String(error).replace(/\s+/gu, ' ').slice(0, 300)}`;
}
