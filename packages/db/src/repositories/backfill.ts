/**
 * Backfill plans and their interval checkpoints (P4.2).
 *
 * The contract this file exists to keep: **a resumed backfill trusts only the database.** No
 * cursor in process memory, no in-memory plan, nothing that a restart on another machine cannot
 * reconstruct exactly. Every function here is either idempotent or explicitly says what it
 * changed.
 *
 * `markIntervalDone` takes a `Transaction` rather than a pool on purpose: it is meant to be called
 * *inside* the transaction that commits the window's facts, so there is never an instant where the
 * facts exist and the checkpoint does not. A crash cannot land between them.
 */

import { randomUUID } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../generated/database.ts';

export type BackfillMode = 'HISTORICAL' | 'DELETION_SWEEP';
export type BackfillPlanStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABANDONED';
export type BackfillIntervalStatus = 'PENDING' | 'DONE' | 'SPLIT' | 'FAILED';

export interface BackfillPlanRequest {
  readonly sourceId: string;
  readonly productId: number | null;
  readonly mode: BackfillMode;
  readonly rangeFrom: Date;
  readonly rangeTo: Date;
  readonly minMagnitude: number | null;
  readonly windowMs: number;
  readonly minWindowMs: number;
}

export interface BackfillPlanRow {
  readonly id: string;
  readonly sourceId: string;
  readonly productId: number | null;
  readonly mode: BackfillMode;
  readonly rangeFrom: Date;
  readonly rangeTo: Date;
  readonly minMagnitude: number | null;
  readonly windowMs: number;
  readonly minWindowMs: number;
  readonly status: BackfillPlanStatus;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export interface BackfillIntervalRow {
  readonly planId: string;
  readonly from: Date;
  readonly to: Date;
  readonly status: BackfillIntervalStatus;
  readonly attempts: number;
  readonly nReceived: number;
}

type Db = Kysely<DB> | Transaction<DB>;

interface PlanRowRaw {
  readonly id: string;
  readonly source_id: string;
  readonly product_id: number | null;
  readonly mode: string;
  readonly range_from: Date;
  readonly range_to: Date;
  readonly min_magnitude: string | number | null;
  readonly window_ms: string | number;
  readonly min_window_ms: string | number;
  readonly status: string;
  readonly created_at: Date;
  readonly finished_at: Date | null;
}

/** `bigint` and `numeric` arrive as strings from `pg`; a silent `NaN` here would be a wrong plan. */
function asNumber(value: string | number | null, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`backfill plan ${field} is not a number: ${String(value)}`);
  }
  return parsed;
}

