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
import {
  createJsonLogger,
  runFireIngestion,
  runIngestion,
  type FireIngestionOutcome,
  type RunOutcome,
} from '@geonerva/pipeline';
import {
  FIRMS_MAX_DAY_RANGE,
  FIRMS_SENSORS,
  GDACS_EVENT_TYPES,
  USGS_FEEDS,
  createSourceClient,
  emscAdapter,
  firmsDescriptor,
  gdacsAdapter,
  isFirmsSensor,
  isUsgsFeed,
  usgsAdapter,
  type FirmsSensor,
  type SourceAdapter,
} from '@geonerva/sources';

/**
 * The adapters this build can run, keyed by what an operator types.
 *
 * GDACS appears six times, as `gdacs:EQ` … `gdacs:DR`, because it *is* six products: the database
 * has had one `source_products` row per event type since P2, each with its own hazard type,
 * capabilities and latency class. One key called `gdacs` would have to mean "all of them", which
 * is a different operation with a different failure mode — and a partial failure across six
 * products has no single run row to record it in.
 */
const ADAPTERS: Readonly<Record<string, SourceAdapter<never>>> = {
  usgs: usgsAdapter as SourceAdapter<never>,
  emsc: emscAdapter as SourceAdapter<never>,
  ...Object.fromEntries(
    GDACS_EVENT_TYPES.map((eventType) => [
      `gdacs:${eventType}`,
      gdacsAdapter(eventType) as unknown as SourceAdapter<never>,
    ]),
  ),
};

/**
 * What `--feed` means, per source, checked before a database connection is opened.
 *
 * A map rather than a chain of `if (source === ...)`, because the second source made the shape of
 * the problem visible: `--feed` does not mean the same kind of thing twice. For USGS it names one
 * of three summary files; for EMSC there are no feeds at all, only how far back `updatedafter`
 * reaches, in minutes. A source with nothing to validate is absent from the map and its value
 * goes to the adapter, which refuses what it does not understand rather than defaulting.
 */
/**
 * Whether this process has a FIRMS credential.
 *
 * Read from the environment rather than the validated config, because argument parsing happens
 * before the config is loaded and the answer changes what `--feed` is allowed to mean. A wrong
 * answer here can only make the message wrong, never the behaviour: `fetchFirms` decides the mode
 * from the key it is actually given.
 */
const keylessFirms =
  process.env['FIRMS_MAP_KEY'] === undefined || process.env['FIRMS_MAP_KEY'].length === 0;

const FEED_VALIDATORS: Readonly<Record<string, (feed: string) => string | null>> = {
  usgs: (feed) =>
    isUsgsFeed(feed) ? null : `unknown feed: ${feed} (available: ${USGS_FEEDS.join(', ')})`,
  emsc: (feed) => {
    const minutes = Number(feed);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 10_080
      ? null
      : `unknown feed: ${feed} (EMSC takes a lookback in whole minutes, 1 to 10080)`;
  },
  /*
   * FIRMS takes `--feed` as a `DAY_RANGE`, and refuses it outright without a key.
   *
   * There was no validator at all, so `FEED_VALIDATORS[source]?.(feed)` returned `undefined`, no
   * error was raised, and the value was then dropped because `runFireIngestion` was called
   * without it. An operator asking for five days after an outage got a normal two-day poll and a
   * `SUCCEEDED` — which is precisely what the rule ten lines above says must not happen.
   *
   * In keyless mode it cannot mean anything at all: the public files are whatever they are, and
   * pretending otherwise is the same lie in a different place.
   */
  ...Object.fromEntries(
    FIRMS_SENSORS.map((sensor) => [
      `firms:${sensor}`,
      (feed: string) => {
        if (keylessFirms) {
          return (
            `--feed is not available without a FIRMS_MAP_KEY: the keyless files are fixed ` +
            `24-hour snapshots and cannot be widened`
          );
        }
        const days = Number(feed);
        return Number.isInteger(days) && days >= 1 && days <= FIRMS_MAX_DAY_RANGE
          ? null
          : `unknown feed: ${feed} (FIRMS takes a DAY_RANGE of 1 to ${FIRMS_MAX_DAY_RANGE})`;
      },
    ]),
  ),
  ...Object.fromEntries(
    GDACS_EVENT_TYPES.map((eventType) => [
      `gdacs:${eventType}`,
      (feed: string) => {
        const hours = Number(feed);
        return Number.isInteger(hours) && hours >= 1 && hours <= 2_160
          ? null
          : `unknown feed: ${feed} (GDACS takes a lookback in whole hours, 1 to 2160)`;
      },
    ]),
  ),
};

