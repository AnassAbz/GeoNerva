/**
 * The ingestion run lifecycle (ARCHITECTURE §4.2), source-agnostic.
 *
 * Six steps: lease → fetch → parse → normalize → persist (one transaction) → post-commit. The
 * pipeline knows nothing about any provider; everything provider-specific arrives through the
 * adapter contract, which is what makes the second adapter a configuration change rather than a
 * second copy of this file.
 *
 * Three rules this file exists to enforce:
 *
 *  1. **Every attempt commits a run row, including failures.** A failed poll is the evidence that
 *     a source is unhealthy. Dropping it would make a broken feed indistinguishable from a quiet
 *     one, which is the single most misleading thing this system could do.
 *  2. **Facts and the run row commit together, or not at all.** One transaction, `finishRun` as
 *     its last statement, and the same batch timestamp on both, so a replay can never see half a
 *     batch or facts whose run has not landed.
 *  3. **Nothing is skipped silently.** Every record that does not become a fact leaves a reject
 *     row or fails the batch, and every failure carries a class and a sanitized detail.
 */

import type { Kysely, Transaction } from 'kysely';

import type { DB } from '@geonerva/db';
import {
  acquireRunLease,
  batchTimestamp,
  finishRun,
  findProductByCode,
  headContentHashes,
  insertVersionIfChanged,
  lastPayloadDigest,
  recordReject,
  resolveSourceRecord,
  upsertRawRecords,
  VersionRejectedError,
  type InsertVersionInput,
} from '@geonerva/db';
import type { ErrorClass, RunStatus, RunTrigger } from '@geonerva/domain';
import { SourceFetchError, type HttpClient } from '@geonerva/http';
import {
  NormalizationError,
  type FetchResult,
  type NormalizedRecord,
  type RejectedRecord,
  type SourceAdapter,
} from '@geonerva/sources';

import { createJsonLogger, sanitizeDetail, type Logger } from './logging.ts';

export interface RunIngestionOptions<TRaw> {
  readonly db: Kysely<DB>;
  readonly adapter: SourceAdapter<TRaw>;
  readonly client: HttpClient;
  readonly trigger: RunTrigger;
  readonly feed?: string;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly workerVersion?: string;
  /** Injected so tests can assert timings without a real clock. */
  readonly monotonic?: () => number;
}

export interface RunCounts {
  readonly received: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly newRecords: number;
  readonly newVersions: number;
  readonly unchanged: number;
  readonly mergedRecords: number;
}

export interface RunOutcome {
  /** `LEASE_HELD` is not a run: another worker owns this product and no row was written. */
  readonly status: RunStatus | 'LEASE_HELD';
  readonly runId: string | null;
  readonly errorClass: ErrorClass | null;
  readonly detail: string | null;
  readonly counts: RunCounts;
  readonly stageMs: {
    readonly fetchMs: number;
    readonly parseMs: number;
    readonly normalizeMs: number;
    readonly persistMs: number;
    readonly totalMs: number;
  };
  readonly committedAt: Date | null;
}

const EMPTY_COUNTS: RunCounts = {
  received: 0,
  accepted: 0,
  rejected: 0,
  newRecords: 0,
  newVersions: 0,
  unchanged: 0,
  mergedRecords: 0,
};

/**
 * Maps a fetch failure onto the stored taxonomy (ADR-032).
 *
 * `NETWORK`, `CONFIG_ERROR` and `ABORTED` exist precisely so this function does not have to lie;
 * the classes line up one to one, and an unrecognised one becomes `UNKNOWN` rather than being
 * guessed at.
 */
export function classifyFetchFailure(error: SourceFetchError): ErrorClass {
  switch (error.errorClass) {
    case 'HTTP_4XX':
    case 'HTTP_5XX':
    case 'RATE_LIMITED':
    case 'TIMEOUT':
    case 'TOO_LARGE':
    case 'NETWORK':
    case 'CONFIG_ERROR':
    case 'ABORTED':
      return error.errorClass;
    default:
      return 'UNKNOWN';
  }
}

