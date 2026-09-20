/**
 * Hazard-specific `attributes` schemas for `observation_versions.attributes`
 * (docs/DOMAIN_MODEL.md §4.7).
 *
 * Rules that shape every schema here:
 *
 *  1. **Normalized, not raw.** `attributes` is GeoNerva's canonical shape. The untouched provider
 *     payload lives in `raw_source_records`; provider field names never appear outside
 *     `packages/sources` (docs/ARCHITECTURE.md §3, rule 4). Keys are therefore provider-neutral,
 *     with the provenance documented per field.
 *  2. **Queried values are columns, not attributes.** `magnitude`, `magnitude_type`, `depth_km`,
 *     `centroid`, `contributor`, lifecycle and severity have typed columns because the read path
 *     filters on them. `attributes` holds everything else.
 *  3. **Derived never mixes with observed.** Only provider-stated values go in `attributes`.
 *     GeoNerva's own distances, relevance and baselines are separate types (§1.5).
 *  4. **Strict objects.** An unexpected key is a normalization bug or schema drift, so it fails
 *     loudly instead of being stored. Adding a key is a deliberate, reviewed change.
 *  5. **Verbatim where the licence demands it.** ECCC requires alert text to be reproduced with
 *     "no alteration of the content or intent" (docs/DATA_SOURCES.md §4.2), so those fields are
 *     named `*_verbatim` and are never paraphrased, truncated or summarized by GeoNerva or by AI.
 */

import { z } from 'zod';

import { HAZARD_TYPES, type HazardType } from '../enums.ts';

/** Upper bound on a single normalized attributes object, enforced before insert. */
export const MAX_ATTRIBUTES_BYTES = 16 * 1024;

const shortText = z.string().trim().min(1).max(200);
const longText = z.string().min(1).max(8_000);
const isoLike = z.string().trim().min(4).max(40);
const nonNegativeInt = z.number().int().min(0);
const iso3 = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 3166-1 alpha-3 country code');
const iso2 = z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 country code');

/**
 * Fields shared by every GDACS event type. GDACS models an event as a sequence of **episodes**;
 * the episode number is part of the identity of a version, not of the record (§4.6).
 *
 * `datemodified` is deliberately **not** here: GDACS bulk-restamps dozens of unrelated old events
 * within the same minute, so it is not a change signal. Version creation depends only on the
 * normalized `content_sha256` (see `packages/db/src/repositories/observation-versions.ts`).
 */
const gdacsCommon = {
  /** GDACS episode number for this version, verbatim. */
  episode_id: shortText.optional(),
  /** GDACS alert score (`alertscore`), an internal 0–3-ish impact index. Context only. */
  alert_score: z.number().min(0).max(100).optional(),
  /** Country names as GDACS lists them, verbatim and unmapped. */
  countries: z.array(shortText).max(60).optional(),
  country_iso3: z.array(iso3).max(60).optional(),
  /** GDACS `iscurrent`. `false` drives `EVENT_RESOLVED` rather than any GeoNerva judgement. */
  is_current: z.boolean().optional(),
  /** The agency GDACS credits for the underlying data, e.g. "JTWC", "GloFAS". */
  source_agency: shortText.optional(),
  /** GDACS event name as published, e.g. "Tropical Cyclone FREDDY-23". */
  event_name: shortText.optional(),
} as const;

/**
 * Earthquake (`EARTHQUAKE`) — produced by USGS ComCat, EMSC FDSN and, as a derived copy,
 * GDACS EQ. Magnitude, magnitude type and depth are columns; everything below is context.
 */
