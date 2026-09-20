/**
 * SourceHealth derivation (docs/DOMAIN_MODEL.md §4.3, ADR-022).
 *
 * Health is a **pure function** of ingestion-run history plus the freshness policy. Nothing is
 * written except the runs themselves, which is what makes health replayable for free: asking
 * "what did GeoNerva know about FIRMS health at 12:10?" is the same call with a different `asOf`.
 *
 * Two consequences of that design are load-bearing:
 *
 *  - A run is only knowledge once it is **committed**. `committed_at` is the batch timestamp taken
 *    immediately before `COMMIT`, so a run still `RUNNING` — or one that committed after `asOf` —
 *    is invisible. This is what keeps invariant I2 ("replay never sees the future") true for the
 *    health read path, not just for facts.
 *  - **Failed runs are committed too**, with zero versions, because failure is the evidence that
 *    a source is unhealthy (§4.4).
 *
 * The function never reads a clock: `asOf` is always supplied by the caller.
 */

import {
  SUCCESSFUL_RUN_STATUSES,
  type ErrorClass,
  type RunStatus,
  type SourceHealthStatus,
} from '../enums.ts';
import { evidenceId, type EvidenceId } from '../evidence/evidence-id.ts';
import { hasDataCurrencyPolicy, type FreshnessPolicy } from '../value-objects/freshness-policy.ts';
import type { Uuid } from '../value-objects/ids.ts';
import { elapsedSeconds } from '../value-objects/time.ts';

/** The subset of an `ingestion_runs` row the derivation needs. */
export interface IngestionRunFact {
  readonly id: Uuid;
  readonly status: RunStatus;
  /** When the adapter started. Always ≤ `committedAt`. */
  readonly startedAt: Date;
  /** The batch timestamp. `null` while the run is still `RUNNING`, which makes it invisible. */
  readonly committedAt: Date | null;
  /** Newest provider `observed_at` this run saw, for the data-currency dimension. */
  readonly newestObservedAt: Date | null;
  readonly errorClass: ErrorClass | null;
}

/** Why a source is in the state it is in. Reasons are shown on `/data-status`, never hidden. */
export const SOURCE_HEALTH_REASONS = [
  /** The source or product is switched off in the database. */
  'DISABLED',
  /** No successful poll has ever been committed at or before `asOf`. */
  'NEVER_SUCCEEDED',
  /** No successful poll for longer than `unavailableAfterS`. */
  'NO_SUCCESS_BEYOND_LIMIT',
  /** No successful poll within `fetchStaleAfterS`. */
  'POLL_STALE',
  /** Last success is older than `fetchFreshWithinS` but still within the stale threshold. */
  'POLL_AGEING',
  /** At least one failed run has been committed since the last success (failure within grace). */
  'LAST_POLL_FAILED',
  /** The most recent successful run only stored part of its batch. */
  'PARTIAL_BATCH',
  /** Newest observation older than `dataStaleAfterS`. */
  'DATA_STALE',
  /** Newest observation older than `dataCurrentWithinS`. */
  'DATA_AGEING',
  /** Polls succeed, but a source where silence is abnormal has never delivered an observation. */
  'DATA_NEVER_SEEN',
  /** Everything within policy. */
  'OK',
] as const;
export type SourceHealthReason = (typeof SOURCE_HEALTH_REASONS)[number];

/** Derived health of one source, or of one product within a source. */
export interface SourceHealth {
  readonly sourceId: string;
  /** `null` for the source-level rollup, a `source_products.id` for a single feed or sensor. */
  readonly productId: number | null;
  readonly status: SourceHealthStatus;
  /** Most recent attempt GeoNerva knows about at `asOf` (from a committed run). */
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  /** Data currency: the newest provider observation any visible successful run reported. */
  readonly newestObservedAt: Date | null;
  readonly consecutiveFailures: number;
  readonly lastErrorClass: ErrorClass | null;
  /** The policy the judgement was made against, so the UI can state the expectation. */
  readonly expected: FreshnessPolicy;
  /** `EV:RUN:<id>` of the most recent visible run, or `null` when there is none. */
  readonly evidenceId: EvidenceId | null;
  readonly reasons: readonly SourceHealthReason[];
  /** The knowledge time this judgement is for. */
  readonly asOf: Date;
}

