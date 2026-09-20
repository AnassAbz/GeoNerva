/**
 * GDACS feature → GeoNerva observation. Pure: no clock, no IO, no randomness.
 *
 * GDACS is where the "one canonical object" temptation is strongest and most wrong. It publishes
 * six hazard types through one endpoint with one property bag, and the same field means a
 * different quantity in each: `severitydata.severity` is a magnitude for an earthquake, a wind
 * speed for a cyclone, a burnt area for a wildfire, and a number that is `0` for every live flood
 * observed. Flattening those into "severity" would produce a column nobody can read, so the unit
 * is what decides which quantity this is, and each hazard's facts land in that hazard's own
 * attribute schema.
 *
 * Four things that are silent if got wrong:
 *
 *  1. **GDACS earthquakes are not a second opinion.** 99 of 100 recent GDACS EQs carried
 *     `source: NEIC`, and `geteventdata.sourceid` is the USGS event id itself. Ingesting one
 *     without recording what it restates would let "USGS and GDACS agree" render as independent
 *     corroboration, when it is one solution quoted twice — the exact failure ADR-030 exists to
 *     prevent. The upstream id goes into `upstream_event_ref` *and* into `derivedFrom`.
 *  2. **`datemodified` is not a change signal.** GDACS bulk-restamps dozens of unrelated old
 *     events within the same minute. It is stored as `source_updated_at` and kept out of the
 *     content hash, or every poll would manufacture a revision of everything it touched.
 *  3. **`iscurrent` is the string `"false"`, not `false`.** `Boolean("false")` is `true`, so the
 *     obvious coercion marks every resolved event as ongoing.
 *  4. **Alert levels are GDACS's own scale and are never mapped onto anything.** They are impact
 *     *estimates* from a model, not hazard intensity, and PAGER — which has a Yellow that GDACS
 *     does not — is a different model entirely. The level string is stored verbatim under the
 *     scheme name `GDACS`, and nothing is derived from `alertscore` at all, because RSS and the
 *     API disagree about it.
 */

import {
  isNullIsland,
  isValidLatitude,
  parseHazardAttributes,
  type GeometryRole,
  type HazardType,
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
import { roundStored, wrapLongitude } from '../usgs/normalize.ts';
import { gdacsInstant, isGdacsEventType, type GdacsEventType } from './api.ts';
import type { GdacsFeature, GdacsProperties } from './schema.ts';

/** GDACS event type → the hazard family GeoNerva models it as. */
export const GDACS_HAZARD_TYPES: Readonly<Record<GdacsEventType, HazardType>> = {
  EQ: 'EARTHQUAKE',
  TC: 'TROPICAL_CYCLONE',
  FL: 'FLOOD',
  VO: 'VOLCANO',
  WF: 'WILDFIRE_EVENT',
  DR: 'DROUGHT',
};

/** The three levels GDACS publishes. A fourth would be drift worth seeing, so the set is closed. */
const ALERT_LEVELS = new Set(['Green', 'Orange', 'Red']);

function rejected(id: string, reasonCode: RejectReasonCode, message: string): NormalizationError {
  return new NormalizationError('value-in-range', id, message, reasonCode);
}

function text(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** `"true"` / `"false"` as GDACS writes them. Anything else is absent, not false. */
function flag(value: 'true' | 'false' | null): boolean | undefined {
  if (value === null) return undefined;
  return value === 'true';
}

/** The record key. `eventid` alone is not unique — the six types number independently. */
export function gdacsPrimaryKey(eventType: string, eventId: number | string): string {
  return `${eventType}:${String(eventId)}`;
}

/**
 * The country list, as GDACS gives it, with names and ISO3 codes kept apart.
 *
 * `affectedcountries` entries are `{ iso3, countryname }`. The names are unmapped and verbatim —
 * GeoNerva has no country vocabulary of its own and inventing one here would put a normalization
 * decision inside an ingestion adapter.
 */
function countriesOf(properties: GdacsProperties): {
  names: string[];
  iso3: string[];
} {
  const names: string[] = [];
  const iso3 = new Set<string>();

  const primary = text(properties.country);
  if (primary !== undefined) names.push(primary.slice(0, 200));
  const primaryIso = text(properties.iso3);
  if (primaryIso !== undefined && /^[A-Z]{3}$/.test(primaryIso)) iso3.add(primaryIso);

  for (const entry of properties.affectedcountries ?? []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { iso3: code, countryname } = entry as { iso3?: unknown; countryname?: unknown };
    if (typeof countryname === 'string') {
      const name = text(countryname);
      if (name !== undefined && !names.includes(name.slice(0, 200))) names.push(name.slice(0, 200));
    }
    if (typeof code === 'string' && /^[A-Z]{3}$/.test(code.trim())) iso3.add(code.trim());
  }
  // Bounded by the attribute schema at 60; more than that is a provider bug, not a big event.
  return { names: names.slice(0, 60), iso3: [...iso3].sort().slice(0, 60) };
}

/** The fields every GDACS hazard shares, in GeoNerva's vocabulary. */
function commonAttributes(properties: GdacsProperties): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};

  const episode = properties.episodeid;
  if (episode !== null) attributes['episode_id'] = String(episode);
  /*
   * `alert_score` is stored and nothing is derived from it.
   *
   * RSS and the API disagree about `alertscore` and `episodealertscore` for the same event, so a
   * number computed from either would be a number that depends on which endpoint happened to
   * answer. Only the level *string* is used anywhere.
   */
  if (
    properties.alertscore !== null &&
    properties.alertscore >= 0 &&
    properties.alertscore <= 100
  ) {
    attributes['alert_score'] = properties.alertscore;
  }

  const { names, iso3 } = countriesOf(properties);
  if (names.length > 0) attributes['countries'] = names;
  if (iso3.length > 0) attributes['country_iso3'] = iso3;

  const current = flag(properties.iscurrent);
  if (current !== undefined) attributes['is_current'] = current;

  const agency = text(properties.source);
  if (agency !== undefined) attributes['source_agency'] = agency.slice(0, 200);
  const eventName = text(properties.eventname) ?? text(properties.name);
  if (eventName !== undefined) attributes['event_name'] = eventName.slice(0, 200);

  return attributes;
}

