/**
 * FreshnessPolicy (docs/DOMAIN_MODEL.md §4.2, ADR-009, ADR-022).
 *
 * A source's health has **two independent dimensions**, and conflating them is the mistake the
 * original brief made for FIRMS:
 *
 *  - *poll freshness* — how long ago GeoNerva last talked to the provider successfully;
 *  - *data currency* — how old the newest observation the provider offers is.
 *
 * FIRMS polls can be perfectly healthy while its newest detection is three hours old, because NRT
 * processing itself takes ~3 h (docs/DATA_SOURCES.md §3.3). Only sources where silence is
 * abnormal (`quietIsNormal: false`) get a data-currency judgement at all: a quiet hour on USGS
 * means no earthquakes, not a broken feed.
 *
 * Durations are whole **seconds**, which keeps the `jsonb` column exact and diffable.
 */

import { z } from 'zod';

import { HOUR_MS, MINUTE_MS, SECOND_MS } from './time.ts';

/** Thresholds that turn ingestion-run history into a `SourceHealthStatus`. */
export interface FreshnessPolicy {
  /** How often GeoNerva asks. Not a health threshold by itself; it calibrates the others. */
  readonly pollIntervalS: number;
  /** A successful poll younger than this is FRESH. */
  readonly fetchFreshWithinS: number;
  /** No successful poll for longer than this is STALE. Must exceed `fetchFreshWithinS`. */
  readonly fetchStaleAfterS: number;
  /** No successful poll for longer than this is UNAVAILABLE. Must exceed `fetchStaleAfterS`. */
  readonly unavailableAfterS: number;
  /** Newest `observed_at` younger than this is current. `null` disables the data dimension. */
  readonly dataCurrentWithinS: number | null;
  /** Newest `observed_at` older than this is STALE data. `null` disables it. */
  readonly dataStaleAfterS: number | null;
  /**
   * `true` when "no new records" is normal (USGS, EMSC, GDACS, ECCC) and `false` when the source
   * always has something globally (FIRMS). Drives `EMPTY_SUSPICIOUS` and data currency.
   */
  readonly quietIsNormal: boolean;
}

/** Default UNAVAILABLE threshold: no successful poll for more than 24 h (§4.3). */
export const DEFAULT_UNAVAILABLE_AFTER_S = (24 * HOUR_MS) / SECOND_MS;

const positiveSeconds = z
  .number()
  .int()
  .positive()
  .max(365 * 24 * 3600);

export const freshnessPolicySchema = z
  .object({
    pollIntervalS: positiveSeconds,
    fetchFreshWithinS: positiveSeconds,
    fetchStaleAfterS: positiveSeconds,
    unavailableAfterS: positiveSeconds.default(DEFAULT_UNAVAILABLE_AFTER_S),
    dataCurrentWithinS: positiveSeconds.nullable().default(null),
    dataStaleAfterS: positiveSeconds.nullable().default(null),
    quietIsNormal: z.boolean(),
  })
  .refine((p) => p.fetchFreshWithinS < p.fetchStaleAfterS, {
    message: 'fetchFreshWithinS must be smaller than fetchStaleAfterS',
    path: ['fetchStaleAfterS'],
  })
  .refine((p) => p.fetchStaleAfterS <= p.unavailableAfterS, {
    message: 'fetchStaleAfterS must not exceed unavailableAfterS',
    path: ['unavailableAfterS'],
  })
  .refine(
    (p) =>
      p.dataCurrentWithinS === null ||
      p.dataStaleAfterS === null ||
      p.dataCurrentWithinS < p.dataStaleAfterS,
    {
      message: 'dataCurrentWithinS must be smaller than dataStaleAfterS',
      path: ['dataStaleAfterS'],
    },
  )
  .refine((p) => p.quietIsNormal || p.dataCurrentWithinS !== null, {
    message: 'a source where silence is abnormal must define dataCurrentWithinS',
    path: ['dataCurrentWithinS'],
  });

/** True when the policy asks for a data-currency judgement in addition to poll freshness. */
export function hasDataCurrencyPolicy(policy: FreshnessPolicy): boolean {
  return policy.dataCurrentWithinS !== null;
}

/**
 * Polling behaviour that belongs to the source rather than to the adapter code. Kept alongside
 * the freshness policy in the same `policy` column so that retuning a source is a data change.
 */
export interface PollingPolicy {
  /** Base scheduling interval in seconds; mirrors `FreshnessPolicy.pollIntervalS`. */
  readonly intervalS: number;
  /** Fraction of the interval used as random jitter, so that sources do not poll in lockstep. */
  readonly jitterRatio: number;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
}

export const pollingPolicySchema = z.object({
  intervalS: positiveSeconds,
  jitterRatio: z.number().min(0).max(0.5).default(0.1),
  timeoutMs: z.number().int().positive().max(300_000),
  maxBodyBytes: z
    .number()
    .int()
    .positive()
    .max(200 * 1024 * 1024),
});

/** The full contents of `sources.policy` / `source_products.policy`. */
export interface SourcePolicy {
  readonly freshness: FreshnessPolicy;
  readonly polling: PollingPolicy;
}

export const sourcePolicySchema = z.object({
  freshness: freshnessPolicySchema,
  polling: pollingPolicySchema,
});

const minutes = (n: number): number => (n * MINUTE_MS) / SECOND_MS;
const hours = (n: number): number => (n * HOUR_MS) / SECOND_MS;

/**
 * Initial policies from docs/DOMAIN_MODEL.md §4.2, to be retuned from production run history.
 * These are the values the migration seeds; the table below is the single place they are written.
 */
export const INITIAL_FRESHNESS_POLICIES = {
  'usgs:comcat': {
    pollIntervalS: minutes(5),
    fetchFreshWithinS: minutes(20),
    fetchStaleAfterS: minutes(60),
    unavailableAfterS: hours(24),
    dataCurrentWithinS: null,
    dataStaleAfterS: null,
    quietIsNormal: true,
  },
  'emsc:rts': {
    pollIntervalS: minutes(5),
    fetchFreshWithinS: minutes(20),
    fetchStaleAfterS: minutes(60),
    unavailableAfterS: hours(24),
    dataCurrentWithinS: null,
    dataStaleAfterS: null,
    quietIsNormal: true,
  },
  'gdacs:*': {
    pollIntervalS: minutes(10),
    fetchFreshWithinS: minutes(40),
    fetchStaleAfterS: hours(2),
    unavailableAfterS: hours(24),
    dataCurrentWithinS: null,
    dataStaleAfterS: null,
    quietIsNormal: true,
  },
  'firms:VIIRS_*': {
    pollIntervalS: minutes(30),
    fetchFreshWithinS: minutes(90),
    fetchStaleAfterS: hours(3),
    unavailableAfterS: hours(24),
    dataCurrentWithinS: hours(6),
    dataStaleAfterS: hours(12),
    quietIsNormal: false,
  },
  'eccc:weather-alerts': {
    pollIntervalS: minutes(5),
    fetchFreshWithinS: minutes(20),
    fetchStaleAfterS: minutes(60),
    unavailableAfterS: hours(24),
    dataCurrentWithinS: null,
    dataStaleAfterS: null,
    quietIsNormal: true,
  },
} as const satisfies Record<string, FreshnessPolicy>;

export type InitialPolicyKey = keyof typeof INITIAL_FRESHNESS_POLICIES;
