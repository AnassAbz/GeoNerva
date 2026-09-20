/**
 * USGS feature → GeoNerva observation. Pure: no clock, no IO, no randomness.
 *
 * The things most likely to be got wrong, all of them silent if got wrong:
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
 *  4. **The hash must cover what is actually stored, at the precision it is stored.** `magnitude`
 *     and `depth_km` are `numeric(_, 2)`, so hashing the full float would make `content_sha256`
 *     impossible to re-derive from the row — and would turn a depth revision of 8.245 → 8.247
 *     into a version whose two rows both read 8.25.
 *
 * **Changing what the hash covers is an event, not a refactor.** The hash is the only change
 * detector (ADR-029), so adding or removing a field from `hashable` makes every existing record
 * look revised exactly once: the P3 rounding and alias-sorting changes produced 233 new versions
 * for 9 genuinely new records on the next live poll. That is correct behaviour and it settles
 * after one poll, but it fills "What Changed?" with revisions nothing caused, so it belongs in a
 * release note rather than in a quiet commit.
 *
 * **Which failures are per-record and which are fatal.** A bad *value* (a latitude of 91, an
 * out-of-range intensity) is one reject row: the batch survives, the reject is counted, and the
 * 20 % drift threshold decides whether the feed as a whole has changed. A broken *identity* is
 * fatal to the batch, because carrying on would fabricate a duplicate record that later reads as
 * a second independent source. `NormalizationError` carries a `reasonCode` for the first kind and
 * omits it for the second.
 */

