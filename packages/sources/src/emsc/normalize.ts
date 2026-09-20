/**
 * EMSC feature → GeoNerva observation. Pure: no clock, no IO, no randomness.
 *
 * EMSC is the second earthquake source, and the value of a second source is entirely in its
 * independence: GDACS restates NEIC solutions, so without EMSC there is no genuine cross-source
 * agreement to show. That makes the failure mode here worse than for a lone source — a record
 * mangled in a way that still looks plausible becomes *corroborating evidence* for something that
 * never happened. The four things below are all silent if got wrong.
 *
 *  1. **Depth is `properties.depth`, and the GeoJSON z cannot be used at all.** For the live RTS
 *     catalogue `coordinates[2]` is the *negation* of the depth — an 8.1 km event publishes
 *     z = -8.1, and a Hawaiʻi event 0.2 km *above* the datum publishes `depth: -0.2` with
 *     z = 0.2. For the EMSC-EMB merged bulletin it is the depth itself: of 97 events on
 *     2010-01-01, 78 EMB records publish z = +depth and 12 RTS records publish z = -depth (the
 *     7 remaining EMB records are at depth 0, where both are the same number).
 *
 *     So there is no sign convention to follow, only two of them, and which one applies depends
 *     on a field the GeoJSON itself does not carry. The USGS adapter reads the z because for
 *     USGS the z *is* the depth; copying that line inverted 78 of 97 historical depths, and
 *     every value stayed plausible. What the data does support is that the **magnitudes** always
 *     agree, so that is what is checked — it still catches the z becoming some unrelated number,
 *     without asserting a sign rule the provider does not keep.
 *
 *     Found by a live backfill of one 2010 day rejecting 73 % of its records, against the sign
 *     check that assumed the RTS convention held everywhere. Fixture: `emsc/emb-2010-day.json`.
 *
 *  2. **Identity is `unid`, not the feature `id`.** They agree in everything observed, which is
 *     exactly why the check is cheap and worth making: `unid` is what EMSC documents as stable
 *     and `id` is what a serializer is free to restate. Disagreement is fatal to the batch, not a
 *     reject, because ingesting under the wrong key fabricates a duplicate record that later
 *     reads as a second independent source — the most expensive mistake this system can make.
 *  3. **`lastupdate` is out of the content hash.** ADR-029: the hash is the only change detector,
 *     and hashing a revision stamp manufactures a version per poll.
 *  4. **`magtype` case is not stable.** Recent events carry `ml`, older ones `MD`, for the same
 *     scale. Hashing the provider's casing would turn a re-cased bulletin into a revision of
 *     every record in it, so it is lower-cased — magnitude scale names are case-insensitive by
 *     convention, and `Mw` and `mw` are not two different measurements.
 *
 * **What is deliberately *not* interpreted.** `evtype` is stored verbatim. Live counts over 2,000
 * recent events were `ke` 1,990, `ue` 7, `se` 3, and EMSC's WADL documents no vocabulary for the
 * field. Expanding three observed codes from inference would risk presenting, say, a mining or
 * nuclear explosion as an earthquake — a wrong expansion is worse than an opaque one, and the
 * opaque one can be fixed once the vocabulary is confirmed with EMSC.
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
import {
  DEPTH_KM_RANGE,
  MAGNITUDE_RANGE,
  roundStored,
  withinStoredRange,
  wrapLongitude,
} from '../usgs/normalize.ts';
import type { EmscFeature } from './schema.ts';

/**
 * How far |`geometry.coordinates[2]`| may sit from |`properties.depth`| before the record is
 * refused.
 *
 * Not zero. The two are serialized independently and EMSC prints them at different precisions —
 * `depth: 9` against z `9.0` is common — so an exact comparison would reject on formatting. A
 * metre is far below anything a hypocentre is determined to and far above any rounding EMSC does,
 *
 * Absolute values, because the *sign* differs between EMSC's two catalogues and only the
 * magnitude is a claim both of them make. See the header.
 */
const DEPTH_AGREEMENT_KM = 0.001;

/**
 * How far `properties.lat`/`lon` may sit from the geometry before the record is refused.
 *
 * ~1 metre at the equator. The same reasoning: the pair is redundant, redundancy is only useful
 * if it is checked, and a position that disagrees with its own geometry is not a position.
 */
const POSITION_AGREEMENT_DEG = 0.00001;

function rejected(unid: string, reasonCode: RejectReasonCode, message: string): NormalizationError {
  return new NormalizationError('value-in-range', unid, message, reasonCode);
}

