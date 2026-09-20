/**
 * The USGS deletion reconcile (DATA_SOURCES §1.4).
 *
 * Summary feeds silently drop deleted events, so absence from a later feed means nothing and must
 * never be read as a deletion. The only place a deletion is *stated* is FDSN
 * `includedeleted=only`, and this is the sweep that reads it.
 *
 * Two things make it unlike an ordinary batch, both discovered by reading the real capture rather
 * than the documentation:
 *
 *  1. **Most deletions have no identity.** 55 of 98 entries in the P0 capture have an empty `id`
 *     and null `ids`, `net` and `code` — USGS purges an event's metadata when it deletes it. Those
 *     are counted and reported as `MISSING_IDENTITY` rejects. They are never skipped quietly, and
 *     never guessed at: there is genuinely no way to know which record they were.
 *  2. **A deletion for an event we never ingested is not an error.** It resolves to no record and
 *     is counted. Creating one would conjure a record whose only version says it was deleted —
 *     a fact GeoNerva invented.
 */

import type { Kysely } from 'kysely';

import {
  acquireRunLease,
  batchTimestamp,
  findProductByCode,
  findRecordByAliases,
  finishRun,
  insertTombstone,
  recordReject,
  type DB,
} from '@geonerva/db';
import { SourceFetchError, type HttpClient } from '@geonerva/http';
import {
  FdsnQueryError,
  fdsnFetch,
  parseDeletionSweep,
  type SourceAdapter,
} from '@geonerva/sources';

import { createJsonLogger, sanitizeDetail, type Logger } from './logging.ts';
import { classifyFetchFailure, describeDatabaseFailure } from './run.ts';

