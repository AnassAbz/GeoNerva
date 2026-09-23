/**
 * The member solutions of a canonical event, and the one numeric coercion the read models share.
 *
 * Extracted from `snapshot.ts` so that the baseline metrics can reach it without importing the
 * snapshot builder. `snapshot.ts` is the module that *assembles cards*, and cards now carry a
 * baseline metric — so `snapshot.ts → baseline-metrics.ts` is the direction the dependency has to
 * run, and anything both of them need has to sit below both. `no-circular` in
 * `.dependency-cruiser.cjs` is what makes that a rule rather than a preference.
 *
 * Nothing here is new behaviour: both functions are the ones `snapshot.ts` exported, moved
 * verbatim and still re-exported from there so every existing importer keeps working.
 */

import type { MemberSolution } from '@geonerva/correlation';
import type { LinkRow, ObservationRow } from '@geonerva/db/asof';

/**
 * The correlation package's view of one event's members.
 *
 * `relation` is narrowed to the two values agreement cares about: a derived copy is not a second
 * opinion, and everything else is a member of the same event.
 */
export function memberSolutionsOf(
  rows: readonly ObservationRow[],
  linkByRecord: ReadonlyMap<string, LinkRow>,
): MemberSolution[] {
  return rows.map((row) => ({
    sourceId: row.source_id,
    sourceRecordId: row.source_record_id,
    relation:
      linkByRecord.get(row.source_record_id)?.relation === 'DERIVED_COPY'
        ? 'DERIVED_COPY'
        : 'SAME_EVENT',
    epicentre: { lat: row.lat, lon: row.lon },
    magnitude: numberOf(row.magnitude),
    magnitudeType: row.magnitude_type,
    depthKm: numberOf(row.depth_km),
    providerStatus: row.provider_status,
    contributor: row.contributor,
  }));
}

/** `numeric` columns arrive as strings; a non-finite one is absent, never zero. */
export function numberOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
