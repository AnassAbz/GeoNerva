/**
 * USGS feature → GeoNerva observation. Pure: no clock, no IO, no randomness.
 *
 * The three things most likely to be got wrong, all of them silent if got wrong:
 *
 *  1. **Identity is the alias set, not `id`.** USGS says `id` "may change over time", and P0
 *     confirmed it does: querying FDSN by `us7000tiar` answers under `pr2026261000`. Keying on
 *     `id` would quietly create a second record for the same earthquake and then report two
 *     independent sources agreeing — the exact failure the independence rule exists to prevent.
 *  2. **`dmin` is in degrees, not kilometres.** The column is `min_station_distance_km`. Storing
 *     the raw value would understate the distance by ~111× and make every solution look far
 *     better constrained than it is.
 *  3. **The content hash must ignore `updated`.** USGS re-stamps `updated` on events whose
 *     content did not change; hashing it would manufacture a revision per poll, and "What
 *     Changed?" would fill with changes that never happened (ADR-029).
 */

import {
  isNormalizedLongitude,
  isNullIsland,
  isValidLatitude,
  parseHazardAttributes,
  type LatLon,
} from '@geonerva/domain';

import {
  NormalizationError,
  canonicalJson,
  contentHash,
  payloadHash,
  type NormalizeContext,
  type NormalizedRecord,
} from '../contract.ts';
import type { UsgsFeature } from './schema.ts';

/** 1° of arc at the equator, in km. USGS documents `dmin` in degrees and suggests this factor. */
const KM_PER_DEGREE = 111.195;

/** Maximum aliases the attributes schema will accept; more means our identity model is wrong. */
const MAX_ALIASES = 50;

/**
 * Splits USGS's comma-wrapped `ids` (`",nc75438582,us7000tiar,"`) into an alias set.
 *
 * Order is preserved for readability but the set is deduplicated, because a repeated alias would
 * otherwise inflate `identity_refs` and change the content hash without any change upstream.
 */