/** `severitydata.severity`, but only when the unit says it is the quantity being asked for. */
function severityIn(properties: GdacsProperties, unit: string): number | undefined {
  const data = properties.severitydata;
  if (data?.severity === null || data === null) return undefined;
  const actual = text(data.severityunit)?.toLowerCase();
  if (actual !== unit.toLowerCase()) return undefined;
  return data.severity;
}

function hazardAttributes(
  hazardType: HazardType,
  properties: GdacsProperties,
  upstream: string | undefined,
  key: string,
  geometry: GdacsGeometryInput | undefined,
): Record<string, unknown> {
  const severityText = text(properties.severitydata?.severitytext ?? null);
  // Every GDACS-native hazard schema spreads `gdacsCommon`; EARTHQUAKE does not — see below.
  const attributes = hazardType === 'EARTHQUAKE' ? {} : commonAttributes(properties);

  switch (hazardType) {
    case 'EARTHQUAKE': {
      /*
       * Deliberately **not** `commonAttributes`.
       *
       * `earthquakeAttributesSchema` is shared by USGS, EMSC and GDACS, and it is a strict object
       * that does not carry GDACS's episode, alert score, country list or `iscurrent`. That is
       * not an oversight: the schema was written with GDACS EQ in mind and gave it exactly one
       * field, `upstream_event_ref`, because a GDACS earthquake is a *copy of a USGS solution*
       * and its value is the cross-reference, not its own metadata. Widening a schema three
       * sources share, so that one of them can store an episode counter for a record it did not
       * compute, would be weakening a frozen contract for convenience.
       *
       * Nothing is lost: the alert level is in the `severity_scheme`/`severity_value` columns,
       * `iscurrent` is in `lifecycle_status`, the episode is in the content hash, and the whole
       * GDACS payload is in `raw_source_records` either way.
       */
      const eqAttributes: Record<string, unknown> = { identity_refs: [key] };
      if (upstream !== undefined) eqAttributes['upstream_event_ref'] = upstream.slice(0, 200);
      const region = text(properties.name) ?? text(properties.description);
      if (region !== undefined) eqAttributes['region_name'] = region.slice(0, 200);
      return eqAttributes;
    }
    case 'TROPICAL_CYCLONE': {
      const name = text(properties.eventname);
      if (name !== undefined) attributes['storm_name'] = name.slice(0, 200);
      const wind = severityIn(properties, 'km/h');
      if (wind !== undefined && wind >= 0 && wind <= 500) {
        attributes['max_wind_kmh'] = roundStored(wind);
      }
      const agency = text(properties.source);
      if (agency !== undefined) attributes['forecast_agency'] = `${agency.slice(0, 180)} via GDACS`;
      return attributes;
    }
    case 'WILDFIRE_EVENT': {
      const hectares = severityIn(properties, 'ha');
      if (hectares !== undefined && hectares >= 0 && hectares <= 100_000_000) {
        attributes['burnt_area_ha'] = roundStored(hectares);
      }
      return attributes;
    }
    case 'VOLCANO': {
      const name = text(properties.eventname) ?? text(properties.name);
      if (name !== undefined) attributes['volcano_name'] = name.slice(0, 200);
      if (severityText !== undefined)
        attributes['alert_text_verbatim'] = severityText.slice(0, 200);
      return attributes;
    }
    case 'DROUGHT': {
      /*
       * A drought has no instant, so GDACS's own window text is what is shown rather than a date
       * GeoNerva picked. `observed_at` still has to be *something* — see the note there.
       */
      const from = text(properties.fromdate);
      const to = text(properties.todate);
      const period = from === undefined ? undefined : to === undefined ? from : `${from} – ${to}`;
      if (period !== undefined) attributes['period_text_verbatim'] = period.slice(0, 200);
      return attributes;
    }
    case 'FLOOD': {
      /*
       * `has_area_geometry` is required by the schema and is **not knowable from the list**: every
       * list row reports `Class: Point_Centroid` regardless of what `getgeometry` holds. Answering
       * it from the list would assert that a flood has no modelled area when it has simply not
       * been asked — and that assertion caps the event's relevance (ARCHITECTURE §9.3).
       *
       * So the flood adapter fetches the geometry, and `geometry === undefined` here means the
       * question could not be asked at all, which is a reject rather than a guess.
       */
      if (geometry === undefined) {
        throw new NormalizationError(
          'flood-needs-geometry',
          key,
          'a GDACS flood cannot be normalized without a getgeometry answer: has_area_geometry is ' +
            'only knowable from it, and guessing would cap or uncap relevance wrongly',
        );
      }
      attributes['has_area_geometry'] = geometry.hasArea;
      if (severityText !== undefined) {
        // Shown as a quotation, always labelled modelled rather than observed. The documented
        // method behind the number is outdated and every live GLOFAS event scores 0, so the
        // sentence is the only honest thing to show.
        attributes['severity_text_verbatim'] = severityText.slice(0, 200);
      }
      return attributes;
    }

    /*
     * The four hazard families GDACS does not publish.
     *
     * Listed rather than left to `default`, so that adding a hazard type to the domain is a
     * compile error here instead of a silent fall-through that would hand a thermal detection the
     * GDACS common attributes and no hazard-specific ones at all. Reaching any of these means the
     * event-type map is wrong, which `normalizeGdacsFeature` has already refused.
     */
    case 'THERMAL_ACTIVITY':
    case 'WEATHER_ALERT':
    case 'TSUNAMI':
    case 'OTHER': {
      throw new NormalizationError(
        'gdacs-publishes-this-hazard',
        key,
        `GDACS does not publish ${hazardType}, so there is no mapping for it`,
      );
    }
  }
}