function optionalText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parses an instant EMSC has already been validated to emit, and refuses anything else.
 *
 * The schema proved it parses; this proves it is a *usable* instant. A year 0001 or a year 9999
 * passes `Date.parse` and would go into a `timestamptz` column and a time-ordered read path as a
 * fact about the world.
 */
function instant(unid: string, field: string, value: string): Date {
  const parsed = new Date(value);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) {
    throw rejected(unid, 'SCHEMA_INVALID', `${field}=${value} is not a usable instant`);
  }
  // 1900 and 2100. EMSC's own catalogue starts in 1998; anything outside this is not a revision
  // of a real event, it is a corrupt field that would sort to one end of every query forever.
  if (ms < -2_208_988_800_000 || ms > 4_102_444_800_000) {
    throw rejected(unid, 'SCHEMA_INVALID', `${field}=${value} is outside [1900, 2100)`);
  }
  return parsed;
}

function buildAttributes(feature: EmscFeature, unid: string): Record<string, unknown> {
  const p = feature.properties;
  const attributes: Record<string, unknown> = { identity_refs: [unid] };

  const region = optionalText(p.flynn_region);
  if (region !== undefined) attributes['region_name'] = region.slice(0, 200);
  const eventType = optionalText(p.evtype);
  if (eventType !== undefined) attributes['event_type'] = eventType.slice(0, 200);
  /*
   * Which catalogue the row came from, per record rather than per product.
   *
   * The seeded product is `emsc/rts`, and a live poll really is all `EMSC-RTS`. A backfill is not:
   * a single day in 2010 came back 85 `EMSC-EMB` — the merged bulletin, revised long after the
   * fact — to 12 `EMSC-RTS`. Labelling those as RTS because the product says so would be GeoNerva
   * asserting a provenance the provider contradicted in the same response.
   */
  const catalog = optionalText(p.source_catalog);
  if (catalog !== undefined) attributes['provider_catalog'] = catalog.slice(0, 200);

  return attributes;
}

