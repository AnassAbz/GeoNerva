/**
 * Canonical events, links and the projection cache (DOMAIN_MODEL §4.8, ADR-005).
 *
 * A canonical event is identity only. Everything a user sees about it is *projected* from the
 * linked records' latest versions, which is why there is no `magnitude` column here to disagree
 * with the sources.
 *
 * Links are bitemporal and append-only in spirit: re-evaluating correlation **closes** a link
 * (`unlinked_at`) and opens a new one rather than editing the old row, so a replay shows the
 * correlation GeoNerva actually believed at that moment — including a split that was later
 * reversed. The partial unique index on `(source_record_id) WHERE unlinked_at IS NULL` enforces
 * invariant I6: a record has at most one active canonical link.
 */

import { randomUUID } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';

import type { AgreementLevel, HazardType, LinkMatchKind, LinkRelation } from '@geonerva/domain';

import type { DB } from '../generated/database.ts';
import { generatePublicId } from '../public-id.ts';

type Db = Kysely<DB> | Transaction<DB>;

export interface CreateCanonicalEventInput {
  readonly hazardType: HazardType;
  readonly createdAt: Date;
  readonly createdByRun?: string | null;
  readonly id?: string;
  readonly publicId?: string;
}

/**
 * Creates a canonical event.
 *
 * The public id is random rather than sequential, so that a shareable URL does not reveal how
 * many events exist or let anyone enumerate them. A collision retries; with 32^6 tokens per year
 * and prefix, that happens essentially never.
 */
export async function createCanonicalEvent(
  db: Db,
  input: CreateCanonicalEventInput,
): Promise<{ id: string; publicId: string }> {
  const id = input.id ?? randomUUID();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const publicId = input.publicId ?? generatePublicId(input.hazardType, input.createdAt);
    const result = await sql<{ id: string; public_id: string }>`
      INSERT INTO geonerva.canonical_events (id, public_id, hazard_type, created_at, created_by_run)
      VALUES (${id}::uuid, ${publicId}, ${input.hazardType}, ${input.createdAt},
              ${input.createdByRun ?? null}::uuid)
      ON CONFLICT (public_id) DO NOTHING
      RETURNING id::text AS id, public_id
    `.execute(db);
    const row = result.rows[0];
    if (row !== undefined) return { id: row.id, publicId: row.public_id };
    if (input.publicId !== undefined) {
      throw new Error(`public id ${input.publicId} is already taken`);
    }
  }
  throw new Error('could not allocate a unique public id after five attempts');
}

export interface LinkRecordInput {
  readonly canonicalEventId: string;
  readonly sourceRecordId: string;
  readonly relation: LinkRelation;
  readonly matchKind: LinkMatchKind;
  readonly confidence?: number | null;
  readonly reasons?: unknown;
  readonly algorithmVersion: string;
  readonly linkedAt: Date;
}

/**
 * Links a record to a canonical event.
 *
 * If the record already has an active link to a *different* event, that link is closed first with
 * a reason — a record cannot belong to two events at once, and the transition is recorded rather
 * than overwritten. Linking to the same event again is a no-op, which keeps re-running
 * correlation cheap and idempotent.
 */
export async function linkRecord(
  trx: Transaction<DB>,
  input: LinkRecordInput,
): Promise<{ linkId: string; created: boolean; closedLinkId: string | null }> {
  const existing = await sql<{ id: string; canonical_event_id: string }>`
    SELECT id::text AS id, canonical_event_id::text AS canonical_event_id
    FROM geonerva.canonical_links
    WHERE source_record_id = ${input.sourceRecordId}::bigint AND unlinked_at IS NULL
    FOR UPDATE
  `.execute(trx);

  const current = existing.rows[0];
  let closedLinkId: string | null = null;

  if (current !== undefined) {
    if (current.canonical_event_id === input.canonicalEventId) {
      return { linkId: current.id, created: false, closedLinkId: null };
    }
    await sql`
      UPDATE geonerva.canonical_links
      SET unlinked_at = ${input.linkedAt}, unlink_reason = 'RELINKED'
      WHERE id = ${current.id}::bigint
    `.execute(trx);
    closedLinkId = current.id;
  }

  const inserted = await sql<{ id: string }>`
    INSERT INTO geonerva.canonical_links (
      canonical_event_id, source_record_id, relation, match_kind, confidence, reasons,
      algorithm_version, linked_at)
    VALUES (${input.canonicalEventId}::uuid, ${input.sourceRecordId}::bigint, ${input.relation},
            ${input.matchKind}, ${input.confidence ?? null},
            ${input.reasons === undefined ? null : JSON.stringify(input.reasons)}::jsonb,
            ${input.algorithmVersion}, ${input.linkedAt})
    RETURNING id::text AS id
  `.execute(trx);

  const linkId = inserted.rows[0]?.id;
  if (linkId === undefined) throw new Error('failed to insert canonical link');
  return { linkId, created: true, closedLinkId };
}

