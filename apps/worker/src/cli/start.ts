/**
 * `geonerva-worker start` — the long-running poll loop.
 *
 * The scheduler itself lives in `@geonerva/pipeline`; this is the composition root that turns
 * configuration and the database's own polling policy into jobs.
 *
 * The interval comes from `sources.policy.polling`, not from code. Changing how often a source is
 * polled is then a data change rather than a deploy, and — more importantly — the interval the
 * worker uses and the interval `/data-status` judges freshness against are the same number by
 * construction, so a source can never look stale because two files disagreed.
 */

import { ConfigError, loadWorkerConfig } from '@geonerva/config';
import {
  createDatabase,
  getPollingPolicy,
  listSourceProducts,
  listSources,
  recordWorkerHeartbeat,
  workerPoolOptions,
} from '@geonerva/db';
import {
  createJsonLogger,
  runCorrelation,
  runIngestion,
  runScheduler,
  runClustering,
  runFireIngestion,
  runSeed,
  type FireIngestionOutcome,
  type RunOutcome,
  type ScheduledJob,
  type SchedulerSummary,
} from '@geonerva/pipeline';
import {
  FIRMS_SENSORS,
  createSourceClient,
  emscAdapter,
  firmsDescriptor,
  gdacsAdapter,
  usgsAdapter,
  type SourceAdapter,
} from '@geonerva/sources';

/**
 * How often correlation looks for work, and by how much that is jittered.
 *
 * A constant rather than a row in `sources.policy`: correlation is not a source, and inventing a
 * pseudo-source row to carry its interval would corrupt `listSources`, coverage and `/data-status`,
 * each of which iterates real sources. `DEFAULT_BREAKER` and the heartbeat interval are the
 * existing precedents for a scheduling constant living in code. The number is argued in ADR-044.
 */
import {
  describeSourceStateMismatch,
  findSourceStateMismatch,
  type ScheduledFeed,
} from './scheduled-sources.ts';

const CORRELATION_INTERVAL_MS = 60_000;
const CORRELATION_JITTER_RATIO = 0.1;

/**
 * How often the single-source seeding derivation looks for work.
 *
 * The same sixty seconds as correlation and for the same reason (ADR-044): the gate makes an idle
 * tick cheap, and a longer interval would leave the families that depend on `SEED` — floods,
 * cyclones, volcanoes, droughts, GDACS wildfire events — reporting `DERIVATION_STALE` for no
 * reason. The two derivations take different advisory locks, so neither queues behind the other.
 */
const SEED_INTERVAL_MS = 60_000;

/**
 * How often fire clustering looks for work (ADR-045).
 *
 * Deliberately slower than the other two derivations. FIRMS is polled every fifteen minutes and a
 * satellite overpass delivers a place's detections in one batch, so there is nothing for a
 * sixty-second tick to find; and unlike correlation, a clustering pass is not cheap when it *does*
 * run — it reads the whole 72-hour window. Five minutes keeps the fire card comfortably inside its
 * own staleness bound while leaving the gate to absorb the idle wakeups.
 */
/**
 * A fire ingestion outcome as the scheduler's `RunOutcome`.
 *
 * `FireIngestionOutcome` is deliberately its own shape — it carries `partitionsTouched`,
 * `newestAcquiredAt` and `keyless`, none of which mean anything for a source that writes
 * observation versions. The scheduler only needs the status, the class and the counters, so the
 * mapping is narrow and the FIRMS-specific facts stay on the terminal log line rather than being
 * flattened into a vocabulary that has no room for them.
 */
function asRunOutcome(outcome: FireIngestionOutcome): RunOutcome {
  return {
    status: outcome.status,
    runId: outcome.runId,
    errorClass: outcome.errorClass,
    detail: outcome.detail,
    counts: {
      received: outcome.counts.received,
      accepted: outcome.counts.inserted,
      rejected: outcome.counts.rejected,
      newRecords: outcome.counts.inserted,
      newVersions: 0,
      unchanged: outcome.counts.duplicates,
      mergedRecords: 0,
    },
    stageMs: { fetchMs: 0, parseMs: 0, normalizeMs: 0, persistMs: 0, totalMs: 0 },
    committedAt: null,
    httpStatus: null,
  };
}

