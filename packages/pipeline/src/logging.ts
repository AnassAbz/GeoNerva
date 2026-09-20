/**
 * Structured ingestion logs, with redaction by allowlist.
 *
 * Allowlist, not blocklist. A log line is assembled from fields this module knows about; anything
 * else is dropped. The alternative — logging an object and stripping the dangerous keys — fails
 * the first time a provider adds a field, and the failure mode is a key in a log aggregator.
 *
 * This is not a metrics platform. It emits one JSON line per run and one per stage, with the
 * counters `/data-status` is derived from, so a human or `jq` can answer "what happened at
 * 03:10?" without a database. Anything more is a later phase's problem.
 */

import type { ErrorClass, RunStatus } from '@geonerva/domain';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Every field an ingestion log line may carry. Anything not here is not logged. */
export interface IngestionLogFields {
  readonly sourceId?: string;
  readonly productCode?: string;
  readonly runId?: string;
  readonly trigger?: string;
  readonly stage?: 'lease' | 'fetch' | 'parse' | 'normalize' | 'persist' | 'run';
  readonly status?: RunStatus | 'LEASE_HELD';
  readonly errorClass?: ErrorClass;
  /** Sanitized: a short description, never a provider body or a stack trace. */
  readonly detail?: string;
  /** Host and path only. Never a full URL — FIRMS puts its key in the path. */
  readonly endpoint?: string;
  readonly httpStatus?: number;
  readonly attempts?: number;
  readonly bytes?: number;
  readonly conditional?: boolean;
  readonly received?: number;
  readonly declaredCount?: number;
  readonly accepted?: number;
  readonly rejected?: number;
  readonly newRecords?: number;
  readonly newVersions?: number;
  readonly unchanged?: number;
  readonly mergedRecords?: number;
  readonly newestObservedAt?: string;
  readonly fetchMs?: number;
  readonly parseMs?: number;
  readonly normalizeMs?: number;
  readonly persistMs?: number;
  readonly totalMs?: number;
}

const ALLOWED_FIELDS: readonly (keyof IngestionLogFields)[] = [
  'sourceId',
  'productCode',
  'runId',
  'trigger',
  'stage',
  'status',
  'errorClass',
  'detail',
  'endpoint',
  'httpStatus',
  'attempts',
  'bytes',
  'conditional',
  'received',
  'declaredCount',
  'accepted',
  'rejected',
  'newRecords',
  'newVersions',
  'unchanged',
  'mergedRecords',
  'newestObservedAt',
  'fetchMs',
  'parseMs',
  'normalizeMs',
  'persistMs',
  'totalMs',
];

/** Length beyond which a detail is truncated, matching the 1 KB the run column accepts. */
export const MAX_DETAIL_LENGTH = 1_000;

export interface Logger {
  log(level: LogLevel, event: string, fields: IngestionLogFields): void;
}

/**
 * Trims a message to something safe to store and log.
 *
 * Newlines collapse because a stack trace pasted into `error_message` defeats both the 1 KB
 * bound and the one-line-per-event format.
 */
export function sanitizeDetail(value: string): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length <= MAX_DETAIL_LENGTH
    ? flattened
    : `${flattened.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

/** Builds the record actually written: allowlisted keys, `undefined` dropped, detail bounded. */
export function redact(fields: IngestionLogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_FIELDS) {
    const value = fields[key];
    if (value === undefined) continue;
    out[key] = key === 'detail' && typeof value === 'string' ? sanitizeDetail(value) : value;
  }
  return out;
}

/**
 * One JSON object per line on stdout — the format a container runtime already collects.
 *
 * `process.stdout.write` rather than `console.log`: this is a library, and `console` is reserved
 * for the CLI layer that is allowed to talk to a human.
 */
export function createJsonLogger(
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  now: () => Date = () => new Date(),
): Logger {
  return {
    log(level, event, fields) {
      write(JSON.stringify({ ts: now().toISOString(), level, event, ...redact(fields) }));
    },
  };
}

/** A logger that records instead of printing, for tests and for asserting what was observable. */
export function createMemoryLogger(): Logger & {
  readonly entries: { level: LogLevel; event: string; fields: Record<string, unknown> }[];
} {
  const entries: { level: LogLevel; event: string; fields: Record<string, unknown> }[] = [];
  return {
    entries,
    log(level, event, fields) {
      entries.push({ level, event, fields: redact(fields) });
    },
  };
}
