/**
 * @geonerva/pipeline — Ingestion orchestration: run leases, persistence, post-commit correlation,
 * clustering and materialization.
 *
 * See docs/ARCHITECTURE.md §3 for this package's responsibility and allowed dependencies.
 */

export { describeBackfillFailure, runBackfill } from './backfill.ts';
export { runDeletionSweep } from './deletion-sweep.ts';
export type { DeletionSweepOptions, DeletionSweepOutcome } from './deletion-sweep.ts';
export type { BackfillOutcome, BackfillRequest, RunBackfillOptions } from './backfill.ts';

export { classifyFetchFailure, describeDatabaseFailure, runIngestion } from './run.ts';
export type { BatchCommitContext, RunCounts, RunIngestionOptions, RunOutcome } from './run.ts';

export { DEFAULT_BREAKER, countsAsFailure, jitteredDelay, runScheduler } from './scheduler.ts';
export type {
  BreakerPolicy,
  ScheduledJob,
  SchedulerOptions,
  SchedulerSummary,
} from './scheduler.ts';

export {
  MAX_DETAIL_BYTES,
  createJsonLogger,
  createMemoryLogger,
  redact,
  sanitizeDetail,
} from './logging.ts';
export type { IngestionLogFields, LogLevel, Logger } from './logging.ts';
export { runFireIngestion } from './fire-ingest.ts';
export type { FireIngestionOutcome, RunFireIngestionOptions } from './fire-ingest.ts';

export { correlateEarthquakes, projectCanonicalEvent } from './correlate.ts';
export type { CorrelateOptions, CorrelateResult } from './correlate.ts';