/** What `getgeometry` said, when the adapter asked. */
export interface GdacsGeometryInput {
  readonly hasArea: boolean;
  readonly features: readonly unknown[];
  readonly oversized: boolean;
}

export interface GdacsNormalizeInput {
  readonly feature: GdacsFeature;
  /** `geteventdata` for this event, when the adapter fetched one. */
  readonly detail?: GdacsProperties | undefined;
  /** `getgeometry` for this event. Required for floods; absent for everything else. */
  readonly geometry?: GdacsGeometryInput | undefined;
}

export function normalizeGdacsFeature(
  input: GdacsNormalizeInput,
  ctx: NormalizeContext,
): NormalizedRecord {
  const { feature } = input;
  const p = feature.properties;
  const key = gdacsPrimaryKey(p.eventtype, p.eventid);

  // Fatal: the descriptor is per event type, so a feature of another type in this batch means the
  // query did not ask what we think it asked, and every record in it is suspect.
  const expected = ctx.descriptor.hazardType;
  const hazardType: HazardType | undefined = isGdacsEventType(p.eventtype)
    ? GDACS_HAZARD_TYPES[p.eventtype]
    : undefined;
  if (hazardType === undefined) {
    throw new NormalizationError(
      'known-event-type',
      key,
      `eventtype ${p.eventtype} is not one GDACS publishes`,
    );
  }
  if (hazardType !== expected) {
    throw new NormalizationError(
      'event-type-matches-product',
      key,
      `a ${p.eventtype} event arrived in the ${expected} product's batch`,
    );
  }
  if (!Number.isInteger(p.eventid) || p.eventid < 1) {
    throw new NormalizationError('identity-present', key, `eventid ${p.eventid} is not an id`);
  }

  if (feature.geometry === null) {
    throw rejected(key, 'COORDINATES_INVALID', 'the event has no geometry at all');
  }
  const [rawLon, lat] = feature.geometry.coordinates;
  const lon = wrapLongitude(rawLon);
  if (!isValidLatitude(lat) || !Number.isFinite(lon)) {
    throw rejected(key, 'COORDINATES_INVALID', `lat=${lat} lon=${rawLon} is not a WGS84 position`);
  }
  const centroid: LatLon = { lat, lon };
  if (isNullIsland(centroid)) {
    throw rejected(key, 'NULL_ISLAND', 'the centroid is exactly (0, 0), a missing-value sentinel');
  }

  /*
   * `observed_at` is `fromdate` — when GDACS says the event began.
   *
   * Not `datemodified`, which is bulk-restamped, and not `todate`, which for an ongoing event is
   * "now" and would march forward every poll, re-dating an event that has not moved. For a
   * long-running hazard this means `observed_at` is the *onset*, which is what "when did this
   * happen" means for a wildfire that has been burning for a fortnight.
   */
  const observedAt = gdacsInstant(p.fromdate);
  if (observedAt === null) {
    throw rejected(key, 'MISSING_OBSERVED_AT', `fromdate=${p.fromdate} is not an instant`);
  }
  const sourceUpdatedAt = p.datemodified === null ? null : gdacsInstant(p.datemodified);

  const alertLevel = text(p.alertlevel);
  if (alertLevel !== undefined && !ALERT_LEVELS.has(alertLevel)) {
    // Closed on purpose: a fourth level is a change in what GDACS means, and the read path styles
    // exactly three. A reject row makes it visible instead of storing a word nothing can render.
    throw rejected(key, 'SCHEMA_INVALID', `alertlevel ${alertLevel} is not Green, Orange or Red`);
  }
  const episodeLevel = text(p.episodealertlevel);
  if (episodeLevel !== undefined && !ALERT_LEVELS.has(episodeLevel)) {
    throw rejected(
      key,
      'SCHEMA_INVALID',
      `episodealertlevel ${episodeLevel} is not Green, Orange or Red`,
    );
  }

  // `sourceid` is blank in the list; the detail call is the only place it exists.
  const upstream = text(input.detail?.sourceid) ?? text(p.sourceid);

  const parsed = parseHazardAttributes(
    hazardType,
    hazardAttributes(hazardType, p, upstream, key, input.geometry),
  );
  if (!parsed.ok) {
    throw new NormalizationError(
      'attributes-match-schema',
      key,
      `normalized attributes are invalid: ${parsed.issues.join('; ')}`,
    );
  }

  /*
   * `iscurrent: "false"` is GDACS saying the event is over.
   *
   * `ENDED`, not `DELETED`: the event happened and is finished, which is a different statement
   * from the provider retracting it, and the two must never read alike. `DELETED` is a tombstone
   * and would remove the event from the map; `ENDED` leaves it there, finished.
   */
  const lifecycleStatus = flag(p.iscurrent) === false ? 'ENDED' : 'ACTIVE';

  const title = text(p.name) ?? text(p.description) ?? null;

  /*
   * The shapes, role-tagged, exactly as GDACS published them.
   *
   * `Poly_Affected` is the modelled affected area and `Poly_Global` is a much larger envelope
   * whose derivation GDACS does not document. Both are kept, under different roles, because the
   * UI must be able to show the smaller one and say "modelled" — and because discarding the
   * larger silently would make a later question about it unanswerable. Nothing is simplified or
   * reprojected: a shape GeoNerva altered is no longer the shape the provider published.
   */
  const geometries: { role: GeometryRole; seq: number; geoJson: unknown }[] = [];
  for (const shape of input.geometry?.features ?? []) {
    if (typeof shape !== 'object' || shape === null) continue;
    const shapeGeometry = (shape as { geometry?: unknown }).geometry;
    if (shapeGeometry === undefined || shapeGeometry === null) continue;
    const properties = (shape as { properties?: unknown }).properties;
    const cls =
      typeof properties === 'object' && properties !== null
        ? (properties as { Class?: unknown }).Class
        : undefined;
    const role: GeometryRole = cls === 'Poly_Global' ? 'global_area' : 'affected_area';
    geometries.push({
      role,
      seq: geometries.filter((g) => g.role === role).length,
      geoJson: shapeGeometry,
    });
  }
  const magnitude = hazardType === 'EARTHQUAKE' ? (severityIn(p, 'M') ?? null) : null;

  /*
   * What a revision means for GDACS: the episode, the levels, the position, the facts.
   *
   * `datemodified` is out (bulk-restamped). `todate` is out for the same reason in reverse: it
   * tracks "now" for an ongoing event, so including it would make every poll of a live wildfire a
   * new version saying nothing happened. `episodeid` is *in*, because a new episode is exactly
   * what GDACS means by an update.
   */
  const hashable = {
    alertLevel: alertLevel ?? null,
    attributes: parsed.attributes,
    episodeAlertLevel: episodeLevel ?? null,
    /*
     * Explicitly here rather than only inside `attributes`, because the earthquake schema has no
     * place for it and DATA_SOURCES §2.3 is unambiguous: each episode is a new observation
     * version. Leaving it out for EQ alone would make one hazard silently version differently
     * from the other five.
     */
    episodeId: p.episodeid === null ? null : String(p.episodeid),
    lat,
    lifecycleStatus,
    lon,
    magnitude: magnitude === null ? null : roundStored(magnitude),
    observedAtMs: observedAt.getTime(),
    primaryKey: key,
    title,
    upstream: upstream ?? null,
    /*
     * The shapes are in the hash, and for a flood they are frequently the *only* thing that
     * moves: the centroid, the level and the severity stay put while the modelled area grows.
     * Leaving them out would make a spreading flood look like nothing happening.
     */
    geometries: geometries.map((geometry) => ({
      role: geometry.role,
      seq: geometry.seq,
      geoJson: geometry.geoJson,
    })),
  };

  /*
   * The raw payload is the list feature *and* the detail, together.
   *
   * Storing only the feature would discard the `sourceid` that made this a derived copy, and a
   * replay years later would re-derive a record that looks independent.
   */
  const rawPayload: unknown = {
    feature,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.geometry === undefined ? {} : { geometry: input.geometry }),
  };

  return {
    primaryKey: key,
    aliases: [key],
    hazardType,
    observedAt,
    sourceUpdatedAt,
    lifecycleStatus,
    centroid,
    // The list gives a point and says so (`Class: Point_Centroid`). Area geometry is a separate
    // request; claiming a shape we have not fetched would be a claim about the event's extent.
    geometryKind: 'CENTROID_ONLY',
    magnitude: magnitude === null ? null : roundStored(magnitude),
    magnitudeType: hazardType === 'EARTHQUAKE' ? 'M' : null,
    depthKm: null,
    contributor: text(p.source) ?? null,
    providerStatus: null,
    /*
     * GDACS's own scale, under its own name, mapped onto nothing.
     *
     * The episode level is what this version carries; the event level is the event's overall
     * state and lives in the attributes. They differ in practice — SAUDEL-26 episodes 20 and 21
     * were Green and Orange within the same event.
     */
    severityScheme: alertLevel === undefined && episodeLevel === undefined ? null : 'GDACS_ALERT',
    severityValue: episodeLevel ?? alertLevel ?? null,
    title,
    sourceUrl: null,
    attributes: parsed.attributes,
    ...(geometries.length === 0 ? {} : { geometries }),
    contentSha256: contentHash(hashable),
    rawPayload,
    rawPayloadSha256: payloadHash(new TextEncoder().encode(canonicalJson(rawPayload))),
    /*
     * Recorded for earthquakes only, and always as `usgs`.
     *
     * For EQ, `sourceid` is a USGS ComCat id whatever network GDACS credits: `NEIC` gives
     * `us7000tikb`, `PRICO RS` gives `pr2026261000`, `ALASKA EC` gives `aka2026rcluqc`. That id
     * is what lets correlation attach this record as a DERIVED_COPY of a USGS solution instead
     * of counting it as a second source agreeing.
     *
     * For the other five hazards GDACS's `sourceid` points at a model or an agency GeoNerva does
     * not ingest — GLOFAS, GWIS, JTWC — so there is nothing to be derived *from* inside this
     * system, and claiming a lineage to a source that is not held would be a cross-reference to
     * nowhere. Those ids stay in the raw payload, which is where an unmodelled fact belongs.
     */
    ...(hazardType === 'EARTHQUAKE' && upstream !== undefined
      ? { derivedFrom: { source: 'usgs', ref: upstream } }
      : {}),
  };
}
