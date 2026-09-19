/**
 * Builders for integration tests.
 *
 * These exist so that a test reads as the scenario it describes — "USGS publishes M5.1, then
 * revises it to M5.3" — rather than as twenty lines of column assignment. Every builder takes an
 * explicit clock value: no test may depend on the wall clock (docs/TESTING.md).
 */

import { createHash, randomUUID } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';

import type { GeometryKind, HazardType, LatLon, LifecycleStatus } from '@geonerva/domain';

import type { DB } from '../generated/database.ts';
import { acquireRunLease, finishRun } from '../repositories/ingestion-runs.ts';
import {
  insertVersionIfChanged,
  type InsertVersionResult,
  type VersionGeometryInput,
} from '../repositories/observation-versions.ts';
import { resolveSourceRecord } from '../repositories/source-records.ts';

/** A deterministic 32-byte content hash for a test's notion of "this content". */
export function contentHash(...parts: readonly (string | number | boolean | null)[]): Buffer {
  return createHash('sha256').update(parts.map(String).join('\u0000'), 'utf8').digest();
}

/** Marrakech, Montréal, Suva and Longyearbyen: the reference coordinates used across the suite. */
export const PLACES = {
  marrakech: { lat: 31.63, lon: -8.0 },
  montreal: { lat: 45.5019, lon: -73.5674 },
  suva: { lat: -18.1416, lon: 178.4419 },
  /** Just across the antimeridian from Suva. */
  eastOfSuva: { lat: -18.1416, lon: -178.5 },
  longyearbyen: { lat: 78.2232, lon: 15.6267 },
} as const satisfies Record<string, LatLon>;

export interface SeedRunOptions {
  readonly sourceId?: string;
  readonly productId?: number | null;
  readonly startedAt: Date;
  readonly status?: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  readonly newestObservedAt?: Date | null;
  readonly errorClass?: 'HTTP_5XX' | 'TIMEOUT' | 'SCHEMA_DRIFT' | null;
}

/** Creates and finishes a run, returning its id and the `committed_at` it produced. */
export async function seedRun(
  db: Kysely<DB>,
  options: SeedRunOptions,
): Promise<{ runId: string; committedAt: Date }> {
  const lease = await acquireRunLease(db, {
    sourceId: options.sourceId ?? 'usgs',
    productId: options.productId ?? null,
    trigger: 'SCHEDULE',
    startedAt: options.startedAt,
  });
  if (!lease.acquired) throw new Error('could not acquire the run lease in a test');

  const status = options.status ?? 'SUCCEEDED';
  await finishRun(db, {
    runId: lease.runId,
    status,
    newestObservedAt: options.newestObservedAt ?? null,
    errorClass: options.errorClass ?? (status === 'FAILED' ? 'HTTP_5XX' : null),
    finishedAt: options.startedAt,
  });

  // `finishRun` stamps `committed_at` with `clock_timestamp()`, which is correct in production —
  // it is the moment the batch actually became visible. A test, though, describes a *simulated*
  // timeline ("the poll at 10:00, then the one at 15:00"), so the factory rewrites the stamp to
  // that timeline. This is the only place any test touches `committed_at` directly; everything
  // downstream reads it exactly as the production code would.
  const committedAt = options.startedAt;
  await sql`
    UPDATE geonerva.ingestion_runs SET committed_at = ${committedAt} WHERE id = ${lease.runId}::uuid
  `.execute(db);

  return { runId: lease.runId, committedAt };
}

export interface SeedObservationOptions {
  readonly sourceId?: string;
  readonly productId?: number | null;
  readonly hazardType?: HazardType;
  readonly primaryKey: string;
  readonly aliases?: readonly string[];
  readonly ingestedAt: Date;
  readonly observedAt?: Date;
  readonly lifecycleStatus?: LifecycleStatus;
  readonly magnitude?: number | null;
  readonly depthKm?: number | null;
  readonly contributor?: string | null;
  readonly centroid: LatLon;
  readonly geometryKind?: GeometryKind;
  readonly attributes?: Record<string, unknown>;
  readonly severityScheme?: string | null;
  readonly severityValue?: string | null;
  readonly sourceUpdatedAt?: Date | null;
  readonly geometries?: readonly VersionGeometryInput[];
  /** Overrides the derived content hash, so a test can force "unchanged" or "changed". */
  readonly contentSha256?: Buffer;
  readonly ingestionRunId?: string | null;
}

/**
 * Resolves the record identity and inserts a version if the content changed — the same path the
 * ingestion pipeline uses, so tests exercise production behaviour rather than a shortcut.
 */
export async function seedObservation(
  db: Kysely<DB>,
  options: SeedObservationOptions,
): Promise<InsertVersionResult & { sourceRecordId: string; mergedRecordIds: readonly string[] }> {
  return db.transaction().execute(async (trx: Transaction<DB>) => {
    const identity = await resolveSourceRecord(trx, {
      sourceId: options.sourceId ?? 'usgs',
      productId: options.productId ?? null,
      hazardType: options.hazardType ?? 'EARTHQUAKE',
      primaryKey: options.primaryKey,
      aliases: options.aliases,
      firstIngestedAt: options.ingestedAt,
    });

    const result = await insertVersionIfChanged(trx, {
      sourceRecordId: identity.sourceRecordId,
      hazardType: options.hazardType ?? 'EARTHQUAKE',
      ingestionRunId: options.ingestionRunId ?? null,
      ingestedAt: options.ingestedAt,
      observedAt: options.observedAt ?? options.ingestedAt,
      sourceUpdatedAt: options.sourceUpdatedAt ?? null,
      lifecycleStatus: options.lifecycleStatus ?? 'ACTIVE',
      severityScheme: options.severityScheme ?? null,
      severityValue: options.severityValue ?? null,
      contributor: options.contributor ?? null,
      magnitude: options.magnitude ?? null,
      magnitudeType: options.magnitude === undefined ? null : 'mww',
      depthKm: options.depthKm ?? null,
      centroid: options.centroid,
      geometryKind: options.geometryKind ?? 'EPICENTER',
      attributes: options.attributes ?? {},
      contentSha256:
        options.contentSha256 ??
        contentHash(
          options.primaryKey,
          options.magnitude ?? null,
          options.depthKm ?? null,
          options.centroid.lat,
          options.centroid.lon,
          options.lifecycleStatus ?? 'ACTIVE',
        ),
      geometries: options.geometries,
    });

    return {
      ...result,
      sourceRecordId: identity.sourceRecordId,
      mergedRecordIds: identity.mergedRecordIds,
    };
  });
}

/** A UUID that is stable for a given label, so failures name the same cluster every run. */
export function stableUuid(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** A fresh random UUID, for cases where stability does not matter. */
export function newUuid(): string {
  return randomUUID();
}