/**
 * FIRMS, which is not in `ADAPTERS` because it is not a `SourceAdapter`.
 *
 * Thermal detections never become observation versions (DOMAIN_MODEL §4.9): they have no
 * identity, no revisions and 230,000 rows a day, and they live in a partitioned table with its
 * own insert and its own retention. `runFireIngestion` gives them the same lifecycle — lease,
 * run row, batch verdict, reject rows, health evidence — and a different persist step. Listing
 * them here rather than pretending they fit the other shape is the honest version of that.
 */
const FIRE_SOURCES = FIRMS_SENSORS.map((sensor) => `firms:${sensor}`);

export const AVAILABLE_SOURCES = [...Object.keys(ADAPTERS), ...FIRE_SOURCES];

/** The sensor behind `firms:VIIRS_NOAA20_NRT`, or `null` when this is not a FIRMS source. */
function firmsSensorOf(source: string): FirmsSensor | null {
  if (!source.startsWith('firms:')) return null;
  const sensor = source.slice('firms:'.length);
  return isFirmsSensor(sensor) ? sensor : null;
}

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
  if (source !== undefined && !(source in ADAPTERS) && firmsSensorOf(source) === null) {
    errors.push(`unknown source: ${source} (available: ${AVAILABLE_SOURCES.join(', ')})`);
  }
  // Checked here as well as in the adapter, so an operator gets the answer before the worker
  // opens a database connection — and never gets a different feed than the one they named.
  if (source !== undefined && feed !== undefined) {
    const complaint = FEED_VALIDATORS[source]?.(feed);
    if (complaint !== null && complaint !== undefined) errors.push(complaint);
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

/** The same one-liner for a detection batch, in the terms detections actually have. */
export function describeFireOutcome(outcome: FireIngestionOutcome): string {
  const mode = outcome.keyless ? 'keyless' : 'Area API';
  if (outcome.status === 'SUCCEEDED' || outcome.status === 'PARTIAL') {
    const counts = outcome.counts;
    return (
      `${outcome.status} (${mode}) — ${counts.received} received, ${counts.inserted} new, ` +
      `${counts.duplicates} already held, ${counts.rejected} rejected` +
      (outcome.newestAcquiredAt === null
        ? ''
        : `; newest ${outcome.newestAcquiredAt.toISOString()}`)
    );
  }
  return outcome.detail === null
    ? `${outcome.status} (${mode})`
    : `${outcome.status} (${mode}) — ${outcome.detail}`;
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
  const sensor = source === undefined ? null : firmsSensorOf(source);
  const adapter = source === undefined ? undefined : ADAPTERS[source];
  if (adapter === undefined && sensor === null) {
    console.error(`✗ unknown source: ${source ?? '(none given)'}`);
    return 2;
  }

  const handle = createDatabase(workerPoolOptions(config.DATABASE_URL_WORKER, config.NODE_ENV));
  try {
    if (sensor !== null) {
      /*
       * Keyless when no `FIRMS_MAP_KEY` is configured, and it says so in the output.
       *
       * Not a silent degradation: the keyless files are not a strict 24 hours (P0 measured ≈ 42),
       * cannot be backfilled, and are the same two sensors. An operator who thinks they are
       * polling the Area API when they are reading a public file would draw the wrong conclusion
       * from a gap, so the mode is part of the result rather than an implementation detail.
       */
      const descriptor = firmsDescriptor(sensor);
      const outcome = await runFireIngestion({
        db: handle.db,
        client: createSourceClient(descriptor, {
          userAgent: `GeoNerva/${config.NODE_ENV} (+https://github.com/geonerva)`,
        }),
        sensor,
        ...(config.FIRMS_MAP_KEY === undefined ? {} : { mapKey: config.FIRMS_MAP_KEY }),
        // Validated above: a whole number of days in [1, 5], and refused without a key.
        ...(args.feed === undefined ? {} : { dayRange: Number(args.feed) }),
        trigger: 'MANUAL',
        logger: createJsonLogger(),
        ...(signal === undefined ? {} : { signal }),
      });
      console.error(describeFireOutcome(outcome));
      return outcome.errorClass === 'CONFIG_ERROR' ? 1 : 0;
    }
    if (adapter === undefined) {
      console.error(`✗ unknown source: ${source ?? '(none given)'}`);
      return 2;
    }
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