interface PersistResult {
  readonly counts: RunCounts;
  readonly newestObservedAt: Date | null;
  readonly committedAt: Date;
}

/**
 * Writes one batch and closes its run, in a single transaction.
 *
 * The batch timestamp is read once, from the database, and used for every version *and* for the
 * run's `committed_at`. `observationsAsOf` filters on `ingested_at` alone, so if those two ever
 * disagreed there would be an instant where a batch's facts are visible but the run that produced
 * them is not — a replay inconsistent with its own provenance.
 */
async function persistBatch(
  trx: Transaction<DB>,
  runId: string,
  adapter: SourceAdapter<unknown>,
  records: readonly NormalizedRecord[],
  rejects: readonly RejectedRecord[],
  fetched: Extract<FetchResult, { kind: 'FETCHED' }>,
  receivedCount: number,
): Promise<PersistResult> {
  const ingestedAt = await batchTimestamp(trx);

  let newRecords = 0;
  let newVersions = 0;
  let unchanged = 0;
  let mergedRecords = 0;
  let rejected = rejects.length;
  let newestObservedAt: Date | null = null;

  for (const reject of rejects) {
    await recordReject(trx, runId, reject.reasonCode, reject.excerpt);
  }

  // Identity first, for every record, because the next two decisions both need it.
  const resolvedIds: string[] = [];
  for (const record of records) {
    const resolved = await resolveSourceRecord(trx, {
      sourceId: adapter.descriptor.sourceId,
      hazardType: record.hazardType,
      primaryKey: record.primaryKey,
      aliases: record.aliases,
      firstIngestedAt: ingestedAt,
    });
    if (resolved.created) newRecords += 1;
    mergedRecords += resolved.mergedRecordIds.length;
    resolvedIds.push(resolved.sourceRecordId);
  }

  /*
   * Store a provider payload only for a record whose content actually changed.
   *
   * Raw payloads are content-addressed over the *whole* feature, including `updated`. USGS
   * re-stamps `updated` without changing anything, so storing one per record per poll would write
   * ~230 rows of ~1.3 KB every time any event in the feed moved — about 84 MB/day at a five
   * minute cadence — none of which would have a version to be the provenance of.
   *
   * `insertVersionIfChanged` still makes the real decision under a row lock; this only decides
   * what is worth storing beforehand, and it errs towards storing.
   */
  const heads = await headContentHashes(trx, resolvedIds);
  const changing = records.filter((record, index) => {
    const head = heads.get(resolvedIds[index] ?? '');
    return head?.equals(record.contentSha256) !== true;
  });

  const rawIds = await upsertRawRecords(
    trx,
    changing.map((record) => ({
      sourceId: adapter.descriptor.sourceId,
      payloadSha256: record.rawPayloadSha256,
      payload: record.rawPayload,
      firstSeenAt: ingestedAt,
    })),
  );

  for (const [index, record] of records.entries()) {
    const sourceRecordId = resolvedIds[index];
    if (sourceRecordId === undefined) {
      throw new Error(`no resolved identity for ${record.primaryKey}; this is a pipeline bug`);
    }

    const input: InsertVersionInput = {
      sourceRecordId,
      hazardType: record.hazardType,
      ingestionRunId: runId,
      ingestedAt,
      observedAt: record.observedAt,
      sourceUpdatedAt: record.sourceUpdatedAt,
      lifecycleStatus: record.lifecycleStatus,
      severityScheme: record.severityScheme,
      severityValue: record.severityValue,
      providerStatus: record.providerStatus,
      contributor: record.contributor,
      magnitude: record.magnitude,
      magnitudeType: record.magnitudeType,
      depthKm: record.depthKm,
      centroid: record.centroid,
      geometryKind: record.geometryKind,
      attributes: record.attributes,
      title: record.title,
      sourceUrl: record.sourceUrl,
      contentSha256: record.contentSha256,
      rawRecordId: rawIds.get(record.rawPayloadSha256.toString('hex')) ?? null,
    };

    try {
      const result = await insertVersionIfChanged(trx, input);
      if (result.inserted) newVersions += 1;
      else unchanged += 1;
    } catch (error) {
      // A record the time-semantics invariants refuse (a future observation, an inverted
      // validity interval) is a reject with a reason code — never a dropped record, and never a
      // reason to lose the rest of a good batch.
      if (!(error instanceof VersionRejectedError)) throw error;
      rejected += 1;
      await recordReject(trx, runId, error.reasonCode, {
        id: record.primaryKey,
        issues: [sanitizeDetail(error.message)],
      });
      continue;
    }

    if (newestObservedAt === null || record.observedAt.getTime() > newestObservedAt.getTime()) {
      newestObservedAt = record.observedAt;
    }
  }

  const accepted = records.length;
  const counts: RunCounts = {
    received: receivedCount,
    accepted,
    rejected,
    newRecords,
    newVersions,
    unchanged,
    mergedRecords,
  };

  // Last statement of the transaction, with the stamp the versions already carry.
  const committedAt = await finishRun(trx, {
    runId,
    status: rejected > 0 ? 'PARTIAL' : 'SUCCEEDED',
    httpStatus: fetched.httpStatus,
    bytesReceived: fetched.bytes,
    payloadSha256: fetched.payloadSha256,
    counts: {
      received: receivedCount,
      newRecords,
      newVersions,
      unchanged,
      rejected,
    },
    newestObservedAt,
    committedAt: ingestedAt,
  });

  return { counts, newestObservedAt, committedAt };
}

