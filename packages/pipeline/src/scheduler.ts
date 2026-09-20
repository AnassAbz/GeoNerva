/**
 * The worker's poll loop (ARCHITECTURE §4.2, IMPLEMENTATION_PLAN P3 task 5).
 *
 * One independent loop per job. Each sleeps for its configured interval ± jitter, runs once, and
 * sleeps again — so two sources on the same interval drift apart instead of hammering the network
 * in lockstep, and a slow run delays only its own source.
 *
 * **Why not a cron library.** The plan named `croner`, and this uses plain timers instead. Every
 * v1 schedule is "every N seconds", which is an interval, not a calendar; a cron expression buys
 * nothing here and `setTimeout` can be driven by an injected clock, which is what makes the
 * breaker and the jitter testable without waiting. When a genuinely calendar-based job arrives —
 * the daily reconcile and the retention sweep in P4/P6 — that is the moment to add a cron
 * dependency, for the jobs that need one.
 *
 * **The circuit breaker** exists so that a provider outage costs one request every 15 minutes
 * rather than one every 5. It counts *failed runs*, not exceptions: `runIngestion` already
 * converts everything it can into a committed run row, and a `SKIPPED` run is a healthy answer.
 * A cancelled run does not count — a deploy is not a provider fault (ADR-032).
 */

import type { RunOutcome } from './run.ts';
import type { Logger } from './logging.ts';

export interface BreakerPolicy {
  /** Consecutive failed runs before the source is only probed. */
  readonly openAfterFailures: number;
  /** How long to wait between probes while open. */
  readonly probeIntervalMs: number;
}

export const DEFAULT_BREAKER: BreakerPolicy = {
  openAfterFailures: 5,
  probeIntervalMs: 15 * 60 * 1000,
};

export interface ScheduledJob {
  /** Identifies the job in logs; usually `source:product`. */
  readonly name: string;
  readonly intervalMs: number;
  /** Fraction of the interval to randomise by, both ways. 0.1 means ±10 %. */
  readonly jitterRatio: number;
  run(signal: AbortSignal): Promise<RunOutcome>;
}

export interface SchedulerOptions {
  readonly jobs: readonly ScheduledJob[];
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Called on its own interval so `/data-status` can tell a dead worker from a quiet one. */
  readonly heartbeat?: (at: Date) => Promise<void>;
  readonly heartbeatIntervalMs?: number;
  readonly breaker?: Partial<BreakerPolicy>;
  /** Injected for tests: the sleeper, the clock and the jitter source. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
  readonly random?: () => number;
  /** Stops each loop after this many iterations. For tests; unbounded in production. */
  readonly maxIterations?: number;
}

export interface SchedulerSummary {
  readonly name: string;
  readonly runs: number;
  readonly failures: number;
  readonly breakerOpen: boolean;
}

/** Resolves when the signal aborts, or after `ms`. Never rejects. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `interval ± interval × jitterRatio`, never negative. */
export function jitteredDelay(intervalMs: number, jitterRatio: number, random: number): number {
  const spread = intervalMs * jitterRatio;
  return Math.max(0, Math.round(intervalMs - spread + random * 2 * spread));
}

/**
 * A run that counts against the breaker.
 *
 * `SKIPPED` is a healthy answer — the provider replied and nothing had changed — and `LEASE_HELD`
 * means another worker is doing the job. Neither is evidence that the source is broken, and
 * counting them would open the breaker on a perfectly working system.
 */
export function countsAsFailure(outcome: RunOutcome): boolean {
  return outcome.status === 'FAILED' && outcome.errorClass !== 'ABORTED';
}

