/**
 * The adapter contract every provider implements (ARCHITECTURE §4.1).
 *
 * The shape is frozen; what this file adds is the reasoning a second adapter needs in order to be
 * written by copying the first:
 *
 *  - **`normalize` is pure.** No clock, no IO, no database. It receives one parsed record and
 *    returns the facts. That is what makes the fixtures a complete specification of an adapter's
 *    behaviour and what lets replay re-derive a version without a network.
 *  - **The batch verdict is per batch, not per record.** One malformed feature out of 400 is a
 *    reject row; eighty of them is schema drift, and the right response to drift is to write
 *    *nothing* and shout, because a half-ingested batch looks exactly like a quiet day.
 *  - **Nothing is skipped silently.** Every record that does not become a fact leaves either a
 *    reject row with a reason code or a raised error. A `continue` with no trace is a bug.
 *
 * Conditional GET: the HTTP client supports `If-None-Match`, but the frozen schema has nowhere to
 * persist a validator between runs, so adapters detect "nothing changed" by comparing the body
 * digest with `ingestion_runs.payload_sha256` of the previous run instead. The cost is one
 * download per poll that a 304 could have avoided — about 1 MB every five minutes for USGS.
 * Adding an `etag` column is not worth a change to a frozen table for that.
 */

import { createHash } from 'node:crypto';

import type {
  GeometryKind,
  GeometryRole,
  HazardType,
  LatLon,
  LifecycleStatus,
  RejectReasonCode,
  SeverityScheme,
  SourceCapability,
} from '@geonerva/domain';
import { HttpClient, type HttpClientOptions } from '@geonerva/http';

/**
 * Static facts about a source product. Freshness policy and attribution are *not* copied here:
 * they are seeded in `geonerva.sources` and would drift if they existed twice. The descriptor
 * names the policy instead, and a test asserts every descriptor matches a seeded product.
 */
export interface SourceDescriptor {
  /** `geonerva.sources.id`. */
  readonly sourceId: string;
  /** `geonerva.source_products.code`. */
  readonly productCode: string;
  /** Key into `INITIAL_FRESHNESS_POLICIES`. */
  readonly policyKey: string;
  readonly hazardType: HazardType;
  readonly capabilities: readonly SourceCapability[];
  /** Hosts this adapter may reach. Passed straight to the HTTP client's allowlist. */
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /**
   * Whether a batch of zero records means the feed is broken.
   *
   * Deliberately **not** called `quietIsNormal`, and deliberately not read from the freshness
   * policy, because they answer different questions and USGS answers them differently:
   *
   *  - `FreshnessPolicy.quietIsNormal` (seeded, `true` for USGS) asks *"is it normal for the
   *    newest observation to be old?"* — yes, hours can pass with no notable earthquake.
   *  - This asks *"is it normal for a whole poll to contain nothing?"* — no. `all_day` is a
   *    24-hour window over ~400 events/day, so an empty one is a broken feed, and reporting it
   *    as "no earthquakes" would be the most misleading thing this system could say.
   *
   * One name for both would have forced one answer, and either answer would be wrong somewhere.
   */
  readonly emptyBatchIsSuspicious: boolean;
  /** Fraction of rejected records above which the batch is treated as schema drift. */
  readonly maxRejectRatio: number;
}

export interface FetchContext {
  readonly client: HttpClient;
  readonly signal?: AbortSignal;
  /** Digest of the body the previous run ingested, or `null` on the first ever run. */
  readonly lastPayloadSha256: Buffer | null;
  /** Which feed to poll, when the adapter offers more than one. */
  readonly feed?: string;
}

interface FetchMeta {
  readonly httpStatus: number;
  readonly bytes: number;
  readonly payloadSha256: Buffer;
  /** Host and path only — a feed URL may carry a key (FIRMS does), and this is logged. */
  readonly endpoint: string;
  readonly attempts: number;
  readonly durationMs: number;
  /**
   * The span of provider data this request asked for, in observation time, or `null` when the
   * adapter cannot state one (ADR-041). A live poll that commits successfully records this span in
   * the coverage ledger: it is how GeoNerva knows that a quiet hour was *read* and not merely
   * unobserved. Adapter knowledge — `all_day` is 24 hours, EMSC asks for `updatedafter` — carried
   * on the result so nothing downstream branches on a source id.
   */
  readonly readWindow: ReadWindow | null;
}

