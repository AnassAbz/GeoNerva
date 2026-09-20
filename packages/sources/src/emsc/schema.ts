/**
 * The EMSC SeismicPortal FDSN event schema (DATA_SOURCES §6).
 *
 * EMSC serves GeoJSON under `format=json` — `format=geojson` is an HTTP 400 — and the shape is
 * close enough to USGS's to be mistaken for it. The differences that matter are all in the
 * places a copied adapter would not look:
 *
 *  - **`properties.depth` is the depth; `geometry.coordinates[2]` is its negation.** Live on
 *    2026-09-20: an 8.1 km event carries `coordinates: [..., -8.1]`, and a Hawaiʻi event 0.2 km
 *    *above* the datum carries `depth: -0.2` with `coordinates: [..., 0.2]`. Reading the GeoJSON
 *    z the way the USGS adapter does would invert every depth in the catalogue, and nothing
 *    downstream would notice because the numbers stay plausible.
 *  - **Times are ISO strings, not epoch milliseconds.** USGS sends `time: 1758...` and EMSC sends
 *    `time: "2026-09-19T20:35:53.1Z"`. `z.number()` here would reject the whole catalogue, which
 *    is at least loud; the reverse would not be.
 *  - **`unid` is the identity, not the feature `id`.** They are equal in everything observed, and
 *    the adapter *checks* that rather than assuming it, because `unid` is what EMSC documents as
 *    stable and `id` is what a GeoJSON serializer is free to change.
 *  - **`source_catalog` is not constant.** Live polls are all `EMSC-RTS`; a backfill into 2010
 *    returns 85 `EMSC-EMB` (the merged bulletin) to 12 `EMSC-RTS` in a single day. The product is
 *    seeded as `emsc/rts`, so the per-record catalogue is recorded in the attributes rather than
 *    assumed from the product code.
 *
 * Strictness follows the USGS reasoning: the envelope is strict, `properties` is loose so a new
 * field cannot take the source down, and every field `normalize` reads is required even when it
 * is nullable, so a rename is a reject rather than a silently missing value.
 */

import { z } from 'zod';

/** JSON cannot carry NaN or Infinity, and zod 4's `z.number()` already rejects them. */
const finiteNumber = z.number();

/**
 * An ISO-8601 instant as EMSC writes it: `2026-09-19T20:35:53.1Z`, or with microseconds on
 * `lastupdate`. Validated by parsing rather than by pattern, because the failure that matters is
 * "this does not denote an instant", not "this does not match a regex".
 */
const isoInstant = z
  .string()
  .min(4)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'is not a parsable instant');

export const emscFeaturePropertiesSchema = z.looseObject({
  /** EMSC's stable identifier, e.g. `20260803_0000324`. The identity of the record. */
  unid: z.string().min(1).max(100),
  /** The id within `source_catalog`, e.g. `2037122`. Not globally unique; context only. */
  source_id: z.string().min(1).max(100).nullable(),
  /** `EMSC-RTS` on live polls, `EMSC-EMB` for much of the historical bulletin. */
  source_catalog: z.string().min(1).max(100).nullable(),
  /** Origin time. */
  time: isoInstant,
  /** Last revision time. Excluded from the content hash by ADR-029. */
  lastupdate: isoInstant.nullable(),
  lat: finiteNumber,
  lon: finiteNumber,
  /** Kilometres, positive downwards. Negative above the datum. See the header. */
  depth: finiteNumber.nullable(),
  mag: finiteNumber.nullable(),
  /** Case is not stable: `ml` on recent events, `MD` on older ones. Lowercased in normalize. */
  magtype: z.string().max(100).nullable(),
  /**
   * Left open on purpose. Live counts over 2,000 recent events (2026-09-20) were `ke` 1,990,
   * `ue` 7, `se` 3, and EMSC's WADL documents no vocabulary for the field. Closing it on three
   * observed values would take the catalogue down the first time a fourth appeared, and guessing
   * what the codes expand to would be worse than storing them: a mis-expanded `kn` would present
   * a nuclear explosion as an earthquake. Stored verbatim; see DATA_SOURCES §6.1.
   */
  evtype: z.string().min(1).max(100).nullable(),
  /** The agency credited with the solution, e.g. `EMSC`, `IPMA`, `KOERI`. */
  auth: z.string().max(100).nullable(),
  /** Flinn–Engdahl region name, e.g. `MOROCCO`. */
  flynn_region: z.string().max(500).nullable(),
});
export type EmscFeatureProperties = z.infer<typeof emscFeaturePropertiesSchema>;

export const emscFeatureSchema = z.looseObject({
  type: z.literal('Feature'),
  /**
   * Nullable rather than required: `unid` is the identity, and taking the source down because a
   * serializer stopped emitting the redundant top-level `id` would be a self-inflicted outage.
   * The adapter still checks the two agree whenever `id` is present.
   */
  id: z.string().min(1).max(100).nullish(),
  geometry: z.looseObject({
    type: z.literal('Point'),
    /** `[lon, lat]`, optionally followed by the **negated** depth. */
    coordinates: z.tuple([finiteNumber, finiteNumber]).rest(finiteNumber),
  }),
  properties: emscFeaturePropertiesSchema,
});
export type EmscFeature = z.infer<typeof emscFeatureSchema>;

export const emscFeedSchema = z.looseObject({
  type: z.literal('FeatureCollection'),
  /**
   * What EMSC says it returned — and it means *returned*, not *matched*: `limit=25000` answers
   * 200 with `count: 20000` and 20,000 features. It is therefore useless as a completeness check
   * and is not used as one. Truncation is detected by the row count instead (see `fdsn.ts`).
   */
  metadata: z.looseObject({ count: finiteNumber.nullish() }).nullish(),
  features: z.array(z.unknown()),
});
