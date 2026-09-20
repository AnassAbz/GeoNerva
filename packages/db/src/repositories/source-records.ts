/**
 * Source-record identity: resolution by alias intersection, and the USGS merge case
 * (DOMAIN_MODEL §4.6, §6.6).
 *
 * The hard part of ingestion is not storing a record; it is deciding *which* record an incoming
 * payload is. USGS ComCat makes this explicit: an event carries a list of `ids`, the preferred one
 * can change (`us…` → `pr…`), and ComCat can later decide that two events it had published
 * separately are the same earthquake.
 *
 * The rule, implemented below:
 *
 *  - the incoming identifiers are intersected with `source_record_aliases`;
 *  - **no match** → a new record, with every identifier stored as an alias;
 *  - **one match** → that record, plus any identifiers it had not seen before;
 *  - **two or more matches** → the provider has associated records GeoNerva held apart. The
 *    **oldest** record survives (its public identity is the one users may already have seen), the
 *    others are marked `merged_into`, their aliases are re-pointed, and their versions stay
 *    exactly where they are. Nothing is deleted, so a replay before the merge still sees two
 *    separate records — which is what actually happened.
 *
 * Correlation must be re-run for the survivor afterwards; that is the caller's job (P5), and the
 * merge result says which records were absorbed so it knows.
 */

import { sql, type Kysely, type Transaction } from 'kysely';

import type { HazardType } from '@geonerva/domain';

import type { DB } from '../generated/database.ts';

export interface ResolveSourceRecordInput {
  readonly sourceId: string;
  readonly productId?: number | null;
  readonly hazardType: HazardType;
  /** The provider's preferred identifier for this record. */
  readonly primaryKey: string;
  /** Every identifier the provider has ever used for it, including `primaryKey`. */
  readonly aliases?: readonly string[];
  readonly firstIngestedAt: Date;
}

export interface ResolveSourceRecordResult {
  readonly sourceRecordId: string;
  readonly created: boolean;
  /** Records absorbed into the survivor by this call, oldest-first. Usually empty. */
  readonly mergedRecordIds: readonly string[];
  /** Aliases added by this call. */
  readonly addedAliases: readonly string[];
}

type Db = Kysely<DB> | Transaction<DB>;

async function findRecordIdsByAliases(
  db: Db,
  sourceId: string,
  aliases: readonly string[],
): Promise<string[]> {
  if (aliases.length === 0) return [];
  const result = await sql<{ source_record_id: string }>`
    SELECT DISTINCT source_record_id::text AS source_record_id
    FROM geonerva.source_record_aliases
    WHERE source_id = ${sourceId}
      AND alias = ANY(${sql.val(aliases)}::text[])
  `.execute(db);
  return result.rows.map((row) => row.source_record_id);
}

/** Follows `merged_into` to the surviving record. Merge chains are short but not impossible. */
async function resolveSurvivor(db: Db, recordId: string): Promise<string> {
  const result = await sql<{ id: string }>`
    WITH RECURSIVE chain AS (
      SELECT id, merged_into FROM geonerva.source_records WHERE id = ${recordId}::bigint
      UNION ALL
      SELECT r.id, r.merged_into
      FROM geonerva.source_records r
      JOIN chain c ON r.id = c.merged_into
    )
    SELECT id::text AS id FROM chain WHERE merged_into IS NULL LIMIT 1
  `.execute(db);
  const survivor = result.rows[0]?.id;
  if (survivor === undefined) throw new Error(`source record ${recordId} has no surviving record`);
  return survivor;
}

/**
 * Resolves (and creates, merges or extends) the identity of one provider record.
 *
 * Runs inside the caller's transaction, and takes a row lock on the candidate records so that two
 * concurrent batches cannot merge the same pair in opposite directions.
 */