export interface DeletionSweepOptions<TRaw> {
  readonly db: Kysely<DB>;
  readonly adapter: SourceAdapter<TRaw>;
  readonly client: HttpClient;
  /** The window to sweep. Deletions are published with the event's original time. */
  readonly from: Date;
  readonly to: Date;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

export interface DeletionSweepOutcome {
  readonly status: 'SUCCEEDED' | 'FAILED' | 'LEASE_HELD';
  readonly runId: string | null;
  readonly errorClass: string | null;
  /** Deletions we could identify and had already ingested. */
  readonly tombstoned: number;
  /** Identified, but for an event GeoNerva never held. Not an error. */
  readonly unknownToUs: number;
  /**
   * Identified, but the alias set matched more than one surviving record.
   *
   * Recorded as a reject rather than resolved by picking one: tombstoning an arbitrary record
   * would leave the other `ACTIVE` forever, and row order is not stable, so a second sweep could
   * pick the other one and the operation would not even be idempotent.
   */
  readonly ambiguous: number;
  /** Stripped of all identity by the provider. Counted, never guessed at. */
  readonly unidentifiable: number;
  /** Already tombstoned by an earlier sweep, so re-running writes nothing. */
  readonly alreadyTombstoned: number;
  readonly detail: string | null;
}

/**
 * Runs one deletion sweep.
 *
 * Idempotent: `insertTombstone` derives its hash from the status *and* the previous content, so a
 * second sweep over the same window finds the head already tombstoned and writes nothing.
 */
export async function runDeletionSweep<TRaw>(
  options: DeletionSweepOptions<TRaw>,
): Promise<DeletionSweepOutcome> {
  const { db, adapter, client } = options;
  const logger = options.logger ?? createJsonLogger();
  const descriptor = adapter.descriptor;
  const base = { sourceId: descriptor.sourceId, productCode: descriptor.productCode };

  const product = await findProductByCode(db, descriptor.sourceId, descriptor.productCode);
  if (product === null) {
    return {
      status: 'FAILED',
      runId: null,
      errorClass: 'CONFIG_ERROR',
      tombstoned: 0,
      unknownToUs: 0,
      ambiguous: 0,
      unidentifiable: 0,
      alreadyTombstoned: 0,
      detail: `no source_product ${descriptor.productCode} for ${descriptor.sourceId}`,
    };
  }

  const lease = await acquireRunLease(db, {
    sourceId: descriptor.sourceId,
    productId: product.id,
    trigger: 'RECONCILE',
  });
  if (!lease.acquired) {
    logger.log('info', 'deletion_sweep.lease_held', { ...base, stage: 'lease' });
    return {
      status: 'LEASE_HELD',
      runId: null,
      errorClass: null,
      tombstoned: 0,
      unknownToUs: 0,
      ambiguous: 0,
      unidentifiable: 0,
      alreadyTombstoned: 0,
      detail: 'another run holds this product',
    };
  }
  const runId = lease.runId;

  const fail = async (errorClass: string, detail: string): Promise<DeletionSweepOutcome> => {
    const sanitized = sanitizeDetail(detail);
    await finishRun(db, {
      runId,
      status: 'FAILED',
      errorClass: errorClass as never,
      errorMessage: sanitized,
    });
    logger.log('error', 'deletion_sweep.failed', { ...base, runId, detail: sanitized });
    return {
      status: 'FAILED',
      runId,
      errorClass,
      tombstoned: 0,
      unknownToUs: 0,
      ambiguous: 0,
      unidentifiable: 0,
      alreadyTombstoned: 0,
      detail: sanitized,
    };
  };

  let body: Uint8Array;
  let httpStatus: number;
  try {
    const fetched = await fdsnFetch({ from: options.from, to: options.to }, 'deleted-only', {
      client,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    body = fetched.body;
    httpStatus = fetched.httpStatus;
  } catch (error) {
    if (!(error instanceof SourceFetchError)) throw error;
    return await fail(classifyFetchFailure(error), error.describe());
  }

  let sweep;
  try {
    sweep = parseDeletionSweep(body);
  } catch (error) {
    if (!(error instanceof FdsnQueryError)) throw error;
    // Includes the "nothing in this sweep is identifiable" case, which means we are blind to
    // deletions entirely and is worth failing over.
    return await fail('SCHEMA_DRIFT', error.message);
  }

  let tombstoned = 0;
  let unknownToUs = 0;
  let alreadyTombstoned = 0;
  let ambiguous = 0;

  let committedAt: Date;
  try {
    committedAt = await db.transaction().execute(async (trx) => {
      // Counters are reset inside the transaction: on a retry after a rollback they must not
      // carry numbers from work that no longer exists.
      tombstoned = 0;
      unknownToUs = 0;
      alreadyTombstoned = 0;
      ambiguous = 0;
      const ingestedAt = await batchTimestamp(trx);

      for (const deletion of sweep.deletions) {
        const found = await findRecordByAliases(trx, descriptor.sourceId, deletion.aliases);

        if (found.kind === 'NONE') {
          /*
           * A deletion for an event we never ingested. Creating a record here would invent a
           * fact, so it is counted *and* recorded: a run whose counts did not add up would leave
           * an operator unable to tell "43 accounted for elsewhere" from "43 silently dropped".
           */
          unknownToUs += 1;
          await recordReject(trx, runId, 'MISSING_IDENTITY', {
            id: deletion.primaryKey,
            reason: 'a deletion for an event GeoNerva has never ingested',
          });
          continue;
        }

        if (found.kind === 'AMBIGUOUS') {
          ambiguous += 1;
          await recordReject(trx, runId, 'MISSING_IDENTITY', {
            id: deletion.primaryKey,
            reason: `the alias set matches ${found.sourceRecordIds.length} records; refusing to guess which was deleted`,
          });
          continue;
        }

        const result = await insertTombstone(trx, {
          sourceRecordId: found.sourceRecordId,
          status: 'DELETED',
          ingestedAt,
          ingestionRunId: runId,
        });
        if (result.inserted) tombstoned += 1;
        else alreadyTombstoned += 1;
      }

      // Every stripped entry leaves a row. `MISSING_IDENTITY` exists for exactly this.
      for (let index = 0; index < sweep.unidentifiable; index += 1) {
        await recordReject(trx, runId, 'MISSING_IDENTITY', {
          reason: 'the provider published a deletion with no identifiers',
        });
      }

      return finishRun(trx, {
        runId,
        status: 'SUCCEEDED',
        httpStatus,
        bytesReceived: body.byteLength,
        counts: {
          received: sweep.deletions.length + sweep.unidentifiable,
          newVersions: tombstoned,
          unchanged: alreadyTombstoned,
          // Everything received that did not become a tombstone leaves a reject row, so the
          // counts on the run row reconcile: received = tombstoned + already + rejected.
          rejected: sweep.unidentifiable + unknownToUs + ambiguous,
        },
        committedAt: ingestedAt,
      });
    });
  } catch (error) {
    /*
     * The run must still close.
     *
     * Without this the row stays `RUNNING` and the product is leased until the stale-lease
     * threshold expires — half an hour during which every five-minute live poll returns
     * `LEASE_HELD` and writes no run row at all, so six polls leave no health evidence.
     * `runIngestion` was written specifically to close this hole; the sweep did not inherit it.
     */
    return await fail('DB_ERROR', describeDatabaseFailure(error));
  }

  logger.log('info', 'deletion_sweep.finished', {
    ...base,
    runId,
    status: 'SUCCEEDED',
    received: sweep.deletions.length + sweep.unidentifiable,
    newVersions: tombstoned,
    unchanged: alreadyTombstoned,
    rejected: sweep.unidentifiable,
    detail:
      `${tombstoned} tombstoned, ${alreadyTombstoned} already, ${unknownToUs} for events we ` +
      `never held, ${ambiguous} ambiguous, ${sweep.unidentifiable} stripped of identity`,
  });

  return {
    status: 'SUCCEEDED',
    runId,
    errorClass: null,
    tombstoned,
    unknownToUs,
    ambiguous,
    unidentifiable: sweep.unidentifiable,
    alreadyTombstoned,
    detail: committedAt.toISOString(),
  };
}
