/**
 * `geonerva-worker backfill --source usgs --from <date> --to <date> [--min-magnitude N]`
 *
 * One historical range, resumable. Re-running the same command resumes the same plan rather than
 * starting a second one, so the safe way to run a long backfill is to run this repeatedly — with
 * `--max-intervals` to bound each sitting — until it reports COMPLETED.
 */

import { ConfigError, loadWorkerConfig } from '@geonerva/config';
import { createDatabase, workerPoolOptions } from '@geonerva/db';
import {
  createJsonLogger,
  runBackfill,
  runDeletionSweep,
  type BackfillOutcome,
  type DeletionSweepOutcome,
} from '@geonerva/pipeline';
import {
  DEFAULT_WINDOW_PLAN,
  createSourceClient,
  usgsAdapter,
  type SourceAdapter,
} from '@geonerva/sources';

/** Sources with a historical query interface. USGS is the only one until P5. */
const HISTORICAL_ADAPTERS: Readonly<Record<string, SourceAdapter<never>>> = {
  usgs: usgsAdapter as SourceAdapter<never>,
};

export const BACKFILL_USAGE = `Usage: geonerva-worker backfill --source <id> --from <date> --to <date>

  --source          Which source to backfill (${Object.keys(HISTORICAL_ADAPTERS).join(', ')})
  --from            Start of the range, inclusive (ISO 8601, e.g. 2026-01-01)
  --to              End of the range, exclusive (ISO 8601)
  --min-magnitude   Only events at or above this magnitude
  --window-days     Nominal window size before splitting (default 30)
  --max-intervals   Stop after this many windows, leaving the rest for the next run
  --deleted-only    Sweep deletions instead of events

Re-running the same range resumes the same plan; completed windows are not walked again.
Exits 0 when the range completed, 2 when work remains, 1 when the worker could not run.`;

export interface BackfillArgs {
  readonly source?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly minMagnitude?: number;
  readonly windowDays?: number;
  readonly maxIntervals?: number;
  readonly deletedOnly: boolean;
  readonly help: boolean;
  readonly errors: readonly string[];
}

/**
 * Parses a date argument.
 *
 * A bare `2026-01-01` is read as UTC midnight, which is what `Date.parse` already does for that
 * form. Anything ambiguous is refused rather than guessed at: a backfill that silently shifted by
 * the operator's timezone would put a day of earthquakes in the wrong window.
 */
export function parseDateArg(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) return null;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseNumberArg(value: string, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  let source: string | undefined;
  let from: Date | undefined;
  let to: Date | undefined;
  let minMagnitude: number | undefined;
  let windowDays: number | undefined;
  let maxIntervals: number | undefined;
  let deletedOnly = false;
  let help = false;
  const errors: string[] = [];

  const needsValue = new Set([
    '--source',
    '--from',
    '--to',
    '--min-magnitude',
    '--window-days',
    '--max-intervals',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--deleted-only') {
      deletedOnly = true;
      continue;
    }
    if (arg === undefined || !needsValue.has(arg)) {
      // Never ignored: a flag accepted and dropped runs something other than what was asked for.
      errors.push(`unknown argument: ${String(arg)}`);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      errors.push(`${arg} needs a value`);
      continue;
    }
    index += 1;

    switch (arg) {
      case '--source':
        source = value;
        break;
      case '--from':
      case '--to': {
        const parsed = parseDateArg(value);
        if (parsed === null) {
          errors.push(`${arg} must be an ISO date like 2026-01-01, not ${value}`);
          break;
        }
        if (arg === '--from') from = parsed;
        else to = parsed;
        break;
      }
      case '--min-magnitude': {
        const parsed = parseNumberArg(value, -2, 12);
        if (parsed === null) errors.push(`--min-magnitude must be between -2 and 12, not ${value}`);
        else minMagnitude = parsed;
        break;
      }
      case '--window-days': {
        const parsed = parseNumberArg(value, 1, 365);
        if (parsed === null) errors.push(`--window-days must be between 1 and 365, not ${value}`);
        else windowDays = parsed;
        break;
      }
      default: {
        const parsed = parseNumberArg(value, 1, 100_000);
        if (parsed === null) errors.push(`--max-intervals must be a positive count, not ${value}`);
        else maxIntervals = Math.floor(parsed);
        break;
      }
    }
  }

  if (!help) {
    if (source === undefined) errors.push('--source is required');
    else if (!(source in HISTORICAL_ADAPTERS)) {
      errors.push(
        `unknown source: ${source} (available: ${Object.keys(HISTORICAL_ADAPTERS).join(', ')})`,
      );
    }
    if (from === undefined) errors.push('--from is required');
    if (to === undefined) errors.push('--to is required');
    if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) {
      errors.push('--from must be strictly before --to');
    }
  }

  return {
    ...(source === undefined ? {} : { source }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(minMagnitude === undefined ? {} : { minMagnitude }),
    ...(windowDays === undefined ? {} : { windowDays }),
    ...(maxIntervals === undefined ? {} : { maxIntervals }),
    deletedOnly,
    help,
    errors,
  };
}