/** Closes a link, e.g. when a revision breaks the match and the record needs its own event. */
export async function unlinkRecord(
  db: Db,
  sourceRecordId: string,
  unlinkedAt: Date,
  reason: string,
): Promise<string | null> {
  const result = await sql<{ id: string }>`
    UPDATE geonerva.canonical_links
    SET unlinked_at = ${unlinkedAt}, unlink_reason = ${reason}
    WHERE source_record_id = ${sourceRecordId}::bigint AND unlinked_at IS NULL
    RETURNING id::text AS id
  `.execute(db);
  return result.rows[0]?.id ?? null;
}

/**
 * Merges canonical events: the **younger** is merged into the older, and its links are re-pointed
 * by closing and reopening them, so the history of both events survives.
 *
 * The older event survives because its public id is the one that may already be in a shared URL;
 * the younger id redirects (DOMAIN_MODEL §4.8).
 */
export async function mergeCanonicalEvents(
  trx: Transaction<DB>,
  input: {
    readonly survivorId: string;
    readonly absorbedIds: readonly string[];
    readonly mergedAt: Date;
    readonly algorithmVersion: string;
  },
): Promise<{ relinked: number }> {
  if (input.absorbedIds.length === 0) return { relinked: 0 };

  const links = await sql<{
    id: string;
    source_record_id: string;
    relation: string;
    match_kind: string;
    confidence: string | null;
    reasons: unknown;
  }>`
    SELECT id::text AS id, source_record_id::text AS source_record_id, relation, match_kind,
           confidence, reasons
    FROM geonerva.canonical_links
    WHERE canonical_event_id = ANY(${sql.val(input.absorbedIds)}::uuid[])
      AND unlinked_at IS NULL
    FOR UPDATE
  `.execute(trx);

  for (const link of links.rows) {
    await sql`
      UPDATE geonerva.canonical_links
      SET unlinked_at = ${input.mergedAt}, unlink_reason = 'EVENT_MERGED'
      WHERE id = ${link.id}::bigint
    `.execute(trx);

    await sql`
      INSERT INTO geonerva.canonical_links (
        canonical_event_id, source_record_id, relation, match_kind, confidence, reasons,
        algorithm_version, linked_at)
      VALUES (${input.survivorId}::uuid, ${link.source_record_id}::bigint,
              ${link.relation === 'PRIMARY' ? 'SAME_EVENT' : link.relation}, ${link.match_kind},
              ${link.confidence}, ${link.reasons === null ? null : JSON.stringify(link.reasons)}::jsonb,
              ${input.algorithmVersion}, ${input.mergedAt})
    `.execute(trx);
  }

  await sql`
    UPDATE geonerva.canonical_events
    SET merged_into = ${input.survivorId}::uuid, merged_at = ${input.mergedAt}
    WHERE id = ANY(${sql.val(input.absorbedIds)}::uuid[]) AND id <> ${input.survivorId}::uuid
  `.execute(trx);

  await sql`
    DELETE FROM geonerva.canonical_event_state
    WHERE canonical_event_id = ANY(${sql.val(input.absorbedIds)}::uuid[])
      AND canonical_event_id <> ${input.survivorId}::uuid
  `.execute(trx);

  return { relinked: links.rows.length };
}