const CLUSTERING_INTERVAL_MS = 300_000;
const CLUSTERING_JITTER_RATIO = 0.1;
const SEED_JITTER_RATIO = 0.1;

/**
 * The adapters this build polls on a schedule.
 *
 * EMSC was added as its own step, after correlation was scheduled (ADR-044) — a second independent
 * earthquake source is only worth having once something merges the two solutions, and before that
 * it would have produced twice the observations and still no events.
 *
 * **One caveat belongs with it.** `EMSC_POLL_LOOKBACK_MS` is fifteen minutes, three of its five
 * minute poll intervals, so consecutive polls overlap twice over and cannot skip. What that does
 * *not* survive is a worker outage longer than fifteen minutes: USGS reads twenty-four hours back
 * and heals itself, EMSC does not, and the coverage ledger would go on claiming the hole was
 * covered. Closing it is a deliberate act — `worker run --source emsc --feed <minutes>` with a
 * window wide enough to cover the downtime (gate-g8 §6 item 7, latent until this line changed).
 *
 * GDACS and FIRMS remain unscheduled, and deliberately not in the same step as this one.
 */
const SCHEDULED_ADAPTERS: readonly SourceAdapter<never>[] = [
  usgsAdapter as SourceAdapter<never>,
  emscAdapter as SourceAdapter<never>,
  /*
   * GDACS, one family at a time. Each event type is its own `source_products` row with its own
   * coverage ledger (ADR-041), so activating one says nothing about the others — which is the
   * whole point: polling the flood feed must never become evidence that the cyclone feed was read.
   * The database's `enabled` flags must agree with this list; the worker says so at start-up when
   * they do not.
   */
  gdacsAdapter('FL') as SourceAdapter<never>,
  /*
   * `OTHER` draws on both VO and DR, and `coveredSinceForEvery` requires *every* feed a family
   * reads before it will say the family is covered. Activating one of the pair alone would leave
   * the family refusing — honestly, but pointlessly — so they go on together.
   */
  gdacsAdapter('VO') as SourceAdapter<never>,
  gdacsAdapter('DR') as SourceAdapter<never>,
  gdacsAdapter('TC') as SourceAdapter<never>,
  /*
   * A GDACS wildfire is a `WILDFIRE_EVENT` — an official burnt-area event — and never a
   * `THERMAL_ACTIVITY` detection. They are different hazard types in the domain, and the wording
   * on both sides depends on them staying that way.
   */
  gdacsAdapter('WF') as SourceAdapter<never>,
  /*
   * GDACS earthquakes last, because they are the one feed that can corrupt a claim rather than
   * merely add one. GDACS republishes USGS solutions, so a canonical event holding a USGS record
   * and its GDACS copy has two links and **one** independent source; `assessAgreement` excludes
   * `DERIVED_COPY` links from `nIndependentSources` for exactly that reason. With EMSC live the
   * case to watch is three links and two independent sources, never three.
   */
  gdacsAdapter('EQ') as SourceAdapter<never>,
];

/**
 * Every feed this build polls, adapters **and** FIRMS.
 *
 * FIRMS is not a `SourceAdapter` and so cannot live in `SCHEDULED_ADAPTERS`, and the first version
 * of the FIRMS job simply forgot to tell the drift check about it. The consequence was not
 * theoretical: FIRMS ingested 92,616 detections and produced 34,087 clusters while
 * `sources.firms.enabled` was `false`, and the start-up check that exists precisely to catch that
 * said nothing, because the feed it was judging was invisible to it. A list derived from one place
 * is the fix — anything this worker polls has to appear here, or the invariant only covers the
 * sources someone remembered.
 */
export const SCHEDULED_FEEDS: readonly ScheduledFeed[] = [
  ...SCHEDULED_ADAPTERS.map((adapter) => ({
    sourceId: adapter.descriptor.sourceId,
    productCode: adapter.descriptor.productCode,
  })),
  ...FIRMS_SENSORS.map((sensor) => {
    const descriptor = firmsDescriptor(sensor);
    return { sourceId: descriptor.sourceId, productCode: descriptor.productCode };
  }),
];

