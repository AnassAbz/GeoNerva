/**
 * Raw provider payloads, content-addressed (DOMAIN_MODEL §4.5).
 *
 * The exact bytes a provider sent are what makes evidence auditable: "this is the payload the
 * magnitude came from". They are deduplicated by SHA-256, because a five-minute poll re-delivers
 * the same event dozens of times and storing each copy would dwarf the facts themselves.
 *
 * FIRMS is deliberately excluded: a CSV row is already flat and is stored losslessly in
 * `fire_detections` with every original column, so a second copy would add nothing. The batch
 * hash lives on the run instead.
 *
 * After the retention window the **body** is pruned and the **hash stays forever**, so an audit
 * can still prove what was ingested even when the payload itself is gone.
 */

import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../generated/database.ts';

type Db = Kysely<DB> | Transaction<DB>;

export interface RawRecordInput {
  readonly sourceId: string;
  readonly payloadSha256: Buffer;
  readonly payload: unknown;
  readonly firstSeenAt?: Date;
  /**
   * Store the row and its digest without the body (ADR-033).
   *
   * A backfill does this from the outset: the audit chain and `raw_record_id` survive, but the
   * ~315 MB of JSON that merely duplicates the normalized facts is never written. It is the same
   * end state `prunePayloadsBefore` produces, reached immediately instead of after 30 days, and
   * `payload_pruned` means exactly this already — so the API reports the absence rather than
   * implying the payload never existed.
   */
  readonly pruned?: boolean;
}

/**
 * Stores payloads that are not already known, and returns the id of every one — new or existing —
 * keyed by hex digest, so callers can attach `raw_record_id` to the versions they write.
 */
export async function upsertRawRecords(
  db: Db,
  records: readonly RawRecordInput[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (records.length === 0) return ids;

  // Deduplicate within the batch first: a single poll routinely contains the same payload twice.
  const unique = new Map<string, RawRecordInput>();
  for (const record of records) {
    const key = record.payloadSha256.toString('hex');
    if (!unique.has(key)) unique.set(key, record);
  }

  for (const record of unique.values()) {
    const pruned = record.pruned === true;
    const result = await sql<{ id: string }>`
      INSERT INTO geonerva.raw_source_records
        (source_id, payload_sha256, payload, payload_pruned, payload_captured, first_seen_at)
      VALUES (${record.sourceId}, ${record.payloadSha256},
              ${pruned ? null : JSON.stringify(record.payload)}::jsonb, ${pruned}, ${!pruned},
              ${record.firstSeenAt ?? new Date()})
      ON CONFLICT (source_id, payload_sha256) DO UPDATE
        -- Fill the body in when this writer has one and the stored row does not.
        --
        -- A backfill and a live poll collide on the same digest whenever the feature has not
        -- changed, by design: the hash is over the canonical content. With a pure no-op touch the
        -- FIRST writer decided forever, so a backfill running first meant the live body was never
        -- stored and ADR-033's 30-day debugging window silently did not apply to those records.
        -- The stored state depended on ingest order. Filling in is safe the other way too,
        -- because pruning only ever removes.
        SET payload = COALESCE(geonerva.raw_source_records.payload, EXCLUDED.payload),
            payload_pruned = geonerva.raw_source_records.payload_pruned
                             AND EXCLUDED.payload IS NULL,
            -- Once a body is stored the row was captured, and stays so after pruning (ADR-038).
            payload_captured = geonerva.raw_source_records.payload_captured
                               OR EXCLUDED.payload IS NOT NULL
      RETURNING id::text AS id
    `.execute(db);
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('failed to upsert raw source record');
    ids.set(record.payloadSha256.toString('hex'), id);
  }

  return ids;
}

/** A stored payload, or `null` when it has been pruned. Used by `GET /api/v1/evidence/{id}`. */
export async function findRawPayload(
  db: Db,
  rawRecordId: string,
): Promise<{ payload: unknown; sha256Hex: string; pruned: boolean } | null> {
  const result = await sql<{ payload: unknown; sha: string; pruned: boolean }>`
    SELECT payload, encode(payload_sha256, 'hex') AS sha, payload_pruned AS pruned
    FROM geonerva.raw_source_records
    WHERE id = ${rawRecordId}::bigint
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { payload: row.payload, sha256Hex: row.sha, pruned: row.pruned };
}

/**
 * Retention: drops payload bodies older than the cutoff, keeping the hash and the row.
 *
 * Deliberately **not** a `DELETE`: the row is referenced by versions, and the hash is what lets a
 * future audit verify that a re-fetched payload is byte-identical to the one that was ingested.
 */
export async function prunePayloadsBefore(db: Db, cutoff: Date): Promise<number> {
  const result = await sql`
    UPDATE geonerva.raw_source_records
    SET payload = NULL, payload_pruned = true
    WHERE first_seen_at < ${cutoff} AND payload IS NOT NULL
  `.execute(db);
  return Number(result.numAffectedRows ?? 0n);
}
