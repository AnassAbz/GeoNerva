import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UNAVAILABLE_AFTER_S,
  INITIAL_FRESHNESS_POLICIES,
  freshnessPolicySchema,
  hasDataCurrencyPolicy,
  pollingPolicySchema,
  sourcePolicySchema,
} from './freshness-policy.ts';

const base = {
  pollIntervalS: 300,
  fetchFreshWithinS: 1_200,
  fetchStaleAfterS: 3_600,
  quietIsNormal: true,
};

describe('freshness policy', () => {
  it('defaults the unavailable threshold to 24 h', () => {
    expect(freshnessPolicySchema.parse(base).unavailableAfterS).toBe(DEFAULT_UNAVAILABLE_AFTER_S);
    expect(DEFAULT_UNAVAILABLE_AFTER_S).toBe(86_400);
  });

  it('defaults the data dimension to disabled', () => {
    const parsed = freshnessPolicySchema.parse(base);
    expect(parsed.dataCurrentWithinS).toBeNull();
    expect(parsed.dataStaleAfterS).toBeNull();
    expect(hasDataCurrencyPolicy(parsed)).toBe(false);
  });

  it('requires the fetch thresholds to be ordered', () => {
    expect(
      freshnessPolicySchema.safeParse({
        ...base,
        fetchFreshWithinS: 3_600,
        fetchStaleAfterS: 1_200,
      }).success,
    ).toBe(false);
    expect(
      freshnessPolicySchema.safeParse({
        ...base,
        fetchStaleAfterS: 100_000,
        unavailableAfterS: 3_600,
      }).success,
    ).toBe(false);
  });

  it('requires the data thresholds to be ordered', () => {
    expect(
      freshnessPolicySchema.safeParse({
        ...base,
        quietIsNormal: false,
        dataCurrentWithinS: 43_200,
        dataStaleAfterS: 21_600,
      }).success,
    ).toBe(false);
  });

  it('refuses a source where silence is abnormal but data currency is undefined', () => {
    const result = freshnessPolicySchema.safeParse({ ...base, quietIsNormal: false });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive and non-integer durations', () => {
    expect(freshnessPolicySchema.safeParse({ ...base, pollIntervalS: 0 }).success).toBe(false);
    expect(freshnessPolicySchema.safeParse({ ...base, pollIntervalS: -1 }).success).toBe(false);
    expect(freshnessPolicySchema.safeParse({ ...base, pollIntervalS: 1.5 }).success).toBe(false);
  });

  it('validates every seeded policy', () => {
    for (const [key, policy] of Object.entries(INITIAL_FRESHNESS_POLICIES)) {
      const result = freshnessPolicySchema.safeParse(policy);
      expect(result.success, `${key} must be a valid policy`).toBe(true);
    }
  });

  it('gives FIRMS the two-part freshness the NRT latency requires (ADR-009)', () => {
    const firms = INITIAL_FRESHNESS_POLICIES['firms:VIIRS_*'];
    expect(firms.quietIsNormal).toBe(false);
    expect(firms.fetchFreshWithinS).toBe(5_400);
    expect(firms.dataCurrentWithinS).toBe(21_600);
    expect(firms.dataStaleAfterS).toBe(43_200);
    expect(hasDataCurrencyPolicy(firms)).toBe(true);
  });

  it('treats quiet as normal for the event-scale sources', () => {
    for (const key of ['usgs:comcat', 'emsc:rts', 'gdacs:*', 'eccc:weather-alerts'] as const) {
      expect(INITIAL_FRESHNESS_POLICIES[key].quietIsNormal).toBe(true);
      expect(INITIAL_FRESHNESS_POLICIES[key].dataCurrentWithinS).toBeNull();
    }
  });
});

describe('polling policy', () => {
  it('defaults jitter and bounds the limits', () => {
    const parsed = pollingPolicySchema.parse({
      intervalS: 1_800,
      timeoutMs: 120_000,
      maxBodyBytes: 40 * 1024 * 1024,
    });
    expect(parsed.jitterRatio).toBe(0.1);
  });

  it('rejects an unbounded body size', () => {
    expect(
      pollingPolicySchema.safeParse({
        intervalS: 300,
        timeoutMs: 30_000,
        maxBodyBytes: 1024 * 1024 * 1024,
      }).success,
    ).toBe(false);
  });
});

describe('source policy', () => {
  it('composes both halves', () => {
    const parsed = sourcePolicySchema.parse({
      freshness: INITIAL_FRESHNESS_POLICIES['usgs:comcat'],
      polling: { intervalS: 300, timeoutMs: 30_000, maxBodyBytes: 20 * 1024 * 1024 },
    });
    expect(parsed.freshness.pollIntervalS).toBe(300);
    expect(parsed.polling.timeoutMs).toBe(30_000);
  });
});