function toPlan(row: PlanRowRaw): BackfillPlanRow {
  return {
    id: row.id,
    sourceId: row.source_id,
    productId: row.product_id,
    mode: row.mode as BackfillMode,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    minMagnitude: row.min_magnitude === null ? null : asNumber(row.min_magnitude, 'min_magnitude'),
    windowMs: asNumber(row.window_ms, 'window_ms'),
    minWindowMs: asNumber(row.min_window_ms, 'min_window_ms'),
    status: row.status as BackfillPlanStatus,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

const PLAN_COLUMNS = sql`
  id::text AS id, source_id, product_id, mode, range_from, range_to, min_magnitude,
  window_ms, min_window_ms, status, created_at, finished_at
`;

export interface OpenPlanResult {
  readonly plan: BackfillPlanRow;
  /** False when an identical request already had a plan, which is how a resume happens. */
  readonly created: boolean;
}

/**
 * Finds or creates the plan for a request.
 *
 * Requesting the same range twice **resumes** rather than duplicating: the unique index on the
 * request makes the second call return the first plan, so the intervals already marked DONE are
 * not walked again. That is what makes "the same historical range twice" cheap as well as safe —
 * safety alone comes from the content hash, but re-walking a year of windows to discover every
 * record is unchanged is not a property anyone wants.
 *
 * A plan that previously finished is reopened as `RUNNING`, because re-requesting a completed
 * range is a legitimate way to pick up revisions the catalogue has published since.
 */
export async function openBackfillPlan(
  db: Db,
  request: BackfillPlanRequest,
): Promise<OpenPlanResult> {
  const id = randomUUID();
  const inserted = await sql<PlanRowRaw & { was_inserted: boolean }>`
    INSERT INTO geonerva.backfill_plans
      (id, source_id, product_id, mode, range_from, range_to, min_magnitude,
       window_ms, min_window_ms, status)
    VALUES (${id}::uuid, ${request.sourceId}, ${request.productId}, ${request.mode},
            ${request.rangeFrom}, ${request.rangeTo}, ${request.minMagnitude},
            ${request.windowMs}, ${request.minWindowMs}, 'RUNNING')
    ON CONFLICT (source_id, COALESCE(product_id, -1), mode, range_from, range_to,
                 COALESCE(min_magnitude, -99))
      DO UPDATE SET status = 'RUNNING', finished_at = NULL, error_message = NULL,
                    updated_at = clock_timestamp()
    RETURNING ${PLAN_COLUMNS}, (xmax = 0) AS was_inserted
  `.execute(db);

  const row = inserted.rows[0];
  if (row === undefined) throw new Error('failed to open a backfill plan');
  return { plan: toPlan(row), created: row.was_inserted };
}

/** The plan by id, or `null`. Used by a resumed process to read its own parameters back. */
export async function findBackfillPlan(db: Db, planId: string): Promise<BackfillPlanRow | null> {
  const result = await sql<PlanRowRaw>`
    SELECT ${PLAN_COLUMNS} FROM geonerva.backfill_plans WHERE id = ${planId}::uuid
  `.execute(db);
  const row = result.rows[0];
  return row === undefined ? null : toPlan(row);
}

/**
 * Records the intervals of a plan. Idempotent: re-planning the same range adds nothing.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert, because an interval already marked DONE must not
 * be reset to PENDING by a second planning pass — that would re-walk completed work and, worse,
 * make a resumed backfill look like it had made no progress.
 */
export async function addBackfillIntervals(
  db: Db,
  planId: string,
  intervals: readonly { readonly from: Date; readonly to: Date }[],
): Promise<number> {
  let added = 0;
  for (const interval of intervals) {
    const result = await sql`
      INSERT INTO geonerva.backfill_intervals
        (plan_id, interval_from, interval_to, status)
      VALUES (${planId}::uuid, ${interval.from}, ${interval.to}, 'PENDING')
      ON CONFLICT (plan_id, interval_from, interval_to) DO NOTHING
    `.execute(db);
    added += Number(result.numAffectedRows ?? 0n);
  }
  return added;
}

/**
 * The next interval to work on, in time order, or `null` when the plan is finished.
 *
 * `FOR UPDATE SKIP LOCKED` so two workers on the same plan take different intervals instead of
 * both doing the same one. The ingestion lease would stop them writing the same batch twice, but
 * they would each waste a fetch discovering that.
 */
export async function claimNextInterval(
  db: Transaction<DB>,
  planId: string,
): Promise<BackfillIntervalRow | null> {
  const result = await sql<{
    interval_from: Date;
    interval_to: Date;
    status: string;
    attempts: number;
    n_received: number;
  }>`
    SELECT interval_from, interval_to, status, attempts, n_received
    FROM geonerva.backfill_intervals
    WHERE plan_id = ${planId}::uuid AND status = 'PENDING'
    ORDER BY interval_from
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    planId,
    from: row.interval_from,
    to: row.interval_to,
    status: row.status as BackfillIntervalStatus,
    attempts: row.attempts,
    nReceived: row.n_received,
  };
}

/** Counts an attempt before it is made, so a repeatedly failing interval is visible. */
export async function recordIntervalAttempt(
  db: Db,
  planId: string,
  interval: { readonly from: Date; readonly to: Date },
): Promise<number> {
  const result = await sql<{ attempts: number }>`
    UPDATE geonerva.backfill_intervals
    SET attempts = attempts + 1
    WHERE plan_id = ${planId}::uuid
      AND interval_from = ${interval.from}
      AND interval_to = ${interval.to}
    RETURNING attempts
  `.execute(db);
  const attempts = result.rows[0]?.attempts;
  if (attempts === undefined) {
    throw new Error(
      `no backfill interval ${interval.from.toISOString()}–${interval.to.toISOString()} in plan ${planId}`,
    );
  }
  return attempts;
}

/**
 * Marks an interval finished. **Call this inside the transaction that commits its facts.**
 *
 * That is the whole point of taking a `Transaction`: the checkpoint and the facts land together,
 * so no crash can produce facts whose interval still reads PENDING — and no crash can produce a
 * DONE interval whose facts rolled back.
 */
export async function markIntervalDone(
  trx: Transaction<DB>,
  planId: string,
  interval: { readonly from: Date; readonly to: Date },
  received: number,
  ingestionRunId: string | null,
): Promise<void> {
  const result = await sql`
    UPDATE geonerva.backfill_intervals
    SET status = 'DONE',
        completed_at = clock_timestamp(),
        n_received = ${received},
        ingestion_run_id = ${ingestionRunId}::uuid,
        error_class = NULL,
        error_message = NULL
    WHERE plan_id = ${planId}::uuid
      AND interval_from = ${interval.from}
      AND interval_to = ${interval.to}
  `.execute(trx);
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    // Refusing to commit facts whose checkpoint could not be written is the safe direction: the
    // interval stays PENDING and the next pass redoes it, which is idempotent.
    throw new Error(
      `could not checkpoint interval ${interval.from.toISOString()}–${interval.to.toISOString()} of plan ${planId}`,
    );
  }
}

/**
 * Replaces a too-large interval with its children, atomically.
 *
 * The parent becomes SPLIT rather than being deleted, so the plan keeps a record of *why* the
 * windows are the shape they are — and so a resumed process cannot re-create the parent as
 * PENDING and split it forever.
 */
export async function splitBackfillInterval(
  db: Transaction<DB>,
  planId: string,
  parent: { readonly from: Date; readonly to: Date },
  children: readonly { readonly from: Date; readonly to: Date }[],
): Promise<void> {
  const marked = await sql`
    UPDATE geonerva.backfill_intervals
    SET status = 'SPLIT', completed_at = clock_timestamp()
    WHERE plan_id = ${planId}::uuid
      AND interval_from = ${parent.from}
      AND interval_to = ${parent.to}
      AND status <> 'SPLIT'
  `.execute(db);
  if (Number(marked.numAffectedRows ?? 0n) !== 1) {
    throw new Error(
      `could not split interval ${parent.from.toISOString()}–${parent.to.toISOString()} of plan ${planId}`,
    );
  }
  await addBackfillIntervals(db, planId, children);
}

/** Records an interval that failed for a reason splitting will not fix. */
export async function markIntervalFailed(
  db: Db,
  planId: string,
  interval: { readonly from: Date; readonly to: Date },
  errorClass: string,
  errorMessage: string,
): Promise<void> {
  await sql`
    UPDATE geonerva.backfill_intervals
    SET status = 'FAILED', error_class = ${errorClass}, error_message = ${errorMessage}
    WHERE plan_id = ${planId}::uuid
      AND interval_from = ${interval.from}
      AND interval_to = ${interval.to}
  `.execute(db);
}

export interface BackfillProgress {
  readonly total: number;
  readonly pending: number;
  readonly done: number;
  readonly split: number;
  readonly failed: number;
  readonly received: number;
}

/** Progress, for the CLI to print and for a resumed run to report where it is starting from. */
export async function backfillProgress(db: Db, planId: string): Promise<BackfillProgress> {
  const result = await sql<{
    total: string;
    pending: string;
    done: string;
    split: string;
    failed: string;
    received: string;
  }>`
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
           count(*) FILTER (WHERE status = 'DONE')::text    AS done,
           count(*) FILTER (WHERE status = 'SPLIT')::text   AS split,
           count(*) FILTER (WHERE status = 'FAILED')::text  AS failed,
           COALESCE(sum(n_received), 0)::text               AS received
    FROM geonerva.backfill_intervals
    WHERE plan_id = ${planId}::uuid
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    return { total: 0, pending: 0, done: 0, split: 0, failed: 0, received: 0 };
  }
  return {
    total: Number(row.total),
    pending: Number(row.pending),
    done: Number(row.done),
    split: Number(row.split),
    failed: Number(row.failed),
    received: Number(row.received),
  };
}

/** Closes a plan. `COMPLETED` only when nothing is left pending — asserted, not assumed. */
export async function finishBackfillPlan(
  db: Db,
  planId: string,
  status: Exclude<BackfillPlanStatus, 'RUNNING'>,
  errorMessage?: string,
): Promise<void> {
  if (status === 'COMPLETED') {
    const progress = await backfillProgress(db, planId);
    if (progress.pending > 0 || progress.failed > 0) {
      throw new Error(
        `refusing to mark plan ${planId} COMPLETED: ${progress.pending} pending, ${progress.failed} failed`,
      );
    }
  }
  await sql`
    UPDATE geonerva.backfill_plans
    SET status = ${status},
        finished_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        error_message = ${errorMessage ?? null}
    WHERE id = ${planId}::uuid
  `.execute(db);
}
