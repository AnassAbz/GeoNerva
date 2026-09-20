/**
 * The GDACS adapter — six products, one API, and the first source that does not fit "one request,
 * one body" without being bent.
 *
 * **Six adapters, not one.** `geonerva.source_products` has been seeded since P2 with one row per
 * GDACS event type, each with its own hazard types, capabilities and latency class, because a
 * volcano and a drought are not the same product even when one endpoint serves both. The
 * descriptor carries one `hazardType`, so the adapter is built per type — and that turns out to
 * be the thing that makes the paging tractable, since `eventlist=WF` can be read to completion
 * while `eventlist=EQ;TC;FL;VO;DR;WF` cannot (see `api.ts`).
 *
 * **A composed body, not a multi-body fetch.** GDACS needs more than one request to answer one
 * question: the list, then `geteventdata` per earthquake for the `sourceid` that is blank in the
 * list. Rather than widen `FetchResult` to carry several bodies — which would give every source a
 * shape only one of them needs, and would leave "which body is the raw payload?" unanswerable —
 * the adapter assembles the provider's answers into one canonical document. One body, one digest,
 * one raw payload, one parse, and a replay years later that re-derives the same versions from
 * storage. Nothing GeoNerva generated goes into it, so two identical polls still produce
 * identical bytes and the second is `SKIPPED`.
 *
 * **HTTP 204 means the opposite of what it means for EMSC.** EMSC runs an FDSN service where 204
 * is the documented "nothing matched" and is ingested as a successful observation of emptiness.
 * Here a 204 is what you get for *forgetting a parameter* — `SEARCH?eventlist=EQ` without
 * `alertlevel` returns one, reproduced on 2026-09-20 — and GDACS always has live wildfires, so an
 * empty poll of the whole catalogue is a broken read, not a quiet planet. Same status code,
 * opposite meaning, and the difference lives in the adapter where it belongs rather than in a
 * shared rule that would have to be wrong for one of them.
 */

import type { HazardType, RejectReasonCode } from '@geonerva/domain';
import { SourceFetchError } from '@geonerva/http';

import {
  batchVerdict,
  canonicalJson,
  payloadHash,
  type FetchContext,
  type FetchResult,
  type NormalizeContext,
  type NormalizedRecord,
  type ParseContext,
  type ParseResult,
  type RejectedRecord,
  type SourceAdapter,
  type SourceDescriptor,
} from '../contract.ts';
import {
  GDACS_HOST,
  gdacsEndpoint,
  gdacsFetchEventData,
  gdacsFetchGeometry,
  gdacsFetchList,
  type GdacsEventType,
} from './api.ts';
import {
  GDACS_HAZARD_TYPES,
  gdacsPrimaryKey,
  normalizeGdacsFeature,
  type GdacsNormalizeInput,
} from './normalize.ts';
import {
  gdacsComposedSchema,
  gdacsFeatureSchema,
  gdacsPropertiesSchema,
  type GdacsFeature,
  type GdacsProperties,
} from './schema.ts';

/**
 * How far back a live poll looks.
 *
 * 24 hours, because `fromDate`/`toDate` select events whose *range overlaps* the window: a day is
 * enough to catch everything currently active plus anything that began overnight, and widening it
 * does not add ongoing events — they are already in every window. The seeded `gdacs:*` policy
 * polls every 10 minutes, so the overlap is enormous and every repeat is `unchanged` by content
 * hash. That is the intended trade: this API gives no reliable incremental cursor
 * (`datemodified` is bulk-restamped, and `geteventlist/latest` is ordered by `todate`), so the
 * poll is deliberately redundant rather than subtly incomplete.
 */
export const GDACS_POLL_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

/** The hazard types whose upstream id is worth a second request. */
const NEEDS_EVENT_DATA: ReadonlySet<HazardType> = new Set<HazardType>(['EARTHQUAKE']);

/**
 * The hazard types whose geometry is worth a second request.
 *
 * Floods only, and not for completeness: `FloodAttributes.has_area_geometry` is a *required*
 * field that decides how the event is described and whether its relevance is capped, and the
 * event list cannot answer it. For the other five the centroid is a complete record on its own,
 * and a per-event request they do not need would be a cost paid against an API with no published
 * rate limit. Cyclone tracks and volcano cones are real and are deliberately deferred — they need
 * `valid_at` semantics tied to advisory times, which is a modelling decision and not an
 * ingestion one.
 */
const NEEDS_GEOMETRY: ReadonlySet<HazardType> = new Set<HazardType>(['FLOOD']);

