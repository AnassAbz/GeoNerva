/**
 * Version insertion, the content-hash comparison and head maintenance
 * (DOMAIN_MODEL §4.7, ADR-003).
 *
 * **A new version exists if and only if the normalized content hash differs from the record's
 * latest version.** Nothing else creates one. In particular a provider's "last modified" field
 * never does: GDACS bulk-restamps `datemodified` on dozens of unrelated old events within the
 * same minute (P0 verification), so trusting it would manufacture thousands of phantom revisions
 * and fill the `What Changed?` feed with noise. `source_updated_at` is *stored* — it is a real
 * provider statement and users see it — but it is not a trigger.
 *
 * Content may legitimately return to an earlier state (A → B → A). That is three versions, not
 * two: the hash comparison is against the **latest** version only, never against the whole
 * history, because "the provider changed its mind back" is itself a fact worth keeping.
 *
 * `source_record_heads` is updated in the same transaction as the insert, which is what makes the
 * "now" fast path safe to read (ARCHITECTURE §5).
 */

import { sql, type Transaction } from 'kysely';

import {
  isObservedAtAcceptable,
  isAttributesWithinSizeLimit,
  type GeometryKind,
  type GeometryRole,
  type HazardType,
  type LatLon,
  type LifecycleStatus,
} from '@geonerva/domain';

import type { DB } from '../generated/database.ts';

/** A geometry attached to a version, with its role. */
export interface VersionGeometryInput {
  readonly role: GeometryRole | string;
  readonly seq: number;
  /** GeoJSON geometry, as the adapter normalized it. */
  readonly geoJson: unknown;
  /** For forecast geometry: the time this shape applies to. */
  readonly validAt?: Date | null;
  readonly isForecast?: boolean;
}

export interface InsertVersionInput {
  readonly sourceRecordId: string;
  readonly hazardType: HazardType;
  readonly ingestionRunId?: string | null;
  /** The batch timestamp. Every version in one batch shares it. */
  readonly ingestedAt: Date;
  readonly observedAt: Date;
  readonly validFrom?: Date | null;
  readonly validTo?: Date | null;
  readonly sourceUpdatedAt?: Date | null;
  readonly lifecycleStatus: LifecycleStatus;
  readonly severityScheme?: string | null;
  readonly severityValue?: string | null;
  readonly providerStatus?: string | null;
  /** The agency credited with this solution (EMSC `auth`, USGS `net`). */
  readonly contributor?: string | null;
  readonly magnitude?: number | null;
  readonly magnitudeType?: string | null;
  readonly depthKm?: number | null;
  readonly centroid: LatLon;
  readonly geometryKind: GeometryKind;
  readonly attributes: Record<string, unknown>;
  readonly title?: string | null;
  readonly sourceUrl?: string | null;
  readonly derivedFrom?: unknown;
  /** Hash of the normalized content, as 32 raw bytes. The only change detector. */
  readonly contentSha256: Buffer;
  readonly rawRecordId?: string | null;
  readonly geometries?: readonly VersionGeometryInput[];
}

export type InsertVersionResult =
  | { readonly inserted: true; readonly versionId: string; readonly versionSeq: number }
  /** The content was identical to the latest version: counted as `unchanged`. */
  | { readonly inserted: false; readonly versionId: string; readonly versionSeq: number };

/** Raised when a version would violate a time-semantics invariant. */
export class VersionRejectedError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = 'VersionRejectedError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Inserts a version if — and only if — its content differs from the record's current head.
 *
 * The record row is locked first (`SELECT … FOR UPDATE`), which serializes two batches touching
 * the same record and makes `version_seq` gap-free without a sequence per record.
 */
