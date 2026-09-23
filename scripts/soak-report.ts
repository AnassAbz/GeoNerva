/**
 * `pnpm soak [--hours 24] [--min-runs 24]` — the measurement P10's acceptance criterion names:
 * *"a 24 h staging soak with ≥ 99 % non-provider run success"* (`IMPLEMENTATION_PLAN.md` §3).
 *
 * It reads `ingestion_runs`, which ADR-022 makes the single source of truth for what the worker
 * did, rather than scraping logs. A log line can be lost; a committed run cannot.
 *
 * ### What counts, and why — the rulings from `docs/reviews/p10-plan.md` §2
 *
 *  - **Scheduled live polls only.** `isLivePoll` already draws this line for source health: a
 *    backfill running alongside a broken feed must not stand in for it. A soak measures the thing
 *    that runs unattended, so `BACKFILL` and `RECONCILE` are out, and so is `MANUAL`.
 *  - **Provider failures are excluded from the denominator entirely**, so a provider outage during
 *    the soak can neither pass it nor fail it. The split is `PROVIDER_ERROR_CLASSES`, and it runs
 *    the *opposite* way from source health, which deliberately counts `CONFIG_ERROR` as a failure
 *    because a broken allowlist means we really do have no data. Two different questions: health
 *    asks "is there data", the soak asks "did our deployment behave".
 *  - **`ABORTED` is neither.** It is a run we cancelled — a SIGTERM during a restart — and counting
 *    it either way would make a routine deploy move the number.
 *  - **`SKIPPED` is a success** (the worker correctly declined to poll); **`PARTIAL` is not**,
 *    following `runTally24hAsOf` rather than `SUCCESSFUL_RUN_STATUSES`, because a run that rejected
 *    records did not do its job.
 *
 * ### The floor, which matters as much as the rate
 *
 * A rate over a tiny denominator is not evidence, and there is a specific way this metric lies:
 * `NETWORK` is a **provider** class, so a deployment whose egress is broken on our side — a proxy,
 * DNS, a certificate it does not trust — records every run as the provider's fault, excludes them
 * all, and reports 100 % success while ingesting nothing. That is not a hypothetical; it is what
 * this container did on the machine where it was first run. So the report fails when there are
 * fewer than `--min-runs` non-provider runs to judge, and it always prints the provider-failure
 * count beside the rate rather than quietly dropping it.
 *
 * Exit codes are the contract a workflow relies on: **0** the soak passes, **1** it fails (rate
 * below the threshold, or too few runs to tell), **2** the arguments or environment are wrong.
 */

import { sql, type Kysely } from 'kysely';

import { createDb, createPool, workerPoolOptions, type DB } from '../packages/db/src/index.ts';
import { PROVIDER_ERROR_CLASSES } from '../packages/domain/src/enums.ts';

/** The acceptance criterion's own number. */
const DEFAULT_THRESHOLD = 0.99;
/** One run per five minutes is the USGS cadence; a day of it is ~288. Twenty-four is a quiet floor. */
const DEFAULT_MIN_RUNS = 24;
const DEFAULT_HOURS = 24;

interface Options {
  readonly hours: number;
  readonly minRuns: number;
  readonly threshold: number;
}

export function parseArgs(argv: readonly string[]): Options | string {
  let hours = DEFAULT_HOURS;
  let minRuns = DEFAULT_MIN_RUNS;
  let threshold = DEFAULT_THRESHOLD;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--hours' || flag === '--min-runs' || flag === '--threshold') {
      if (value === undefined) return `${flag} needs a value`;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return `${flag} must be a positive number`;
      if (flag === '--hours') hours = parsed;
      else if (flag === '--min-runs') minRuns = parsed;
      else threshold = parsed;
      index += 1;
      continue;
    }
    return `unknown argument: ${flag ?? ''}`;
  }
  if (threshold > 1) return '--threshold is a fraction, so it cannot exceed 1';
  return { hours, minRuns, threshold };
}

export interface SoakTally {
  /** Runs whose failure was ours to own, or which did not fail. The denominator. */
  readonly judged: number;
  /** Of those, the ones that did their job. */
  readonly succeeded: number;
  /** Excluded from the denominator, and printed so nobody mistakes silence for health. */
  readonly providerFailures: number;
  /** Excluded from both: runs we cancelled ourselves. */
  readonly aborted: number;
  /** Distinct builds seen, so a soak that straddles a deploy says so. */
  readonly builds: readonly string[];
}

/**
 * The verdict, separated from the query so the rulings above are testable without a database.
 */
