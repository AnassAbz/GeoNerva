/**
 * The ingestion-run lifecycle and its lease (DOMAIN_MODEL §4.4, §6.6, ARCHITECTURE §4.2).
 *
 * Two properties matter more than anything else here:
 *
 *  1. **At most one run per product at a time.** The lease is a partial unique index on
 *     `(source_id, coalesce(product_id, -1)) WHERE status = 'RUNNING'`, so it is the *database*
 *     that refuses an overlapping poll — not a flag, not a mutex in one process. Two workers, or
 *     one worker restarted mid-poll, cannot both write the same batch.
 *  2. **Every run commits, including failures.** A failed poll is the evidence that a source is
 *     unhealthy; dropping it would make the source look merely quiet. `committed_at` is taken
 *     with `clock_timestamp()` at the moment of finishing, and it is the `ingested_at` the batch
 *     stamps on its versions.
 *
 * A crashed worker leaves a `RUNNING` row behind. Rather than blocking the product forever, the
 * next run expires a lease older than `staleAfterMs` and records it as `LEASE_EXPIRED`, which is
 * both an unblocking action and a visible health signal.
 */

import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { ErrorClass, RunStatus, RunTrigger } from '@geonerva/domain';

import type { DB } from '../generated/database.ts';

/** Default: a lease older than three times the longest expected poll is considered abandoned. */
export const DEFAULT_LEASE_STALE_AFTER_MS = 3 * 10 * 60 * 1000;

export interface AcquireLeaseOptions {
  readonly sourceId: string;
  readonly productId?: number | null;
  readonly trigger: RunTrigger;
  readonly workerVersion?: string | null;
  readonly startedAt?: Date;
  readonly staleAfterMs?: number;
}

export type AcquireLeaseResult =
  | { readonly acquired: true; readonly runId: string; readonly expiredRunId: string | null }
  | {
      readonly acquired: false;
      /** `null` when the holder finished between our attempt and the read that looked for it. */
      readonly heldByRunId: string | null;
      readonly heldSince: Date | null;
    };

/**
 * Attempts the lease insert. Returns `null` when the lease is already held.
 *
 * `ON CONFLICT DO NOTHING` rather than catching the unique violation: inside a transaction a
 * raised error aborts it, so every later statement fails with 25P02 and the caller sees a
 * confusing failure instead of "the lease is taken" (S-17). Not raising keeps this callable from
 * a pool and from a transaction alike.
 */
async function tryInsertRunningRun(
  db: Kysely<DB>,
  options: AcquireLeaseOptions,
  startedAt: Date,
): Promise<string | null> {
  const runId = randomUUID();
  const result = await sql<{ id: string }>`
    INSERT INTO geonerva.ingestion_runs
      (id, source_id, product_id, trigger, started_at, status, worker_version)
    VALUES (${runId}::uuid, ${options.sourceId}, ${options.productId ?? null}, ${options.trigger},
            ${startedAt}, 'RUNNING', ${options.workerVersion ?? null})
    ON CONFLICT DO NOTHING
    RETURNING id::text AS id
  `.execute(db);
  return result.rows[0]?.id ?? null;
}

/**
 * Takes the lease for a product, expiring an abandoned one if necessary.
 *
 * Returns `{ acquired: false }` rather than throwing when another run genuinely holds the lease:
 * a scheduler that is a little early is a normal event, not an error.
 */
export async function acquireRunLease(
  db: Kysely<DB>,
  options: AcquireLeaseOptions,
): Promise<AcquireLeaseResult> {
  /*
   * The database's clock, not the worker's, like every other stamp on a run.
   *
   * `committed_at` and `finished_at` are the database's `clock_timestamp()`, and both are CHECKed
   * `>= started_at`. With `started_at` from the worker's clock, a run finishing within a few
   * milliseconds failed that CHECK whenever the database clock ran behind the worker's — measured
   * on the WSL development VM at up to 7 ms behind, in 12 % of two minutes' samples. `finishRun`
   * then threw, and the run was left RUNNING or recorded FAILED: the fire-ingest and EMSC
   * intermittents, open since P4 and P8.
   */
  const startedAt = options.startedAt ?? (await batchTimestamp(db));
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LEASE_STALE_AFTER_MS;

  const runId = await tryInsertRunningRun(db, options, startedAt);
  if (runId !== null) return { acquired: true, runId, expiredRunId: null };

  // Someone holds the lease. Expire it only if it is older than the stale threshold; the
  // UPDATE is itself the concurrency control, because only one transaction can win it.
  const cutoff = new Date(startedAt.getTime() - staleAfterMs);
  const expired = await sql<{ id: string }>`
    UPDATE geonerva.ingestion_runs
    SET status = 'FAILED',
        finished_at = ${startedAt},
        committed_at = clock_timestamp(),
        error_class = 'LEASE_EXPIRED',
        error_message = 'the previous run did not finish and its lease was expired'
    WHERE source_id = ${options.sourceId}
      AND COALESCE(product_id, -1) = COALESCE(${options.productId ?? null}::smallint, -1)
      AND status = 'RUNNING'
      AND started_at < ${cutoff}
    RETURNING id::text AS id
  `.execute(db);

  const expiredRunId = expired.rows[0]?.id ?? null;
  if (expiredRunId === null) {
    const holder = await sql<{ id: string; started_at: Date }>`
      SELECT id::text AS id, started_at
      FROM geonerva.ingestion_runs
      WHERE source_id = ${options.sourceId}
        AND COALESCE(product_id, -1) = COALESCE(${options.productId ?? null}::smallint, -1)
        AND status = 'RUNNING'
      LIMIT 1
    `.execute(db);
    const row = holder.rows[0];
    if (row === undefined) {
      // The holder finished between our insert and this read; try once more.
      const retried = await tryInsertRunningRun(db, options, startedAt);
      if (retried !== null) return { acquired: true, runId: retried, expiredRunId: null };
      return { acquired: false, heldByRunId: null, heldSince: null };
    }
    return { acquired: false, heldByRunId: row.id, heldSince: row.started_at };
  }

  // The stale lease is ours now; take it. If another worker expired the same lease and inserted
  // first, we simply report it as held rather than raising.
  const afterExpiry = await tryInsertRunningRun(db, options, startedAt);
  if (afterExpiry === null) return { acquired: false, heldByRunId: null, heldSince: null };
  return { acquired: true, runId: afterExpiry, expiredRunId };
}