/** A half-open span of observation time `[from, to)` that one request read. */
export interface ReadWindow {
  readonly from: Date;
  readonly to: Date;
}

export type FetchResult =
  | (FetchMeta & { readonly kind: 'FETCHED'; readonly body: Uint8Array })
  /** Byte-identical to the previous run. Still health evidence, so the run is SKIPPED, not lost. */
  | (FetchMeta & { readonly kind: 'UNCHANGED' })
  /**
   * The provider answered, definitively, that nothing matched the query.
   *
   * A third kind rather than an empty body, because the three are different facts and collapsing
   * them loses the one that matters (ARCHITECTURE §4.2: unavailable ≠ empty ≠ unknown):
   *
   *  - `UNCHANGED` — "the same bytes you already have". Says nothing about the world.
   *  - `NO_DATA` — "I looked, and there is nothing in that window". An observation.
   *  - `FETCHED` with zero records — a *body* that contains no records, which for a feed that
   *    should never be empty is drift (`EMPTY_SUSPICIOUS`), not quiet.
   *
   * EMSC makes the distinction explicit: an FDSN service with the default `nodata=204` answers
   * **HTTP 204 with an empty body** when nothing matched (live-verified 2026-09-20), and a 200
   * carrying `features: []` from that same service is therefore a malformed answer rather than a
   * quiet hour. Routing the 204 here keeps `emptyBatchIsSuspicious` free to mean what it says.
   *
   * There is no body, so there is nothing to hash: `payloadSha256` carries the **previous** run's
   * digest forward, for the same reason a 304 does — storing sha256("") would erase the last
   * real digest and make the next identical body look changed.
   */
  | (FetchMeta & { readonly kind: 'NO_DATA'; readonly detail: string });

export interface ParseContext {
  readonly descriptor: SourceDescriptor;
}

/** A record that will not become a fact, and why. One row in `ingestion_rejects`. */
export interface RejectedRecord {
  readonly reasonCode: RejectReasonCode;
  /** Enough of the offending record to debug it, bounded by the caller. Never the whole body. */
  readonly excerpt: unknown;
  /** Human-readable detail for the log. */
  readonly detail: string;
}

export type ParseResult<TRaw> =
  | {
      readonly verdict: 'OK';
      readonly records: readonly TRaw[];
      readonly rejects: readonly RejectedRecord[];
      /** What the provider said it was sending, when it says so. For a completeness check. */
      readonly declaredCount: number | null;
    }
  | {
      /** The batch is not usable. Nothing is written — not even the records that parsed. */
      readonly verdict: 'REJECTED';
      readonly errorClass: 'SCHEMA_DRIFT' | 'EMPTY_SUSPICIOUS';
      readonly detail: string;
      readonly rejects: readonly RejectedRecord[];
      /**
       * How many records the provider sent, including the ones that parsed fine.
       *
       * Without it the run row reported `n_received = <rejects>`, so a batch of 100 good records
       * and 30 bad ones — which trips the 20 % threshold and is correctly refused — was recorded
       * as having received 30. `failRun` argues at length that a wrong `received` makes drift
       * indistinguishable from an empty feed on `/data-status`, and then this shape made it
       * unavoidable: the variant carried no way to say the number. Every adapter knows it at the
       * point it builds the verdict.
       */
      readonly receivedCount: number;
    };

export interface NormalizeContext {
  readonly descriptor: SourceDescriptor;
}

/**
 * One provider observation, in GeoNerva's vocabulary.
 *
 * Deliberately absent: `ingestedAt`, `sourceRecordId`, `rawRecordId` and `ingestionRunId`. Those
 * belong to the *batch*, are decided at persist time, and letting a pure function invent them is
 * how a batch ends up with two different `ingested_at` values and a replay that shows half of it.
 */