export interface DeriveSourceHealthInput {
  readonly sourceId: string;
  readonly productId?: number | null;
  /** `sources.enabled` (and, for a product, `status !== 'RETIRED'`). */
  readonly enabled: boolean;
  readonly policy: FreshnessPolicy;
  /** Run history in any order. Only committed runs at or before `asOf` are considered. */
  readonly runs: readonly IngestionRunFact[];
  readonly asOf: Date;
}

/** Severity order, so that several independent findings can be combined by "worst wins". */
const STATUS_SEVERITY: Readonly<Record<SourceHealthStatus, number>> = {
  FRESH: 0,
  DEGRADED: 1,
  STALE: 2,
  UNAVAILABLE: 3,
};

function worst(a: SourceHealthStatus, b: SourceHealthStatus): SourceHealthStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

function isSuccessful(status: RunStatus): boolean {
  return (SUCCESSFUL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** Committed runs at or before `asOf`, oldest first. Ties break on `startedAt`, then on `id`. */
function visibleRuns(
  runs: readonly IngestionRunFact[],
  asOf: Date,
): readonly (IngestionRunFact & { readonly committedAt: Date })[] {
  const cutoff = asOf.getTime();
  return runs
    .filter(
      (run): run is IngestionRunFact & { committedAt: Date } =>
        run.committedAt !== null && run.committedAt.getTime() <= cutoff,
    )
    .sort(
      (a, b) =>
        a.committedAt.getTime() - b.committedAt.getTime() ||
        a.startedAt.getTime() - b.startedAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * Derives the health of one source or product at a knowledge time.
 *
 * The decision, in order:
 *
 * | Condition | Status |
 * |---|---|
 * | disabled | `UNAVAILABLE` |
 * | never succeeded | `UNAVAILABLE` |
 * | last success older than `unavailableAfterS` (default 24 h) | `UNAVAILABLE` |
 * | last success older than `fetchStaleAfterS` | `STALE` |
 * | newest observation older than `dataStaleAfterS` (only when `quietIsNormal` is false) | `STALE` |
 * | last success older than `fetchFreshWithinS`, a committed failure since the last success, a `PARTIAL` batch, or newest observation older than `dataCurrentWithinS` | `DEGRADED` |
 * | otherwise | `FRESH` |
 *
 * Several conditions can hold at once; the worst wins and **every** reason is reported.
 */
export function deriveSourceHealth(input: DeriveSourceHealthInput): SourceHealth {
  const { sourceId, enabled, policy, asOf } = input;
  const productId = input.productId ?? null;
  const runs = visibleRuns(input.runs, asOf);

  const lastRun = runs.at(-1) ?? null;
  const lastAttemptAt = runs.reduce<Date | null>(
    (latest, run) =>
      latest === null || run.startedAt.getTime() > latest.getTime() ? run.startedAt : latest,
    null,
  );

  const successes = runs.filter((run) => isSuccessful(run.status));
  const lastSuccess = successes.at(-1) ?? null;
  const lastSuccessAt = lastSuccess?.committedAt ?? null;

  const newestObservedAt = successes.reduce<Date | null>((newest, run) => {
    const candidate = run.newestObservedAt;
    if (candidate === null) return newest;
    return newest === null || candidate.getTime() > newest.getTime() ? candidate : newest;
  }, null);

  // A run we cancelled ourselves — a worker handling SIGTERM — is not evidence about the source
  // (ADR-032). Counting it would mark every source DEGRADED after a routine deploy, which is a
  // false alarm and, worse, trains the operator to ignore the one signal that matters.
  // `CONFIG_ERROR` is deliberately *not* excluded: a broken allowlist means we really do have no
  // data, so the status must degrade. Only `lastErrorClass` says whose fault it is.
  const failuresSinceSuccess = runs.filter(
    (run) =>
      run.status === 'FAILED' &&
      run.errorClass !== 'ABORTED' &&
      (lastSuccessAt === null || run.committedAt.getTime() > lastSuccessAt.getTime()),
  );
  const lastFailure = failuresSinceSuccess.at(-1) ?? null;
  const lastErrorClass =
    lastFailure?.errorClass ??
    runs.filter((run) => run.errorClass !== null).at(-1)?.errorClass ??
    null;

  const evidence = lastRun === null ? null : evidenceId.ingestionRun(lastRun.id);

  const base = {
    sourceId,
    productId,
    lastAttemptAt,
    lastSuccessAt,
    newestObservedAt,
    consecutiveFailures: failuresSinceSuccess.length,
    lastErrorClass,
    expected: policy,
    evidenceId: evidence,
    asOf,
  } as const;

  if (!enabled) {
    return { ...base, status: 'UNAVAILABLE', reasons: ['DISABLED'] };
  }
  if (lastSuccessAt === null) {
    return { ...base, status: 'UNAVAILABLE', reasons: ['NEVER_SUCCEEDED'] };
  }

  const pollAgeS = elapsedSeconds(lastSuccessAt, asOf);
  if (pollAgeS > policy.unavailableAfterS) {
    return { ...base, status: 'UNAVAILABLE', reasons: ['NO_SUCCESS_BEYOND_LIMIT'] };
  }

  const reasons: SourceHealthReason[] = [];
  let status: SourceHealthStatus = 'FRESH';

  if (pollAgeS > policy.fetchStaleAfterS) {
    status = worst(status, 'STALE');
    reasons.push('POLL_STALE');
  } else if (pollAgeS > policy.fetchFreshWithinS) {
    status = worst(status, 'DEGRADED');
    reasons.push('POLL_AGEING');
  }

  if (failuresSinceSuccess.length > 0) {
    status = worst(status, 'DEGRADED');
    reasons.push('LAST_POLL_FAILED');
  }

  if (lastSuccess !== null && lastSuccess.status === 'PARTIAL') {
    status = worst(status, 'DEGRADED');
    reasons.push('PARTIAL_BATCH');
  }

  if (hasDataCurrencyPolicy(policy)) {
    if (newestObservedAt === null) {
      status = worst(status, 'STALE');
      reasons.push('DATA_NEVER_SEEN');
    } else {
      const dataAgeS = elapsedSeconds(newestObservedAt, asOf);
      const staleAfter = policy.dataStaleAfterS;
      const currentWithin = policy.dataCurrentWithinS;
      if (staleAfter !== null && dataAgeS > staleAfter) {
        status = worst(status, 'STALE');
        reasons.push('DATA_STALE');
      } else if (currentWithin !== null && dataAgeS > currentWithin) {
        status = worst(status, 'DEGRADED');
        reasons.push('DATA_AGEING');
      }
    }
  }

  if (reasons.length === 0) reasons.push('OK');
  return { ...base, status, reasons };
}

/**
 * Rolls product-level health up to one source-level judgement.
 *
 * The status is the **worst** across products, because a dashboard must not call FIRMS healthy
 * when NOAA-21 has stopped delivering. Timestamps take the most recent value across products,
 * since they answer "when did we last hear anything from this source at all?".
 */
export function aggregateSourceHealth(
  sourceId: string,
  policy: FreshnessPolicy,
  parts: readonly SourceHealth[],
  asOf: Date,
): SourceHealth {
  if (parts.length === 0) {
    return {
      sourceId,
      productId: null,
      status: 'UNAVAILABLE',
      lastAttemptAt: null,
      lastSuccessAt: null,
      newestObservedAt: null,
      consecutiveFailures: 0,
      lastErrorClass: null,
      expected: policy,
      evidenceId: null,
      reasons: ['NEVER_SUCCEEDED'],
      asOf,
    };
  }

  const latest = (pick: (part: SourceHealth) => Date | null): Date | null =>
    parts.reduce<Date | null>((best, part) => {
      const value = pick(part);
      if (value === null) return best;
      return best === null || value.getTime() > best.getTime() ? value : best;
    }, null);

  const worstPart = parts.reduce((a, b) =>
    STATUS_SEVERITY[a.status] >= STATUS_SEVERITY[b.status] ? a : b,
  );

  return {
    sourceId,
    productId: null,
    status: worstPart.status,
    lastAttemptAt: latest((part) => part.lastAttemptAt),
    lastSuccessAt: latest((part) => part.lastSuccessAt),
    newestObservedAt: latest((part) => part.newestObservedAt),
    consecutiveFailures: Math.max(...parts.map((part) => part.consecutiveFailures)),
    lastErrorClass: worstPart.lastErrorClass,
    expected: policy,
    evidenceId: worstPart.evidenceId,
    reasons: [...new Set(parts.flatMap((part) => part.reasons))],
    asOf,
  };
}

/** True when a health status means the family cannot be shown as if data were complete (I11). */
export function isDataUnavailable(status: SourceHealthStatus): boolean {
  return status === 'STALE' || status === 'UNAVAILABLE';
}