export async function insertVersionIfChanged(
  trx: Transaction<DB>,
  input: InsertVersionInput,
): Promise<InsertVersionResult> {
  if (input.contentSha256.length !== 32) {
    throw new VersionRejectedError('SCHEMA_INVALID', 'content_sha256 must be 32 bytes');
  }
  if (!isObservedAtAcceptable(input.observedAt, input.ingestedAt)) {
    throw new VersionRejectedError(
      'FUTURE_OBSERVATION',
      'observed_at is more than five minutes after ingested_at (invariant I13)',
    );
  }
  if (!isAttributesWithinSizeLimit(input.attributes)) {
    throw new VersionRejectedError('SCHEMA_INVALID', 'attributes exceed the size limit');
  }

  // Lock the identity row, so concurrent batches for the same record queue rather than race.
  const locked = await sql<{ id: string }>`
    SELECT id::text AS id FROM geonerva.source_records
    WHERE id = ${input.sourceRecordId}::bigint
    FOR UPDATE
  `.execute(trx);
  if (locked.rows[0] === undefined) {
    throw new VersionRejectedError('MISSING_IDENTITY', 'source record does not exist');
  }

  const head = await sql<{
    latest_version_id: string;
    latest_version_seq: number;
    latest_content_sha256: Buffer;
  }>`
    SELECT latest_version_id::text AS latest_version_id, latest_version_seq, latest_content_sha256
    FROM geonerva.source_record_heads
    WHERE source_record_id = ${input.sourceRecordId}::bigint
  `.execute(trx);

  const current = head.rows[0];
  if (current !== undefined && current.latest_content_sha256.equals(input.contentSha256)) {
    return {
      inserted: false,
      versionId: current.latest_version_id,
      versionSeq: current.latest_version_seq,
    };
  }

  const versionSeq = (current?.latest_version_seq ?? 0) + 1;

  const inserted = await sql<{ id: string }>`
    INSERT INTO geonerva.observation_versions (
      source_record_id, version_seq, hazard_type, ingestion_run_id, ingested_at, observed_at,
      valid_from, valid_to, source_updated_at, lifecycle_status, severity_scheme, severity_value,
      provider_status, contributor, magnitude, magnitude_type, depth_km, centroid, geometry_kind,
      attributes, title, source_url, derived_from, content_sha256, raw_record_id)
    VALUES (
      ${input.sourceRecordId}::bigint, ${versionSeq}, ${input.hazardType},
      ${input.ingestionRunId ?? null}::uuid, ${input.ingestedAt}, ${input.observedAt},
      ${input.validFrom ?? null}, ${input.validTo ?? null}, ${input.sourceUpdatedAt ?? null},
      ${input.lifecycleStatus}, ${input.severityScheme ?? null}, ${input.severityValue ?? null},
      ${input.providerStatus ?? null}, ${input.contributor ?? null},
      ${input.magnitude ?? null}, ${input.magnitudeType ?? null}, ${input.depthKm ?? null},
      ST_SetSRID(ST_MakePoint(${input.centroid.lon}, ${input.centroid.lat}), 4326)::geography,
      ${input.geometryKind}, ${JSON.stringify(input.attributes)}::jsonb,
      ${input.title ?? null}, ${input.sourceUrl ?? null},
      ${input.derivedFrom === undefined || input.derivedFrom === null ? null : JSON.stringify(input.derivedFrom)}::jsonb,
      ${input.contentSha256}, ${input.rawRecordId ?? null}::bigint)
    RETURNING id::text AS id
  `.execute(trx);

  const versionId = inserted.rows[0]?.id;
  if (versionId === undefined) throw new Error('failed to insert observation version');

  for (const geometry of input.geometries ?? []) {
    await sql`
      INSERT INTO geonerva.observation_geometries
        (observation_version_id, role, seq, valid_at, is_forecast, geog)
      VALUES (${versionId}::bigint, ${geometry.role}, ${geometry.seq},
              ${geometry.validAt ?? null}, ${geometry.isForecast ?? false},
              ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry.geoJson)}), 4326)::geography)
    `.execute(trx);
  }

  // Head maintenance, in the same transaction. This is what makes the "now" fast path equal to
  // the as-of path by construction rather than by hope.
  await sql`
    INSERT INTO geonerva.source_record_heads
      (source_record_id, latest_version_id, latest_version_seq, latest_ingested_at,
       latest_content_sha256)
    VALUES (${input.sourceRecordId}::bigint, ${versionId}::bigint, ${versionSeq},
            ${input.ingestedAt}, ${input.contentSha256})
    ON CONFLICT (source_record_id) DO UPDATE
      SET latest_version_id = EXCLUDED.latest_version_id,
          latest_version_seq = EXCLUDED.latest_version_seq,
          latest_ingested_at = EXCLUDED.latest_ingested_at,
          latest_content_sha256 = EXCLUDED.latest_content_sha256
  `.execute(trx);

  return { inserted: true, versionId, versionSeq };
}

/**
 * Writes a tombstone: a version that says the record no longer stands, carrying the previous
 * content forward so the event detail page can still show what was believed.
 *
 * `DELETED` means the provider said so. `MISSING_FROM_SOURCE` means GeoNerva inferred it, because
 * the record vanished from a source with no deletion channel — EMSC's FDSN API cannot be queried
 * for deletions, so a `unid` absent from two consecutive 7-day reconciles gets this status. The
 * distinction is preserved because one is a provider statement and the other is our inference.
 */
