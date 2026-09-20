/**
 * @geonerva/pipeline — Ingestion orchestration: run leases, persistence, post-commit correlation,
 * clustering and materialization.
 *
 * See docs/ARCHITECTURE.md §3 for this package's responsibility and allowed dependencies.
 */

export { classifyFetchFailure, runIngestion } from './run.ts';
export type { RunCounts, RunIngestionOptions, RunOutcome } from './run.ts';

export {
  MAX_DETAIL_LENGTH,
  createJsonLogger,
  createMemoryLogger,
  redact,
  sanitizeDetail,
} from './logging.ts';
export type { IngestionLogFields, LogLevel, Logger } from './logging.ts';
