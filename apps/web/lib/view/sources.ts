/**
 * Source health, as words (docs/PRODUCT.md §6.7). Status is always shown with a text label and a
 * distinct shape, never by colour alone.
 */

import type {
  ErrorClass,
  HazardFamily,
  SourceHealthStatus,
  SourceHealthView,
} from '@geonerva/domain';

import { FAMILY_META } from './families.ts';
import { formatAgo, formatDuration } from './format.ts';

const SOURCE_SHORT_NAME: Readonly<Record<string, string>> = {
  usgs: 'USGS',
  emsc: 'EMSC',
  gdacs: 'GDACS',
  firms: 'NASA FIRMS',
  eccc: 'ECCC',
};

/** The short display name of a source; unknown ids are shown upper-cased rather than hidden. */
export function sourceName(sourceId: string): string {
  return SOURCE_SHORT_NAME[sourceId] ?? sourceId.toUpperCase();
}

export const STATUS_LABEL: Readonly<Record<SourceHealthStatus, string>> = {
  FRESH: 'Fresh',
  DEGRADED: 'Degraded',
  STALE: 'Stale',
  UNAVAILABLE: 'Unavailable',
};

export const ERROR_CLASS_LABEL: Readonly<Record<ErrorClass, string>> = {
  HTTP_4XX: 'Request refused by the provider (HTTP 4xx)',
  HTTP_5XX: 'Provider error (HTTP 5xx)',
  TIMEOUT: 'Timed out',
  TOO_LARGE: 'Response too large',
  SCHEMA_DRIFT: 'Unexpected format from the provider',
  EMPTY_SUSPICIOUS: 'Suspiciously empty response',
  RATE_LIMITED: 'Rate limited by the provider',
  DB_ERROR: 'GeoNerva storage error',
  LEASE_EXPIRED: 'Previous poll did not finish',
  UNKNOWN: 'Unknown error',
  NETWORK: 'Network error',
  CONFIG_ERROR: 'GeoNerva configuration error',
  ABORTED: 'Cancelled by GeoNerva',
};

/** True when data from this source cannot be relied on (PRODUCT §6.7). */
export function isUnusable(status: SourceHealthStatus): boolean {
  return status === 'STALE' || status === 'UNAVAILABLE';
}

const DATA_REASONS = new Set(['DATA_STALE', 'DATA_AGEING', 'DATA_NEVER_SEEN']);

/**
 * "NASA FIRMS last updated 5 h ago (expected ≤ 3 h)", or the data-currency form when the
 * source is polling fine but its newest observation is old.
 */
export function healthSentence(health: SourceHealthView, now: string): string {
  const name = sourceName(health.sourceId);
  if (health.reasons.includes('DISABLED')) return `${name} is not enabled in GeoNerva yet`;
  const dataProblem = health.reasons.some((reason) => DATA_REASONS.has(reason));
  if (dataProblem) {
    const expected = health.expected.dataStaleAfterS;
    const newest =
      health.newestObservedAt === null
        ? `${name} has delivered no observations yet`
        : `${name} newest observation ${formatAgo(health.newestObservedAt, now)}`;
    return expected === null ? newest : `${newest} (expected ≤ ${formatDuration(expected)})`;
  }
  if (health.lastSuccessAt === null) return `${name} has never delivered successfully`;
  return `${name} last updated ${formatAgo(health.lastSuccessAt, now)} (expected ≤ ${formatDuration(health.expected.fetchStaleAfterS)})`;
}

/**
 * The card's Unavailable state, in the exact form of PRODUCT §6.3:
 * "Fire activity data unavailable — NASA FIRMS last updated 5 h ago (expected ≤ 90 min).
 * Absence of detections cannot be confirmed."
 */
export function unavailableStatement(
  family: HazardFamily,
  sourceHealth: readonly SourceHealthView[],
  now: string,
): { readonly title: string; readonly detail: string } {
  const meta = FAMILY_META[family];
  const worst = sourceHealth.find((health) => isUnusable(health.status)) ?? sourceHealth[0];
  const cause = worst === undefined ? '' : ` — ${healthSentence(worst, now)}`;
  return {
    title: `${meta.label} data unavailable${cause}.`,
    detail: `Absence of ${meta.absenceNoun} cannot be confirmed.`,
  };
}