/** Runs one ingestion of one product, end to end. Never throws for an expected failure. */
export async function runIngestion<TRaw>(options: RunIngestionOptions<TRaw>): Promise<RunOutcome> {
  const { db, adapter, client, trigger } = options;
  const logger = options.logger ?? createJsonLogger();
  const monotonic = options.monotonic ?? (() => performance.now());
  const descriptor = adapter.descriptor;
  const startedAt = monotonic();

  let fetchMs = 0;
  let parseMs = 0;
  let normalizeMs = 0;
  let persistMs = 0;

  const base = { sourceId: descriptor.sourceId, productCode: descriptor.productCode, trigger };
  const finish = (
    status: RunOutcome['status'],
    runId: string | null,
    errorClass: ErrorClass | null,
    detail: string | null,
    counts: RunCounts,
    committedAt: Date | null,
  ): RunOutcome => {
    const totalMs = Math.round(monotonic() - startedAt);
    const outcome: RunOutcome = {
      status,
      runId,
      errorClass,
      detail,
      counts,
      stageMs: {
        fetchMs: Math.round(fetchMs),
        parseMs: Math.round(parseMs),
        normalizeMs: Math.round(normalizeMs),
        persistMs: Math.round(persistMs),
        totalMs,
      },
      committedAt,
    };
    logger.log(status === 'FAILED' ? 'error' : 'info', 'ingestion.run', {
      ...base,
      stage: 'run',
      status,
      ...(runId === null ? {} : { runId }),
      ...(errorClass === null ? {} : { errorClass }),
      ...(detail === null ? {} : { detail }),
      received: counts.received,
      accepted: counts.accepted,
      rejected: counts.rejected,
      newRecords: counts.newRecords,
      newVersions: counts.newVersions,
      unchanged: counts.unchanged,
      mergedRecords: counts.mergedRecords,
      ...outcome.stageMs,
    });
    return outcome;
  };

  const product = await findProductByCode(db, descriptor.sourceId, descriptor.productCode);
  if (product === null) {
    // The adapter names a product the database has never heard of. That is a deployment error,
    // and guessing a product id would attach facts to the wrong feed.
    return finish(
      'FAILED',
      null,
      'CONFIG_ERROR',
      `no source_product ${descriptor.productCode} for source ${descriptor.sourceId}`,
      EMPTY_COUNTS,
      null,
    );
  }

  // ── 1. Lease ────────────────────────────────────────────────────────────
  const lease = await acquireRunLease(db, {
    sourceId: descriptor.sourceId,
    productId: product.id,
    trigger,
    workerVersion: options.workerVersion ?? null,
  });
  if (!lease.acquired) {
    // A scheduler that is a little early is normal, not an error, and must not write a run row.
    logger.log('info', 'ingestion.lease_held', {
      ...base,
      stage: 'lease',
      status: 'LEASE_HELD',
      ...(lease.heldByRunId === null ? {} : { runId: lease.heldByRunId }),
    });
    return finish('LEASE_HELD', null, null, 'another run holds this product', EMPTY_COUNTS, null);
  }
  const runId = lease.runId;
  if (lease.expiredRunId !== null) {
    logger.log('warn', 'ingestion.lease_expired', {
      ...base,
      stage: 'lease',
      runId: lease.expiredRunId,
      errorClass: 'LEASE_EXPIRED',
      detail: 'the previous run did not finish and its lease was expired',
    });
  }

  const failRun = async (
    errorClass: ErrorClass,
    detail: string,
    httpStatus?: number,
    bytes?: number,
  ): Promise<RunOutcome> => {
    const sanitized = sanitizeDetail(detail);
    await finishRun(db, {
      runId,
      status: 'FAILED',
      errorClass,
      errorMessage: sanitized,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(bytes === undefined ? {} : { bytesReceived: bytes }),
    });
    return finish('FAILED', runId, errorClass, sanitized, EMPTY_COUNTS, null);
  };

  try {
    // ── 2. Fetch ──────────────────────────────────────────────────────────
    const previousDigest = await lastPayloadDigest(db, descriptor.sourceId, product.id);
    const fetchStarted = monotonic();
    let fetched: FetchResult;
    try {
      fetched = await adapter.fetch({
        client,
        lastPayloadSha256: previousDigest,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.feed === undefined ? {} : { feed: options.feed }),
      });
    } catch (error) {
      fetchMs = monotonic() - fetchStarted;
      if (!(error instanceof SourceFetchError)) throw error;
      logger.log('error', 'ingestion.fetch_failed', {
        ...base,
        stage: 'fetch',
        runId,
        errorClass: classifyFetchFailure(error),
        detail: error.describe(),
        endpoint: error.context.host,
        ...(error.context.status === undefined ? {} : { httpStatus: error.context.status }),
        ...(error.context.attempt === undefined ? {} : { attempts: error.context.attempt }),
      });
      return await failRun(classifyFetchFailure(error), error.describe(), error.context.status);
    }
    fetchMs = monotonic() - fetchStarted;

    logger.log('info', 'ingestion.fetched', {
      ...base,
      stage: 'fetch',
      runId,
      endpoint: fetched.endpoint,
      httpStatus: fetched.httpStatus,
      attempts: fetched.attempts,
      bytes: fetched.bytes,
      conditional: fetched.kind === 'UNCHANGED',
      fetchMs: Math.round(fetchMs),
    });

    if (fetched.kind === 'UNCHANGED') {
      // Still health evidence: the source answered. SKIPPED, not FAILED and not invisible.
      const committedAt = await finishRun(db, {
        runId,
        status: 'SKIPPED',
        httpStatus: fetched.httpStatus,
        bytesReceived: fetched.bytes,
        payloadSha256: fetched.payloadSha256,
      });
      return finish(
        'SKIPPED',
        runId,
        null,
        'the feed is byte-identical to the last run',
        EMPTY_COUNTS,
        committedAt,
      );
    }

    // ── 3. Parse ──────────────────────────────────────────────────────────
    const parseStarted = monotonic();
    const parsed = adapter.parse(fetched.body, { descriptor });
    parseMs = monotonic() - parseStarted;

    if (parsed.verdict === 'REJECTED') {
      // Nothing is written — not even the records that parsed. A half-ingested batch is
      // indistinguishable from a quiet period, and that is the lie this rule exists to prevent.
      logger.log('error', 'ingestion.batch_rejected', {
        ...base,
        stage: 'parse',
        runId,
        errorClass: parsed.errorClass,
        detail: parsed.detail,
        rejected: parsed.rejects.length,
        parseMs: Math.round(parseMs),
      });
      return await failRun(parsed.errorClass, parsed.detail, fetched.httpStatus, fetched.bytes);
    }

    const received = parsed.records.length + parsed.rejects.length;
    if (parsed.declaredCount !== null && parsed.declaredCount !== received) {
      // Reported, not acted on — see the adapter. Visible so nobody has to guess later.
      logger.log('warn', 'ingestion.count_mismatch', {
        ...base,
        stage: 'parse',
        runId,
        received,
        declaredCount: parsed.declaredCount,
        detail: 'the provider declared a different number of records than it sent',
      });
    }

    // ── 4. Normalize ──────────────────────────────────────────────────────
    const normalizeStarted = monotonic();
    let normalized: NormalizedRecord[];
    try {
      normalized = parsed.records.map((raw) => adapter.normalize(raw, { descriptor }));
    } catch (error) {
      normalizeMs = monotonic() - normalizeStarted;
      if (!(error instanceof NormalizationError)) throw error;
      // An identity-model violation. Continuing would create a duplicate record that later reads
      // as a second independent source agreeing with the first.
      logger.log('error', 'ingestion.invariant_violated', {
        ...base,
        stage: 'normalize',
        runId,
        errorClass: 'SCHEMA_DRIFT',
        detail: error.message,
      });
      return await failRun('SCHEMA_DRIFT', error.message, fetched.httpStatus, fetched.bytes);
    }
    normalizeMs = monotonic() - normalizeStarted;

    // ── 5. Persist ────────────────────────────────────────────────────────
    const persistStarted = monotonic();
    let result: PersistResult;
    try {
      result = await db
        .transaction()
        .execute((trx) =>
          persistBatch(
            trx,
            runId,
            adapter as SourceAdapter<unknown>,
            normalized,
            parsed.rejects,
            fetched,
            received,
          ),
        );
    } catch (error) {
      persistMs = monotonic() - persistStarted;
      // The transaction rolled back, so no facts and no finished run. The run row is still
      // RUNNING and this closes it, outside the failed transaction, so the next poll is not
      // blocked by a lease nobody holds.
      const detail = error instanceof Error ? error.message : 'persist failed';
      logger.log('error', 'ingestion.persist_failed', {
        ...base,
        stage: 'persist',
        runId,
        errorClass: 'DB_ERROR',
        detail,
        persistMs: Math.round(persistMs),
      });
      return await failRun('DB_ERROR', detail, fetched.httpStatus, fetched.bytes);
    }
    persistMs = monotonic() - persistStarted;

    logger.log('info', 'ingestion.persisted', {
      ...base,
      stage: 'persist',
      runId,
      ...(result.newestObservedAt === null
        ? {}
        : { newestObservedAt: result.newestObservedAt.toISOString() }),
      persistMs: Math.round(persistMs),
    });

    // ── 6. Post-commit ────────────────────────────────────────────────────
    // Correlation and projections attach here (P5). They must never roll back facts.

    return finish(
      result.counts.rejected > 0 ? 'PARTIAL' : 'SUCCEEDED',
      runId,
      null,
      null,
      result.counts,
      result.committedAt,
    );
  } catch (error) {
    // Anything not already classified. The run must still close, or the product stays leased.
    const detail = error instanceof Error ? error.message : 'unexpected failure';
    logger.log('error', 'ingestion.unexpected', {
      ...base,
      stage: 'run',
      runId,
      errorClass: 'UNKNOWN',
      detail,
    });
    try {
      return await failRun('UNKNOWN', detail);
    } catch {
      // The run row could not even be closed: the lease expiry path will reclaim it.
      return finish('FAILED', runId, 'UNKNOWN', sanitizeDetail(detail), EMPTY_COUNTS, null);
    }
  }
}