export interface NormalizedRecord {
  /** The provider's current preferred identifier. Stored, but never the only key. */
  readonly primaryKey: string;
  /** Every identifier the provider has associated with this record, including `primaryKey`. */
  readonly aliases: readonly string[];
  readonly hazardType: HazardType;
  readonly observedAt: Date;
  readonly sourceUpdatedAt: Date | null;
  readonly lifecycleStatus: LifecycleStatus;
  readonly centroid: LatLon;
  readonly geometryKind: GeometryKind;
  readonly magnitude: number | null;
  readonly magnitudeType: string | null;
  readonly depthKm: number | null;
  /** The agency credited with this solution, for the independence rule (ADR-030). */
  readonly contributor: string | null;
  readonly providerStatus: string | null;
  /**
   * Which provider scale `severityValue` is on, from the frozen vocabulary.
   *
   * Typed rather than `string`, which is what it was until a GDACS batch of 79 wildfires was
   * refused by the database at the end of a successful fetch, parse and normalize because the
   * scheme had been written as `GDACS` and the column's CHECK says `GDACS_ALERT`. Every other
   * value in this interface that the database constrains — `lifecycleStatus`, `geometryKind`,
   * `hazardType` — was already a union; this one was the exception, and the exception cost a
   * whole batch and a live run to find something the compiler now refuses to build.
   */
  readonly severityScheme: SeverityScheme | null;
  readonly severityValue: string | null;
  readonly title: string | null;
  readonly sourceUrl: string | null;
  /**
   * What this observation restates, when it restates something GeoNerva also holds directly.
   *
   * `{ source, ref }` — e.g. `{ source: 'usgs', ref: 'us7000tikb' }` for a GDACS earthquake,
   * which is a copy of the USGS solution rather than a second opinion about it. Correlation
   * attaches a record with this set as a DERIVED_COPY instead of counting it as agreement, which
   * is the difference between "two sources agree" and "one source quoted twice" (ADR-030).
   *
   * Absent means "not known to be derived", never "independent". A source with no upstream field
   * at all and a source whose upstream field happened to be empty are the same absence here, and
   * neither is evidence of independence.
   */
  readonly derivedFrom?: { readonly source: string; readonly ref: string };
  readonly attributes: Record<string, unknown>;
  /**
   * Role-tagged shapes beyond the centroid: a flood's modelled area, a cyclone's track and wind
   * buffers, a wildfire's burnt area.
   *
   * Optional because most sources have none — an earthquake is a point and a thermal detection is
   * a pixel — and absent must mean "this source publishes no area", never "we did not fetch one".
   * An adapter that *can* fetch an area and chose not to has to say so in its attributes, which
   * is why `FloodAttributes.has_area_geometry` exists as a required field rather than being
   * inferred from this array being empty.
   *
   * The shapes are part of the content hash: a flood whose modelled area moved is a revision, and
   * it is frequently the *only* thing that moved.
   */
  readonly geometries?: readonly NormalizedGeometry[];
  /** Hash of the normalized content — the only change detector (ADR-029). */
  readonly contentSha256: Buffer;
  /** Exactly what the provider sent for this record, stored verbatim for provenance. */
  readonly rawPayload: unknown;
  readonly rawPayloadSha256: Buffer;
}

/**
 * One role-tagged shape, in the form `observation_geometries` stores.
 *
 * Deliberately GeoJSON rather than WKT or a parsed type: it is what every provider here sends, it
 * survives being written to `raw_source_records` and read back years later, and PostGIS takes it
 * directly through `ST_GeomFromGeoJSON`. Nothing in the adapter layer simplifies or reprojects —
 * a shape GeoNerva altered is no longer the shape the provider published.
 */
export interface NormalizedGeometry {
  readonly role: GeometryRole;
  /** Distinguishes several shapes sharing a role, e.g. successive forecast positions. */
  readonly seq: number;
  readonly geoJson: unknown;
  /** For forecast geometry: the time this shape applies to. Never a future `observedAt`. */
  readonly validAt?: Date | null;
  readonly isForecast?: boolean;
}

export interface SourceAdapter<TRaw> {
  readonly descriptor: SourceDescriptor;
  fetch(ctx: FetchContext): Promise<FetchResult>;
  parse(body: Uint8Array, ctx: ParseContext): ParseResult<TRaw>;
  /** Pure. Same input, same output, forever — including across a replay years later. */
  normalize(raw: TRaw, ctx: NormalizeContext): NormalizedRecord;
}

