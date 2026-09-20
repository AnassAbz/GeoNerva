/**
 * Repositories: the write side of `packages/db`.
 *
 * Reads of facts do **not** live here — they live in `../asof.ts`, which is the only fact read
 * path (ADR-003). What is here is everything that changes state: identity resolution, version
 * insertion, the run lease, bulk detection inserts and correlation bookkeeping.
 */

export {
  findProductByCode,
  getPollingPolicy,
  getSourceFreshnessPolicy,
  listProductsWithCapability,
  listSourceProducts,
  listSources,
  retireProduct,
  setSourceEnabled,
} from './sources.ts';
export type { SourceProductRow, SourceRow } from './sources.ts';

export {
  DEFAULT_LEASE_STALE_AFTER_MS,
  acquireRunLease,
  batchTimestamp,
  finishRun,
  lastPayloadDigest,
  listRecentRuns,
  recordReject,
  recordWorkerHeartbeat,
} from './ingestion-runs.ts';
export type {
  AcquireLeaseOptions,
  AcquireLeaseResult,
  FinishRunInput,
  RunSummary,
} from './ingestion-runs.ts';

export { findRawPayload, prunePayloadsBefore, upsertRawRecords } from './raw-records.ts';
export type { RawRecordInput } from './raw-records.ts';

export {
  addAliases,
  findSourceRecord,
  listAliases,
  mergeSourceRecords,
  resolveSourceRecord,
} from './source-records.ts';
export type {
  MergeSourceRecordsInput,
  ResolveSourceRecordInput,
  ResolveSourceRecordResult,
  SourceRecordRow,
} from './source-records.ts';

export {
  VersionRejectedError,
  headContentHashes,
  insertTombstone,
  insertVersionIfChanged,
  listVersions,
  rebuildHeads,
} from './observation-versions.ts';
export type {
  InsertVersionInput,
  InsertVersionResult,
  VersionGeometryInput,
  VersionRow,
} from './observation-versions.ts';

export {
  DETECTION_CHUNK_SIZE,
  assignDetectionsToCluster,
  bulkInsertDetections,
  createCluster,
  dropDetectionPartitionsBefore,
  ensurePartitionsForDays,
  insertClusterVersionIfChanged,
  listDetectionPartitionDays,
  mergeClusters,
  recordMissingDataDay,
} from './fire.ts';
export type {
  BulkInsertResult,
  ClusterVersionInput,
  ClusterVersionResult,
  CreateClusterInput,
  FireDetectionInput,
} from './fire.ts';

export {
  createCanonicalEvent,
  insertCorrelationCandidate,
  linkRecord,
  mergeCanonicalEvents,
  resolveCanonicalEvent,
  unlinkRecord,
  upsertCanonicalEventState,
} from './canonical.ts';
export type {
  CanonicalStateInput,
  CreateCanonicalEventInput,
  LinkRecordInput,
} from './canonical.ts';