/** Bounded for the same reason as the detail pass: this API publishes no rate limit. */
const MAX_GEOMETRY_REQUESTS = 100;

/**
 * How many detail requests one poll will make.
 *
 * GDACS has no documented rate limit, which is a reason for restraint rather than licence. 27
 * earthquakes in a day was the live figure; 200 leaves an order of magnitude and still bounds a
 * poll to something a worker finishes.
 */
const MAX_DETAIL_REQUESTS = 200;

interface GdacsProductShape {
  readonly productCode: GdacsEventType;
  readonly capabilities: SourceDescriptor['capabilities'];
  /** Whether an empty answer means the read is broken. */
  readonly emptyBatchIsSuspicious: boolean;
}

/**
 * Per-type descriptor facts, matching `0008_seed_sources.sql` exactly.
 *
 * `emptyBatchIsSuspicious` is the field that differs, and it differs on evidence rather than
 * taste. Wildfires and earthquakes are always in progress somewhere: 258 concurrent wildfires and
 * 27 earthquakes in one day, so an empty answer for either is a broken read. Cyclones, volcanoes,
 * floods and droughts genuinely have quiet days — `alertlevel=orange;red` for wildfires returned
 * HTTP 204 on 2026-09-20 simply because there were none at those levels — and calling a quiet day
 * a broken feed would take those products dark for no reason.
 */
const PRODUCTS: Readonly<Record<GdacsEventType, GdacsProductShape>> = {
  EQ: {
    productCode: 'EQ',
    capabilities: [
      'REALTIME_EVENTS',
      'EVENT_DETAILS',
      'EVENT_REVISIONS',
      'IMPACT_ALERT_LEVELS',
      'CROSS_REFERENCES',
    ],
    emptyBatchIsSuspicious: true,
  },
  FL: {
    productCode: 'FL',
    capabilities: [
      'REALTIME_EVENTS',
      'EVENT_DETAILS',
      'EVENT_REVISIONS',
      'POLYGONS',
      'IMPACT_ALERT_LEVELS',
    ],
    emptyBatchIsSuspicious: false,
  },
  TC: {
    productCode: 'TC',
    capabilities: [
      'REALTIME_EVENTS',
      'EVENT_DETAILS',
      'EVENT_REVISIONS',
      'POLYGONS',
      'TRACKS',
      'FORECAST_GEOMETRY',
      'IMPACT_ALERT_LEVELS',
    ],
    emptyBatchIsSuspicious: false,
  },
  WF: {
    productCode: 'WF',
    capabilities: [
      'REALTIME_EVENTS',
      'EVENT_DETAILS',
      'EVENT_REVISIONS',
      'POLYGONS',
      'IMPACT_ALERT_LEVELS',
    ],
    emptyBatchIsSuspicious: true,
  },
  VO: {
    productCode: 'VO',
    capabilities: ['REALTIME_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS', 'IMPACT_ALERT_LEVELS'],
    emptyBatchIsSuspicious: false,
  },
  DR: {
    productCode: 'DR',
    capabilities: ['REALTIME_EVENTS', 'EVENT_DETAILS', 'IMPACT_ALERT_LEVELS'],
    emptyBatchIsSuspicious: false,
  },
};

export function gdacsDescriptor(eventType: GdacsEventType): SourceDescriptor {
  const product = PRODUCTS[eventType];
  return {
    sourceId: 'gdacs',
    productCode: product.productCode,
    // One seeded policy covers every GDACS product; they share a cadence and a latency class.
    policyKey: 'gdacs:*',
    hazardType: GDACS_HAZARD_TYPES[eventType],
    capabilities: product.capabilities,
    allowedHosts: [GDACS_HOST],
    /*
     * Longer than the FDSN adapters'. P0 observed a timeout from this API on the day it was
     * characterized, and its own terms promise nothing about availability — so the deadline is
     * generous enough that an ordinary slow answer is not recorded as an outage, while still
     * bounded.
     */
    timeoutMs: 45_000,
    // A full 100-row page is ~135 KB; twenty of them plus details is comfortably inside this.
    maxBytes: 20 * 1024 * 1024,
    emptyBatchIsSuspicious: product.emptyBatchIsSuspicious,
    maxRejectRatio: 0.2,
  };
}

