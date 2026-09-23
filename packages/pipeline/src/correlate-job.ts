/**
 * Correlation as a scheduled job (**ADR-044**).
 *
 * `correlateEarthquakes` turns observations into canonical events, and until this file existed it
 * was called from exactly one place in the repository: its own integration test. A deployment
 * ingested real earthquakes every five minutes and never produced a single event — which the
 * product reported honestly (`DERIVATION_NOT_RUN`) and which made it useless. This is the job that
 * closes that.
 *
 * It is deliberately the same shape as `runIngestion`: it returns a `RunOutcome`, it **never throws
 * for an expected failure**, and it emits exactly one terminal log line whose level is `error`
 * precisely when the status is `FAILED`. The scheduler's circuit breaker counts outcomes, not
 * exceptions, so a correlation that throws past this boundary would be logged as
 * `scheduler.job_threw` with an `UNKNOWN` class and lose its own counters.
 *
 * ### The gate
 *
 * The work list is a `DISTINCT ON` over every earthquake version ever ingested, anti-joined against
 * the active links. A run with nothing to do is therefore a **full scan**, not a free no-op, and at
 * a sixty-second interval that would be fourteen hundred pointless scans a day plus fourteen
 * hundred `analysis_runs` rows recording that nothing happened. So the job asks one cheap question
 * first — is there an earthquake fact newer than the knowledge time of the last successful run? —
 * and returns `SKIPPED` when there is not.
 *
 * The comparison is against the last run's **`as_of`**, not its `finished_at`. A fact that arrives
 * while a run is in flight has `ingested_at < finished_at` and was still excluded by that run's own
 * knowledge bound; gating on `finished_at` would declare it seen and strand it until some unrelated
 * earthquake happened to arrive. That is the one genuinely subtle thing in this file.
 *
 * ### The lock
 *
 * Correlation mints identities. Two overlapping runs can each open a canonical event for the same
 * earthquake before the other's projection lands, leaving one earthquake as two `SINGLE_SOURCE`
 * events — a risk `docs/reviews/gate-g6.md` recorded and deferred to P10. A **PostgreSQL advisory
 * lock** serialises runs: `pg_try_advisory_lock` returns immediately rather than queueing, so a
 * second worker reports `SKIPPED` instead of blocking a scheduler thread, and the lock is released
 * by the server when the session ends — so a killed worker leaves nothing behind. A lease row in
 * `analysis_runs` would have needed an expiry mechanism that table does not have, and one crash
 * would have blocked correlation permanently.
 */

import { correlateEarthquakes, type CorrelateResult } from './correlate.ts';
import type { Logger } from './logging.ts';
import type { RunOutcome } from './run.ts';
import { lastSuccessfulCorrelationAsOf, newestEarthquakeIngestAt, type DB } from '@geonerva/db';
import { sql, type Kysely } from 'kysely';

/**
 * The advisory lock key. An arbitrary constant, chosen once and never derived from anything that
 * could change: two workers must pick the same number or the lock protects nothing.
 */
const CORRELATION_LOCK_KEY = 4_405_001;

/** Counters are reported in `detail`; the log allowlist has no field for them. */
function describeResult(result: CorrelateResult): string {
  return [
    `considered=${String(result.considered)}`,
    `created=${String(result.created)}`,
    `matched=${String(result.matched)}`,
    `identityMatched=${String(result.identityMatched)}`,
    `possible=${String(result.possible)}`,
    `revisionsKept=${String(result.revisionsKept)}`,
    `revisionsBroken=${String(result.revisionsBroken)}`,
    `pendingIdentityRef=${String(result.pendingIdentityRef)}`,
    `projected=${String(result.projected)}`,
  ].join(' ');
}

const NO_COUNTS = {
  received: 0,
  accepted: 0,
  rejected: 0,
  newRecords: 0,
  newVersions: 0,
  unchanged: 0,
  mergedRecords: 0,
} as const;

function outcomeOf(
  status: RunOutcome['status'],
  over: {
    readonly runId?: string | null;
    readonly errorClass?: RunOutcome['errorClass'];
    readonly detail?: string | null;
    readonly totalMs: number;
    readonly committedAt?: Date | null;
  },
): RunOutcome {
  return {
    status,
    runId: over.runId ?? null,
    errorClass: over.errorClass ?? null,
    detail: over.detail ?? null,
    counts: { ...NO_COUNTS },
    stageMs: {
      fetchMs: 0,
      parseMs: 0,
      normalizeMs: 0,
      persistMs: 0,
      totalMs: Math.round(over.totalMs),
    },
    committedAt: over.committedAt ?? null,
    httpStatus: null,
  };
}

