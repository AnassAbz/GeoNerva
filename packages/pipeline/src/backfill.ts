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
  findProductByCode,
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
  /**
   * Windows this invocation fetched, whether or not they completed.
   *
   * "Attempted", not "processed": a window that failed still consumed a request, so it counts
   * against `maxIntervals`. Whether it *completed* is `progress.done`, and a run reporting three
   * attempted with zero done is telling the truth about both.
   */
  readonly intervalsAttempted: number;
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

  /*
   * An adapter without a historical interface cannot be backfilled.
   *
   * `runBackfill` issues FDSN requests on the adapter's behalf, so until the capability interface
   * lands (P5, with the second source) this check is what stops it being pointed at an adapter
   * that has no such endpoint. The host allowlist would refuse the request anyway, but as
   * `CONFIG_ERROR` from deep inside a window — this says the actual reason.
   */
  if (!descriptor.capabilities.includes('HISTORICAL_EVENTS')) {
    throw new WindowPlanError(
      `${descriptor.sourceId}:${descriptor.productCode} does not declare HISTORICAL_EVENTS, ` +
        'so it has no historical interface to back-fill from',
    );
  }

  // Planning first, so an impossible range is refused before a plan row exists.
  const windows = planWindows(request.from, request.to, options.plan);
  const defect = describePlanDefect(windows, request.from, request.to);
  if (defect !== null) {
    // A plan with a hole in it produces a catalogue with a hole in it, and nothing downstream
    // would ever report the gap.
    throw new WindowPlanError(`refusing to persist a defective plan: ${defect}`);
  }

  /*
   * The plan is attached to the same product its runs will be, so two products of one source
   * cannot resume each other's plan and skip windows as already done. The unique index keys on
   * `COALESCE(product_id, -1)`, so leaving it null made every product share one plan identity.
   */
  const product = await findProductByCode(db, descriptor.sourceId, descriptor.productCode);
  if (product === null) {
    throw new WindowPlanError(
      `no source_product ${descriptor.productCode} for source ${descriptor.sourceId}`,
    );
  }

  const { plan, created } = await openBackfillPlan(db, {
    sourceId: descriptor.sourceId,
    productId: product.id,
    mode: mode === 'deleted-only' ? 'DELETION_SWEEP' : 'HISTORICAL',
    rangeFrom: request.from,
    rangeTo: request.to,
    minMagnitude: request.minMagnitude ?? null,
    windowMs: options.plan.windowMs,
    minWindowMs: options.plan.minWindowMs,
  });
  /*
   * A plan's identity is the *question* — range, magnitude, mode — and not the window size used
   * to answer it. So a resumed plan keeps the windows it was planned with, and a request that
   * asks for different ones is refused rather than merged.
   *
   * Merging is what happens without this check, and it is quietly wrong: re-running a 30-day
   * plan with `--window-days 7` would add thirteen fresh PENDING intervals overlapping four that
   * are already DONE. Nothing would be corrupted — the content hash sees to that — but the plan
   * would describe a shape no one asked for, the progress counts would be meaningless, and the
   * backfill would re-walk work it had already finished.
   */
  if (!created && plan.windowMs !== options.plan.windowMs) {
    throw new WindowPlanError(
      `this range is already planned with ${plan.windowMs / 86_400_000}-day windows; ` +
        `re-run it with that size, or use a different range. Requested ` +
        `${options.plan.windowMs / 86_400_000} days.`,
    );
  }

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

  let intervalsAttempted = 0;
  let intervalsSplit = 0;
  let stoppedEarly: string | null = null;
  let newVersions = 0;
  let unchanged = 0;

  while (options.signal?.aborted !== true) {
    if (options.maxIntervals !== undefined && intervalsAttempted >= options.maxIntervals) break;

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

      if (outcome.status === 'LEASE_HELD' || outcome.status === 'SKIPPED') {
        /*
         * Neither outcome wrote anything, so `beforeCommit` never ran and the interval is still
         * PENDING — claiming again returns the *same* one and the loop spins on it.
         *
         * `LEASE_HELD` means another worker owns the product. `SKIPPED` means the product is
         * disabled or retired, which an operator can set at any moment; without this the default
         * CLI invocation (no `--max-intervals`) would spin until `attempts` overflowed, and with
         * one it would report N windows processed having skipped the same window N times.
         */
        stoppedEarly =
          outcome.status === 'LEASE_HELD'
            ? 'another run holds this product; the plan is left open'
            : 'this product is disabled or retired; the plan is left open';
        logger.log('info', 'backfill.stopped_early', {
          ...base,
          runId: plan.id,
          detail: stoppedEarly,
        });
        break;
      }

      /*
       * The count is not just a planning signal: it is the only cross-check that the window we
       * ingested is the window the provider said it had.
       *
       * Without it, FDSN answering HTTP 200 with an empty FeatureCollection for a window it has
       * just said holds 4,000 events — a proxy, a cache, a partial outage, a parameter quietly
       * ignored — marks the interval DONE with `n_received = 0`, commits a SUCCEEDED run, and
       * lets the plan reach COMPLETED. The catalogue then has a permanent hole that nothing will
       * ever report, and "we could not read it" has rendered as "there is nothing there".
       *
       * The check is deliberately one-sided. Receiving *more* than the count is normal: the count
       * and the query are two requests, and the catalogue grows between them.
       */
      if (outcome.status !== 'FAILED' && count.count > 0 && outcome.counts.received < count.count) {
        const detail =
          `the provider counted ${count.count} events in ` +
          `${interval.from.toISOString()}–${interval.to.toISOString()} but returned ` +
          `${outcome.counts.received}`;
        await markIntervalFailed(db, plan.id, interval, 'SCHEMA_DRIFT', sanitizeDetail(detail));
        logger.log('error', 'backfill.count_mismatch', {
          ...base,
          runId: plan.id,
          errorClass: 'SCHEMA_DRIFT',
          received: outcome.counts.received,
          declaredCount: count.count,
          detail,
        });
        // Counted as attempted: it consumed a fetch, so it counts against `maxIntervals`. What
        // it did *not* do is complete, and `progress` is the record of that.
        intervalsAttempted += 1;
        continue;
      }

      /*
       * Another worker holds this product's ingestion lease.
       *
       * Nothing was fetched and nothing was written, so `beforeCommit` never ran and the interval
       * is still PENDING — which means claiming again would hand back the *same* interval, and
       * the loop would spin on it for as long as the other worker held the lease. Stopping is the
       * correct response: the plan stays open and the next invocation resumes it.
       */
      intervalsAttempted += 1;
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
      if (tooLarge && splittable(interval, options.plan)) {
        intervalsSplit += 1;
        await splitTooLargeWindow(db, plan.id, interval, options.plan, logger, base);
        continue;
      }
      // A refusal at the floor is not splittable, and `splitWindow` would throw from inside this
      // catch — straight out of a function whose contract says it never throws for an expected
      // failure, leaving the interval PENDING and the plan RUNNING forever.

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
      : (stoppedEarly ?? `${progress.pending} interval(s) still pending`);
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
    intervalsAttempted,
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
  /*
   * 400 only.
   *
   * P0 did see a 503 "table is full" mean "too many rows", but 503 is *also* the ordinary
   * "provider is busy", and by the time an outcome exists the body that told them apart is gone.
   * Treating every 503 as a size refusal splits a perfectly good 30-day window in half
   * permanently — the parent stays SPLIT, so a transient outage leaves a distortion that resume
   * never repairs. A 400 is safe to read this way because the parameters are typed and closed,
   * so a malformed query is not reachable; a 503 is left to the ordinary retry path.
   */
  return httpStatus === 400;
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