export const earthquakeAttributesSchema = z.strictObject({
  /** Agency that computed the preferred magnitude, when it differs from the contributor. */
  magnitude_source: shortText.optional(),
  /** Number of felt reports (USGS DYFI `felt`). A reason code, never a level change. */
  felt_reports: nonNegativeInt.max(1_000_000).optional(),
  /** Community-reported intensity (USGS `cdi`), on the Modified Mercalli scale. */
  community_intensity_cdi: z.number().min(0).max(12).optional(),
  /** Instrumental shaking intensity (USGS `mmi`), Modified Mercalli. */
  instrumental_intensity_mmi: z.number().min(0).max(12).optional(),
  /**
   * USGS `tsunami = 1`. Per USGS, this "does not indicate if a tsunami actually did or will
   * exist" — only that the event is large and oceanic. GeoNerva reports it with that exact
   * caveat and a link to the official warning centres, and it never changes the relevance level.
   */
  tsunami_flag: z.boolean().optional(),
  /** Provider review state, normalized: how finished the solution is. */
  review_status: z.enum(['automatic', 'reviewed', 'manual', 'deleted']).optional(),
  /** USGS `sig`, a provider significance score. Context only, never a GeoNerva ranking input. */
  significance: nonNegativeInt.max(5_000).optional(),
  /** Stations used in the solution (`nst`). */
  station_count: nonNegativeInt.max(10_000).optional(),
  /** Distance to the nearest station, in km (USGS `dmin`, converted in the adapter). */
  min_station_distance_km: z.number().min(0).max(20_000).optional(),
  /** Largest azimuthal gap between stations, in degrees. A solution-quality indicator. */
  azimuthal_gap_deg: z.number().min(0).max(360).optional(),
  /** RMS travel-time residual, in seconds. */
  rms_s: z.number().min(0).max(100).optional(),
  /**
   * Every provider identifier ever seen for this record (USGS `ids`, EMSC `unid`). These are the
   * **identity references** correlation matches on first (ADR-005), and they are mirrored into
   * `source_record_aliases` for idempotent lookup.
   */
  identity_refs: z.array(shortText).max(50).optional(),
  /** Provider place description (USGS `place`, EMSC `flynn_region`), verbatim. */
  region_name: shortText.optional(),
  /** Provider event type: `earthquake`, `quarry blast`, `explosion`, … */
  event_type: shortText.optional(),
  /**
   * Which of a provider's catalogues this solution came from, when the provider runs more than
   * one and says so per record (EMSC `source_catalog`).
   *
   * It is per record rather than per product because EMSC's single FDSN endpoint serves both: a
   * live poll is entirely `EMSC-RTS`, while one day of 2010 came back 85 `EMSC-EMB` — the merged
   * bulletin, revised long after the fact — to 12 `EMSC-RTS`. The seeded product is `emsc/rts`,
   * so without this field a backfill would label bulletin solutions with a provenance the
   * provider contradicted in the same response.
   */
  provider_catalog: shortText.optional(),
  /**
   * For a derived copy (GDACS EQ): the identifier of the upstream solution GDACS restates, so the
   * correlation engine can attach it as `DERIVED_COPY` instead of counting it as agreement.
   */
  upstream_event_ref: shortText.optional(),
});
export type EarthquakeAttributes = z.infer<typeof earthquakeAttributesSchema>;

/**
 * Thermal activity (`THERMAL_ACTIVITY`) — satellite detections. **No P0 adapter writes an
 * observation version with this hazard type**: FIRMS rows live in `fire_detections` and their
 * summaries in `fire_cluster_versions` (§4.9, §4.10). The schema exists so that the registry is
 * total, and so that a future point-detection source with real event identity has a home.
 */
export const thermalActivityAttributesSchema = z.strictObject({
  /** Satellite platform, e.g. `NOAA-20`. */
  platform: shortText.optional(),
  /** Instrument, e.g. `VIIRS`. */
  instrument: shortText.optional(),
  /** Provider processing version string, e.g. `2.0NRT`. */
  provider_version: shortText.optional(),
  /** Normalized confidence class; the provider's raw value stays in `confidence_raw`. */
  confidence_class: z.enum(['LOW', 'NOMINAL', 'HIGH']).optional(),
  /** Fire radiative power in megawatts, as the provider reports it. */
  frp_mw: z.number().min(0).max(100_000).optional(),
  /** Day or night overpass, verbatim (`D`/`N`). */
  daynight: z.enum(['D', 'N']).optional(),
});
export type ThermalActivityAttributes = z.infer<typeof thermalActivityAttributesSchema>;

/**
 * Wildfire event (`WILDFIRE_EVENT`) — GDACS WF, an **official burnt-area event** (≥ 5,000 ha).
 * This is the only hazard type GeoNerva may describe with the word "wildfire", because an
 * authority said so.
 */
export const wildfireEventAttributesSchema = z.strictObject({
  ...gdacsCommon,
  /** Burnt area in hectares, as GDACS reports it. */
  burnt_area_ha: z.number().min(0).max(100_000_000).optional(),
  /** People potentially affected, as GDACS models it. A model output, not an observation. */
  affected_population: nonNegativeInt.max(10_000_000_000).optional(),
});
export type WildfireEventAttributes = z.infer<typeof wildfireEventAttributesSchema>;

/**
 * Flood (`FLOOD`) — GDACS FL. `has_area_geometry` is load-bearing: a centroid-only event must be
 * described differently, and its relevance is capped (docs/ARCHITECTURE.md §9.3).
 */
export const floodAttributesSchema = z.strictObject({
  ...gdacsCommon,
  /** True when `Poly_Affected` was available, so an area-based assessment is possible. */
  has_area_geometry: z.boolean(),
  /** People potentially affected, as GDACS models it. */
  affected_population: nonNegativeInt.max(10_000_000_000).optional(),
  /**
   * GDACS severity sentence, verbatim (e.g. "Magnitude 3.4 flood signal"). GeoNerva shows it as
   * a quotation and always labels the area as modelled, not observed.
   */
  severity_text_verbatim: shortText.optional(),
});
export type FloodAttributes = z.infer<typeof floodAttributesSchema>;