export interface CorrelationJobOptions {
  readonly db: Kysely<DB>;
  readonly logger: Logger;
  /** The run's knowledge time. Defaults to now; injected by tests. */
  readonly asOf?: Date;
  readonly now?: () => Date;
}

/**
 * One correlation pass: gate, lock, correlate, report.
 *
 * Returns `SKIPPED` when there is nothing new to do or when another run holds the lock — neither is
 * a fault, and neither may trip the circuit breaker. Returns `FAILED` when the pass threw, having
 * already recorded a `FAILED` analysis run; because `lastSucceededAt` does not move, the briefing's
 * availability model degrades on its own without this job telling it to.
 */
export async function runCorrelation(options: CorrelationJobOptions): Promise<RunOutcome> {
  const { db, logger } = options;
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const asOf = options.asOf ?? now();
  const elapsed = (): number => now().getTime() - startedAt;

  const finish = (
    status: RunOutcome['status'],
    over: Parameters<typeof outcomeOf>[1],
  ): RunOutcome => {
    const outcome = outcomeOf(status, over);
    logger.log(status === 'FAILED' ? 'error' : 'info', 'correlation.run', {
      stage: 'run',
      status,
      ...(outcome.runId === null ? {} : { runId: outcome.runId }),
      ...(outcome.errorClass === null ? {} : { errorClass: outcome.errorClass }),
      ...(outcome.detail === null ? {} : { detail: outcome.detail }),
      ...outcome.stageMs,
    });
    return outcome;
  };

  /*
   * Everything below is inside the boundary, not just the correlation itself.
   *
   * `runIngestion`'s contract — *never throws for an expected failure* — is what lets the
   * scheduler treat an outcome as the whole story, and a database that is down fails the **gate**
   * or the connection acquisition long before it reaches `correlateEarthquakes`. An earlier draft
   * wrapped only the call, so a pool that could not hand out a connection threw straight past this
   * function and was logged as `scheduler.job_threw` with an `UNKNOWN` class. A test that broke
   * the handle caught it.
   */
  try {
    return await attempt();
  } catch (error) {
    /*
     * `UNKNOWN`, not `INTERNAL`. The two vocabularies are different on purpose: `analysis_runs`
     * records `INTERNAL` in its own free-text `error_class`, while `RunOutcome.errorClass` is
     * ADR-032's closed set, which a correlation failure does not otherwise fit. What matters to
     * the scheduler is only that it is not `ABORTED`, so the circuit breaker counts it.
     */
    return finish('FAILED', {
      errorClass: 'UNKNOWN',
      detail: `correlation failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      totalMs: elapsed(),
    });
  }

  async function attempt(): Promise<RunOutcome> {
    const [newestFact, lastRunAsOf] = await Promise.all([
      newestEarthquakeIngestAt(db, asOf),
      lastSuccessfulCorrelationAsOf(db),
    ]);

    /*
     * No earthquake facts at all: a derivation that has never run over data that does not exist is
     * not an outage, and the availability model says so too (`newestInputAt === null`).
     */
    if (newestFact === null) {
      return finish('SKIPPED', { detail: 'no earthquake facts to correlate', totalMs: elapsed() });
    }
    if (lastRunAsOf !== null && newestFact.getTime() <= lastRunAsOf.getTime()) {
      return finish('SKIPPED', {
        detail: `nothing ingested since ${lastRunAsOf.toISOString()}`,
        totalMs: elapsed(),
      });
    }

    /*
     * One pinned connection for the whole run: an advisory lock belongs to the session that took
     * it, and a pooled query could take it on one connection and release it on another.
     */
    return await db.connection().execute(async (conn) => {
      const locked = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_lock(${CORRELATION_LOCK_KEY}) AS locked
      `.execute(conn);
      if (locked.rows[0]?.locked !== true) {
        return finish('SKIPPED', {
          detail: 'another correlation run holds the lock',
          totalMs: elapsed(),
        });
      }

      try {
        const result = await correlateEarthquakes(conn, { asOf });
        return finish('SUCCEEDED', {
          runId: result.runId,
          detail: describeResult(result),
          totalMs: elapsed(),
          committedAt: asOf,
        });
      } finally {
        /*
         * Released here rather than left to the session's end, because the connection goes back to
         * the pool and an advisory lock outlives the query that took it. `correlateEarthquakes`
         * closes its own analysis run as FAILED before rethrowing, so a throw leaves the ledger
         * correct and `lastSucceededAt` unmoved; the outer boundary turns it into an outcome.
         */
        await sql`SELECT pg_advisory_unlock(${CORRELATION_LOCK_KEY})`.execute(conn);
      }
    });
  }
}
