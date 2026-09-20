/**
 * The resumable historical backfill (P4.2, P4.3).
 *
 * It drives windows; everything below the fetch is the ordinary ingestion lifecycle. That reuse is
 * the point rather than an economy: a backfilled event and a live one go through the same parse,
 * the same normalize and the same persist, so they resolve to one record because they are the same
 * code path — not because two implementations were expected to agree.
 *
 * What makes it resumable:
 *
 *  - **The plan lives in the database.** No cursor in process memory. A restart on another machine
 *    reads the plan and the interval states and carries on.
 *  - **The checkpoint is written inside the transaction that commits the window's facts.** There is
 *    no instant at which the facts exist and the interval still reads PENDING, so the "crashed
 *    after persistence, before the checkpoint" case is closed by construction rather than repaired
 *    afterwards. Replaying a window is idempotent regardless, which is what makes the *other*
 *    crash — before persistence — safe.
 *  - **Splitting is deterministic.** A resumed process recomputes the same boundaries, and the
 *    parent is kept as `SPLIT` so it can never be re-planned and split again forever.
 */

import type { Kysely } from 'kysely';

import type { ErrorClass } from '@geonerva/domain';

import {
  addBackfillIntervals,
  backfillProgress,
  claimNextInterval,
  finishBackfillPlan,
  markIntervalDone,
  markIntervalFailed,
  openBackfillPlan,
  recordIntervalAttempt,
  resetFailedIntervals,
  splitBackfillInterval,
  type BackfillProgress,
  type DB,
} from '@geonerva/db';
import { SourceFetchError } from '@geonerva/http';
import {
  FdsnQueryError,
  WindowPlanError,
  describePlanDefect,
  fdsnCount,
  fdsnEndpoint,
  fdsnFetch,
  isWindowTooLarge,
  payloadHash,
  planWindows,
  splitWindow,
  type FdsnMode,
  type FdsnWindow,
  type PlannedWindow,
  type SourceAdapter,
  type WindowPlanOptions,
} from '@geonerva/sources';
import type { HttpClient } from '@geonerva/http';

import { createJsonLogger, sanitizeDetail, type Logger } from './logging.ts';
import { runIngestion, type RunOutcome } from './run.ts';

export interface BackfillRequest {
  readonly from: Date;
  readonly to: Date;
  readonly minMagnitude?: number;
}

export interface RunBackfillOptions<TRaw> {
  readonly db: Kysely<DB>;
  readonly adapter: SourceAdapter<TRaw>;
  readonly client: HttpClient;
  readonly request: BackfillRequest;
  readonly plan: WindowPlanOptions;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /**
   * Stop after this many intervals, leaving the rest PENDING.
   *
   * A backfill of a decade is not one sitting. Stopping early is a normal outcome, not a failure,
   * and the plan says exactly where it got to.
   */
  readonly maxIntervals?: number;
  readonly mode?: FdsnMode;
}

export interface BackfillOutcome {
  readonly planId: string;
  /** `COMPLETED` only when nothing is pending or failed — the repository refuses otherwise. */
  readonly status: 'COMPLETED' | 'INCOMPLETE' | 'FAILED';
  readonly progress: BackfillProgress;
  readonly intervalsProcessed: number;
  readonly intervalsSplit: number;
  readonly newVersions: number;
  readonly unchanged: number;
  readonly detail: string | null;
}

/** How many times one window is attempted before it is recorded as FAILED rather than retried. */
const MAX_INTERVAL_ATTEMPTS = 3;

function toFdsnWindow(window: PlannedWindow, minMagnitude: number | undefined): FdsnWindow {
  return {
    from: window.from,
    to: window.to,
    ...(minMagnitude === undefined ? {} : { minMagnitude }),
  };
}

/**
 * Runs (or resumes) a backfill.
 *
 * Never throws for an expected failure: a window the provider refuses, a window that cannot be
 * split, a batch the database rejects — each is recorded against its interval and the backfill
 * carries on, so one bad window in a decade does not discard the decade. The plan cannot then be
 * `COMPLETED`, which is how the failure stays visible instead of being smoothed over.
 */
