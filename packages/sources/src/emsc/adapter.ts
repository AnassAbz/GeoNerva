/**
 * The EMSC adapter — the second earthquake source, and the first test of whether the contract
 * bends to a provider that answers the same questions differently.
 *
 * Three places where it does bend, and why each is the contract's problem rather than EMSC's:
 *
 *  - **HTTP 204 is an answer, not an absence.** EMSC's FDSN service runs the default `nodata=204`,
 *    so a window with no events comes back 204 with an empty body (live-verified 2026-09-20).
 *    That is the provider *observing* emptiness, which is a different fact from "the bytes are
 *    unchanged" and a different fact again from "the body parsed to nothing". It is returned as
 *    `NO_DATA`, and the run SUCCEEDs with zero received.
 *  - **`emptyBatchIsSuspicious` can therefore stay strict.** Because 204 never reaches the parser,
 *    a 200 carrying `features: []` from a service configured for 204 is a malformed answer, and
 *    the fixture manifest says exactly that: *"Expect: EMPTY_SUSPICIOUS (not 'no events')"*. The
 *    same flag on the same contract means "silence is suspicious" for both sources, but it means
 *    it about genuinely different situations.
 *  - **There is no conditional-GET shortcut worth having.** The live poll is `updatedafter=now-N`,
 *    so the URL changes every poll and the body almost always differs. The digest comparison is
 *    still done — it costs nothing and catches a frozen mirror — but it is not expected to fire.
 *
 * Deletions are absent, deliberately and verifiably: `includedeleted` is HTTP 400 *Unknown request
 * parameters(s)* on this service. EMSC publishes retractions only on its websocket, which needs a
 * persistent worker (DATA_SOURCES §6.1, V6). The descriptor does not claim `DELETIONS`, matching
 * the seeded product, so nothing downstream can believe a sweep exists.
 */

import type { RejectReasonCode } from '@geonerva/domain';
import { SourceFetchError } from '@geonerva/http';

