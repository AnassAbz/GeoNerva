/**
 * Analysis runs: the audit trail for GeoNerva's **own** derivations (ARCHITECTURE §4.2 step 6).
 *
 * Correlation, clustering, snapshots and baselines are not facts anybody sent us — they are
 * computed from the fact store, and this table is the record that the computation happened. It is
 * the ingestion-run lifecycle's counterpart on the derived side, and it exists for one reason
 * that is not bookkeeping:
 *
 * > **A derivation that has not run is not an empty result.** Fire clusters are computed from
 * > FIRMS detections. With the detections ingested and the clustering never run, every source is
 * > healthy and the as-of read returns zero clusters — and a product that reports that as
 * > "nothing to report" tells a user standing next to a wildfire that nothing is burning.
 *
 * `resolveAvailability` closes that gap, and this table is where it gets the answer. Nothing else
 * in the system can distinguish "derived nothing" from "did not derive".
 *
 * Unlike an ingestion run, a failure here **never rolls back facts**: projections are rebuildable,
 * so the honest response to a failed derivation is to record it and let the next run redo the
 * work, not to undo an append-only store.
 */

import { randomUUID } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../generated/database.ts';

type Db = Kysely<DB> | Transaction<DB>;

/** The `kind` values `analysis_runs` accepts. Mirrors the CHECK in migration 0006. */
export const ANALYSIS_RUN_KINDS = [
  'CORRELATION',
  'CLUSTERING',
  'SNAPSHOT',
  'BASELINE',
  'AI_BRIEFING',
  'RETENTION',
] as const;
export type AnalysisRunKind = (typeof ANALYSIS_RUN_KINDS)[number];

export type AnalysisRunStatus = 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';

export interface StartAnalysisRunInput {
  readonly kind: AnalysisRunKind;
  /** Only for derivations scoped to one materialized location; `null` for global ones. */
  readonly locationKey?: string | null;
  /** The knowledge time the derivation read at, when it has one. */
  readonly asOf?: Date | null;
  readonly engineVersion: string;
  readonly startedAt?: Date;
  readonly id?: string;
}

/**
 * Opens a run.
 *
 * There is deliberately **no lease** here, unlike `acquireRunLease` for ingestion. An overlapping
 * ingestion poll would write duplicate facts; an overlapping derivation recomputes the same
 * answer from the same append-only inputs, which is wasteful and not incorrect. Adding a lock
 * would be a scheduling decision, and it belongs to the scheduler rather than to the audit table.
 */
export async function startAnalysisRun(db: Db, input: StartAnalysisRunInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await sql`
    INSERT INTO geonerva.analysis_runs
      (id, kind, location_key, as_of, engine_version, started_at, status)
    VALUES (${id}::uuid, ${input.kind}, ${input.locationKey ?? null}, ${input.asOf ?? null},
            ${input.engineVersion}, ${input.startedAt ?? new Date()}, 'RUNNING')
  `.execute(db);
  return id;
}

export interface FinishAnalysisRunInput {
  readonly id: string;
  readonly status: Exclude<AnalysisRunStatus, 'RUNNING'>;
  readonly finishedAt?: Date;
  readonly stats?: unknown;
  readonly errorClass?: string | null;
  /** 32 bytes identifying the inputs, for reproducibility checks. */
  readonly inputsSha256?: Uint8Array | null;
}

/**
 * Closes a run.
 *
 * Every run finishes, including failures: a failed derivation is the evidence that a family's
 * items are not trustworthy, and dropping the row would make the family look merely quiet — the
 * exact confusion this table exists to prevent.
 */
export async function finishAnalysisRun(db: Db, input: FinishAnalysisRunInput): Promise<void> {
  const result = await sql<{ id: string }>`
    UPDATE geonerva.analysis_runs
    SET status = ${input.status},
        finished_at = ${input.finishedAt ?? new Date()},
        stats = ${input.stats === undefined ? null : JSON.stringify(input.stats)}::jsonb,
        error_class = ${input.errorClass ?? null},
        inputs_sha256 = ${input.inputsSha256 ?? null}
    WHERE id = ${input.id}::uuid AND status = 'RUNNING'
    RETURNING id::text AS id
  `.execute(db);
  if (result.rows.length === 0) {
    throw new Error(`analysis run ${input.id} is not RUNNING and cannot be finished`);
  }
}

export interface AnalysisRunRow {
  readonly id: string;
  readonly kind: string;
  readonly location_key: string | null;
  readonly as_of: Date | null;
  readonly engine_version: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly status: string;
  readonly stats: unknown;
  readonly error_class: string | null;
}

/** Recent runs of a kind, newest first — for operational views, not for the read path. */
export async function listAnalysisRuns(
  db: Db,
  options: { readonly kind: AnalysisRunKind; readonly limit?: number },
): Promise<AnalysisRunRow[]> {
  const result = await sql<AnalysisRunRow>`
    SELECT id::text AS id, kind, location_key, as_of, engine_version, started_at, finished_at,
           status, stats, error_class
    FROM geonerva.analysis_runs
    WHERE kind = ${options.kind}
    ORDER BY started_at DESC, id DESC
    LIMIT ${options.limit ?? 50}
  `.execute(db);
  return [...result.rows];
}