/** Human-readable summary. The machine-readable record is the plan and its intervals. */
export function describeBackfill(outcome: BackfillOutcome): string {
  const { progress } = outcome;
  return (
    `${outcome.status}: ${progress.done}/${progress.total} window(s) done` +
    (progress.split > 0 ? `, ${progress.split} split` : '') +
    (progress.pending > 0 ? `, ${progress.pending} pending` : '') +
    (progress.failed > 0 ? `, ${progress.failed} failed` : '') +
    ` — ${progress.received} record(s) received, ${outcome.newVersions} new version(s), ` +
    `${outcome.unchanged} unchanged` +
    (outcome.detail === null ? '' : ` (${outcome.detail})`)
  );
}

/** What a sweep did, including the parts it deliberately could not do. */
export function describeSweep(outcome: DeletionSweepOutcome): string {
  return (
    `${outcome.status}: ${outcome.tombstoned} tombstoned, ` +
    `${outcome.alreadyTombstoned} already tombstoned, ` +
    `${outcome.unknownToUs} for events not held, ` +
    `${outcome.unidentifiable} stripped of identity by the provider` +
    (outcome.detail === null || outcome.status === 'SUCCEEDED' ? '' : ` (${outcome.detail})`)
  );
}

/** 0 completed, 2 work remains (resume by re-running), 1 the worker itself could not run. */
export function backfillExitCode(outcome: BackfillOutcome): number {
  return outcome.status === 'COMPLETED' ? 0 : 2;
}

export async function runBackfillCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> {
  const args = parseBackfillArgs(argv);
  if (args.help) {
    console.log(BACKFILL_USAGE);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const error of args.errors) console.error(`✗ ${error}`);
    console.error(`\n${BACKFILL_USAGE}`);
    return 2;
  }

  let config;
  try {
    config = loadWorkerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`✗ ${error.message}`);
      return 1;
    }
    throw error;
  }

  const source = args.source;
  const adapter = source === undefined ? undefined : HISTORICAL_ADAPTERS[source];
  const from = args.from;
  const to = args.to;
  if (adapter === undefined || from === undefined || to === undefined) {
    console.error('✗ the request is incomplete');
    return 2;
  }

  const handle = createDatabase(workerPoolOptions(config.DATABASE_URL_WORKER, config.NODE_ENV));
  try {
    /*
     * A deletion sweep is a different operation, not a mode of the same one.
     *
     * Routing `--deleted-only` through `runBackfill` sent the `includedeleted=only` body down the
     * ordinary ingest path, where `resolveSourceRecord` **creates on a miss** — so a deletion for
     * an event GeoNerva had never ingested produced a brand-new record whose only version said it
     * was deleted, with a magnitude and a position taken from the deleted feature. That is a fact
     * GeoNerva invented, and `findRecordByAliases` exists precisely to make it impossible.
     */
    if (args.deletedOnly) {
      const sweep = await runDeletionSweep({
        db: handle.db,
        adapter,
        client: createSourceClient(adapter.descriptor, {
          userAgent: `GeoNerva/${config.NODE_ENV} (+https://github.com/geonerva)`,
        }),
        from,
        to,
        logger: createJsonLogger(),
        ...(signal === undefined ? {} : { signal }),
      });
      console.error(describeSweep(sweep));
      return sweep.status === 'SUCCEEDED' ? 0 : 2;
    }

    const outcome = await runBackfill({
      db: handle.db,
      adapter,
      client: createSourceClient(adapter.descriptor, {
        userAgent: `GeoNerva/${config.NODE_ENV} (+https://github.com/geonerva)`,
      }),
      request: {
        from,
        to,
        ...(args.minMagnitude === undefined ? {} : { minMagnitude: args.minMagnitude }),
      },
      plan: {
        windowMs:
          args.windowDays === undefined
            ? DEFAULT_WINDOW_PLAN.windowMs
            : args.windowDays * 24 * 60 * 60 * 1000,
        minWindowMs: DEFAULT_WINDOW_PLAN.minWindowMs,
      },
      logger: createJsonLogger(),
      ...(args.maxIntervals === undefined ? {} : { maxIntervals: args.maxIntervals }),
      ...(signal === undefined ? {} : { signal }),
    });
    console.error(describeBackfill(outcome));
    return backfillExitCode(outcome);
  } catch (error) {
    // A range the planner refuses, or configuration the database disagrees with.
    console.error(`✗ ${error instanceof Error ? error.message : 'the backfill could not start'}`);
    return 1;
  } finally {
    await handle.close();
  }
}