import {
  batchVerdict,
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
import { EMSC_HOST, emscEndpoint, emscUpdatedAfterUrl, isTruncated } from './fdsn.ts';
import { normalizeEmscFeature } from './normalize.ts';
import { emscFeatureSchema, emscFeedSchema, type EmscFeature } from './schema.ts';

/**
 * How far back a live poll asks.
 *
 * Three poll intervals (the seeded `emsc:rts` policy polls every 5 minutes). Overlap rather than a
 * stored cursor, for a reason specific to this service: `updatedafter` answers are **not ordered
 * by `lastupdate`**, so a cursor taken from the last row would be wrong, and a cursor taken from
 * the batch maximum silently skips anything revised between the maximum and the next poll. A
 * window that overlaps itself twice over cannot skip, and every repeat is `unchanged` by content
 * hash, so the cost of the overlap is a comparison rather than a version.
 */
export const EMSC_POLL_LOOKBACK_MS = 15 * 60 * 1_000;

/**
 * How much of a batch may lack a magnitude before the field is treated as gone.
 *
 * Measured against the worst real case there is: the EMSC-EMB merged bulletin, where 2 of 97
 * events on 2010-01-01 have no `mag` key at all — about 2 %. A rename would make it 100 %. Half
 * leaves a very wide margin on both sides of a question that has no borderline answer.
 */
const MAX_MISSING_MAGNITUDE_RATIO = 0.5;

/** Below this, the ratio is noise: three records with one missing is 33 % and means nothing. */
const MIN_RECORDS_FOR_FIELD_DRIFT = 20;

export const emscDescriptor: SourceDescriptor = {
  sourceId: 'emsc',
  productCode: 'rts',
  policyKey: 'emsc:rts',
  hazardType: 'EARTHQUAKE',
  /*
   * Matches `geonerva.source_products` for `emsc/rts` exactly, including what is absent.
   * `DELETIONS` is not here because the FDSN service refuses `includedeleted` outright, and
   * `POINT_DETECTIONS`/`IMPACT_ALERT_LEVELS` are not here because EMSC publishes neither.
   */
  capabilities: [
    'REALTIME_EVENTS',
    'HISTORICAL_EVENTS',
    'EVENT_DETAILS',
    'EVENT_REVISIONS',
    'CROSS_REFERENCES',
  ],
  allowedHosts: [EMSC_HOST],
  timeoutMs: 30_000,
  /*
   * 20,000 rows at roughly 500 B each is ~10 MB; a live poll is a few kilobytes. Measured: the
   * whole 20,000-row cap came back as 10,902,374 bytes on 2026-09-20. 20 MB leaves headroom
   * without letting a mirror serving something else exhaust the worker.
   */
  maxBytes: 20 * 1024 * 1024,
  /*
   * A 200 with no features. Not "a quiet 15 minutes" — that arrives as a 204 and never reaches
   * the parser — but a service that was configured to answer 204 and did not.
   */
  emptyBatchIsSuspicious: true,
  maxRejectRatio: 0.2,
};

/** Bounded excerpt: enough to identify the record, never the whole feature. */
function excerptOf(value: unknown, issues: readonly string[]): unknown {
  const properties =
    typeof value === 'object' && value !== null && 'properties' in value
      ? (value as { properties?: unknown }).properties
      : null;
  const unid =
    typeof properties === 'object' && properties !== null && 'unid' in properties
      ? ((properties as { unid?: unknown }).unid ?? null)
      : null;
  return { unid, issues: issues.slice(0, 5) };
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

function decodeUtf8(body: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function issuesOf(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string[] {
  return error.issues.map(
    (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  );
}

export function parseEmscFeed(body: Uint8Array, ctx: ParseContext): ParseResult<EmscFeature> {
  const text = decodeUtf8(body);
  if (text === null) {
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: 'the response body is not valid UTF-8',
      rejects: [],
      receivedCount: 0,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    // The captured maintenance page is HTML served with 200; it lands here, which is why this is
    // drift rather than an HTTP class.
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: `the response body is not JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
      rejects: [],
      receivedCount: 0,
    };
  }

  /*
   * A single Feature, not a FeatureCollection.
   *
   * `eventid=<unid>` answers with a bare Feature (P0 captured it; DATA_SOURCES §6.1). Accepting
   * both shapes here rather than in a second parser keeps one code path for the by-id lookup the
   * correlation work will need, and a shape this parser did not expect is still drift.
   */
  const single = emscFeatureSchema.safeParse(json);
  const envelope = single.success
    ? { success: true as const, data: { features: [json] as unknown[] } }
    : emscFeedSchema.safeParse(json);

  if (!envelope.success) {
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: `the feed envelope changed shape: ${issuesOf(envelope.error).slice(0, 5).join('; ')}`,
      rejects: [],
      receivedCount: 0,
    };
  }

  const features = envelope.data.features;

  /*
   * Truncation is drift, and it is the only signal there is.
   *
   * EMSC silently caps a response at 20,000 rows with HTTP 200 and no marker of any kind, so a
   * batch that arrives at the cap may be complete or may be the first fifth of the answer. There
   * is no way to tell, and writing it would mark a window ingested over a hole. The backfill sizes
   * windows from `count` so that this should never fire; it fires anyway, because "should never"
   * is not a guarantee and the whole point of the backfill is completeness.
   */
  if (isTruncated(features.length)) {
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: `the response holds ${features.length} records, at the service's silent row cap, so it cannot be assumed complete`,
      rejects: [],
      receivedCount: features.length,
    };
  }

  const records: EmscFeature[] = [];
  const rejects: RejectedRecord[] = [];
  const seen = new Set<string>();

  for (const candidate of features) {
    const parsed = emscFeatureSchema.safeParse(candidate);
    if (!parsed.success) {
      rejects.push(reject('SCHEMA_INVALID', candidate, issuesOf(parsed.error)));
      continue;
    }
    // The same unid twice in one response is a provider bug. Taking the first silently would hide
    // it; taking both would write two versions with the same batch stamp.
    const unid = parsed.data.properties.unid;
    if (seen.has(unid)) {
      rejects.push(
        reject('DUPLICATE_IN_BATCH', candidate, [
          `unid ${unid} appears more than once in this response`,
        ]),
      );
      continue;
    }
    seen.add(unid);
    records.push(parsed.data);
  }

  const verdict = batchVerdict(ctx.descriptor, records.length, rejects.length);
  if (!verdict.ok) {
    return {
      verdict: 'REJECTED',
      errorClass: verdict.errorClass,
      detail: verdict.detail,
      rejects,
      receivedCount: records.length + rejects.length,
    };
  }

  /*
   * A field that disappeared, as distinct from a field that is sometimes absent.
   *
   * `mag` is the one field this adapter reads whose *key* EMSC legitimately omits — 2 of 97
   * events on 2010-01-01 carry no `mag` at all — so the schema cannot require it, and a rename to
   * `magnitude` would otherwise parse cleanly and quietly null every magnitude in the catalogue.
   * Magnitude drives relevance, so "every earthquake is now magnitude-less" must be loud.
   *
   * The threshold is what separates the two: a few per cent is the bulletin, and most of a batch
   * is the field. It is checked after the verdict so that it describes a batch that was otherwise
   * healthy, and skipped on small batches where the ratio says nothing.
   */
  const withoutMagnitude = records.filter(
    (record) => record.properties.mag === undefined || record.properties.mag === null,
  ).length;
  if (records.length >= MIN_RECORDS_FOR_FIELD_DRIFT) {
    const ratio = withoutMagnitude / records.length;
    if (ratio > MAX_MISSING_MAGNITUDE_RATIO) {
      return {
        verdict: 'REJECTED',
        errorClass: 'SCHEMA_DRIFT',
        detail:
          `${withoutMagnitude} of ${records.length} records have no magnitude ` +
          `(${(ratio * 100).toFixed(1)} %), which is a field that has gone rather than a quiet catalogue`,
        rejects,
        receivedCount: records.length + rejects.length,
      };
    }
  }

  /*
   * `metadata.count` is deliberately **not** reported as a declared count.
   *
   * It counts what was *returned*, not what matched: `limit=25000` answers `count: 20000` beside
   * 20,000 features. Passing it to the pipeline's completeness check would compare a number with
   * itself and log a reassuring match on exactly the batch that was truncated. A fixture proves
   * the other direction too — `revision-t1.json` was trimmed to 2 features while `count` still
   * says 27 — so the field cannot be trusted in either direction.
   */
  return { verdict: 'OK', records, rejects, declaredCount: null };
}

async function fetchEmsc(ctx: FetchContext): Promise<FetchResult> {
  /*
   * `feed` names a lookback in minutes, and an unknown one is refused rather than defaulted, for
   * the reason the USGS adapter gives: answering "SUCCEEDED" to an operator who asked for a wider
   * window after an outage leaves the gap they were closing open and invisible.
   */
  let lookbackMs = EMSC_POLL_LOOKBACK_MS;
  if (ctx.feed !== undefined) {
    const minutes = Number(ctx.feed);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
      throw new SourceFetchError(
        'CONFIG_ERROR',
        `unknown EMSC feed ${ctx.feed}; expected a whole number of minutes in [1, 10080]`,
        { host: EMSC_HOST },
      );
    }
    lookbackMs = minutes * 60 * 1_000;
  }

  const since = new Date(Date.now() - lookbackMs);
  const response = await ctx.client.get(emscUpdatedAfterUrl(since), {
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });

  const meta = {
    httpStatus: response.status,
    bytes: response.bytes,
    endpoint: emscEndpoint('query'),
    attempts: response.attempts,
    durationMs: response.durationMs,
    // Everything revised since `since` up to the request (ADR-041).
    readWindow: { from: since, to: new Date(since.getTime() + lookbackMs) },
  } as const;

  /*
   * 204: the service looked and found nothing revised in the window.
   *
   * The digest carried forward is the previous run's, never sha256("") — storing the digest of an
   * empty body would erase the last real one and make the next identical body look changed. When
   * there is no previous digest there is nothing to carry, and hashing the empty body is then
   * harmless because there is nothing to erase.
   */
  if (response.status === 204) {
    return {
      ...meta,
      kind: 'NO_DATA',
      payloadSha256: ctx.lastPayloadSha256 ?? payloadHash(response.body),
      detail: `no EMSC events were revised in the last ${Math.round(lookbackMs / 60_000)} minutes`,
    };
  }

  const digest = response.notModified
    ? (ctx.lastPayloadSha256 ?? payloadHash(response.body))
    : payloadHash(response.body);

  if (response.notModified || ctx.lastPayloadSha256?.equals(digest) === true) {
    return { ...meta, kind: 'UNCHANGED', payloadSha256: digest };
  }
  return { ...meta, kind: 'FETCHED', payloadSha256: digest, body: response.body };
}

export const emscAdapter: SourceAdapter<EmscFeature> = {
  descriptor: emscDescriptor,
  fetch: fetchEmsc,
  parse: parseEmscFeed,
  normalize: (raw: EmscFeature, ctx: NormalizeContext): NormalizedRecord =>
    normalizeEmscFeature(raw, ctx),
};