export async function runBackfill<TRaw>(
  options: RunBackfillOptions<TRaw>,
): Promise<BackfillOutcome> {
  const { db, adapter, client, request } = options;
  const logger = options.logger ?? createJsonLogger();
  const mode = options.mode ?? 'live';
  const descriptor = adapter.descriptor;
  const base = { sourceId: descriptor.sourceId, productCode: descriptor.productCode };

  // Planning first, so an impossible range is refused before a plan row exists.
  const windows = planWindows(request.from, request.to, options.plan);
  const defect = describePlanDefect(windows, request.from, request.to);
  if (defect !== null) {
    // A plan with a hole in it produces a catalogue with a hole in it, and nothing downstream
    // would ever report the gap.
    throw new WindowPlanError(`refusing to persist a defective plan: ${defect}`);
  }

  const { plan, created } = await openBackfillPlan(db, {
    sourceId: descriptor.sourceId,
    productId: null,
    mode: mode === 'deleted-only' ? 'DELETION_SWEEP' : 'HISTORICAL',
    rangeFrom: request.from,
    rangeTo: request.to,
    minMagnitude: request.minMagnitude ?? null,
    windowMs: options.plan.windowMs,
    minWindowMs: options.plan.minWindowMs,
  });
  await addBackfillIntervals(db, plan.id, windows);
  // Re-requesting a range is an explicit instruction to try again, so previously failed windows
  // go back to PENDING. Without this one bad window would make the plan permanently
  // un-completable and the only remedy would be editing the database by hand.
  const retried = await resetFailedIntervals(db, plan.id);

  logger.log('info', 'backfill.started', {
    ...base,
    runId: plan.id,
    detail:
      `${created ? 'new' : 'resuming'} plan, ${windows.length} window(s) over ` +
      `${request.from.toISOString()}–${request.to.toISOString()}` +
      (retried > 0 ? `, retrying ${retried} previously failed` : ''),
  });

  let intervalsProcessed = 0;
  let intervalsSplit = 0;
  let leaseHeld = false;
  let newVersions = 0;
  let unchanged = 0;

  while (options.signal?.aborted !== true) {
    if (options.maxIntervals !== undefined && intervalsProcessed >= options.maxIntervals) break;

    const interval = await db.transaction().execute((trx) => claimNextInterval(trx, plan.id));
    if (interval === null) break;

    const attempts = await recordIntervalAttempt(db, plan.id, interval);
    const window = toFdsnWindow(interval, request.minMagnitude);

    try {
      // Ask how many rows the window holds before paying for them. The count endpoint answers
      // HTTP 200 with an `error` field when it is over the limit, which `parseFdsnCount` reads.
      const count = await fdsnCount(window, mode, {
        client,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (count.overLimit) {
        intervalsSplit += 1;
        await splitTooLargeWindow(db, plan.id, interval, options.plan, logger, base, count.count);
        continue;
      }

      const outcome = await ingestWindow(options, plan.id, interval, window, mode, logger);

      /*
       * Another worker holds this product's ingestion lease.
       *
       * Nothing was fetched and nothing was written, so `beforeCommit` never ran and the interval
       * is still PENDING — which means claiming again would hand back the *same* interval, and
       * the loop would spin on it for as long as the other worker held the lease. Stopping is the
       * correct response: the plan stays open and the next invocation resumes it.
       */
      if (outcome.status === 'LEASE_HELD') {
        leaseHeld = true;
        logger.log('info', 'backfill.lease_held', {
          ...base,
          runId: plan.id,
          detail: 'another run holds this product; leaving the plan open',
        });
        break;
      }

      intervalsProcessed += 1;
      newVersions += outcome.counts.newVersions;
      unchanged += outcome.counts.unchanged;

      /*
       * A fetch failure never reaches the catch below: `runIngestion` converts it into a
       * committed FAILED run, which is its contract. So the window-too-large decision has to be
       * made from the outcome's status, and the status is why `RunOutcome` carries it.
       */
      if (
        outcome.status === 'FAILED' &&
        isSizeRefusal(outcome.httpStatus) &&
        splittable(interval, options.plan)
      ) {
        intervalsSplit += 1;
        await splitTooLargeWindow(db, plan.id, interval, options.plan, logger, base);
        continue;
      }

      if (outcome.status === 'FAILED') {
        await markIntervalFailed(
          db,
          plan.id,
          interval,
          outcome.errorClass ?? 'UNKNOWN',
          sanitizeDetail(outcome.detail ?? 'the window failed'),
        );
      }
    } catch (error) {
      /*
       * No body text: the hardened client discards a non-2xx body rather than risk putting
       * provider bytes in an error, so `isWindowTooLarge` decides on the status alone. That is
       * sound here because the FDSN parameters are typed, validated and closed — a caller cannot
       * produce a malformed query, so a 400 on a window that passed the count check is a
       * disagreement about size.
       */
      const tooLarge = error instanceof SourceFetchError && isWindowTooLarge(error);
      if (tooLarge) {
        intervalsSplit += 1;
        await splitTooLargeWindow(db, plan.id, interval, options.plan, logger, base);
        continue;
      }

      const detail = describeBackfillFailure(error);
      // A window that cannot be split, or a shape we cannot parse, will fail identically on every
      // attempt. Spending three passes to rediscover that is just a slower way to fail.
      if (isPermanent(error) || attempts >= MAX_INTERVAL_ATTEMPTS) {
        await markIntervalFailed(db, plan.id, interval, classOf(error), sanitizeDetail(detail));
        logger.log('error', 'backfill.interval_failed', {
          ...base,
          runId: plan.id,
          errorClass: classOf(error),
          detail: `${interval.from.toISOString()}–${interval.to.toISOString()} after ${attempts} attempts: ${detail}`,
        });
      } else {
        // Left PENDING on purpose: a transient failure deserves another pass, and the attempt
        // counter is what stops that becoming an infinite loop.
        logger.log('warn', 'backfill.interval_retry', {
          ...base,
          runId: plan.id,
          attempts,
          detail: `${interval.from.toISOString()}–${interval.to.toISOString()}: ${detail}`,
        });
        break;
      }
    }
  }

  const progress = await backfillProgress(db, plan.id);
  const aborted = options.signal?.aborted === true;
  let status: BackfillOutcome['status'];
  let detail: string | null = null;

  if (progress.pending === 0 && progress.failed === 0) {
    await finishBackfillPlan(db, plan.id, 'COMPLETED');
    status = 'COMPLETED';
  } else if (progress.failed > 0) {
    await finishBackfillPlan(
      db,
      plan.id,
      'FAILED',
      `${progress.failed} interval(s) failed, ${progress.pending} still pending`,
    );
    status = 'FAILED';
    detail = `${progress.failed} interval(s) failed`;
  } else {
    // Still RUNNING: stopped early by `maxIntervals`, a cancellation, or a retry break. The plan
    // is left open precisely so the next invocation picks it up.
    status = 'INCOMPLETE';
    detail = aborted
      ? 'cancelled; the plan is left open and resumes where it stopped'
      : leaseHeld
        ? 'another run holds this product; the plan is left open'
        : `${progress.pending} interval(s) still pending`;
  }

  logger.log(status === 'FAILED' ? 'error' : 'info', 'backfill.finished', {
    ...base,
    runId: plan.id,
    status: status === 'COMPLETED' ? 'SUCCEEDED' : status === 'FAILED' ? 'FAILED' : 'PARTIAL',
    newVersions,
    unchanged,
    received: progress.received,
    ...(detail === null ? {} : { detail }),
  });

  return {
    planId: plan.id,
    status,
    progress,
    intervalsProcessed,
    intervalsSplit,
    newVersions,
    unchanged,
    detail,
  };
}

/** One window, through the ordinary six-step lifecycle with the fetch supplied by FDSN. */
async function ingestWindow<TRaw>(
  options: RunBackfillOptions<TRaw>,
  planId: string,
  interval: { readonly from: Date; readonly to: Date },
  window: FdsnWindow,
  mode: FdsnMode,
  logger: Logger,
): Promise<RunOutcome> {
  return runIngestion({
    db: options.db,
    adapter: options.adapter,
    client: options.client,
    trigger: 'BACKFILL',
    logger,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // ADR-033: the row and the digest, never the body.
    retainRawPayload: false,
    // A historical window with no events is a quiet period, not a broken feed.
    emptyBatchIsSuspicious: false,
    fetchOverride: async (ctx) => {
      const fetched = await fdsnFetch(window, mode, {
        client: ctx.client,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      return {
        kind: 'FETCHED',
        body: fetched.body,
        httpStatus: fetched.httpStatus,
        bytes: fetched.bytes,
        payloadSha256: payloadHash(fetched.body),
        endpoint: fdsnEndpoint(mode),
        attempts: fetched.attempts,
        durationMs: fetched.durationMs,
      };
    },
    beforeCommit: async (trx, context) => {
      // The checkpoint and the facts, one transaction. Nothing can land between them.
      await markIntervalDone(trx, planId, interval, context.received, context.runId);
    },
  });
}

async function splitTooLargeWindow(
  db: Kysely<DB>,
  planId: string,
  interval: { readonly from: Date; readonly to: Date },
  plan: WindowPlanOptions,
  logger: Logger,
  base: Record<string, string>,
  count?: number,
): Promise<void> {
  const children = splitWindow(interval, plan);
  await db.transaction().execute((trx) => splitBackfillInterval(trx, planId, interval, children));
  logger.log('info', 'backfill.window_split', {
    ...base,
    runId: planId,
    detail:
      `${interval.from.toISOString()}–${interval.to.toISOString()} holds ` +
      `${count === undefined ? 'more rows than the service will return' : `${count} rows`}; split in two`,
  });
}

/**
 * Statuses that mean "this window holds more than the service will return".
 *
 * The documented 400 and the 503 "table is full" P0 observed. The body is gone by the time the
 * outcome exists, and that is acceptable here for the same reason `isWindowTooLarge` accepts it:
 * the parameters are typed and closed, so a malformed query is not reachable.
 */
function isSizeRefusal(httpStatus: number | null): boolean {
  return httpStatus === 400 || httpStatus === 503;
}

/** Whether a window can still be halved, so a refusal at the floor is reported instead of looped. */
function splittable(
  interval: { readonly from: Date; readonly to: Date },
  plan: WindowPlanOptions,
): boolean {
  return interval.to.getTime() - interval.from.getTime() > plan.minWindowMs;
}

/** True when retrying cannot change the answer. */
function isPermanent(error: unknown): boolean {
  if (error instanceof WindowPlanError || error instanceof FdsnQueryError) return true;
  return error instanceof SourceFetchError && !error.transient;
}

function classOf(error: unknown): ErrorClass {
  if (error instanceof SourceFetchError) return error.errorClass;
  if (error instanceof FdsnQueryError) return 'SCHEMA_DRIFT';
  if (error instanceof WindowPlanError) return 'CONFIG_ERROR';
  return 'UNKNOWN';
}

/**
 * A backfill failure, described without quoting a driver or a provider body.
 *
 * `SourceFetchError.describe()` is already host/path/status only; the rest are our own errors and
 * safe to repeat. Anything else is deliberately vague rather than risk putting a connection string
 * in `backfill_intervals.error_message` (SECURITY.md M7).
 */
export function describeBackfillFailure(error: unknown): string {
  if (error instanceof SourceFetchError) return error.describe();
  if (error instanceof FdsnQueryError || error instanceof WindowPlanError) return error.message;
  return 'the window could not be ingested; see the worker log';
}
