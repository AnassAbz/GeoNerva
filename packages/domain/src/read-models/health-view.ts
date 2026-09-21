/**
 * The one mapping from derived source health to its read-model view.
 *
 * `SourceHealth` (ADR-022) is the derivation's output: `Date` objects, the full `FreshnessPolicy`,
 * and an `asOf` the caller already knows. `SourceHealthView` is what the API ships: ISO strings and
 * only the policy fields a reader needs to state the expectation. The conversion is mechanical, and
 * that is precisely why it belongs here rather than being written once per consumer.
 *
 * It was written twice. `packages/briefing` had a private copy for the snapshot's `sourceHealth`,
 * and `apps/web` needed the same thing for `GET /api/v1/sources/status` — two mappers over one
 * frozen contract, which is the shape of a drift where the same source reports `DEGRADED` on the
 * briefing and `FRESH` on the data-status page. There is now one.
 *
 * Note what the view deliberately drops: `asOf`. The knowledge time is carried once per response,
 * in `asOfContext`, and repeating it on every health entry would invite a response where two
 * entries disagree about when they were judged.
 */

import type { FreshnessPolicy } from '../value-objects/freshness-policy.ts';
import type { SourceHealth } from '../health/source-health.ts';
import type { FreshnessPolicyView, SourceHealthView } from './common.ts';

/** The policy as the API exposes it: the cadence fields, without the internal knobs. */
export function toFreshnessPolicyView(policy: FreshnessPolicy): FreshnessPolicyView {
  return {
    pollIntervalS: policy.pollIntervalS,
    fetchFreshWithinS: policy.fetchFreshWithinS,
    fetchStaleAfterS: policy.fetchStaleAfterS,
    unavailableAfterS: policy.unavailableAfterS,
    dataCurrentWithinS: policy.dataCurrentWithinS,
    dataStaleAfterS: policy.dataStaleAfterS,
    quietIsNormal: policy.quietIsNormal,
  };
}

/**
 * Derived health as the API exposes it.
 *
 * Every timestamp becomes ISO-8601 or stays `null`. A `null` here means GeoNerva has no such
 * moment to report — no attempt, no success, no observation — and is never rendered as a zero or
 * as an epoch, because "this source has never delivered an observation" and "this source last
 * delivered one at 1970-01-01" are different claims and only one of them is true.
 */
export function toSourceHealthView(health: SourceHealth): SourceHealthView {
  return {
    sourceId: health.sourceId,
    productId: health.productId,
    status: health.status,
    lastAttemptAt: health.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: health.lastSuccessAt?.toISOString() ?? null,
    newestObservedAt: health.newestObservedAt?.toISOString() ?? null,
    consecutiveFailures: health.consecutiveFailures,
    lastErrorClass: health.lastErrorClass,
    reasons: health.reasons,
    expected: toFreshnessPolicyView(health.expected),
    evidenceId: health.evidenceId,
  };
}