/**
 * One reading of the database's wall clock, to stamp a whole batch with.
 *
 * It comes from the database, not the worker, so a worker whose clock has drifted cannot write
 * facts that appear to arrive before or after the run that carries them. `clock_timestamp()`
 * rather than `now()`, which inside a transaction is the transaction's start time (S-16).
 */
export async function batchTimestamp(db: Kysely<DB>): Promise<Date> {
  const result = await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(db);
  const at = result.rows[0]?.at;
  if (at === undefined) throw new Error('clock_timestamp() returned no row');
  return at;
}

export interface FinishRunInput {
  readonly runId: string;
  readonly status: Exclude<RunStatus, 'RUNNING'>;
  readonly httpStatus?: number | null;
  readonly bytesReceived?: number | null;
  readonly payloadSha256?: Buffer | null;
  readonly counts?: {
    readonly received?: number;
    readonly newRecords?: number;
    readonly newVersions?: number;
    readonly unchanged?: number;
    readonly rejected?: number;
  };
  readonly newestObservedAt?: Date | null;
  readonly errorClass?: ErrorClass | null;
  /** Sanitized and bounded by the schema to 1 KB. Never a provider body. */
  readonly errorMessage?: string | null;
  readonly finishedAt?: Date;
  /**
   * The batch timestamp, when the caller has already stamped its versions with it.
   *
   * Omit it and the run takes `clock_timestamp()` here, which is right for a run that wrote no
   * facts (a failure, a lease expiry). An ingestion that *did* write versions must pass the very
   * value it used, because `observationsAsOf` filters on `ingested_at` alone: if the two differ,
   * there is an instant at which the batch's facts are visible while the run that produced them
   * is not yet counted, and the replay is momentarily inconsistent with its own provenance.
   *
   * It is still a `clock_timestamp()` reading taken inside the transaction, never `now()`, which
   * would be the transaction's start time (S-16).
   */
  readonly committedAt?: Date;
}

/**
 * Closes a run. `committed_at` is taken with `clock_timestamp()` — the real wall clock at COMMIT,
 * not `now()`, which inside a transaction would be the transaction's start time and would make a
 * long batch look as if it had been visible earlier than it was.
 */
export async function finishRun(db: Kysely<DB>, input: FinishRunInput): Promise<Date> {
  const counts = input.counts ?? {};
  const result = await sql<{ committed_at: Date }>`
    UPDATE geonerva.ingestion_runs
    SET status = ${input.status},
        -- The database's clock, for the reason acquireRunLease gives: the CHECK against
        -- started_at compares stamps, and they must come from one clock.
        finished_at = COALESCE(${input.finishedAt ?? null}::timestamptz, clock_timestamp()),
        -- DOMAIN_MODEL section 2: ingested_at is one stamp per batch, taken immediately before
        -- the commit, so finishRun must be the last statement of the ingestion transaction.
        -- clock_timestamp() rather than now() is what makes it the real end of the batch instead
        -- of the moment the transaction opened (S-16). A batch that already stamped its versions
        -- passes that same instant as committedAt, so the two can never disagree.
        committed_at = COALESCE(${input.committedAt ?? null}::timestamptz, clock_timestamp()),
        http_status = ${input.httpStatus ?? null},
        bytes_received = ${input.bytesReceived ?? null},
        payload_sha256 = ${input.payloadSha256 ?? null},
        n_received = ${counts.received ?? 0},
        n_new_records = ${counts.newRecords ?? 0},
        n_new_versions = ${counts.newVersions ?? 0},
        n_unchanged = ${counts.unchanged ?? 0},
        n_rejected = ${counts.rejected ?? 0},
        newest_observed_at = ${input.newestObservedAt ?? null},
        error_class = ${input.errorClass ?? null},
        error_message = ${input.errorMessage ?? null}
    WHERE id = ${input.runId}::uuid AND status = 'RUNNING'
    RETURNING committed_at
  `.execute(db);

  const committedAt = result.rows[0]?.committed_at;
  if (committedAt === undefined) {
    throw new Error(`run ${input.runId} is not RUNNING and cannot be finished`);
  }
  return committedAt;
}

