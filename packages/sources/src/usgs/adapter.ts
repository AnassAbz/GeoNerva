/**
 * The USGS adapter — the reference implementation of the contract.
 *
 * It polls the real-time GeoJSON summary feed (DATA_SOURCES §1.1). Deletions are *not* visible
 * here: summary feeds silently drop deleted events, so absence from a later feed means nothing
 * and must never be inferred as a deletion. That signal comes from the FDSN `includedeleted=only`
 * reconcile, which is a later phase.
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
import { normalizeUsgsFeature } from './normalize.ts';
import { usgsFeatureSchema, usgsFeedSchema, type UsgsFeature } from './schema.ts';

const USGS_HOST = 'earthquake.usgs.gov';

/**
 * The summary feeds this adapter may poll. `all_day` is the routine poll; the wider windows are
 * for a cold start or a gap after downtime, and are selected by the caller, never automatically.
 */
export const USGS_FEEDS = ['all_hour', 'all_day', 'all_week'] as const;
export type UsgsFeed = (typeof USGS_FEEDS)[number];

export const DEFAULT_USGS_FEED: UsgsFeed = 'all_day';

const USGS_FEED_SPAN_MS: Readonly<Record<UsgsFeed, number>> = {
  all_hour: 60 * 60 * 1_000,
  all_day: 24 * 60 * 60 * 1_000,
  all_week: 7 * 24 * 60 * 60 * 1_000,
};

/**
 * What one summary-feed request read (ADR-041): the feed's span, ending when it was requested.
 *
 * USGS regenerates the summary files about once a minute, so the file served may be a little older
 * than the request. The start is pulled in by five minutes to claim less, never more.
 */
export function usgsReadWindow(feed: UsgsFeed, requestedAt: Date): { from: Date; to: Date } {
  return {
    from: new Date(requestedAt.getTime() - USGS_FEED_SPAN_MS[feed] + 5 * 60 * 1_000),
    to: requestedAt,
  };
}

export function usgsFeedUrl(feed: UsgsFeed): string {
  return `https://${USGS_HOST}/earthquakes/feed/v1.0/summary/${feed}.geojson`;
}

export function isUsgsFeed(value: string): value is UsgsFeed {
  return (USGS_FEEDS as readonly string[]).includes(value);
}

export const usgsDescriptor: SourceDescriptor = {
  sourceId: 'usgs',
  // `geonerva.source_products.code` is scoped by source, so it is `comcat`, not `usgs:comcat`.
  // The prefixed form is the freshness-policy key, which is global and therefore qualified.
  productCode: 'comcat',
  policyKey: 'usgs:comcat',
  hazardType: 'EARTHQUAKE',
  // The seeded product has declared HISTORICAL_EVENTS and DELETIONS since P2; the descriptor did
  // not, so code and database disagreed about USGS precisely in the direction of the two things
  // P4 built. `runBackfill` and `runDeletionSweep` now check these.
  capabilities: [
    'REALTIME_EVENTS',
    'HISTORICAL_EVENTS',
    'EVENT_REVISIONS',
    'DELETIONS',
    'CROSS_REFERENCES',
  ],
  allowedHosts: [USGS_HOST],
  timeoutMs: 30_000,
  maxBytes: 20 * 1024 * 1024,
  // USGS records ~400 events a day worldwide. A feed with nothing in it is a broken feed, not a
  // quiet planet, and calling it quiet would be the most misleading thing this system could say.
  // This is a different question from the seeded policy's `quietIsNormal` — see the descriptor.
  emptyBatchIsSuspicious: true,
  maxRejectRatio: 0.2,
};

