/**
 * The FIRMS ingestion path — the same lifecycle, a different destination.
 *
 * Every other source ends in `observation_versions`: a record with an identity, a content hash
 * and a history of revisions. Thermal detections have none of those. FIRMS publishes no
 * identifier, never revises a detection, and produces ≈ 230,000 rows a day across the two sensors
 * GeoNerva ingests. Their identity is derived —
 * `(product, acquired_at, round(lat, 4), round(lon, 4))`, ADR-011 — their storage is a
 * daily-partitioned table, and their retention is "drop the partition" (ADR-018).
 *
 * So this function reuses the parts that make ingestion *honest* and replaces the part that
 * would be wrong:
 *
 *  - kept: the product lookup, the disabled/retired check, the run lease, the run row, the batch
 *    verdict, the reject rows, the error taxonomy, the redacted logging, the health evidence;
 *  - replaced: the persist step, which bulk-inserts into `fire_detections` with
 *    `ON CONFLICT DO NOTHING` so that an overlapping `DAY_RANGE=2` poll is a no-op (invariant
 *    I8), after creating the daily partitions the batch touches;
 *  - absent: content hashing, alias resolution, version sequencing, tombstones. None of them has
 *    a meaning here, and pretending otherwise would put 230,000 synthetic identities a day into
 *    the table the whole read path depends on.
 *
 * The run row is where the two paths meet: `/data-status` reads the same columns for FIRMS as for
 * USGS, so a stalled sensor is visible in the same place and in the same terms as a stalled feed.
 */

import type { Kysely } from 'kysely';

import {
  PartialDetectionInsertError,
  bulkInsertDetections,
  finishRun,
  findProductByCode,
  acquireRunLease,
  recordReject,
  type DB,
  type FireDetectionInput,
} from '@geonerva/db';
import type { ErrorClass, RunTrigger } from '@geonerva/domain';
import { SourceFetchError, type HttpClient } from '@geonerva/http';
import {
  MAX_PARTITION_DAYS,
  fetchFirms,
  firmsDescriptor,
  parseFirms,
  redactFirmsUrl,
  type FirmsSensor,
} from '@geonerva/sources';

import { createJsonLogger, sanitizeDetail, type Logger } from './logging.ts';

export interface RunFireIngestionOptions {
  readonly db: Kysely<DB>;
  readonly client: HttpClient;
  readonly sensor: FirmsSensor;
  /** Absent means keyless mode: the public 24-hour file, no credential and no backfill. */
  readonly mapKey?: string | undefined;
  readonly trigger?: RunTrigger;
  readonly dayRange?: number;
  /** `YYYY-MM-DD`, with a key only. */
  readonly date?: string;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly workerVersion?: string | null;
}

export interface FireIngestionOutcome {
  readonly status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED' | 'LEASE_HELD';
  readonly runId: string | null;
  readonly errorClass: ErrorClass | null;
  readonly detail: string | null;
  readonly counts: {
    readonly received: number;
    readonly inserted: number;
    /** Rows already present — the overlap between consecutive polls, and proof of idempotency. */
    readonly duplicates: number;
    readonly rejected: number;
  };
  readonly partitionsTouched: readonly string[];
  readonly newestAcquiredAt: Date | null;
  /** True when no credential was used, so a reader knows which mode produced these numbers. */
  readonly keyless: boolean;
}

const EMPTY = { received: 0, inserted: 0, duplicates: 0, rejected: 0 } as const;

/**
 * How many reject rows one batch may write.
 *
 * A drifted 128,000-row CSV could otherwise try to write 128,000 reject rows inside the
 * transaction whose entire purpose is to record that something went wrong. The parser already
 * bounds what it returns; this is the second bound, at the place that actually writes.
 */
const MAX_REJECT_ROWS = 100;

/**
 * How far ahead of the ingest clock an acquisition may be.
 *
 * A satellite clock a few minutes fast is ordinary; a detection dated next week is not an
 * observation. Five minutes matches invariant I13, which `observation_versions` enforces in the
 * database — `fire_detections` has no equivalent CHECK, so the rule is applied here instead of
 * being absent for the one high-volume table.
 */
const FUTURE_HORIZON_MS = 5 * 60 * 1_000;