import {
  isNullIsland,
  isValidLatitude,
  parseHazardAttributes,
  type LatLon,
  type RejectReasonCode,
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

/** `observation_versions.magnitude` and `.depth_km` are both `numeric(_, 2)`. */
const STORED_DECIMALS = 2;

/**
 * Splits USGS's comma-wrapped `ids` (`",nc75438582,us7000tiar,"`) into an alias set.
 *
 * Sorted, not feed-ordered. The set is part of the content hash, and ComCat reshuffles `ids` when
 * contributor preference changes; keeping feed order would turn a reordering into a revision that
 * says nothing happened.
 */
export function parseIds(ids: string | null): readonly string[] {
  if (ids === null) return [];
  const seen = new Set<string>();
  for (const part of ids.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen].sort();
}

/**
 * Wraps a longitude into [-180, 180).
 *
 * Exactly +180 is a real place — the Kermadec and Fiji events sit on it, and a captured month of
 * M4.5+ data reached 179.899 — but `isNormalizedLongitude` excludes it, because +180 and -180 are
 * the same meridian and the normalized form keeps one. Rejecting the record instead would take
 * the whole source down for as long as that event stayed in the feed, since `all_day` republishes
 * it for 24 hours. Wrapping is exact and loses nothing.
 */
export function wrapLongitude(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  /*
   * A value already in range is returned untouched.
   *
   * The modular arithmetic below is three floating-point operations, and on an in-range value
   * they are not free: -155.285507202148 comes back as -155.28550720214798. That is about a
   * hundredth of a millimetre and physically meaningless, but it is still GeoNerva silently
   * storing a number the provider did not send, and it would change the content hash of every
   * record for no reason. The golden snapshot caught it.
   */
  if (value >= -180 && value < 180) return value;
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  // -0 is a valid longitude but hashes differently from 0.
  return wrapped === 0 ? 0 : wrapped;
}

/**
 * Rounds to the precision the column stores, the way the column stores it.
 *
 * Not `Math.round(v * 100) / 100`. `8.245 * 100` is `824.4999…` in IEEE-754, which rounds down to
 * 8.24 — while `pg` sends the number as the decimal string `"8.245"` and PostgreSQL's `numeric`
 * rounds half away from zero to **8.25**. Rounding in binary would therefore hash a value the
 * database does not hold, which is the precise failure this rounding exists to prevent.
 *
 * So the shortest round-trip decimal string is rounded directly, as the database would.
 */
export function roundStored(value: number): number {
  if (!Number.isFinite(value)) return value;
  const text = value.toString();
  // Exponent form (1e-7) never appears in a magnitude or a depth; fall back rather than guess.
  if (text.includes('e') || text.includes('E')) return value;

  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  if (fraction.length <= STORED_DECIMALS) return value;

  const kept = fraction.slice(0, STORED_DECIMALS);
  const nextDigit = fraction.charCodeAt(STORED_DECIMALS) - 0x30;
  const scaled = BigInt(whole + kept) + (nextDigit >= 5 ? 1n : 0n);
  const digits = scaled.toString().padStart(STORED_DECIMALS + 1, '0');
  const cut = digits.length - STORED_DECIMALS;
  const rounded = `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  const result = Number(negative ? `-${rounded}` : rounded);
  // `numeric` has no negative zero — `(-0.004)::numeric(6,2)` is `0.00` — and neither should the
  // hashed value, so a depth just above sea level cannot hash two different ways.
  return result === 0 ? 0 : result;
}

function optionalText(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function rejected(
  feature: UsgsFeature,
  reasonCode: RejectReasonCode,
  message: string,
): NormalizationError {
  return new NormalizationError('value-in-range', feature.id, message, reasonCode);
}

/**
 * The attribute bag.
 *
 * Provider values are **not** clamped into range. Clamping looks harmless and is not: the clamped
 * value goes into the content hash, so a provider revising `gap` from 380 to 500 — both clamped
 * to 360 — would hash identically and the revision would be thrown away as `unchanged`. An
 * out-of-range value is drift in a field we read, so it becomes a reject the batch verdict counts.
 */
function buildAttributes(
  feature: UsgsFeature,
  aliases: readonly string[],
): Record<string, unknown> {
  const p = feature.properties;
  const attributes: Record<string, unknown> = { review_status: p.status };

  const inRange = (name: string, value: number, min: number, max: number): number => {
    if (value < min || value > max) {
      throw rejected(
        feature,
        'SCHEMA_INVALID',
        `${name}=${value} is outside the range [${min}, ${max}] this field accepts`,
      );
    }
    return value;
  };
  const asCount = (name: string, value: number, max: number): number => {
    if (!Number.isInteger(value)) {
      throw rejected(feature, 'SCHEMA_INVALID', `${name}=${value} should be a whole number`);
    }
    return inRange(name, value, 0, max);
  };

  if (p.felt !== null) attributes['felt_reports'] = asCount('felt', p.felt, 1_000_000);
  if (p.cdi !== null) attributes['community_intensity_cdi'] = inRange('cdi', p.cdi, 0, 12);
  if (p.mmi !== null) attributes['instrumental_intensity_mmi'] = inRange('mmi', p.mmi, 0, 12);
  if (p.tsunami !== null) attributes['tsunami_flag'] = p.tsunami === 1;
  if (p.sig !== null) attributes['significance'] = asCount('sig', p.sig, 5_000);
  if (p.nst !== null) attributes['station_count'] = asCount('nst', p.nst, 10_000);
  // Degrees → km. See the header: this is the unit trap.
  if (p.dmin !== null) {
    attributes['min_station_distance_km'] = roundStored(
      inRange('dmin', p.dmin, 0, 180) * KM_PER_DEGREE,
    );
  }
  if (p.gap !== null) attributes['azimuthal_gap_deg'] = inRange('gap', p.gap, 0, 360);
  if (p.rms !== null) attributes['rms_s'] = inRange('rms', p.rms, 0, 100);
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

  // Fatal, not a reject: each of these means the identity model itself is wrong, and carrying on
  // would create a duplicate record that later reads as a second independent source.
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

  const [rawLongitude, latitude, depth] = feature.geometry.coordinates;
  const longitude = wrapLongitude(rawLongitude);
  if (!isValidLatitude(latitude) || !Number.isFinite(longitude)) {
    throw rejected(
      feature,
      'COORDINATES_INVALID',
      `lat=${latitude} lon=${rawLongitude} is not a usable WGS84 position`,
    );
  }
  const centroid: LatLon = { lat: latitude, lon: longitude };
  if (isNullIsland(centroid)) {
    throw rejected(
      feature,
      'NULL_ISLAND',
      'the epicentre is exactly (0, 0), a missing-coordinate sentinel rather than a location',
    );
  }

  // The attributes schema is the frozen contract for this column, so a value it refuses after
  // the range checks above is a bug in this function rather than provider drift, and raising is
  // better than producing a record the database would reject deeper in the transaction.
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
  const sourceUrl = optionalText(p.url) ?? null;
  const magnitude = p.mag === null ? null : roundStored(p.mag);
  const depthKm = depth === null ? null : roundStored(depth);

  /*
   * What a revision means for this source. Everything GeoNerva would show or reason about is in
   * here, at the precision it is stored; `updated`, feed metadata and anything derived are
   * deliberately out, so a re-stamped `updated` produces `unchanged` rather than a version.
   *
   * `primaryKey` is included on purpose: ComCat changing an event's preferred id *is* a provider
   * statement worth recording, even though identity itself is the alias set.
   */
  const hashable = {
    aliases: [...aliases],
    attributes: parsed.attributes,
    contributor,
    depthKm,
    lat: latitude,
    lifecycleStatus,
    lon: longitude,
    magnitude,
    magnitudeType,
    observedAtMs: p.time,
    primaryKey: feature.id,
    providerStatus: p.status,
    severity: alert === undefined ? null : { scheme: 'PAGER', value: alert },
    sourceUrl,
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
    magnitude,
    magnitudeType,
    depthKm,
    contributor,
    providerStatus: p.status,
    severityScheme: alert === undefined ? null : 'PAGER',
    severityValue: alert ?? null,
    title,
    sourceUrl,
    attributes: parsed.attributes,
    contentSha256: contentHash(hashable),
    rawPayload,
    // Canonical, so the same feature always dedupes to one raw row regardless of key order.
    rawPayloadSha256: payloadHash(new TextEncoder().encode(canonicalJson(rawPayload))),
  };
}
