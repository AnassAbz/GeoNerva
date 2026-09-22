/**
 * Where a catalog's unbroken coverage up to a knowledge time begins (P8 review H1, H2).
 *
 * Pure, so the contiguity rule is tested without a database. Spans are half-open `[from, to)`,
 * and two spans join when the second begins no later than the first ends — overlapping or exactly
 * adjacent. A gap of any size breaks the run: the windows inside it were never read, and the
 * baseline must not reach across them.
 */

import type { CatalogCoverage, CoverageSpan } from '@geonerva/db/asof';

/**
 * How close to the knowledge time coverage must reach (ADR-041). The ledger records whole hours
 * only, so the hour containing `asOf` is never covered, and polls arrive every few minutes: a feed
 * read continuously up to `asOf` shows coverage ending up to about an hour and a poll interval
 * before it. Two hours tolerates that and nothing longer — a feed silent for longer is not "read
 * up to now".
 */
export const COVERAGE_EDGE_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/**
 * The start of the contiguous covered span that reaches `asOf` — ends no earlier than
 * `edgeToleranceMs` before it — or `null` when nothing covered reaches it, in which case the
 * recent windows were not read either, and there is nothing honest to compare.
 */
export function coveredSince(
  spans: readonly CoverageSpan[],
  asOf: Date,
  edgeToleranceMs = 0,
): Date | null {
  const sorted = spans
    .filter((span) => span.from.getTime() < span.to.getTime())
    .sort((left, right) => left.from.getTime() - right.from.getTime());

  let start: number | null = null;
  let end = Number.NEGATIVE_INFINITY;
  let answer: number | null = null;
  for (const span of sorted) {
    const from = span.from.getTime();
    const to = span.to.getTime();
    if (start === null || from > end) {
      start = from;
      end = to;
    } else {
      end = Math.max(end, to);
    }
    if (start <= asOf.getTime() && end >= asOf.getTime() - edgeToleranceMs) answer = start;
  }
  return answer === null ? null : new Date(answer);
}

/**
 * Where coverage began when **every** product had to be read — a GDACS family whose events come
 * from more than one feed, say. The latest of the products' starts, or `null` if any product's
 * coverage does not reach `asOf`, or there is no product at all.
 */
export function coveredSinceForEvery(
  coverage: CatalogCoverage,
  asOf: Date,
  edgeToleranceMs = 0,
): Date | null {
  if (coverage.productIds.length === 0) return null;
  let latest: number | null = null;
  for (const productId of coverage.productIds) {
    const start = coveredSince(
      coverage.spans.filter((span) => span.productId === productId),
      asOf,
      edgeToleranceMs,
    );
    if (start === null) return null;
    latest = latest === null ? start.getTime() : Math.max(latest, start.getTime());
  }
  return latest === null ? null : new Date(latest);
}