async function runJobLoop(
  job: ScheduledJob,
  options: SchedulerOptions,
  policy: BreakerPolicy,
): Promise<SchedulerSummary> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const { signal, logger } = options;

  let runs = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let iterations = 0;
  // Read through a call, not a property: the loop condition narrows `signal.aborted` to `false`
  // for the whole body, so the check after the sleep would be dead code TypeScript is happy to
  // optimise away in its own mind — and the shutdown would be noticed one poll late.
  const stopping = (): boolean => signal.aborted;

  while (!stopping()) {
    if (options.maxIterations !== undefined && iterations >= options.maxIterations) break;
    iterations += 1;

    const open = consecutiveFailures >= policy.openAfterFailures;
    /*
     * The first poll happens almost immediately — within the jitter window, up to 30 s for a
     * 5-minute source — rather than a full interval after start-up.
     *
     * Waiting the whole interval would mean a deploy ingests nothing for five minutes, and an
     * operator watching `worker start` would have no way to tell a working worker from a broken
     * one. The small random offset is still enough to keep two workers that restart together
     * from polling in lockstep, and the lease makes an overlap harmless anyway.
     */
    const delay = open
      ? policy.probeIntervalMs
      : iterations === 1
        ? Math.round(random() * job.intervalMs * job.jitterRatio)
        : jitteredDelay(job.intervalMs, job.jitterRatio, random());
    await sleep(delay, signal);
    if (stopping()) break;

    try {
      const outcome = await job.run(signal);
      runs += 1;
      if (countsAsFailure(outcome)) {
        failures += 1;
        consecutiveFailures += 1;
        if (consecutiveFailures === policy.openAfterFailures) {
          logger.log('warn', 'scheduler.breaker_open', {
            sourceId: job.name,
            detail: `${consecutiveFailures} consecutive failed runs; probing every ${Math.round(policy.probeIntervalMs / 1000)}s`,
          });
        }
      } else {
        if (consecutiveFailures >= policy.openAfterFailures) {
          logger.log('info', 'scheduler.breaker_closed', { sourceId: job.name });
        }
        consecutiveFailures = 0;
      }
    } catch (error) {
      /*
       * `runIngestion` converts everything it can into a committed run row, so reaching here
       * means something outside the run lifecycle broke — most likely the database being
       * unreachable. The loop must not die: the next tick is the retry, and a worker that exits
       * on the first blip stops polling every other source too.
       */
      runs += 1;
      failures += 1;
      consecutiveFailures += 1;
      logger.log('error', 'scheduler.job_threw', {
        sourceId: job.name,
        errorClass: 'UNKNOWN',
        detail: error instanceof Error ? error.message : 'the job threw a non-error',
      });
    }
  }

  return {
    name: job.name,
    runs,
    failures,
    breakerOpen: consecutiveFailures >= policy.openAfterFailures,
  };
}

async function runHeartbeatLoop(options: SchedulerOptions): Promise<void> {
  const beat = options.heartbeat;
  if (beat === undefined) return;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const interval = options.heartbeatIntervalMs ?? 60_000;
  let iterations = 0;

  while (!options.signal.aborted) {
    if (options.maxIterations !== undefined && iterations >= options.maxIterations) break;
    iterations += 1;
    try {
      await beat(now());
    } catch (error) {
      // A heartbeat that cannot be written is worth saying, but it must never stop ingestion.
      options.logger.log('warn', 'scheduler.heartbeat_failed', {
        detail: error instanceof Error ? error.message : 'heartbeat failed',
      });
    }
    await sleep(interval, options.signal);
  }
}

/**
 * Runs every job until the signal aborts, then resolves once they have all stopped.
 *
 * Resolving only after every loop has finished is what makes shutdown orderly: the caller can
 * close the database pool knowing nothing is still writing to it.
 */
export async function runScheduler(options: SchedulerOptions): Promise<SchedulerSummary[]> {
  const policy = { ...DEFAULT_BREAKER, ...options.breaker };
  options.logger.log('info', 'scheduler.started', {
    detail: options.jobs.map((job) => `${job.name} every ${job.intervalMs / 1000}s`).join(', '),
  });

  const results = await Promise.all([
    ...options.jobs.map((job) => runJobLoop(job, options, policy)),
    runHeartbeatLoop(options).then(() => null),
  ]);

  const summaries = results.filter((result): result is SchedulerSummary => result !== null);
  options.logger.log('info', 'scheduler.stopped', {
    detail: summaries
      .map((s) => `${s.name}: ${s.runs} runs, ${s.failures} failed${s.breakerOpen ? ', open' : ''}`)
      .join('; '),
  });
  return summaries;
}
