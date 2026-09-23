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
  recordWorkerHeartbeat,
  workerPoolOptions,
} from '@geonerva/db';
import {
  createJsonLogger,
  runIngestion,
  runScheduler,
  type ScheduledJob,
  type SchedulerSummary,
} from '@geonerva/pipeline';
import { createSourceClient, usgsAdapter, type SourceAdapter } from '@geonerva/sources';

/** The adapters this build polls on a schedule. */
const SCHEDULED_ADAPTERS: readonly SourceAdapter<never>[] = [usgsAdapter as SourceAdapter<never>];

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
