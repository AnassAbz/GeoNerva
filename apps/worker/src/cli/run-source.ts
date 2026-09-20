/**
 * `geonerva-worker run --source <id> [--feed <name>]` — one ingestion, on demand.
 *
 * This is the composition root for ingestion: it is the only place that turns configuration into
 * a database handle, an HTTP client and an adapter. Everything below it takes those as arguments,
 * which is what keeps the pipeline testable without a network or a process environment.
 *
 * It exits non-zero only when the *worker* failed. A run that failed because a provider was down
 * exits 0: that is a successfully recorded observation about the provider, the run row says so,
 * and a scheduler treating it as a crash would restart a worker that is working correctly.
 *
 * `CONFIG_ERROR` is the exception, and it is the whole reason ADR-032 gave it its own class: a
 * host that is not allowlisted, or a product the database has never heard of, is *our* fault and
 * never self-heals. Exiting 0 on it would let a misconfigured deployment sit there looking
 * healthy, so that one exits 1.
 *
 * The two `CONFIG_ERROR` paths differ in how much evidence they leave, which is why the exit code
 * matters more for one than the other: an allowlist or redirect refusal happens after the lease
 * is taken, so it commits a FAILED run and degrades source health normally. An unknown product is
 * found *before* the lease, so there is no run to write and nothing appears in health at all.
 */

import { createDatabase, workerPoolOptions } from '@geonerva/db';
import { ConfigError, loadWorkerConfig } from '@geonerva/config';
import { createJsonLogger, runIngestion, type RunOutcome } from '@geonerva/pipeline';
import {
  USGS_FEEDS,
  createSourceClient,
  isUsgsFeed,
  usgsAdapter,
  type SourceAdapter,
} from '@geonerva/sources';

/** The adapters this build can run. Adding the second source is one line here. */
const ADAPTERS: Readonly<Record<string, SourceAdapter<never>>> = {
  usgs: usgsAdapter as SourceAdapter<never>,
};

export const AVAILABLE_SOURCES = Object.keys(ADAPTERS);

export interface RunSourceArgs {
  readonly source?: string;
  readonly feed?: string;
  readonly help: boolean;
  readonly errors: readonly string[];
}

/**
 * Parses `--source usgs --feed all_day`.
 *
 * Unknown flags are an error rather than being ignored: silently dropping `--dry-run` because it
 * is not implemented would run the real thing while the operator believed otherwise.
 */
export function parseRunArgs(argv: readonly string[]): RunSourceArgs {
  let source: string | undefined;
  let feed: string | undefined;
  let help = false;
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--source' || arg === '--feed') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        errors.push(`${arg} needs a value`);
        continue;
      }
      if (arg === '--source') source = value;
      else feed = value;
      index += 1;
      continue;
    }
    errors.push(`unknown argument: ${String(arg)}`);
  }

  if (!help && source === undefined) errors.push('--source is required');
  if (source !== undefined && !(source in ADAPTERS)) {
    errors.push(`unknown source: ${source} (available: ${AVAILABLE_SOURCES.join(', ')})`);
  }
  // Checked here as well as in the adapter, so an operator gets the answer before the worker
  // opens a database connection — and never gets a different feed than the one they named.
  if (source === 'usgs' && feed !== undefined && !isUsgsFeed(feed)) {
    errors.push(`unknown feed: ${feed} (available: ${USGS_FEEDS.join(', ')})`);
  }

  return {
    ...(source === undefined ? {} : { source }),
    ...(feed === undefined ? {} : { feed }),
    help,
    errors,
  };
}

export const RUN_USAGE = `Usage: geonerva-worker run --source <id> [--feed <name>]

  --source   Which source to poll (${AVAILABLE_SOURCES.join(', ')})
  --feed     Which feed of that source, when it offers more than one

Exits 0 when the run was recorded, whatever its outcome; a provider being down is an
observation, not a worker failure. Exits 1 only when the worker itself could not run.`;

/**
 * The process exit code for a finished run.
 *
 * 0 means "the worker did its job", which includes faithfully recording that a provider was
 * broken. 1 means the worker itself cannot work until a human changes something.
 */
export function exitCodeFor(outcome: RunOutcome): number {
  return outcome.errorClass === 'CONFIG_ERROR' ? 1 : 0;
}

/** Human-readable one-liner. The machine-readable record is the JSON log and the run row. */
export function describeOutcome(outcome: RunOutcome): string {
  const counts = outcome.counts;
  const summary = `${outcome.status} in ${outcome.stageMs.totalMs} ms`;
  if (outcome.status === 'SUCCEEDED' || outcome.status === 'PARTIAL') {
    return `${summary} — ${counts.accepted} accepted, ${counts.newRecords} new, ${counts.newVersions} versions, ${counts.unchanged} unchanged, ${counts.rejected} rejected`;
  }
  return outcome.detail === null ? summary : `${summary} — ${outcome.detail}`;
}

export async function runSource(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> {
  const args = parseRunArgs(argv);
  if (args.help) {
    console.log(RUN_USAGE);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const error of args.errors) console.error(`✗ ${error}`);
    console.error(`\n${RUN_USAGE}`);
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
  const adapter = source === undefined ? undefined : ADAPTERS[source];
  if (adapter === undefined) {
    console.error(`✗ unknown source: ${source ?? '(none given)'}`);
    return 2;
  }

  const handle = createDatabase(workerPoolOptions(config.DATABASE_URL_WORKER, config.NODE_ENV));
  try {
    const outcome = await runIngestion({
      db: handle.db,
      adapter,
      client: createSourceClient(adapter.descriptor, {
        userAgent: `GeoNerva/${config.NODE_ENV} (+https://github.com/geonerva)`,
      }),
      trigger: 'MANUAL',
      logger: createJsonLogger(),
      ...(args.feed === undefined ? {} : { feed: args.feed }),
      ...(signal === undefined ? {} : { signal }),
    });
    console.error(describeOutcome(outcome));
    return exitCodeFor(outcome);
  } finally {
    await handle.close();
  }
}