export function verdictOf(
  tally: SoakTally,
  options: Options,
): { readonly pass: boolean; readonly rate: number | null; readonly reason: string } {
  if (tally.judged < options.minRuns) {
    return {
      pass: false,
      rate: tally.judged === 0 ? null : tally.succeeded / tally.judged,
      reason:
        `only ${String(tally.judged)} non-provider runs in the window, and ` +
        `${String(options.minRuns)} are needed before a rate means anything` +
        (tally.providerFailures > 0
          ? ` (${String(tally.providerFailures)} runs failed on the provider's side — if that is ` +
            `all of them, check this deployment's egress before blaming the provider)`
          : ''),
    };
  }
  const rate = tally.succeeded / tally.judged;
  if (rate < options.threshold) {
    return {
      pass: false,
      rate,
      reason: `${formatRate(rate)} of non-provider runs succeeded, below ${formatRate(options.threshold)}`,
    };
  }
  return {
    pass: true,
    rate,
    reason: `${formatRate(rate)} of ${String(tally.judged)} non-provider runs succeeded`,
  };
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)} %`;
}

/**
 * The tally itself, against a database handle the caller owns.
 *
 * Separated from `tally` so an integration test can put runs of every shape into a real PostgreSQL
 * and check the counts. That is not ceremony: the first version of this query wrote
 * `NOT (error_class = 'ABORTED')`, which is NULL for every successful run, so every success fell
 * out of the denominator. No unit test would have found it.
 */
export async function tallyRuns(db: Kysely<DB>, hours: number): Promise<SoakTally> {
  {
    const providerClasses = [...PROVIDER_ERROR_CLASSES];
    const result = await sql<{
      judged: string;
      succeeded: string;
      provider_failures: string;
      aborted: string;
      builds: string[] | null;
    }>`
      WITH window_runs AS (
        SELECT r.status, r.error_class, r.worker_version
        FROM geonerva.ingestion_runs r
        WHERE r.committed_at IS NOT NULL
          AND r.committed_at >= now() - make_interval(hours => ${hours})
          AND r.trigger = 'SCHEDULE'
      ),
      classified AS (
        -- COALESCE, because a run that succeeded has no error_class at all: without it
        -- NOT (error_class = 'ABORTED') is NULL for every success and the denominator
        -- silently loses exactly the rows the rate is about.
        SELECT status,
               worker_version,
               COALESCE(error_class = 'ABORTED', false) AS ours_to_cancel,
               COALESCE(error_class = ANY(${sql.val(providerClasses)}::text[]), false)
                 AS provider_fault
        FROM window_runs
      )
      SELECT
        count(*) FILTER (WHERE NOT ours_to_cancel AND NOT provider_fault)::text AS judged,
        count(*) FILTER (
          WHERE NOT ours_to_cancel
            AND NOT provider_fault
            AND status IN ('SUCCEEDED', 'SKIPPED')
        )::text AS succeeded,
        count(*) FILTER (WHERE provider_fault)::text AS provider_failures,
        count(*) FILTER (WHERE ours_to_cancel)::text AS aborted,
        array_remove(array_agg(DISTINCT worker_version), NULL) AS builds
      FROM classified
    `.execute(db);

    const row = result.rows[0];
    return {
      judged: Number(row?.judged ?? 0),
      succeeded: Number(row?.succeeded ?? 0),
      providerFailures: Number(row?.provider_failures ?? 0),
      aborted: Number(row?.aborted ?? 0),
      builds: row?.builds ?? [],
    };
  }
}

/** Opens the deployment's own connection, tallies, and closes it. */
async function tally(hours: number): Promise<SoakTally> {
  const url = process.env['DATABASE_URL_WORKER'] ?? process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('set DATABASE_URL_WORKER (or DATABASE_URL) to the deployment being soaked');
  }
  const db = createDb(createPool(workerPoolOptions(url, process.env['NODE_ENV'] ?? 'production')));
  try {
    return await tallyRuns(db, hours);
  } finally {
    await db.destroy();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    console.error(`✗ ${options}`);
    return 2;
  }

  let counts: SoakTally;
  try {
    counts = await tally(options.hours);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : 'the soak query failed'}`);
    return 2;
  }

  const verdict = verdictOf(counts, options);
  const lines = [
    `window              last ${String(options.hours)} h, scheduled polls only`,
    `non-provider runs   ${String(counts.judged)} (${String(counts.succeeded)} succeeded)`,
    `provider failures   ${String(counts.providerFailures)} (excluded from the rate)`,
    `cancelled by us     ${String(counts.aborted)} (excluded from both)`,
    `builds seen         ${counts.builds.length === 0 ? 'none recorded — set GEONERVA_BUILD' : counts.builds.join(', ')}`,
  ];
  console.log(lines.join('\n'));
  console.log(`${verdict.pass ? '✓' : '✗'} ${verdict.reason}`);
  return verdict.pass ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