export function normalizeEmscFeature(
  feature: EmscFeature,
  ctx: NormalizeContext,
): NormalizedRecord {
  const p = feature.properties;
  const unid = p.unid.trim();

  // Fatal, not a reject: an identity that cannot be trusted fabricates duplicate records.
  if (unid.length === 0) {
    throw new NormalizationError('identity-present', p.unid, 'unid is blank');
  }
  if (feature.id !== null && feature.id !== undefined && feature.id.trim() !== unid) {
    throw new NormalizationError(
      'feature-id-matches-unid',
      unid,
      `the feature id ${feature.id} disagrees with unid ${unid}`,
    );
  }

  /*
   * The alias set is exactly `[unid]`.
   *
   * `source_id` is deliberately excluded. It is unique only within `source_catalog`, and the same
   * response carries two catalogues — so `2037122` as a bare alias could collide with a different
   * event from the other catalogue and merge two earthquakes into one record. It is recorded as
   * context instead. EMSC publishes no foreign identifiers in the event JSON at all: the USGS id
   * is available only from the separate EventID service, as a *fuzzy* misfit match, which is
   * correlation evidence and not identity (ADR-005).
   */
  const aliases: readonly string[] = [unid];

  const [geoLon, geoLat, geoZ] = feature.geometry.coordinates;
  const longitude = wrapLongitude(p.lon);
  const latitude = p.lat;
  if (!isValidLatitude(latitude) || !Number.isFinite(longitude)) {
    throw rejected(
      unid,
      'COORDINATES_INVALID',
      `lat=${latitude} lon=${p.lon} is not a usable WGS84 position`,
    );
  }
  if (
    Math.abs(latitude - geoLat) > POSITION_AGREEMENT_DEG ||
    Math.abs(wrapLongitude(geoLon) - longitude) > POSITION_AGREEMENT_DEG
  ) {
    throw rejected(
      unid,
      'COORDINATES_INVALID',
      `properties (${latitude}, ${p.lon}) disagree with geometry (${geoLat}, ${geoLon})`,
    );
  }
  const centroid: LatLon = { lat: latitude, lon: longitude };
  if (isNullIsland(centroid)) {
    throw rejected(
      unid,
      'NULL_ISLAND',
      'the epicentre is exactly (0, 0), a missing-coordinate sentinel rather than a location',
    );
  }

  /*
   * The depth, and a cross-check of the one thing both serializers agree on.
   *
   * `geoZ` is optional in the schema because a two-element coordinate pair is valid GeoJSON; when
   * EMSC sends it — it always has — its magnitude must be the depth's. Its *sign* must not be
   * read: RTS negates it and EMB does not.
   */
  // Bounded before it can reach `numeric(6, 2)`, where an overflow is batch-fatal rather than a
  // reject — see `DEPTH_KM_RANGE`.
  if (p.depth !== null && !withinStoredRange(p.depth, DEPTH_KM_RANGE)) {
    throw rejected(
      unid,
      'SCHEMA_INVALID',
      `depth=${p.depth} km is outside [${DEPTH_KM_RANGE.min}, ${DEPTH_KM_RANGE.max}]`,
    );
  }
  const depthKm = p.depth === null ? null : roundStored(p.depth);
  if (p.depth !== null && geoZ !== undefined) {
    if (Math.abs(Math.abs(geoZ) - Math.abs(p.depth)) > DEPTH_AGREEMENT_KM) {
      throw rejected(
        unid,
        'SCHEMA_INVALID',
        `depth=${p.depth} and geometry z=${geoZ} are not the same distance, so they are not the same measurement`,
      );
    }
  }

  const parsed = parseHazardAttributes('EARTHQUAKE', buildAttributes(feature, unid));
  if (!parsed.ok) {
    throw new NormalizationError(
      'attributes-match-schema',
      unid,
      `normalized attributes are invalid: ${parsed.issues.join('; ')}`,
    );
  }

  const observedAt = instant(unid, 'time', p.time);
  const sourceUpdatedAt = p.lastupdate === null ? null : instant(unid, 'lastupdate', p.lastupdate);
  // An absent key and an explicit null are the same fact: EMSC has no magnitude for this event.
  // (They are *not* the same fact at batch level — see the drift check in the parser.)
  if (p.mag !== null && p.mag !== undefined && !withinStoredRange(p.mag, MAGNITUDE_RANGE)) {
    throw rejected(
      unid,
      'SCHEMA_INVALID',
      `mag=${p.mag} is outside [${MAGNITUDE_RANGE.min}, ${MAGNITUDE_RANGE.max}]`,
    );
  }
  const magnitude = p.mag === null || p.mag === undefined ? null : roundStored(p.mag);
  const magnitudeType = optionalText(p.magtype)?.toLowerCase() ?? null;
  const contributor = optionalText(p.auth) ?? null;
  const region = optionalText(p.flynn_region) ?? null;

  /*
   * A title, because every other source has one and a read path that has to special-case a null
   * title for one source will eventually forget to. Composed from what EMSC sends and nothing
   * else: the region as published, and the magnitude at the precision it is stored, so the string
   * cannot disagree with the column beside it.
   *
   * It is in the hash, and that is correct — it is a function of fields already in the hash, so it
   * can never be the *reason* a version is created.
   */
  const title =
    region === null
      ? magnitude === null
        ? null
        : `M ${magnitude.toFixed(1)}`
      : magnitude === null
        ? region
        : `M ${magnitude.toFixed(1)} — ${region}`;

  /*
   * EMSC publishes no lifecycle or review state at all: there is no `status`, and retractions are
   * websocket-only. Everything the FDSN service returns is a live solution, so the status is
   * ACTIVE and `providerStatus` is null rather than an invented value — an absent provider
   * statement must not be dressed up as one.
   */
  const lifecycleStatus = 'ACTIVE' as const;

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
    observedAtMs: observedAt.getTime(),
    primaryKey: unid,
    providerStatus: null,
    severity: null,
    sourceUrl: null,
    title,
  };

  const rawPayload: unknown = feature;
  return {
    primaryKey: unid,
    aliases,
    hazardType: ctx.descriptor.hazardType,
    observedAt,
    sourceUpdatedAt,
    lifecycleStatus,
    centroid,
    geometryKind: 'EPICENTER',
    magnitude,
    magnitudeType,
    depthKm,
    contributor,
    providerStatus: null,
    severityScheme: null,
    severityValue: null,
    title,
    sourceUrl: null,
    attributes: parsed.attributes,
    contentSha256: contentHash(hashable),
    rawPayload,
    /*
     * Canonical, and here it is not a nicety.
     *
     * EMSC uses two different serializers: with `orderby` the feature members come out in a
     * different order, with different whitespace, for the same event. Hashing the received bytes
     * would make the same record dedupe to two raw rows depending on which query returned it.
     */
    rawPayloadSha256: payloadHash(new TextEncoder().encode(canonicalJson(rawPayload))),
  };
}
