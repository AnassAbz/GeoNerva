/**
 * The reads correlation needs, and only those (ARCHITECTURE §6.1).
 *
 * These are **write-side** reads: they run inside the derivation that builds canonical events, at
 * the derivation's own knowledge time, and they are not the path a briefing takes. That is why
 * they live in `repositories/` rather than in `asof.ts` — the as-of layer answers "what did
 * GeoNerva know at T", and the dependency rules stop the web app reaching anything here at all.
 *
 * Candidate generation reads `canonical_event_state`, which ARCHITECTURE §6.1 names explicitly:
 * it is the indexed "now" projection, and correlation is the thing that keeps it current. Using a
 * cache to *build* facts is sound in a way that using one to *replay* them is not.
 */

import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../generated/database.ts';

type Db = Kysely<DB> | Transaction<DB>;

/** The latest version of one earthquake record, shaped for the correlation engine. */
export interface CorrelationRecordRow {
  readonly source_record_id: string;
  readonly source_id: string;
  readonly primary_key: string;
  /** Only populated by `recordsNeedingSeedEvent`, where the caller is not family-specific. */
  readonly hazard_type?: string;
  readonly version_id: string;
  readonly ingested_at: Date;
  readonly observed_at: Date;
  readonly lat: number;
  readonly lon: number;
  readonly magnitude: string | null;
  readonly magnitude_type: string | null;
  readonly depth_km: string | null;
  readonly contributor: string | null;
  readonly provider_status: string | null;
  readonly lifecycle_status: string;
  readonly derived_from: unknown;
  /** The active link, when the record already belongs to an event. */
  readonly link_id: string | null;
  readonly canonical_event_id: string | null;
  readonly linked_at: Date | null;
  readonly link_algorithm_version: string | null;
}

/**
 * Earthquake records whose correlation is not up to date at `asOf`.
 *
 * Two populations, deliberately in one query: records with no active link at all, and linked
 * records whose latest version was ingested *after* the link was decided. The second is the
 * revision case — a solution that moved has to be re-checked against the event it joined, because
 * the reason it joined may no longer hold.
 *
 * The order is `observed_at, source_record_id`: correlating in origin-time order means an
 * aftershock is scored against events that already exist rather than against whichever record the
 * planner returned first, and the id tiebreak stops two records with identical origin times from
 * deciding the outcome by row order.
 */
export async function earthquakeRecordsToCorrelate(
  db: Db,
  options: { readonly asOf: Date; readonly limit?: number; readonly sourceIds?: readonly string[] },
): Promise<CorrelationRecordRow[]> {
  const sourceFilter =
    options.sourceIds === undefined
      ? sql`TRUE`
      : sql`r.source_id = ANY(${sql.val(options.sourceIds)}::text[])`;

  const result = await sql<CorrelationRecordRow>`
    WITH latest AS (
      SELECT DISTINCT ON (v.source_record_id)
             v.source_record_id::text            AS source_record_id,
             r.source_id,
             r.primary_key,
             v.id::text                          AS version_id,
             v.ingested_at,
             v.observed_at,
             ST_Y(v.centroid::geometry)          AS lat,
             ST_X(v.centroid::geometry)          AS lon,
             v.magnitude,
             v.magnitude_type,
             v.depth_km,
             v.contributor,
             v.provider_status,
             v.lifecycle_status,
             v.derived_from
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE r.hazard_type = 'EARTHQUAKE'
        AND r.merged_into IS NULL
        AND v.ingested_at <= ${options.asOf}
        AND ${sourceFilter}
      ORDER BY v.source_record_id, v.ingested_at DESC, v.version_seq DESC
    )
    SELECT latest.*,
           l.id::text                 AS link_id,
           l.canonical_event_id::text AS canonical_event_id,
           l.linked_at,
           l.algorithm_version        AS link_algorithm_version
    FROM latest
    LEFT JOIN geonerva.canonical_links l
           ON l.source_record_id = latest.source_record_id::bigint AND l.unlinked_at IS NULL
    WHERE latest.lifecycle_status NOT IN ('DELETED', 'MISSING_FROM_SOURCE')
      AND (l.id IS NULL OR l.linked_at < latest.ingested_at)
    ORDER BY latest.observed_at, latest.source_record_id::bigint
    LIMIT ${options.limit ?? 5000}
  `.execute(db);
  return [...result.rows];
}

export interface CandidateEventRow {
  readonly canonical_event_id: string;
  readonly observed_at: Date;
  readonly lat: number;
  readonly lon: number;
  readonly magnitude: string | null;
  readonly headline: unknown;
  readonly member_source_ids: readonly string[];
}