/** Bounded excerpt: enough to identify the record, never the whole feature. */
function excerptOf(value: unknown, issues: readonly string[]): unknown {
  const id =
    typeof value === 'object' && value !== null && 'id' in value
      ? ((value as { id?: unknown }).id ?? null)
      : null;
  return { id, issues: issues.slice(0, 5) };
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

export function parseUsgsFeed(body: Uint8Array, ctx: ParseContext): ParseResult<UsgsFeature> {
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
    // An HTML error page served with 200 lands here, which is why this is drift and not a 4xx.
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: `the response body is not JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
      rejects: [],
      receivedCount: 0,
    };
  }

  const envelope = usgsFeedSchema.safeParse(json);
  if (!envelope.success) {
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: `the feed envelope changed shape: ${envelope.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
      rejects: [],
      receivedCount: 0,
    };
  }

  const declaredCount = envelope.data.metadata.count ?? null;
  const features = envelope.data.features;

  /*
   * `metadata.count` and `features.length` disagreeing would suggest a partial body, and it is
   * tempting to fail the batch on it. That is not done, deliberately:
   *
   *  - truncation nearly always breaks `JSON.parse`, which is caught above, so this guard would
   *    be defending an already-covered case;
   *  - USGS documents `count` but promises nothing about it under caching, and a false positive
   *    here stops the source completely.
   *
   * Stopping ingestion on an assumption the provider never made is the worse failure, so the
   * discrepancy is *reported* — `declaredCount` travels with the result and the pipeline logs it
   * against the accepted count — rather than acted on. Nothing is skipped either way.
   */

  const records: UsgsFeature[] = [];
  const rejects: RejectedRecord[] = [];
  const seen = new Set<string>();

  for (const candidate of features) {
    const parsed = usgsFeatureSchema.safeParse(candidate);
    if (!parsed.success) {
      rejects.push(
        reject(
          'SCHEMA_INVALID',
          candidate,
          parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
          ),
        ),
      );
      continue;
    }
    // The same preferred id twice in one feed is a provider bug; taking the first silently would
    // hide it, and taking both would write two versions with the same batch stamp.
    if (seen.has(parsed.data.id)) {
      rejects.push(
        reject('DUPLICATE_IN_BATCH', candidate, [
          `id ${parsed.data.id} appears more than once in this feed`,
        ]),
      );
      continue;
    }
    seen.add(parsed.data.id);
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
  return { verdict: 'OK', records, rejects, declaredCount };
}

async function fetchUsgs(ctx: FetchContext): Promise<FetchResult> {
  /*
   * An unknown feed is refused, never defaulted.
   *
   * `all_month` is a real USGS feed that this adapter does not list. Falling back to `all_day`
   * would answer "SUCCEEDED, 230 accepted" to an operator who asked for a month of backfill after
   * an outage, and the gap they were trying to close would stay open and invisible.
   */
  if (ctx.feed !== undefined && !isUsgsFeed(ctx.feed)) {
    throw new SourceFetchError(
      'CONFIG_ERROR',
      `unknown USGS feed ${ctx.feed}; expected one of ${USGS_FEEDS.join(', ')}`,
      { host: USGS_HOST },
    );
  }
  const feed = ctx.feed ?? DEFAULT_USGS_FEED;
  const url = usgsFeedUrl(feed);
  // The deadline and the size cap are not passed per request: the client is built from the
  // descriptor (see `createSourceClient`), so they are enforced in one place and an adapter
  // cannot quietly widen them.
  const requestedAt = new Date();
  const response = await ctx.client.get(url, { signal: ctx.signal });

  /*
   * On a 304 the body is empty, so its digest is sha256("") — and writing that to the run row
   * would erase the last real payload digest, making the *next* identical feed look changed.
   * A 304 means "the body you already have", so the digest we already have is what it is.
   */
  const digest = response.notModified
    ? (ctx.lastPayloadSha256 ?? payloadHash(response.body))
    : payloadHash(response.body);
  const meta = {
    httpStatus: response.status,
    bytes: response.bytes,
    payloadSha256: digest,
    endpoint: `${USGS_HOST}/earthquakes/feed/v1.0/summary/${feed}.geojson`,
    attempts: response.attempts,
    durationMs: response.durationMs,
    readWindow: usgsReadWindow(feed, requestedAt),
  } as const;

  if (response.notModified) return { ...meta, kind: 'UNCHANGED' };
  if (ctx.lastPayloadSha256?.equals(digest) === true) {
    return { ...meta, kind: 'UNCHANGED' };
  }
  return { ...meta, kind: 'FETCHED', body: response.body };
}

export const usgsAdapter: SourceAdapter<UsgsFeature> = {
  descriptor: usgsDescriptor,
  fetch: fetchUsgs,
  parse: parseUsgsFeed,
  normalize: (raw: UsgsFeature, ctx: NormalizeContext): NormalizedRecord =>
    normalizeUsgsFeature(raw, ctx),
};