export async function resolveSourceRecord(
  trx: Transaction<DB>,
  input: ResolveSourceRecordInput,
): Promise<ResolveSourceRecordResult> {
  const aliases = [...new Set([input.primaryKey, ...(input.aliases ?? [])])].filter(
    (alias) => alias.length > 0,
  );

  const matchedRaw = await findRecordIdsByAliases(trx, input.sourceId, aliases);
  const matched = [...new Set(await Promise.all(matchedRaw.map((id) => resolveSurvivor(trx, id))))];

  if (matched.length === 0) {
    // `ON CONFLICT` covers the race where another transaction created the same primary key
    // between our lookup and this insert.
    const inserted = await sql<{ id: string; was_inserted: boolean; merged_into: string | null }>`
      INSERT INTO geonerva.source_records
        (source_id, product_id, hazard_type, primary_key, first_ingested_at)
      VALUES (${input.sourceId}, ${input.productId ?? null}, ${input.hazardType},
              ${input.primaryKey}, ${input.firstIngestedAt})
      ON CONFLICT (source_id, primary_key) DO UPDATE SET primary_key = EXCLUDED.primary_key
      RETURNING id::text AS id,
                -- xmax is 0 only for a genuinely new row; on the DO UPDATE path it is the
                -- updating transaction's id. Without this the caller counts an existing record
                -- as new every time an alias row is missing.
                (xmax = 0) AS was_inserted,
                merged_into::text AS merged_into
    `.execute(trx);
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('failed to insert source record');

    /*
     * The row we got back may have been merged into another record. Attaching versions to an
     * absorbed record would hide them from `observationsAsOf`, which follows `merged_at` — a
     * silent disappearance rather than an error, so it is resolved here.
     */
    const recordId = row.merged_into === null ? row.id : await resolveSurvivor(trx, row.id);
    const added = await addAliases(trx, input.sourceId, recordId, aliases);
    return {
      sourceRecordId: recordId,
      created: row.was_inserted,
      mergedRecordIds: [],
      addedAliases: added,
    };
  }

  if (matched.length === 1) {
    const recordId = matched[0];
    if (recordId === undefined) throw new Error('unreachable: matched record missing');
    const added = await addAliases(trx, input.sourceId, recordId, aliases);
    return { sourceRecordId: recordId, created: false, mergedRecordIds: [], addedAliases: added };
  }

  return mergeSourceRecords(trx, {
    sourceId: input.sourceId,
    recordIds: matched,
    aliases,
    mergedAt: input.firstIngestedAt,
    reason: 'PROVIDER_ASSOCIATED_IDS',
  });
}

/** Inserts the aliases a record does not have yet. Returns the ones actually added. */
export async function addAliases(
  db: Db,
  sourceId: string,
  sourceRecordId: string,
  aliases: readonly string[],
): Promise<string[]> {
  if (aliases.length === 0) return [];
  const result = await sql<{ alias: string }>`
    INSERT INTO geonerva.source_record_aliases (source_id, alias, source_record_id)
    SELECT ${sourceId}, alias, ${sourceRecordId}::bigint
    FROM unnest(${sql.val(aliases)}::text[]) AS alias
    ON CONFLICT (source_id, alias) DO NOTHING
    RETURNING alias
  `.execute(db);
  return result.rows.map((row) => row.alias);
}

export interface MergeSourceRecordsInput {
  readonly sourceId: string;
  /** Two or more record ids that the provider has associated. */
  readonly recordIds: readonly string[];
  readonly aliases?: readonly string[];
  readonly mergedAt: Date;
  readonly reason: string;
}

/**
 * Merges several records into the oldest one.
 *
 * "Oldest" is `first_ingested_at`, with the numeric id as a tiebreak, so the outcome is
 * deterministic and does not depend on the order the provider happened to list its ids in. The
 * absorbed records keep every version they had; only their `merged_into` pointer is set.
 */
export async function mergeSourceRecords(
  trx: Transaction<DB>,
  input: MergeSourceRecordsInput,
): Promise<ResolveSourceRecordResult> {
  const ordered = await sql<{ id: string }>`
    SELECT id::text AS id
    FROM geonerva.source_records
    WHERE id = ANY(${sql.val(input.recordIds)}::bigint[])
      AND merged_into IS NULL
    ORDER BY first_ingested_at ASC, id ASC
    FOR UPDATE
  `.execute(trx);

  const ids = ordered.rows.map((row) => row.id);
  const survivor = ids[0];
  if (survivor === undefined) throw new Error('merge called with no live records');
  const absorbed = ids.slice(1);

  if (absorbed.length > 0) {
    await sql`
      UPDATE geonerva.source_records
      SET merged_into = ${survivor}::bigint, merged_at = ${input.mergedAt}, merge_reason = ${input.reason}
      WHERE id = ANY(${sql.val(absorbed)}::bigint[])
    `.execute(trx);

    // Aliases follow the survivor, so a later poll for any of the old identifiers resolves here.
    await sql`
      UPDATE geonerva.source_record_aliases
      SET source_record_id = ${survivor}::bigint
      WHERE source_id = ${input.sourceId}
        AND source_record_id = ANY(${sql.val(absorbed)}::bigint[])
    `.execute(trx);
  }

  const added = await addAliases(trx, input.sourceId, survivor, input.aliases ?? []);
  return {
    sourceRecordId: survivor,
    created: false,
    mergedRecordIds: absorbed,
    addedAliases: added,
  };
}

