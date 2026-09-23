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

import {
  SEEDED_HAZARD_TYPES,
  correlateEarthquakes,
  seedSingleSourceEvents,
  type CorrelateResult,
  type SeedResult,
} from './correlate.ts';
import type { Logger } from './logging.ts';
import type { RunOutcome } from './run.ts';
import { lastSuccessfulDerivationAsOf, newestHazardIngestAt, type DB } from '@geonerva/db';
import { sql, type Kysely } from 'kysely';

/**
 * What one derivation needs in order to be scheduled.
 *
 * Two of them exist, and they are genuinely the same job over different facts: `CORRELATION`
 * matches earthquake solutions from independent catalogues, `SEED` opens a single-source event for
 * the families where no matching is possible because only one source reports them. Both are pure
 * functions of database state, both are idempotent, and both would silently never run if nobody
 * scheduled them — which is exactly what happened to each in turn.
 */
interface DerivationSpec<T> {
  /** Matches `analysis_runs.kind`, and is what the availability model looks up. */
  readonly kind: string;
  /** The log event name. Kept distinct per derivation so one cannot be mistaken for the other. */
  readonly event: string;
  /**
   * The advisory lock key. Arbitrary constants, chosen once and never derived from anything that
   * could change: two workers must pick the same number or the lock protects nothing. **Distinct
   * per derivation**, because correlation and seeding touch different records and serialising one
   * behind the other would be a pointless queue.
   */
  readonly lockKey: number;
  /** Which hazards this derivation reads, so its gate is not woken by another family's feed. */
  readonly hazardTypes: readonly string[];
  run(conn: Kysely<DB>, asOf: Date): Promise<T>;
  describe(result: T): string;
}

/** Counters are reported in `detail`; the log allowlist has no field for them. */
function describeCorrelation(result: CorrelateResult): string {
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

const CORRELATION: DerivationSpec<CorrelateResult> = {
  kind: 'CORRELATION',
  event: 'correlation.run',
  lockKey: 4_405_001,
  hazardTypes: ['EARTHQUAKE'],
  run: async (conn, asOf) => await correlateEarthquakes(conn, { asOf }),
  describe: describeCorrelation,
};

const SEED: DerivationSpec<SeedResult> = {
  kind: 'SEED',
  event: 'seed.run',
  lockKey: 4_405_002,
  hazardTypes: SEEDED_HAZARD_TYPES,
  run: async (conn, asOf) => await seedSingleSourceEvents(conn, { asOf }),
  describe: (result) => `considered=${String(result.considered)} created=${String(result.created)}`,
};

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
 * One derivation pass: gate, lock, derive, report.
 *
 * Returns `SKIPPED` when there is nothing new to do or when another run holds the lock — neither is
 * a fault, and neither may trip the circuit breaker. Returns `FAILED` when the pass threw, having
 * already recorded a `FAILED` analysis run; because `lastSucceededAt` does not move, the briefing's
 * availability model degrades on its own without this job telling it to.
 */
async function runDerivation<T>(
  spec: DerivationSpec<T>,
  options: CorrelationJobOptions,
): Promise<RunOutcome> {
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
    logger.log(status === 'FAILED' ? 'error' : 'info', spec.event, {
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
      detail: `${spec.kind} failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      totalMs: elapsed(),
    });
  }

  async function attempt(): Promise<RunOutcome> {
    const [newestFact, lastRunAsOf] = await Promise.all([
      newestHazardIngestAt(db, asOf, spec.hazardTypes),
      lastSuccessfulDerivationAsOf(db, spec.kind),
    ]);

    /*
     * No earthquake facts at all: a derivation that has never run over data that does not exist is
     * not an outage, and the availability model says so too (`newestInputAt === null`).
     */
    if (newestFact === null) {
      return finish('SKIPPED', {
        detail: 'no facts of these hazards to derive',
        totalMs: elapsed(),
      });
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
        SELECT pg_try_advisory_lock(${spec.lockKey}) AS locked
      `.execute(conn);
      if (locked.rows[0]?.locked !== true) {
        return finish('SKIPPED', {
          detail: 'another run of this derivation holds the lock',
          totalMs: elapsed(),
        });
      }

      try {
        const result = await spec.run(conn, asOf);
        return finish('SUCCEEDED', {
          runId: (result as { runId: string }).runId,
          detail: spec.describe(result),
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
        await sql`SELECT pg_advisory_unlock(${spec.lockKey})`.execute(conn);
      }
    });
  }
}

/** Earthquake correlation, scheduled (ADR-044). */
export async function runCorrelation(options: CorrelationJobOptions): Promise<RunOutcome> {
  return await runDerivation(CORRELATION, options);
}

/**
 * Single-source seeding, scheduled for the same reason correlation is.
 *
 * `DERIVED_FAMILIES` gates floods, cyclones and "other" on `SEED`, so without this job a GDACS
 * flood is ingested and then reported as `DERIVATION_NOT_RUN` for ever — the identical defect
 * ADR-044 fixed for earthquakes, one family over.
 */
export async function runSeed(options: CorrelationJobOptions): Promise<RunOutcome> {
  return await runDerivation(SEED, options);
}
