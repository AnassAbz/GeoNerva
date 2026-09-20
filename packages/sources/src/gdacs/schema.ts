/**
 * The GDACS event-list schema (DATA_SOURCES §2).
 *
 * Same strictness rule as the other adapters — loose properties so a new field cannot take the
 * source down, required-even-when-nullable for every field `normalize` reads — with two
 * provider-specific notes:
 *
 *  - **`istemporary` and `iscurrent` are the strings `"true"`/`"false"`,** not booleans. A schema
 *    written as `z.boolean()` rejects the entire catalogue, and one written as `z.unknown()`
 *    would silently make `Boolean("false")` true, which is the more expensive mistake: `iscurrent`
 *    drives `EVENT_RESOLVED`, so every resolved event would read as ongoing.
 *  - **`countryonland` is present on some types and absent on others** — every non-EQ row carried
 *    it on 2026-09-20 and no EQ row did. Nothing reads it, so it simply rides along.
 *
 * `eventid` is typed as a number because that is what GDACS sends, and it is the identity: a
 * string here would make `EQ:1567022` and `EQ:"1567022"` two different records.
 */

import { z } from 'zod';

const finiteNumber = z.number();

/** GDACS's own `"true"`/`"false"` strings, and nothing else. */
const gdacsBoolean = z.enum(['true', 'false']);

/**
 * `severitydata` — the one field whose meaning changes completely per hazard type.
 *
 * EQ: magnitude in `M`. TC: maximum wind in `km/h`. WF: burnt area in `ha`. FL: a signal
 * magnitude that is `0` for every live GLOFAS event observed. The unit is therefore not
 * decoration, it is what says which quantity this is, and normalization reads it before deciding
 * what the number means.
 */
export const gdacsSeveritySchema = z.looseObject({
  severity: finiteNumber.nullable(),
  severitytext: z.string().nullable(),
  severityunit: z.string().nullable(),
});

export const gdacsPropertiesSchema = z.looseObject({
  eventtype: z.string().min(1).max(10),
  eventid: finiteNumber,
  /** Increments per update. Part of the identity of a *version*, never of the record (§4.6). */
  episodeid: finiteNumber.nullable(),
  eventname: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  /** The event's overall level. `Green | Orange | Red`. */
  alertlevel: z.string().nullable(),
  alertscore: finiteNumber.nullable(),
  /** This episode's level, which can differ from the event's — SAUDEL-26 went Green → Orange. */
  episodealertlevel: z.string().nullable(),
  episodealertscore: finiteNumber.nullable(),
  istemporary: gdacsBoolean.nullable(),
  iscurrent: gdacsBoolean.nullable(),
  country: z.string().nullable(),
  iso3: z.string().nullable(),
  /** No timezone suffix. Parsed as UTC explicitly — see `gdacsInstant`. */
  fromdate: z.string().min(1).max(40),
  todate: z.string().nullable(),
  /**
   * Bulk-restamped by GDACS jobs — P0 saw dozens of unrelated old events re-stamped within the
   * same minute — so it is **not** a change signal and is deliberately kept out of the content
   * hash. It is still stored, as `source_updated_at`, because it is what the provider said.
   */
  datemodified: z.string().nullable(),
  /** The agency GDACS credits: `NEIC`, `GLOFAS`, `GWIS`, `NOAA`, `JTWC`. */
  source: z.string().nullable(),
  /**
   * The upstream event id. **Empty in the list and in the RSS** — only `geteventdata` fills it —
   * and for EQ it is the USGS id that makes the record a derived copy rather than a second
   * opinion.
   */
  sourceid: z.string().nullable(),
  severitydata: gdacsSeveritySchema.nullable(),
  affectedcountries: z.array(z.unknown()).nullable(),
});
export type GdacsProperties = z.infer<typeof gdacsPropertiesSchema>;

export const gdacsFeatureSchema = z.looseObject({
  type: z.literal('Feature'),
  geometry: z
    .looseObject({
      type: z.literal('Point'),
      coordinates: z.tuple([finiteNumber, finiteNumber]).rest(finiteNumber),
    })
    .nullable(),
  properties: gdacsPropertiesSchema,
});
export type GdacsFeature = z.infer<typeof gdacsFeatureSchema>;

/**
 * What the adapter's `fetch` assembles and `parse` reads.
 *
 * GDACS needs more than one request to answer one question — the list, and then `geteventdata`
 * per earthquake for the `sourceid` that is blank in the list. Rather than bend the contract to
 * allow a multi-body fetch, the adapter composes the provider's answers into **one** document:
 * one body, one digest, one raw payload, one parse, and a replay years later that re-derives the
 * same versions without a network. Nothing in it is GeoNerva's — no timestamps, no counters —
 * so two identical polls still produce identical bytes and the second is `SKIPPED`.
 */
export const gdacsComposedSchema = z.looseObject({
  events: z.array(z.unknown()),
  /** Keyed by event id as a string, present only for the types that need a detail call. */
  details: z.record(z.string(), z.unknown()),
  /**
   * Keyed by event id as a string, present only for floods.
   *
   * `hasArea` is separate from `features` on purpose: a flood whose modelled area exists but was
   * too large to store is not the same as a flood with no modelled area, and collapsing the two
   * would make a cap on *our* side read as a statement about the *provider's* data.
   */
  geometries: z
    .record(
      z.string(),
      z.looseObject({
        hasArea: z.boolean(),
        features: z.array(z.unknown()),
        oversized: z.boolean(),
      }),
    )
    .optional(),
});
export type GdacsComposed = z.infer<typeof gdacsComposedSchema>;