function excerptOf(value: unknown, issues: readonly string[]): unknown {
  const properties =
    typeof value === 'object' && value !== null && 'properties' in value
      ? (value as { properties?: unknown }).properties
      : null;
  const identity =
    typeof properties === 'object' && properties !== null
      ? {
          eventtype: (properties as { eventtype?: unknown }).eventtype ?? null,
          eventid: (properties as { eventid?: unknown }).eventid ?? null,
        }
      : { eventtype: null, eventid: null };
  return { ...identity, issues: issues.slice(0, 5) };
}

function reject(
  reasonCode: RejectReasonCode,
  value: unknown,
  issues: readonly string[],
): RejectedRecord {
  return {
    reasonCode,
    excerpt: excerptOf(value, issues),
    detail: issues.join('; ').slice(0, 500),
  };
}

function issuesOf(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string[] {
  return error.issues.map(
    (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  );
}

/** What `normalize` receives: the list feature, plus the detail when one was fetched. */
export interface GdacsRecord extends GdacsNormalizeInput {
  readonly feature: GdacsFeature;
  readonly detail: GdacsProperties | undefined;
}

export type { GdacsGeometryInput } from './normalize.ts';

export function parseGdacsList(body: Uint8Array, ctx: ParseContext): ParseResult<GdacsRecord> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch (error) {
    /*
     * The captured HTML maintenance page served with HTTP 200 lands here, and so does a page that
     * `gdacsFetchList` handed back untouched because it was not a feature collection. Both are
     * drift: the transport was fine and the content was not.
     */
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: `the response body is not JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
      rejects: [],
    };
  }

  const composed = gdacsComposedSchema.safeParse(json);
  if (!composed.success) {
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: `the composed GDACS body changed shape: ${issuesOf(composed.error).slice(0, 5).join('; ')}`,
      rejects: [],
    };
  }

  const records: GdacsRecord[] = [];
  const rejects: RejectedRecord[] = [];
  const seen = new Set<string>();

  for (const candidate of composed.data.events) {
    const parsed = gdacsFeatureSchema.safeParse(candidate);
    if (!parsed.success) {
      rejects.push(reject('SCHEMA_INVALID', candidate, issuesOf(parsed.error)));
      continue;
    }
    const key = gdacsPrimaryKey(parsed.data.properties.eventtype, parsed.data.properties.eventid);
    /*
     * A second dedupe, after the one in `gdacsFetchList`.
     *
     * Not redundant: the fetch-time one exists so that paging terminates and the composed body is
     * honest, and this one exists because `parse` must be a total function of its body — a stored
     * payload replayed years from now goes through here and not through the fetcher.
     */
    if (seen.has(key)) {
      rejects.push(
        reject('DUPLICATE_IN_BATCH', candidate, [`${key} appears more than once in this batch`]),
      );
      continue;
    }
    seen.add(key);

    const rawDetail = composed.data.details[String(parsed.data.properties.eventid)];
    let detail: GdacsProperties | undefined;
    if (rawDetail !== undefined) {
      const properties =
        typeof rawDetail === 'object' && rawDetail !== null
          ? (rawDetail as { properties?: unknown }).properties
          : undefined;
      const parsedDetail = gdacsPropertiesSchema.safeParse(properties);
      /*
       * A detail that does not parse is dropped, not a reject.
       *
       * The list row is a complete record on its own; the detail only ever *adds* the upstream
       * id. Failing the event because its optional enrichment was malformed would lose a real
       * earthquake to a second request that was never required. What it costs is that the record
       * is normalized without `derivedFrom`, which correlation reads as "not known to be derived"
       * — never as "independent". That asymmetry is deliberate (see the contract).
       */
      detail = parsedDetail.success ? parsedDetail.data : undefined;
    }
    /*
     * The geometry answer, when one was fetched. Absent means "not asked" for every hazard but
     * FLOOD, and for FLOOD it means "asked and could not be answered" — which `normalize` turns
     * into a reject rather than into a flood with no modelled area.
     */
    const rawGeometry = composed.data.geometries?.[String(parsed.data.properties.eventid)];

    records.push({
      feature: parsed.data,
      detail,
      ...(rawGeometry === undefined ? {} : { geometry: rawGeometry }),
    });
  }

  const verdict = batchVerdict(ctx.descriptor, records.length, rejects.length);
  if (!verdict.ok) {
    return { verdict: 'REJECTED', errorClass: verdict.errorClass, detail: verdict.detail, rejects };
  }

  /*
   * No declared count.
   *
   * GDACS publishes no total anywhere — not in the list, not in a count endpoint — so there is
   * nothing to check the batch against. Saying so explicitly is better than inventing a number
   * from the rows we happened to read, which would check the batch against itself.
   */
  return { verdict: 'OK', records, rejects, declaredCount: null };
}

async function fetchGdacs(eventType: GdacsEventType, ctx: FetchContext): Promise<FetchResult> {
  let lookbackMs = GDACS_POLL_LOOKBACK_MS;
  if (ctx.feed !== undefined) {
    const hours = Number(ctx.feed);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 90) {
      throw new SourceFetchError(
        'CONFIG_ERROR',
        `unknown GDACS feed ${ctx.feed}; expected a whole number of hours in [1, 2160]`,
        { host: GDACS_HOST },
      );
    }
    lookbackMs = hours * 60 * 60 * 1_000;
  }

  const to = new Date();
  const window = { from: new Date(to.getTime() - lookbackMs), to };
  const list = await gdacsFetchList(ctx.client, eventType, window, {
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });

  const endpoint = gdacsEndpoint(eventType);

  if (list.kind === 'MALFORMED') {
    // Handed straight through, so `parse` fails it with the provider's own bytes as the evidence.
    return {
      kind: 'FETCHED',
      body: list.body,
      httpStatus: list.httpStatus,
      bytes: list.body.byteLength,
      payloadSha256: payloadHash(list.body),
      endpoint,
      attempts: list.attempts,
      durationMs: list.durationMs,
    };
  }

  /*
   * The detail pass. Earthquakes only, bounded, and never fatal.
   *
   * Sorted by event id so that the composed body does not depend on the order pages happened to
   * arrive in — otherwise an unstable page sort would change the digest of an unchanged
   * catalogue and manufacture a poll's worth of "new" bytes every time.
   */
  const details: Record<string, unknown> = {};
  const geometries: Record<string, unknown> = {};
  let attempts = list.attempts;
  const durationMs = list.durationMs;
  const hazardType = GDACS_HAZARD_TYPES[eventType];

  const identified: { id: number; episodeId: number | null }[] = [];
  for (const feature of list.features) {
    const properties =
      typeof feature === 'object' && feature !== null
        ? (feature as { properties?: unknown }).properties
        : null;
    if (typeof properties !== 'object' || properties === null) continue;
    const { eventid, episodeid } = properties as { eventid?: unknown; episodeid?: unknown };
    if (typeof eventid !== 'number' || !Number.isInteger(eventid) || eventid <= 0) continue;
    identified.push({
      id: eventid,
      episodeId: typeof episodeid === 'number' && Number.isInteger(episodeid) ? episodeid : null,
    });
  }
  identified.sort((a, b) => a.id - b.id);

  if (NEEDS_EVENT_DATA.has(hazardType)) {
    for (const { id } of identified.slice(0, MAX_DETAIL_REQUESTS)) {
      const detail = await gdacsFetchEventData(ctx.client, eventType, id, {
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      attempts += 1;
      if (detail !== null) details[String(id)] = detail;
    }
  }

  if (NEEDS_GEOMETRY.has(hazardType)) {
    for (const { id, episodeId } of identified.slice(0, MAX_GEOMETRY_REQUESTS)) {
      const geometry = await gdacsFetchGeometry(ctx.client, eventType, id, episodeId, {
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      attempts += 1;
      // `null` means the question could not be asked, which `normalize` turns into a reject. It
      // is deliberately not recorded as `hasArea: false` — that would be an answer we do not have.
      if (geometry !== null) geometries[String(id)] = geometry;
    }
  }

  /*
   * One canonical document. Keys sorted at every depth by `canonicalJson`, so the digest depends
   * on what GDACS said and on nothing else — not on page order, not on the clock, not on which of
   * the detail requests happened to answer first.
   */
  const composed = { events: list.features, details, geometries };
  const body = new TextEncoder().encode(canonicalJson(composed));
  const digest = payloadHash(body);

  const meta = {
    httpStatus: 200,
    bytes: body.byteLength,
    payloadSha256: digest,
    endpoint,
    attempts,
    durationMs,
  } as const;

  if (ctx.lastPayloadSha256?.equals(digest) === true) {
    return { ...meta, kind: 'UNCHANGED' };
  }
  return { ...meta, kind: 'FETCHED', body };
}

export function gdacsAdapter(eventType: GdacsEventType): SourceAdapter<GdacsRecord> {
  return {
    descriptor: gdacsDescriptor(eventType),
    fetch: (ctx: FetchContext) => fetchGdacs(eventType, ctx),
    parse: parseGdacsList,
    normalize: (raw: GdacsRecord, ctx: NormalizeContext): NormalizedRecord =>
      normalizeGdacsFeature(raw, ctx),
  };
}