/**
 * Canonical events inside the candidate window, from the indexed projection.
 *
 * The window is the *generation* step, not the decision: it is deliberately wider than anything
 * that could match, so that the misfit — not an index predicate — is what rejects a pair. Events
 * already merged into another are excluded, because linking to a redirect would attach a record
 * to an identity that no longer exists.
 */
export async function candidateEventsNear(
  db: Db,
  options: {
    readonly originTime: Date;
    readonly epicentre: { readonly lat: number; readonly lon: number };
    readonly maxDeltaSeconds: number;
    readonly maxDistanceMeters: number;
    readonly excludeEventIds?: readonly string[];
  },
): Promise<CandidateEventRow[]> {
  const exclusion =
    options.excludeEventIds === undefined || options.excludeEventIds.length === 0
      ? sql`TRUE`
      : sql`s.canonical_event_id <> ALL(${sql.val(options.excludeEventIds)}::uuid[])`;

  const result = await sql<CandidateEventRow>`
    SELECT s.canonical_event_id::text          AS canonical_event_id,
           s.observed_at,
           ST_Y(s.centroid::geometry)          AS lat,
           ST_X(s.centroid::geometry)          AS lon,
           s.magnitude,
           s.headline,
           coalesce(
             array_agg(DISTINCT r.source_id) FILTER (WHERE r.source_id IS NOT NULL),
             '{}'::text[])                     AS member_source_ids
    FROM geonerva.canonical_event_state s
    JOIN geonerva.canonical_events e ON e.id = s.canonical_event_id
    LEFT JOIN geonerva.canonical_links l
           ON l.canonical_event_id = s.canonical_event_id AND l.unlinked_at IS NULL
    LEFT JOIN geonerva.source_records r ON r.id = l.source_record_id
    WHERE s.hazard_type = 'EARTHQUAKE'
      AND e.merged_into IS NULL
      AND s.observed_at >= ${options.originTime}::timestamptz
            - make_interval(secs => ${options.maxDeltaSeconds})
      AND s.observed_at <= ${options.originTime}::timestamptz
            + make_interval(secs => ${options.maxDeltaSeconds})
      AND ST_DWithin(
            s.centroid,
            ST_SetSRID(ST_MakePoint(${options.epicentre.lon}, ${options.epicentre.lat}), 4326)::geography,
            ${options.maxDistanceMeters})
      AND ${exclusion}
    GROUP BY s.canonical_event_id, s.observed_at, s.centroid, s.magnitude, s.headline
    ORDER BY s.canonical_event_id
  `.execute(db);
  return [...result.rows];
}

export interface EventMemberRow {
  readonly source_record_id: string;
  readonly source_id: string;
  readonly primary_key: string;
  readonly relation: string;
  readonly observed_at: Date;
  readonly lat: number;
  readonly lon: number;
  readonly magnitude: string | null;
  readonly magnitude_type: string | null;
  readonly depth_km: string | null;
  readonly provider_status: string | null;
  readonly contributor: string | null;
  readonly title: string | null;
  readonly source_url: string | null;
  readonly ingested_at: Date;
}

/**
 * The active members of a canonical event, each at its latest version.
 *
 * Ordered by source record id so the projection built from them cannot vary with row order — the
 * agreement spread is order-independent by construction, but the headline's final tiebreak and
 * the stored member list are not.
 */
export async function eventMembers(db: Db, canonicalEventId: string): Promise<EventMemberRow[]> {
  const result = await sql<EventMemberRow>`
    SELECT l.source_record_id::text  AS source_record_id,
           r.source_id,
           r.primary_key,
           l.relation,
           v.observed_at,
           ST_Y(v.centroid::geometry) AS lat,
           ST_X(v.centroid::geometry) AS lon,
           v.magnitude,
           v.magnitude_type,
           v.depth_km,
           v.provider_status,
           v.contributor,
           v.title,
           v.source_url,
           v.ingested_at
    FROM geonerva.canonical_links l
    JOIN geonerva.source_records r ON r.id = l.source_record_id
    JOIN LATERAL (
      SELECT ov.*
      FROM geonerva.observation_versions ov
      WHERE ov.source_record_id = l.source_record_id
      ORDER BY ov.ingested_at DESC, ov.version_seq DESC
      LIMIT 1
    ) v ON TRUE
    WHERE l.canonical_event_id = ${canonicalEventId}::uuid
      AND l.unlinked_at IS NULL
    ORDER BY l.source_record_id
  `.execute(db);
  return [...result.rows];
}

/**
 * The canonical event a provider's cross-reference points at, or `null`.
 *
 * Stage 1 in one query: an alias of the referenced provider id, the source record that holds it,
 * and that record's active link. Merge redirects are followed, because a reference to an id that
 * ComCat has since merged still identifies the surviving earthquake.
 */