/** Follows merge redirects to the surviving event, for `GET /events/{publicId}`. */
export async function resolveCanonicalEvent(
  db: Db,
  publicId: string,
): Promise<{ id: string; publicId: string; redirected: boolean } | null> {
  const result = await sql<{ id: string; public_id: string; redirected: boolean }>`
    WITH RECURSIVE chain AS (
      SELECT id, public_id, merged_into, false AS redirected
      FROM geonerva.canonical_events WHERE public_id = ${publicId}
      UNION ALL
      SELECT e.id, e.public_id, e.merged_into, true
      FROM geonerva.canonical_events e
      JOIN chain c ON e.id = c.merged_into
    )
    SELECT id::text AS id, public_id, redirected FROM chain WHERE merged_into IS NULL LIMIT 1
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { id: row.id, publicId: row.public_id, redirected: row.redirected };
}

export interface CanonicalStateInput {
  readonly canonicalEventId: string;
  readonly hazardType: HazardType;
  readonly asOf: Date;
  readonly engineVersion: string;
  readonly observedAt: Date;
  readonly centroid: { readonly lat: number; readonly lon: number };
  readonly footprintGeoJson?: unknown | null;
  readonly isActive: boolean;
  readonly magnitude?: number | null;
  readonly severityScheme?: string | null;
  readonly severityValue?: string | null;
  readonly headline: unknown;
  readonly agreement: { readonly level: AgreementLevel; readonly [key: string]: unknown };
  readonly nSources: number;
  readonly nIndependentSources: number;
}

/**
 * Refreshes the "now" projection for one event.
 *
 * This table is a cache: it is rebuilt whenever a linked record gets a version, and it is never
 * consulted for a replay. Deleting it would slow the map down and change nothing else.
 */
export async function upsertCanonicalEventState(
  db: Db,
  input: CanonicalStateInput,
): Promise<void> {
  const footprint =
    input.footprintGeoJson === undefined || input.footprintGeoJson === null
      ? sql`NULL`
      : sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(input.footprintGeoJson)}), 4326)::geography`;

  await sql`
    INSERT INTO geonerva.canonical_event_state (
      canonical_event_id, hazard_type, as_of, engine_version, observed_at, centroid, footprint,
      is_active, magnitude, severity_scheme, severity_value, headline, agreement, n_sources,
      n_independent_sources, updated_at)
    VALUES (
      ${input.canonicalEventId}::uuid, ${input.hazardType}, ${input.asOf}, ${input.engineVersion},
      ${input.observedAt},
      ST_SetSRID(ST_MakePoint(${input.centroid.lon}, ${input.centroid.lat}), 4326)::geography,
      ${footprint}, ${input.isActive}, ${input.magnitude ?? null},
      ${input.severityScheme ?? null}, ${input.severityValue ?? null},
      ${JSON.stringify(input.headline)}::jsonb, ${JSON.stringify(input.agreement)}::jsonb,
      ${input.nSources}, ${input.nIndependentSources}, now())
    ON CONFLICT (canonical_event_id) DO UPDATE SET
      hazard_type = EXCLUDED.hazard_type,
      as_of = EXCLUDED.as_of,
      engine_version = EXCLUDED.engine_version,
      observed_at = EXCLUDED.observed_at,
      centroid = EXCLUDED.centroid,
      footprint = EXCLUDED.footprint,
      is_active = EXCLUDED.is_active,
      magnitude = EXCLUDED.magnitude,
      severity_scheme = EXCLUDED.severity_scheme,
      severity_value = EXCLUDED.severity_value,
      headline = EXCLUDED.headline,
      agreement = EXCLUDED.agreement,
      n_sources = EXCLUDED.n_sources,
      n_independent_sources = EXCLUDED.n_independent_sources,
      updated_at = now()
  `.execute(db);
}

/**
 * Records a pair that scored close but was **not** merged.
 *
 * Storing near-misses is what lets the UI say "possibly the same event" instead of quietly
 * choosing. A wrong merge destroys information; an unmerged pair only costs a sentence.
 */
export async function insertCorrelationCandidate(
  db: Db,
  input: {
    readonly recordA: string;
    readonly recordB: string;
    readonly decision: 'POSSIBLE_MATCH' | 'NO_MATCH_CLOSE';
    readonly score?: number | null;
    readonly reasons?: unknown;
    readonly algorithmVersion: string;
    readonly evaluatedAt: Date;
  },
): Promise<string | null> {
  // The pair is ordered so that (a, b) and (b, a) are the same row, which the CHECK enforces.
  const [low, high] =
    BigInt(input.recordA) < BigInt(input.recordB)
      ? [input.recordA, input.recordB]
      : [input.recordB, input.recordA];

  const result = await sql<{ id: string }>`
    INSERT INTO geonerva.correlation_candidates
      (record_a, record_b, decision, score, reasons, algorithm_version, evaluated_at)
    VALUES (${low}::bigint, ${high}::bigint, ${input.decision}, ${input.score ?? null},
            ${input.reasons === undefined ? null : JSON.stringify(input.reasons)}::jsonb,
            ${input.algorithmVersion}, ${input.evaluatedAt})
    ON CONFLICT (record_a, record_b, algorithm_version, evaluated_at) DO NOTHING
    RETURNING id::text AS id
  `.execute(db);
  return result.rows[0]?.id ?? null;
}
