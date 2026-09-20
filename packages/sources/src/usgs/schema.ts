/**
 * The USGS summary-feed schema (DATA_SOURCES §1.2).
 *
 * Two deliberate choices:
 *
 *  - **The envelope is strict, the feature properties are not.** A new field appearing in
 *    `properties` is routine — USGS adds product types over time — and failing the batch for it
 *    would take the source down for a harmless change. A new *top-level* shape, or a changed
 *    type on a field we depend on, is drift and must fail.
 *  - **The schema declares exactly the fields `normalize` consumes, and no others.** `detail`,
 *    `sources`, `types` and `tz` are deliberately absent: nothing reads them, they ride along in
 *    the loose object, and the whole feature is stored verbatim as the raw payload regardless. A
 *    field we do not read has no business being able to fail a batch — and `detail` really is
 *    absent from FDSN single-event answers, which a stricter schema rejected outright.
 *
 *    The converse matters more: a field we *do* read stays required even when it is nullable, so
 *    that renaming `mag` to `magnitude` is a reject rather than a silently missing magnitude.
 *  - **Only the fields we actually use are typed.** `nullable()` is used where USGS really does
 *    send null (verified in P0 against a month of data): `mag` is null for sonic booms, `place`
 *    is null on many deleted events, `alert` is null for most events under M5.5, and `nst`,
 *    `dmin`, `gap`, `rms` are null for small regional events.
 */

import { z } from 'zod';

/** JSON cannot carry NaN or Infinity, and zod 4's `z.number()` already rejects them. */
const finiteNumber = z.number();

export const usgsFeaturePropertiesSchema = z.looseObject({
  mag: finiteNumber.nullable(),
  place: z.string().nullable(),
  /** Epoch milliseconds, UTC. */
  time: finiteNumber,
  updated: finiteNumber.nullable(),
  url: z.string().nullable(),
  felt: finiteNumber.nullable(),
  cdi: finiteNumber.nullable(),
  mmi: finiteNumber.nullable(),
  /** PAGER alert level. */
  alert: z.string().nullable(),
  /**
   * Closed on purpose. `observation_versions.attributes.review_status` accepts exactly these
   * four, so a fifth value must surface as a reject row with a reason code — visible on
   * `/data-status` and countable against the drift threshold — rather than as a crash inside the
   * persist transaction or, worse, a silently dropped field.
   */
  status: z.enum(['automatic', 'reviewed', 'manual', 'deleted']),
  tsunami: finiteNumber.nullable(),
  sig: finiteNumber.nullable(),
  net: z.string().nullable(),
  code: z.string().nullable(),
  /** Comma-delimited and comma-wrapped: `,nc75438582,us7000tiar,`. The identity (§1.3). */
  ids: z.string().nullable(),
  nst: finiteNumber.nullable(),
  dmin: finiteNumber.nullable(),
  rms: finiteNumber.nullable(),
  gap: finiteNumber.nullable(),
  magType: z.string().nullable(),
  type: z.string().nullable(),
  title: z.string().nullable(),
});

/**
 * `[longitude, latitude, depth_km]`. Depth is routinely negative — 308 of 10,823 events in a real
 * month were above sea level — so no lower bound is imposed here.
 */
export const usgsGeometrySchema = z.strictObject({
  type: z.literal('Point'),
  coordinates: z.tuple([finiteNumber, finiteNumber, finiteNumber.nullable()]),
});

export const usgsFeatureSchema = z.looseObject({
  type: z.literal('Feature'),
  properties: usgsFeaturePropertiesSchema,
  geometry: usgsGeometrySchema,
  id: z.string().min(1),
});

/**
 * The envelope. `features` is validated per element by the parser rather than here, so one bad
 * feature yields one reject row instead of failing the batch.
 */
export const usgsFeedSchema = z.looseObject({
  type: z.literal('FeatureCollection'),
  metadata: z.looseObject({
    generated: finiteNumber.nullable().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    status: finiteNumber.optional(),
    api: z.string().optional(),
    count: finiteNumber.nullable().optional(),
  }),
  features: z.array(z.unknown()),
});

export type UsgsFeature = z.infer<typeof usgsFeatureSchema>;
export type UsgsFeed = z.infer<typeof usgsFeedSchema>;