export interface SourceRecordRow {
  readonly id: string;
  readonly sourceId: string;
  readonly productId: number | null;
  readonly hazardType: string;
  readonly primaryKey: string;
  readonly firstIngestedAt: Date;
  readonly mergedInto: string | null;
  readonly mergedAt: Date | null;
}

/** One record by `(source, primary key)`. */
/**
 * What an alias set resolved to. `AMBIGUOUS` is a real answer, not an error to be smoothed over.
 */
export type AliasLookup =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'ONE'; readonly sourceRecordId: string }
  | { readonly kind: 'AMBIGUOUS'; readonly sourceRecordIds: readonly string[] };

/**
 * Resolves an alias set to an existing record, **without creating one**.
 *
 * `resolveSourceRecord` creates on a miss, which is right for ingestion and wrong for a deletion
 * sweep: a tombstone for an event GeoNerva never ingested would conjure a record whose only
 * version says it was deleted. The answer to "we have never heard of this" is `null`.
 *
 * Merge redirects are followed, so an alias belonging to an absorbed record resolves to the
 * survivor rather than to a record `observationsAsOf` no longer returns.
 */
export async function findRecordByAliases(
  db: Db,
  sourceId: string,
  aliases: readonly string[],
): Promise<AliasLookup> {
  const matched = await findRecordIdsByAliases(db, sourceId, aliases);
  const survivors = [
    ...new Set(await Promise.all(matched.map((id) => resolveSurvivor(db, id)))),
  ].sort();

  const first = survivors[0];
  if (first === undefined) return { kind: 'NONE' };
  /*
   * More than one surviving record for one alias set is the situation `resolveSourceRecord`
   * treats as a *merge*. A read path must not resolve it by picking one: the caller would
   * tombstone an arbitrary record and leave the other ACTIVE forever, with no reject row and no
   * error — and because row order is not stable, a second pass could pick the other one, so the
   * operation would not even be idempotent.
   */
  if (survivors.length > 1) return { kind: 'AMBIGUOUS', sourceRecordIds: survivors };
  return { kind: 'ONE', sourceRecordId: first };
}

export async function findSourceRecord(
  db: Db,
  sourceId: string,
  primaryKey: string,
): Promise<SourceRecordRow | null> {
  const result = await sql<{
    id: string;
    source_id: string;
    product_id: number | null;
    hazard_type: string;
    primary_key: string;
    first_ingested_at: Date;
    merged_into: string | null;
    merged_at: Date | null;
  }>`
    SELECT id::text AS id, source_id, product_id, hazard_type, primary_key, first_ingested_at,
           merged_into::text AS merged_into, merged_at
    FROM geonerva.source_records
    WHERE source_id = ${sourceId} AND primary_key = ${primaryKey}
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    productId: row.product_id,
    hazardType: row.hazard_type,
    primaryKey: row.primary_key,
    firstIngestedAt: row.first_ingested_at,
    mergedInto: row.merged_into,
    mergedAt: row.merged_at,
  };
}

/** Every alias of a record, for the event-detail view. */
export async function listAliases(
  db: Db,
  sourceId: string,
  sourceRecordId: string,
): Promise<string[]> {
  const result = await sql<{ alias: string }>`
    SELECT alias FROM geonerva.source_record_aliases
    WHERE source_id = ${sourceId} AND source_record_id = ${sourceRecordId}::bigint
    ORDER BY alias
  `.execute(db);
  return result.rows.map((row) => row.alias);
}
