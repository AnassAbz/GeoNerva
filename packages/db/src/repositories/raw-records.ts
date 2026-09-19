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
    const result = await sql<{ id: string }>`
      INSERT INTO geonerva.raw_source_records (source_id, payload_sha256, payload, first_seen_at)
      VALUES (${record.sourceId}, ${record.payloadSha256}, ${JSON.stringify(record.payload)}::jsonb,
              ${record.firstSeenAt ?? new Date()})
      ON CONFLICT (source_id, payload_sha256) DO UPDATE
        SET source_id = EXCLUDED.source_id
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