/**
 * Tropical cyclone (`TROPICAL_CYCLONE`) — GDACS TC. Forecast geometry is modelled through
 * `valid_from`/`valid_to` on the geometries, never through a future `observed_at` (§2).
 * GeoNerva never computes its own tracks, arrival times or intensities.
 */
export const tropicalCycloneAttributesSchema = z.strictObject({
  ...gdacsCommon,
  /** Storm name as the issuing agency names it, e.g. `FREDDY`. */
  storm_name: shortText.optional(),
  /** Maximum sustained wind in km/h, as reported. */
  max_wind_kmh: z.number().min(0).max(500).optional(),
  /** The agency's own category scale name, e.g. `SAFFIR_SIMPSON`, `AUS`, `JMA`. */
  category_scheme: shortText.optional(),
  /** The agency's category value on that scale, verbatim. */
  category_value: shortText.optional(),
  /** When the forecast this version carries was issued, verbatim from the provider. */
  forecast_issued_at: isoLike.optional(),
  /** Agency credited with the track/forecast, e.g. "JTWC via GDACS". */
  forecast_agency: shortText.optional(),
  /** Wind-buffer thresholds present in this version, in km/h, ascending. */
  wind_buffer_thresholds_kmh: z.array(z.number().min(0).max(500)).max(10).optional(),
});
export type TropicalCycloneAttributes = z.infer<typeof tropicalCycloneAttributesSchema>;

/** Volcano (`VOLCANO`) — GDACS VO. Ash dispersion is deferred, so no plume fields exist. */
export const volcanoAttributesSchema = z.strictObject({
  ...gdacsCommon,
  volcano_name: shortText.optional(),
  /** Smithsonian GVP volcano number, when GDACS provides it. */
  volcano_id: shortText.optional(),
  /** Provider alert wording, verbatim. */
  alert_text_verbatim: shortText.optional(),
  /** Exclusion zone radius in km, when an authority declared one. */
  exclusion_zone_km: z.number().min(0).max(1_000).optional(),
});
export type VolcanoAttributes = z.infer<typeof volcanoAttributesSchema>;

/** Drought (`DROUGHT`) — GDACS DR. Shown as context; no relevance model in v1. */
export const droughtAttributesSchema = z.strictObject({
  ...gdacsCommon,
  affected_population: nonNegativeInt.max(10_000_000_000).optional(),
  /** Provider's own window description, verbatim (droughts have no instant). */
  period_text_verbatim: shortText.optional(),
});
export type DroughtAttributes = z.infer<typeof droughtAttributesSchema>;

/**
 * Weather alert (`WEATHER_ALERT`, P1) — ECCC GeoMet and NWS, both CAP-shaped.
 *
 * The ECCC licence requires alerts to be "reproduced in such a way that there is no alteration of
 * the content or intent of the alert". Every text field here is therefore stored and rendered
 * **verbatim**, and runtime AI may reference these fields but must never paraphrase them
 * (docs/DATA_SOURCES.md §4.2, docs/ARCHITECTURE.md §11).
 */
export const weatherAlertAttributesSchema = z.strictObject({
  /** CAP `identifier` of the message this version came from. */
  cap_identifier: shortText.optional(),
  /** CAP `references` — the messages this one updates or cancels. */
  cap_references: z.array(shortText).max(50).optional(),
  /** CAP `msgType`: Alert, Update, Cancel, Ack, Error. */
  message_type: z.enum(['Alert', 'Update', 'Cancel', 'Ack', 'Error']).optional(),
  /** Normalized alert class, which drives relevance (docs/ARCHITECTURE.md §9.6). */
  alert_class: z.enum(['warning', 'watch', 'advisory', 'statement', 'ended']).optional(),
  /** The provider's own alert name, verbatim, e.g. "Snowfall warning". */
  alert_type_verbatim: shortText.optional(),
  urgency: z.enum(['Immediate', 'Expected', 'Future', 'Past', 'Unknown']).optional(),
  certainty: z.enum(['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']).optional(),
  response_type: z.array(shortText).max(10).optional(),
  /** ECCC risk colour, kept on its own scheme (`ECCC_RISK_COLOUR`). */
  risk_colour: shortText.optional(),
  /** CAP `headline`, verbatim. */
  headline_verbatim: shortText.optional(),
  /** CAP `description`, verbatim and unabridged. */
  description_verbatim: longText.optional(),
  /** CAP `instruction`, verbatim and unabridged. */
  instruction_verbatim: longText.optional(),
  /** CAP `areaDesc`, verbatim. */
  area_description_verbatim: shortText.optional(),
  /** Issuing office, verbatim. */
  sender_name: shortText.optional(),
  /** BCP 47 language tag of the verbatim text. */
  language: z.string().trim().min(2).max(35).optional(),
  /**
   * MSC GeoMet alert-thread identifier. The feature `id` has the shape
   * `<alert-thread><YYYYMMDDhhmm>_<feature_id>`; `feature_id` alone is not unique within a single
   * poll, so the thread part is what ties successive messages together (docs/DOMAIN_MODEL.md §4.6).
   */
  alert_thread_id: shortText.optional(),
  country: iso2.optional(),
});
export type WeatherAlertAttributes = z.infer<typeof weatherAlertAttributesSchema>;