/**
 * Raised by `normalize`, for the two different kinds of thing that can be wrong with a record.
 *
 *  - **With a `reasonCode`:** this one record is unusable, but the batch is not. It becomes a
 *    reject row, it is counted, and the drift threshold decides whether the feed as a whole has
 *    changed. A bad latitude is this kind.
 *  - **Without one:** an invariant that makes the whole batch untrustworthy. The identity rules
 *    are these: carrying on after "the preferred id is not in its own alias set" would fabricate
 *    a duplicate record, which later reads as a second independent source agreeing with the
 *    first — the most expensive mistake this system can make.
 *
 * The distinction matters because getting it wrong in the safe-looking direction is not safe: a
 * single bad coordinate treated as batch-fatal takes a source dark for as long as the provider
 * keeps republishing that record, which for a 24-hour summary feed is a day.
 */
export class NormalizationError extends Error {
  readonly providerId: string;
  readonly invariant: string;
  /** Present when only this record is affected; absent when the batch cannot be trusted. */
  readonly reasonCode: RejectReasonCode | undefined;

  constructor(
    invariant: string,
    providerId: string,
    message: string,
    reasonCode?: RejectReasonCode,
  ) {
    super(`${invariant} (${providerId}): ${message}`);
    this.name = 'NormalizationError';
    this.invariant = invariant;
    this.providerId = providerId;
    this.reasonCode = reasonCode;
  }

  /** True when the batch can continue without this record. */
  get isRecordLevel(): boolean {
    return this.reasonCode !== undefined;
  }
}

/**
 * Builds the HTTP client a source is allowed to use, from its descriptor.
 *
 * The allowlist, the deadline and the size cap come from one place and are applied at
 * construction, so an adapter cannot widen them per request — and a test can narrow them without
 * the adapter's cooperation.
 */
export function createSourceClient(
  descriptor: SourceDescriptor,
  options: { readonly userAgent: string } & Partial<HttpClientOptions>,
): HttpClient {
  return new HttpClient({
    allowedHosts: [...descriptor.allowedHosts],
    timeoutMs: descriptor.timeoutMs,
    maxBytes: descriptor.maxBytes,
    ...options,
  });
}

/**
 * Deterministic JSON: object keys sorted at every depth, so two structurally equal values always
 * produce the same bytes. `JSON.stringify` preserves insertion order, which means the same record
 * arriving with its fields in a different order would otherwise hash differently and manufacture
 * a revision that never happened.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    // An absent key and a key set to undefined must hash alike: JSON.stringify drops both.
    if (entry !== undefined) sorted[key] = canonicalize(entry);
  }
  return sorted;
}

/** The content digest, as the 32 raw bytes `observation_versions.content_sha256` stores. */
export function contentHash(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

/** Digest of a payload exactly as received, for `raw_records` and `ingestion_runs`. */
export function payloadHash(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

/**
 * Decides the batch verdict from the counts (ARCHITECTURE §4.2).
 *
 * Kept here rather than in each adapter so the 20 % threshold cannot drift between sources, and
 * so the rule is testable without a provider.
 */
export function batchVerdict(
  descriptor: SourceDescriptor,
  accepted: number,
  rejected: number,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly errorClass: 'SCHEMA_DRIFT' | 'EMPTY_SUSPICIOUS';
      readonly detail: string;
    } {
  const total = accepted + rejected;
  if (total === 0) {
    if (!descriptor.emptyBatchIsSuspicious) return { ok: true };
    return {
      ok: false,
      errorClass: 'EMPTY_SUSPICIOUS',
      detail: `${descriptor.productCode} returned no records, and silence is not normal for it`,
    };
  }
  const ratio = rejected / total;
  if (ratio > descriptor.maxRejectRatio) {
    return {
      ok: false,
      errorClass: 'SCHEMA_DRIFT',
      detail: `${rejected} of ${total} records failed validation (${(ratio * 100).toFixed(1)} %), above the ${(descriptor.maxRejectRatio * 100).toFixed(0)} % drift threshold`,
    };
  }
  return { ok: true };
}