/**
 * The body digest the last committed run for this product ingested, or `null` if there is none.
 *
 * This is what lets a poll answer "nothing changed" without a stored ETag: an identical body
 * means an identical batch, so the run is SKIPPED rather than re-deriving 230 unchanged records.
 * Only runs that actually ingested a body count — a failed fetch has no payload to compare, and
 * treating its absence as "changed" is the safe direction.
 */
export async function lastPayloadDigest(
  db: Kysely<DB>,
  sourceId: string,
  productId: number | null,
): Promise<Buffer | null> {
  const result = await sql<{ payload_sha256: Buffer | null }>`
    SELECT payload_sha256
    FROM geonerva.ingestion_runs
    WHERE source_id = ${sourceId}
      AND COALESCE(product_id, -1) = COALESCE(${productId}::smallint, -1)
      AND committed_at IS NOT NULL
      AND payload_sha256 IS NOT NULL
    ORDER BY committed_at DESC
    LIMIT 1
  `.execute(db);
  return result.rows[0]?.payload_sha256 ?? null;
}

/** Records a rejected record for a run. Excerpts are bounded by the caller. */
export async function recordReject(
  db: Kysely<DB>,
  runId: string,
  reasonCode: string,
  excerpt?: unknown,
): Promise<void> {
  await sql`
    INSERT INTO geonerva.ingestion_rejects (run_id, reason_code, excerpt)
    VALUES (${runId}::uuid, ${reasonCode}, ${excerpt === undefined ? null : JSON.stringify(excerpt)}::jsonb)
  `.execute(db);
}

export interface RunSummary {
  readonly id: string;
  readonly sourceId: string;
  readonly productId: number | null;
  readonly trigger: RunTrigger;
  readonly status: RunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly committedAt: Date | null;
  readonly counts: {
    readonly received: number;
    readonly newRecords: number;
    readonly newVersions: number;
    readonly unchanged: number;
    readonly rejected: number;
  };
  readonly newestObservedAt: Date | null;
  readonly errorClass: ErrorClass | null;
}

/** Recent runs for the data-status page. Only committed runs are knowledge (I2). */
export async function listRecentRuns(
  db: Kysely<DB>,
  options: { sourceId?: string; asOf?: Date; limit?: number } = {},
): Promise<RunSummary[]> {
  const sourceFilter =
    options.sourceId === undefined ? sql`TRUE` : sql`r.source_id = ${options.sourceId}`;
  const asOfFilter =
    options.asOf === undefined
      ? sql`r.committed_at IS NOT NULL`
      : sql`r.committed_at IS NOT NULL AND r.committed_at <= ${options.asOf}`;

  const result = await sql<{
    id: string;
    source_id: string;
    product_id: number | null;
    trigger: string;
    status: string;
    started_at: Date;
    finished_at: Date | null;
    committed_at: Date | null;
    n_received: number;
    n_new_records: number;
    n_new_versions: number;
    n_unchanged: number;
    n_rejected: number;
    newest_observed_at: Date | null;
    error_class: string | null;
  }>`
    SELECT r.id::text AS id, r.source_id, r.product_id, r.trigger, r.status, r.started_at,
           r.finished_at, r.committed_at, r.n_received, r.n_new_records, r.n_new_versions,
           r.n_unchanged, r.n_rejected, r.newest_observed_at, r.error_class
    FROM geonerva.ingestion_runs r
    WHERE ${sourceFilter} AND ${asOfFilter}
    ORDER BY r.committed_at DESC
    LIMIT ${options.limit ?? 20}
  `.execute(db);

  return result.rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    productId: row.product_id,
    trigger: row.trigger as RunTrigger,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    committedAt: row.committed_at,
    counts: {
      received: row.n_received,
      newRecords: row.n_new_records,
      newVersions: row.n_new_versions,
      unchanged: row.n_unchanged,
      rejected: row.n_rejected,
    },
    newestObservedAt: row.newest_observed_at,
    errorClass: row.error_class as ErrorClass | null,
  }));
}

/** Updates the worker heartbeat shown as "worker last seen" on `/data-status`. */
export async function recordWorkerHeartbeat(
  db: Kysely<DB>,
  seenAt: Date,
  version: string | null,
): Promise<void> {
  await sql`
    INSERT INTO geonerva.worker_heartbeat (id, last_seen_at, version)
    VALUES (true, ${seenAt}, ${version})
    ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, version = EXCLUDED.version
  `.execute(db);
}