export async function canonicalEventForAlias(
  db: Db,
  sourceId: string,
  alias: string,
): Promise<{ canonicalEventId: string; sourceRecordId: string } | null> {
  const result = await sql<{ canonical_event_id: string; source_record_id: string }>`
    WITH RECURSIVE matched AS (
      SELECT a.source_record_id
      FROM geonerva.source_record_aliases a
      JOIN geonerva.source_records r ON r.id = a.source_record_id
      WHERE r.source_id = ${sourceId} AND a.alias = ${alias}
    ),
    survivor AS (
      SELECT m.source_record_id AS id, r.merged_into
      FROM matched m JOIN geonerva.source_records r ON r.id = m.source_record_id
      UNION ALL
      SELECT r.id, r.merged_into
      FROM survivor s JOIN geonerva.source_records r ON r.id = s.merged_into
    )
    SELECT l.canonical_event_id::text AS canonical_event_id,
           l.source_record_id::text   AS source_record_id
    FROM survivor s
    JOIN geonerva.canonical_links l
      ON l.source_record_id = s.id AND l.unlinked_at IS NULL
    JOIN geonerva.canonical_events e
      ON e.id = l.canonical_event_id AND e.merged_into IS NULL
    WHERE s.merged_into IS NULL
    ORDER BY l.canonical_event_id
    LIMIT 1
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { canonicalEventId: row.canonical_event_id, sourceRecordId: row.source_record_id };
}

/**
 * The newest earthquake fact visible at `asOf`, by ingestion time.
 *
 * This is the input `resolveAvailability` compares a derivation's last success against: if a fact
 * arrived after correlation last ran, the canonical events on screen are behind the fact store
 * and a zero among them is not an observation.
 */
export async function newestEarthquakeIngestAt(db: Db, asOf: Date): Promise<Date | null> {
  const result = await sql<{ newest: Date | null }>`
    SELECT max(v.ingested_at) AS newest
    FROM geonerva.observation_versions v
    JOIN geonerva.source_records r ON r.id = v.source_record_id
    WHERE r.hazard_type = 'EARTHQUAKE' AND v.ingested_at <= ${asOf}
  `.execute(db);
  return result.rows[0]?.newest ?? null;
}

/**
 * Records of a non-correlated hazard type that have no canonical event yet.
 *
 * GeoNerva holds exactly **one** source for floods, cyclones, volcanoes and droughts, so there is
 * nothing to correlate them *against* — ARCHITECTURE §6.2 makes each one its own canonical event.
 * That is not a decision the matcher made; it is the absence of a second opinion, and the event
 * exists so the read model has a stable subject to point at.
 *
 * Only records with no link at all are returned. Unlike an earthquake, a revision here cannot
 * break a match, because there is no match to break.
 */
export async function recordsNeedingSeedEvent(
  db: Db,
  options: {
    readonly asOf: Date;
    readonly hazardTypes: readonly string[];
    readonly limit?: number;
  },
): Promise<CorrelationRecordRow[]> {
  const result = await sql<CorrelationRecordRow>`
    WITH latest AS (
      SELECT DISTINCT ON (v.source_record_id)
             v.source_record_id::text            AS source_record_id,
             r.source_id,
             r.primary_key,
             r.hazard_type,
             v.id::text                          AS version_id,
             v.ingested_at,
             v.observed_at,
             ST_Y(v.centroid::geometry)          AS lat,
             ST_X(v.centroid::geometry)          AS lon,
             v.magnitude,
             v.magnitude_type,
             v.depth_km,
             v.contributor,
             v.provider_status,
             v.lifecycle_status,
             v.derived_from
      FROM geonerva.observation_versions v
      JOIN geonerva.source_records r ON r.id = v.source_record_id
      WHERE r.hazard_type = ANY(${sql.val(options.hazardTypes)}::text[])
        AND r.merged_into IS NULL
        AND v.ingested_at <= ${options.asOf}
      ORDER BY v.source_record_id, v.ingested_at DESC, v.version_seq DESC
    )
    SELECT latest.*,
           NULL::text        AS link_id,
           NULL::text        AS canonical_event_id,
           NULL::timestamptz AS linked_at,
           NULL::text        AS link_algorithm_version
    FROM latest
    WHERE latest.lifecycle_status NOT IN ('DELETED', 'MISSING_FROM_SOURCE')
      AND NOT EXISTS (
        SELECT 1 FROM geonerva.canonical_links l
        WHERE l.source_record_id = latest.source_record_id::bigint AND l.unlinked_at IS NULL
      )
    ORDER BY latest.observed_at, latest.source_record_id::bigint
    LIMIT ${options.limit ?? 5000}
  `.execute(db);
  return [...result.rows];
}