export async function runFireIngestion(
  options: RunFireIngestionOptions,
): Promise<FireIngestionOutcome> {
  const { db, sensor } = options;
  const descriptor = firmsDescriptor(sensor);
  const logger = options.logger ?? createJsonLogger();
  const trigger: RunTrigger = options.trigger ?? 'SCHEDULE';
  const keyless = options.mapKey === undefined || options.mapKey.length === 0;
  const base = { sourceId: descriptor.sourceId, productCode: descriptor.productCode, trigger };

  const finish = (
    status: FireIngestionOutcome['status'],
    runId: string | null,
    errorClass: ErrorClass | null,
    detail: string | null,
    counts: FireIngestionOutcome['counts'] = EMPTY,
    partitionsTouched: readonly string[] = [],
    newestAcquiredAt: Date | null = null,
  ): FireIngestionOutcome => ({
    status,
    runId,
    errorClass,
    detail,
    counts,
    partitionsTouched,
    newestAcquiredAt,
    keyless,
  });

  const product = await findProductByCode(db, descriptor.sourceId, descriptor.productCode);
  if (product === null) {
    return finish(
      'FAILED',
      null,
      'CONFIG_ERROR',
      `no source_product ${descriptor.productCode} for source ${descriptor.sourceId}`,
    );
  }
  if (!product.enabled || product.status === 'RETIRED') {
    const reason = product.enabled
      ? `${descriptor.productCode} is retired`
      : `${descriptor.productCode} is disabled`;
    logger.log('info', 'ingestion.product_disabled', {
      ...base,
      stage: 'lease',
      status: 'SKIPPED',
      detail: reason,
    });
    return finish('SKIPPED', null, null, reason);
  }

  const lease = await acquireRunLease(db, {
    sourceId: descriptor.sourceId,
    productId: product.id,
    trigger,
    workerVersion: options.workerVersion ?? null,
  });
  if (!lease.acquired) {
    logger.log('info', 'ingestion.lease_held', {
      ...base,
      stage: 'lease',
      status: 'LEASE_HELD',
      ...(lease.heldByRunId === null ? {} : { runId: lease.heldByRunId }),
    });
    return finish('LEASE_HELD', null, null, 'another run holds this product');
  }
  const runId = lease.runId;

  const failRun = async (
    errorClass: ErrorClass,
    detail: string,
    httpStatus?: number,
    bytes?: number,
    seen?: { readonly received: number; readonly rejected: number },
  ): Promise<FireIngestionOutcome> => {
    // Every path into a stored message goes through both: the ordinary sanitizer, and the FIRMS
    // one that removes anything shaped like a MAP_KEY wherever it appears.
    const sanitized = sanitizeDetail(redactFirmsUrl(detail, options.mapKey));
    /*
     * The failure path must not have a failure path.
     *
     * `finishRun` refuses a run that is no longer `RUNNING` — which happens when the lease was
     * expired underneath a slow poll — and it throws to say so. Called from inside a `catch`,
     * that turned a recorded failure into an unhandled rejection with a stack trace and no run
     * row at all. `run.ts` wraps its equivalent call for exactly this reason; this one did not.
     */
    try {
      await finishRun(db, {
        runId,
        status: 'FAILED',
        errorClass,
        errorMessage: sanitized,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(bytes === undefined ? {} : { bytesReceived: bytes }),
        ...(seen === undefined
          ? {}
          : { counts: { received: seen.received, rejected: seen.rejected } }),
      });
    } catch {
      logger.log('error', 'ingestion.finish_failed', {
        ...base,
        runId,
        errorClass: 'LEASE_EXPIRED',
        detail: 'the run could not be finished; its lease was taken over',
      });
    }
    return finish('FAILED', runId, errorClass, sanitized, {
      ...EMPTY,
      ...(seen === undefined ? {} : { received: seen.received, rejected: seen.rejected }),
    });
  };

  try {
    const fetched = await fetchFirms({
      client: options.client,
      sensor,
      ...(options.mapKey === undefined ? {} : { mapKey: options.mapKey }),
      ...(options.dayRange === undefined ? {} : { dayRange: options.dayRange }),
      ...(options.date === undefined ? {} : { date: options.date }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    logger.log('info', 'ingestion.fetched', {
      ...base,
      stage: 'fetch',
      runId,
      // Already redacted by the adapter; it is a placeholder path, never the real one.
      endpoint: fetched.endpoint,
      httpStatus: fetched.httpStatus,
      attempts: fetched.attempts,
      bytes: fetched.bytes,
    });

    const parsed = parseFirms(fetched.body, sensor);
    if (parsed.verdict === 'REJECTED') {
      logger.log('error', 'ingestion.batch_rejected', {
        ...base,
        stage: 'parse',
        runId,
        errorClass: parsed.errorClass,
        detail: parsed.detail,
        rejected: parsed.rejects.length,
      });
      for (const item of parsed.rejects.slice(0, MAX_REJECT_ROWS)) {
        await recordReject(db, runId, item.reasonCode, item.excerpt);
      }
      /*
       * `receivedTotal`, not `rejects.length`.
       *
       * The reject array is a bounded *sample*; reporting its length as `n_received` told
       * `/data-status` that a drifted 128,000-row file had delivered 100 rows, which is the
       * precise confusion `failRun` exists to prevent — a drift event and an empty feed must not
       * look alike.
       */
      return await failRun(parsed.errorClass, parsed.detail, fetched.httpStatus, fetched.bytes, {
        received: parsed.receivedTotal,
        rejected: parsed.rejectedTotal,
      });
    }

    const received = parsed.detections.length + parsed.rejectedTotal;
    const ingestedAt = new Date();

    /*
     * Two guards that have to run before a single row is inserted, because the insert creates
     * partitions first and a `CREATE TABLE` is not rolled back by the failure that follows it.
     *
     * **Forward-dated acquisitions.** The parser bounds `acq_date` to [2012, 2100) as a pure
     * property of the value; only here is there a clock, so only here can "the future" be
     * checked. `fire_detections` has no `observed_at <= ingested_at` CHECK of its own, but a
     * detection dated next week is not an observation, and it would create a partition that
     * retention never reclaims — it only drops days *older* than the cutoff.
     *
     * **Partition count.** A legitimate file spans two days; a keyed `DAY_RANGE=5` request spans
     * six. A file with scattered dates would issue one `CREATE TABLE ... PARTITION OF` plus an
     * `ALTER TABLE` per distinct day, permanently, on every poll.
     */
    const horizon = new Date(ingestedAt.getTime() + FUTURE_HORIZON_MS);
    const futureDetections = parsed.detections.filter(
      (detection) => detection.acquiredAt > horizon,
    ).length;
    const usable = parsed.detections.filter((detection) => detection.acquiredAt <= horizon);
    const days = new Set(
      usable.map((detection) => detection.acquiredAt.toISOString().slice(0, 10)),
    );
    if (days.size > MAX_PARTITION_DAYS) {
      return await failRun(
        'SCHEMA_DRIFT',
        `the batch spans ${days.size} distinct acquisition days, above the ` +
          `${MAX_PARTITION_DAYS} one file should ever touch`,
        fetched.httpStatus,
        fetched.bytes,
        { received, rejected: parsed.rejectedTotal },
      );
    }
    for (const detection of parsed.detections) {
      if (detection.acquiredAt > horizon) {
        await recordReject(db, runId, 'FUTURE_OBSERVATION', {
          acquiredAt: detection.acquiredAt.toISOString(),
        });
        if (futureDetections >= MAX_REJECT_ROWS) break;
      }
    }
    const rows: FireDetectionInput[] = usable.map((detection) => ({
      productId: product.id,
      acquiredAt: detection.acquiredAt,
      lat: detection.lat,
      lon: detection.lon,
      confidenceClass: detection.confidenceClass,
      confidenceRaw: detection.confidenceRaw,
      frp: detection.frp,
      brightTi4: detection.brightTi4,
      brightTi5: detection.brightTi5,
      scan: detection.scan,
      track: detection.track,
      daynight: detection.daynight,
      providerVersion: detection.providerVersion,
      ingestionRunId: runId,
      ingestedAt,
    }));

    /*
     * Not one transaction.
     *
     * Every other persist path here is all-or-nothing, because a half-written *batch of facts*
     * is indistinguishable from a quiet period. Detections are different: they have no identity
     * to be half-resolved and no versions to be half-sequenced, and 128,000 rows in one
     * transaction would hold a lock long enough to park every other writer. `ON CONFLICT DO
     * NOTHING` makes a retry of a partially-inserted batch exact rather than merely safe, so the
     * chunked insert loses nothing the transaction was protecting.
     */
    const result = await bulkInsertDetections(db, rows);

    for (const item of parsed.rejects.slice(0, MAX_REJECT_ROWS)) {
      await recordReject(db, runId, item.reasonCode, item.excerpt);
    }

    let newestAcquiredAt: Date | null = null;
    for (const detection of usable) {
      if (newestAcquiredAt === null || detection.acquiredAt > newestAcquiredAt) {
        newestAcquiredAt = detection.acquiredAt;
      }
    }

    /*
     * `PARTIAL` when anything was rejected, exactly as the ordinary path decides it: the batch
     * was usable and some of it was not, and a reader must be able to tell that from a clean run
     * without opening the reject table.
     */
    const rejectedTotal = parsed.rejectedTotal + futureDetections;
    const status = rejectedTotal > 0 ? 'PARTIAL' : 'SUCCEEDED';
    await finishRun(db, {
      runId,
      status,
      httpStatus: fetched.httpStatus,
      bytesReceived: fetched.bytes,
      payloadSha256: fetched.payloadSha256,
      newestObservedAt: newestAcquiredAt,
      counts: {
        received,
        /*
         * `newRecords` is the count of detections actually stored, and `unchanged` is the
         * overlap. The columns are named for the version path and mean the same things here: how
         * much of this batch was new, and how much we had already.
         */
        newRecords: result.inserted,
        unchanged: result.duplicates,
        rejected: rejectedTotal,
      },
    });

    logger.log('info', 'ingestion.run', {
      ...base,
      stage: 'run',
      runId,
      status,
      received,
      accepted: usable.length,
      rejected: rejectedTotal,
      newRecords: result.inserted,
      unchanged: result.duplicates,
      // Surfaced, not swallowed: a rate that moves from one in a hundred thousand to one in ten
      // is a provider change, and the only way anyone learns that is by seeing the number.
      ...(parsed.frpDropped === 0 ? {} : { detail: `${parsed.frpDropped} negative frp dropped` }),
      ...(newestAcquiredAt === null ? {} : { newestObservedAt: newestAcquiredAt.toISOString() }),
    });

    return finish(
      status,
      runId,
      null,
      null,
      {
        received,
        inserted: result.inserted,
        duplicates: result.duplicates,
        rejected: rejectedTotal,
      },
      result.partitionsCreated,
      newestAcquiredAt,
    );
  } catch (error) {
    if (error instanceof SourceFetchError) {
      logger.log('error', 'ingestion.fetch_failed', {
        ...base,
        stage: 'fetch',
        runId,
        errorClass: error.errorClass,
        detail: redactFirmsUrl(error.describe(), options.mapKey),
        endpoint: error.context.host,
        ...(error.context.status === undefined ? {} : { httpStatus: error.context.status }),
      });
      /*
       * `describe()` for a provider failure, our own sentence for a configuration one.
       *
       * `SourceFetchError.describe()` is deliberately host-and-status only, which is right when
       * the words might be the provider's. A `CONFIG_ERROR` on this path is never the provider's:
       * every one is constructed here or in the FIRMS adapter, with a fixed sentence and nothing
       * interpolated from a response. Storing "CONFIG_ERROR firms.modaps.eosdis.nasa.gov
       * status=400" leaves an operator to guess which of several things it meant; storing "FIRMS
       * refused the credential; the MAP_KEY is invalid or its transaction budget is spent" tells
       * them what to do, and carries nothing secret.
       *
       * It still goes through `redactFirmsUrl` and `sanitizeDetail` in `failRun`, because a rule
       * that depends on every future caller being careful is not a rule.
       */
      return await failRun(
        error.errorClass,
        error.errorClass === 'CONFIG_ERROR' ? error.message : error.describe(),
        error.context.status,
      );
    }
    /*
     * Never the driver's words — but never a dead end either.
     *
     * A `pg` error message can carry a connection string, and this is the path that writes to
     * `ingestion_runs.error_message` (SECURITY.md M7), so the message itself is dropped. What is
     * kept is the part that is structural rather than textual: the SQLSTATE and the constraint
     * name. Those name the rule that was broken and contain nothing about the connection.
     *
     * This exists because the first version logged "the batch could not be stored" and nothing
     * else, and diagnosing a real failure — a NOAA-21 batch refused after 33,000 rows — meant
     * rebuilding the call by hand outside the worker. A redaction that makes an operator
     * reconstruct the failure themselves is not a safe default, it is an unusable one.
     */
    /*
     * A partial insert says how far it got.
     *
     * Without this the run row read `n_received = 0` on a batch that had already stored 33,000
     * rows under its own id — so any reconciliation between `fire_detections` and
     * `ingestion_runs` was wrong, and the partitions the batch created went unreported. The
     * retry is exact either way (`ON CONFLICT DO NOTHING`); this is about the *record* of what
     * happened being true.
     */
    const partial = error instanceof PartialDetectionInsertError ? error : null;
    const dbError = (partial?.cause ?? error) as {
      code?: unknown;
      constraint?: unknown;
      table?: unknown;
    };
    const sqlstate = typeof dbError.code === 'string' ? dbError.code : 'unknown';
    const constraint = typeof dbError.constraint === 'string' ? dbError.constraint : null;
    const table = typeof dbError.table === 'string' ? dbError.table : null;
    const where =
      `SQLSTATE ${sqlstate}` +
      (constraint === null ? '' : ` on ${constraint}`) +
      (table === null ? '' : ` (${table})`);
    const progress =
      partial === null ? '' : `; stored ${partial.inserted} of ${partial.received} rows first`;
    logger.log('error', 'ingestion.failed', {
      ...base,
      stage: 'persist',
      runId,
      errorClass: 'DB_ERROR',
      detail: `the batch could not be stored: ${where}${progress}`,
      ...(partial === null ? {} : { received: partial.received, newRecords: partial.inserted }),
    });
    return await failRun(
      'DB_ERROR',
      `the batch could not be stored: ${where}${progress}`,
      undefined,
      undefined,
      partial === null ? undefined : { received: partial.received, rejected: 0 },
    );
  }
}