/** Tsunami (`TSUNAMI`) — reserved. No v1 source produces it; the schema exists to be total. */
export const tsunamiAttributesSchema = z.strictObject({
  /** Official advisory wording, verbatim, if a source is ever added. */
  advisory_text_verbatim: longText.optional(),
  /** Issuing warning centre, e.g. "PTWC". */
  warning_centre: shortText.optional(),
});
export type TsunamiAttributes = z.infer<typeof tsunamiAttributesSchema>;

/** Other (`OTHER`) — anything a source reports that has no dedicated model yet. */
export const otherAttributesSchema = z.strictObject({
  ...gdacsCommon,
  /** The provider's own label for the hazard, verbatim. */
  provider_hazard_label: shortText.optional(),
});
export type OtherAttributes = z.infer<typeof otherAttributesSchema>;

/** Attribute type per hazard type. */
export interface HazardAttributesByType {
  readonly EARTHQUAKE: EarthquakeAttributes;
  readonly THERMAL_ACTIVITY: ThermalActivityAttributes;
  readonly WILDFIRE_EVENT: WildfireEventAttributes;
  readonly FLOOD: FloodAttributes;
  readonly TROPICAL_CYCLONE: TropicalCycloneAttributes;
  readonly VOLCANO: VolcanoAttributes;
  readonly DROUGHT: DroughtAttributes;
  readonly WEATHER_ALERT: WeatherAlertAttributes;
  readonly TSUNAMI: TsunamiAttributes;
  readonly OTHER: OtherAttributes;
}

/** The attributes shape for one hazard type. */
export type AttributesFor<T extends HazardType> = HazardAttributesByType[T];

/** Any hazard's attributes. */
export type HazardAttributes = HazardAttributesByType[HazardType];

/**
 * The registry. Total over `HazardType` by construction: adding a hazard type without a schema
 * is a compile error, and a unit test asserts the key set equals `HAZARD_TYPES`.
 */
export const HAZARD_ATTRIBUTE_SCHEMAS = {
  EARTHQUAKE: earthquakeAttributesSchema,
  THERMAL_ACTIVITY: thermalActivityAttributesSchema,
  WILDFIRE_EVENT: wildfireEventAttributesSchema,
  FLOOD: floodAttributesSchema,
  TROPICAL_CYCLONE: tropicalCycloneAttributesSchema,
  VOLCANO: volcanoAttributesSchema,
  DROUGHT: droughtAttributesSchema,
  WEATHER_ALERT: weatherAlertAttributesSchema,
  TSUNAMI: tsunamiAttributesSchema,
  OTHER: otherAttributesSchema,
} as const satisfies Record<HazardType, z.ZodType>;

/** Hazard types whose attributes a P0 adapter actually writes. */
export const P0_ATTRIBUTE_HAZARD_TYPES = [
  'EARTHQUAKE',
  'WILDFIRE_EVENT',
  'FLOOD',
  'TROPICAL_CYCLONE',
  'VOLCANO',
  'DROUGHT',
  'OTHER',
] as const;

/**
 * Validates unknown JSON against the schema for `hazardType`. Returns a discriminated result so
 * that callers can record an `ingestion_rejects` row instead of throwing inside a batch.
 */
export function parseHazardAttributes<T extends HazardType>(
  hazardType: T,
  value: unknown,
):
  | { readonly ok: true; readonly attributes: AttributesFor<T> }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const schema: z.ZodType = HAZARD_ATTRIBUTE_SCHEMAS[hazardType];
  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, attributes: result.data as AttributesFor<T> };
}

/**
 * True when a serialized attributes object is within the storage bound. Uses `TextEncoder`
 * rather than `Buffer` so that the domain stays runnable in a browser bundle.
 */
export function isAttributesWithinSizeLimit(attributes: unknown): boolean {
  const json = JSON.stringify(attributes);
  const encoded = new TextEncoder().encode(typeof json === 'string' ? json : 'null');
  return encoded.length <= MAX_ATTRIBUTES_BYTES;
}

/** Every hazard type that has a schema, for exhaustiveness tests. */
export const HAZARD_TYPES_WITH_SCHEMAS: readonly HazardType[] = HAZARD_TYPES;