export function parseIds(ids: string | null): readonly string[] {
  if (ids === null) return [];
  const seen = new Set<string>();
  for (const part of ids.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

function optionalText(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Clamps into the range the column allows, so a provider outlier cannot fail a whole batch. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The attribute bag, built by assignment rather than spread so each provider field is converted
 * in one visible place — including the two that need a unit or a rounding decision.
 */
function buildAttributes(
  feature: UsgsFeature,
  aliases: readonly string[],
): Record<string, unknown> {
  const p = feature.properties;
  const attributes: Record<string, unknown> = { review_status: p.status };

  if (p.felt !== null) attributes['felt_reports'] = clamp(Math.round(p.felt), 0, 1_000_000);
  if (p.cdi !== null) attributes['community_intensity_cdi'] = clamp(p.cdi, 0, 12);
  if (p.mmi !== null) attributes['instrumental_intensity_mmi'] = clamp(p.mmi, 0, 12);
  if (p.tsunami !== null) attributes['tsunami_flag'] = p.tsunami === 1;
  if (p.sig !== null) attributes['significance'] = clamp(Math.round(p.sig), 0, 5_000);
  if (p.nst !== null) attributes['station_count'] = clamp(Math.round(p.nst), 0, 10_000);
  // Degrees → km. See the header: this is the unit trap.
  if (p.dmin !== null) {
    attributes['min_station_distance_km'] = clamp(p.dmin * KM_PER_DEGREE, 0, 20_000);
  }
  if (p.gap !== null) attributes['azimuthal_gap_deg'] = clamp(p.gap, 0, 360);
  if (p.rms !== null) attributes['rms_s'] = clamp(p.rms, 0, 100);
  if (aliases.length > 0) attributes['identity_refs'] = [...aliases];

  const place = optionalText(p.place);
  if (place !== undefined) attributes['region_name'] = place.slice(0, 200);
  const eventType = optionalText(p.type);
  if (eventType !== undefined) attributes['event_type'] = eventType.slice(0, 200);

  return attributes;
}

export function normalizeUsgsFeature(
  feature: UsgsFeature,
  ctx: NormalizeContext,
): NormalizedRecord {
  const p = feature.properties;
  const aliases = parseIds(p.ids);

  // Invariants, not rejects: each of these means the identity model itself is wrong, and carrying
  // on would create a duplicate record that later looks like a second independent source.
  if (!aliases.includes(feature.id)) {
    throw new NormalizationError(
      'preferred-id-in-alias-set',
      feature.id,
      `ids=${p.ids ?? '(null)'} does not contain the feature's own id`,
    );
  }
  if (aliases.length > MAX_ALIASES) {
    throw new NormalizationError(
      'alias-set-bounded',
      feature.id,
      `${aliases.length} aliases exceeds the ${MAX_ALIASES} the schema allows`,
    );
  }

  const [longitude, latitude, depth] = feature.geometry.coordinates;
  if (!isValidLatitude(latitude) || !isNormalizedLongitude(longitude)) {
    throw new NormalizationError(
      'coordinates-in-range',
      feature.id,
      `lat=${latitude} lon=${longitude} is outside the WGS84 range`,
    );
  }
  const centroid: LatLon = { lat: latitude, lon: longitude };
  if (isNullIsland(centroid)) {
    throw new NormalizationError(
      'not-null-island',
      feature.id,
      'the epicentre is exactly (0, 0), a missing-coordinate sentinel rather than a location',
    );
  }

  // The attributes schema is the frozen contract for this column. Failing it is a bug in this
  // function, not provider drift, so it raises rather than producing a record the database would
  // reject deeper in the transaction, where the diagnosis is much harder.
  const parsed = parseHazardAttributes('EARTHQUAKE', buildAttributes(feature, aliases));
  if (!parsed.ok) {
    throw new NormalizationError(
      'attributes-match-schema',
      feature.id,
      `normalized attributes are invalid: ${parsed.issues.join('; ')}`,
    );
  }

  const alert = optionalText(p.alert);
  const lifecycleStatus = p.status === 'deleted' ? 'DELETED' : 'ACTIVE';
  const contributor = optionalText(p.net) ?? null;
  const magnitudeType = optionalText(p.magType) ?? null;
  const title = optionalText(p.title) ?? null;
  const depthKm = depth;

  /*
   * What a revision means for this source. Everything GeoNerva would show or reason about is in
   * here; `updated`, feed metadata and anything derived are deliberately out, so a re-stamped
   * `updated` produces `unchanged` rather than a version.
   */
  const hashable = {
    aliases: [...aliases].sort(),
    attributes: parsed.attributes,
    contributor,
    depthKm,
    lat: latitude,
    lifecycleStatus,
    lon: longitude,
    magnitude: p.mag,
    magnitudeType,
    observedAtMs: p.time,
    primaryKey: feature.id,
    providerStatus: p.status,
    severity: alert === undefined ? null : { scheme: 'PAGER', value: alert },
    title,
  };

  const rawPayload: unknown = feature;
  return {
    primaryKey: feature.id,
    aliases,
    hazardType: ctx.descriptor.hazardType,
    observedAt: new Date(p.time),
    sourceUpdatedAt: p.updated === null ? null : new Date(p.updated),
    lifecycleStatus,
    centroid,
    geometryKind: 'EPICENTER',
    magnitude: p.mag,
    magnitudeType,
    depthKm,
    contributor,
    providerStatus: p.status,
    severityScheme: alert === undefined ? null : 'PAGER',
    severityValue: alert ?? null,
    title,
    sourceUrl: optionalText(p.url) ?? null,
    attributes: parsed.attributes,
    contentSha256: contentHash(hashable),
    rawPayload,
    // Canonical, so the same feature always dedupes to one raw row regardless of key order.
    rawPayloadSha256: payloadHash(new TextEncoder().encode(canonicalJson(rawPayload))),
  };
}