export async function insertTombstone(
  trx: Transaction<DB>,
  input: {
    readonly sourceRecordId: string;
    readonly status: 'DELETED' | 'MISSING_FROM_SOURCE';
    readonly ingestedAt: Date;
    readonly ingestionRunId?: string | null;
    readonly contentSha256: Buffer;
  },
): Promise<InsertVersionResult> {
  const previous = await sql<{
    hazard_type: string;
    observed_at: Date;
    valid_from: Date | null;
    valid_to: Date | null;
    source_updated_at: Date | null;
    severity_scheme: string | null;
    severity_value: string | null;
    provider_status: string | null;
    contributor: string | null;
    magnitude: string | null;
    magnitude_type: string | null;
    depth_km: string | null;
    lat: number;
    lon: number;
    geometry_kind: string;
    attributes: Record<string, unknown>;
    title: string | null;
    source_url: string | null;
    derived_from: unknown;
    raw_record_id: string | null;
  }>`
    SELECT v.hazard_type, v.observed_at, v.valid_from, v.valid_to, v.source_updated_at,
           v.severity_scheme, v.severity_value, v.provider_status, v.contributor,
           v.magnitude, v.magnitude_type, v.depth_km,
           ST_Y(v.centroid::geometry) AS lat, ST_X(v.centroid::geometry) AS lon,
           v.geometry_kind, v.attributes, v.title, v.source_url, v.derived_from,
           v.raw_record_id::text AS raw_record_id
    FROM geonerva.source_record_heads h
    JOIN geonerva.observation_versions v ON v.id = h.latest_version_id
    WHERE h.source_record_id = ${input.sourceRecordId}::bigint
  `.execute(trx);

  const row = previous.rows[0];
  if (row === undefined) {
    throw new VersionRejectedError(
      'MISSING_IDENTITY',
      'cannot tombstone a record that has no versions',
    );
  }

  return insertVersionIfChanged(trx, {
    sourceRecordId: input.sourceRecordId,
    hazardType: row.hazard_type as HazardType,
    ingestionRunId: input.ingestionRunId ?? null,
    ingestedAt: input.ingestedAt,
    observedAt: row.observed_at,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    sourceUpdatedAt: row.source_updated_at,
    lifecycleStatus: input.status,
    severityScheme: row.severity_scheme,
    severityValue: row.severity_value,
    providerStatus: row.provider_status,
    contributor: row.contributor,
    magnitude: row.magnitude === null ? null : Number(row.magnitude),
    magnitudeType: row.magnitude_type,
    depthKm: row.depth_km === null ? null : Number(row.depth_km),
    centroid: { lat: row.lat, lon: row.lon },
    geometryKind: row.geometry_kind as GeometryKind,
    attributes: row.attributes,
    title: row.title,
    sourceUrl: row.source_url,
    derivedFrom: row.derived_from,
    contentSha256: input.contentSha256,
    rawRecordId: row.raw_record_id,
  });
}

export interface VersionRow {
  readonly id: string;
  readonly sourceRecordId: string;
  readonly versionSeq: number;
  readonly ingestedAt: Date;
  readonly observedAt: Date;
  readonly lifecycleStatus: string;
  readonly contentSha256: Buffer;
}

/** Every version of a record, oldest first: the audit trail behind the event timeline. */
export async function listVersions(
  trx: Transaction<DB> | import('kysely').Kysely<DB>,
  sourceRecordId: string,
  options: { asOf?: Date } = {},
): Promise<VersionRow[]> {
  const asOfFilter =
    options.asOf === undefined ? sql`TRUE` : sql`v.ingested_at <= ${options.asOf}`;
  const result = await sql<{
    id: string;
    source_record_id: string;
    version_seq: number;
    ingested_at: Date;
    observed_at: Date;
    lifecycle_status: string;
    content_sha256: Buffer;
  }>`
    SELECT v.id::text AS id, v.source_record_id::text AS source_record_id, v.version_seq,
           v.ingested_at, v.observed_at, v.lifecycle_status, v.content_sha256
    FROM geonerva.observation_versions v
    WHERE v.source_record_id = ${sourceRecordId}::bigint AND ${asOfFilter}
    ORDER BY v.version_seq
  `.execute(trx);

  return result.rows.map((row) => ({
    id: row.id,
    sourceRecordId: row.source_record_id,
    versionSeq: row.version_seq,
    ingestedAt: row.ingested_at,
    observedAt: row.observed_at,
    lifecycleStatus: row.lifecycle_status,
    contentSha256: row.content_sha256,
  }));
}

/**
 * Rebuilds `source_record_heads` from the versions table.
 *
 * The cache is derived data, so it must be reconstructible; this is what the equivalence test
 * uses to prove that the fast path cannot drift from the truth, and what an operator runs if it
 * ever does.
 */
export async function rebuildHeads(trx: Transaction<DB>): Promise<number> {
  await sql`DELETE FROM geonerva.source_record_heads`.execute(trx);
  const result = await sql`
    INSERT INTO geonerva.source_record_heads
      (source_record_id, latest_version_id, latest_version_seq, latest_ingested_at,
       latest_content_sha256)
    SELECT DISTINCT ON (v.source_record_id)
           v.source_record_id, v.id, v.version_seq, v.ingested_at, v.content_sha256
    FROM geonerva.observation_versions v
    ORDER BY v.source_record_id, v.ingested_at DESC, v.version_seq DESC
  `.execute(trx);
  return Number(result.numAffectedRows ?? 0n);
}