export const START_USAGE = `Usage: geonerva-worker start

Polls every enabled source on the interval its policy defines, until SIGTERM.

  - the interval and its jitter come from sources.policy.polling in the database
  - a source that fails five polls in a row is probed every 15 minutes instead
  - SIGTERM cancels in-flight work; each run closes as ABORTED rather than
    leaving a lease behind`;

/** One line per source, for the operator watching a deploy. */
export function describeSummaries(summaries: readonly SchedulerSummary[]): string {
  if (summaries.length === 0) return 'no sources were scheduled';
  return summaries
    .map(
      (summary) =>
        `${summary.name}: ${summary.runs} run(s), ${summary.failures} failed${
          summary.breakerOpen ? ', breaker open' : ''
        }`,
    )
    .join('\n');
}

export async function startWorker(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(START_USAGE);
    return 0;
  }
  if (argv.length > 0) {
    console.error(`✗ unknown argument: ${String(argv[0])}\n\n${START_USAGE}`);
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

  const logger = createJsonLogger();
  const handle = createDatabase(workerPoolOptions(config.DATABASE_URL_WORKER, config.NODE_ENV));

  try {
    /*
     * Which build is running, recorded on every run and every heartbeat.
     *
     * `NODE_ENV` used to be written into `worker_heartbeat.version`, which answered a question
     * nobody asks: a soak that sees failures needs to know *which build* produced them, and
     * "production" is true of every build ever deployed. `GEONERVA_BUILD` is what the deployment
     * stamps in; a checkout that has not set it records nothing rather than something misleading
     * (`docs/reviews/p10-plan.md` §2.4).
     */
    const workerVersion = config.GEONERVA_BUILD ?? null;

    // F-12: a production process says so on start-up, so a misconfigured deployment is visible
    // in the first log line rather than in whatever behaves oddly later.
    logger.log('info', 'worker.starting', {
      detail:
        `NODE_ENV=${config.NODE_ENV} retention=${config.RETENTION_PROFILE} ` +
        `ai=${config.AI_MODE} build=${workerVersion ?? '(unset)'}`,
    });

    /*
     * Does the job list agree with the database's own switches? Enabling a feed takes two changes
     * that have to agree, and each direction of disagreement fails quietly on its own — a
     * scheduled-but-disabled product writes no run row at all. Reported, never fatal: the database
     * is the documented control surface for switching a feed off.
     */
    const [allProducts, enabledSources] = await Promise.all([
      listSourceProducts(handle.db, { includeDisabled: true, includeRetired: true }),
      listSources(handle.db),
    ]);
    const mismatch = findSourceStateMismatch(
      SCHEDULED_FEEDS,
      allProducts,
      new Set(enabledSources.map((source) => source.id)),
    );
    for (const detail of describeSourceStateMismatch(mismatch)) {
      logger.log('warn', 'worker.source_state_mismatch', { detail });
    }

    const jobs: ScheduledJob[] = [];
    for (const adapter of SCHEDULED_ADAPTERS) {
      const descriptor = adapter.descriptor;
      const policy = await getPollingPolicy(handle.db, descriptor.sourceId, descriptor.productCode);
      const client = createSourceClient(descriptor, {
        userAgent: `GeoNerva/${config.NODE_ENV} (+https://github.com/geonerva)`,
      });
      jobs.push({
        name: `${descriptor.sourceId}:${descriptor.productCode}`,
        intervalMs: policy.intervalS * 1000,
        jitterRatio: policy.jitterRatio,
        run: (jobSignal) =>
          runIngestion({
            db: handle.db,
            adapter,
            client,
            trigger: 'SCHEDULE',
            logger,
            signal: jobSignal,
            // So a failure in the soak can be attributed to a build rather than to "production".
            ...(workerVersion === null ? {} : { workerVersion }),
          }),
      });
    }

    /*
     * FIRMS, which is not a `SourceAdapter` and so cannot join `SCHEDULED_ADAPTERS`.
     *
     * It answers a different question from every other source — 230,000 pixel detections a day,
     * no identifiers, no revisions, no events — and writes to `fire_detections` rather than to
     * observation versions (ADR-011). What it shares is the run row, the health evidence and the
     * coverage ledger, and `trigger: 'SCHEDULE'` is what makes that last one record anything: the
     * ledger is written for scheduled polls only, so the manual CLI's `MANUAL` produces detections
     * with no covered hours and a permanently `INSUFFICIENT_COVERAGE` fire trend.
     *
     * Keyless here, because no `FIRMS_MAP_KEY` is configured: the public 24-hour global files,
     * which is a supported mode and the one this build has been run against. The mode travels on
     * the outcome rather than being inferred, so a gap is not mistaken for an outage.
     */
    for (const sensor of FIRMS_SENSORS) {
      const descriptor = firmsDescriptor(sensor);
      const policy = await getPollingPolicy(handle.db, descriptor.sourceId, descriptor.productCode);
      const client = createSourceClient(descriptor, {
        userAgent: `GeoNerva/${config.NODE_ENV} (+https://github.com/geonerva)`,
      });
      jobs.push({
        name: `${descriptor.sourceId}:${descriptor.productCode}`,
        intervalMs: policy.intervalS * 1000,
        jitterRatio: policy.jitterRatio,
        run: async (jobSignal) =>
          asRunOutcome(
            await runFireIngestion({
              db: handle.db,
              client,
              sensor,
              ...(config.FIRMS_MAP_KEY === undefined ? {} : { mapKey: config.FIRMS_MAP_KEY }),
              trigger: 'SCHEDULE',
              logger,
              signal: jobSignal,
            }),
          ),
      });
    }

    /*
     * Correlation, beside the ingestion jobs (ADR-044). Until this existed the worker ingested
     * observations and never produced a canonical event, and the product said so — honestly, and
     * uselessly.
     *
     * Sixty seconds, where the sources are polled every three hundred. The two timers are
     * independent and jittered, so matching the poll interval would let a correlation tick land
     * just before a poll and leave canonical state a full extra interval behind the facts. What
     * makes a one-minute tick affordable is that `runCorrelation` gates on whether anything has
     * been ingested since the last successful run, and does nothing when the answer is no.
     */
    jobs.push({
      name: 'correlation:earthquakes',
      intervalMs: CORRELATION_INTERVAL_MS,
      jitterRatio: CORRELATION_JITTER_RATIO,
      run: () => runCorrelation({ db: handle.db, logger }),
    });

    /*
     * Seeding, for the hazards where no matching is possible because only one source reports them.
     * Without it a GDACS flood is ingested and then reported as `DERIVATION_NOT_RUN` for ever —
     * the same defect ADR-044 fixed for earthquakes, one family over.
     */
    jobs.push({
      name: 'seed:single-source',
      intervalMs: SEED_INTERVAL_MS,
      jitterRatio: SEED_JITTER_RATIO,
      run: () => runSeed({ db: handle.db, logger }),
    });

    /*
     * Fire clustering. Without it FIRMS detections accumulate and `FIRE_ACTIVITY` reports
     * `DERIVATION_NOT_RUN` for ever — the defect ADR-044 fixed for earthquakes and ADR-045 for
     * this family, which until now had no implementation at all rather than merely no schedule.
     */
    jobs.push({
      name: 'clustering:fire',
      intervalMs: CLUSTERING_INTERVAL_MS,
      jitterRatio: CLUSTERING_JITTER_RATIO,
      run: () => runClustering({ db: handle.db, logger }),
    });

    const summaries = await runScheduler({
      jobs,
      signal,
      logger,
      heartbeat: (at) => recordWorkerHeartbeat(handle.db, at, workerVersion),
    });
    console.error(describeSummaries(summaries));
    return 0;
  } catch (error) {
    // Configuration the database disagrees with — an unknown source, or a product with no
    // polling policy. The worker cannot run until a human changes something.
    console.error(`✗ ${error instanceof Error ? error.message : 'the worker could not start'}`);
    return 1;
  } finally {
    await handle.close();
  }
}
