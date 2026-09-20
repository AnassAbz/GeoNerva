import { describe, expect, it } from 'vitest';

import {
  aggregateSourceHealth,
  deriveSourceHealth,
  isDataUnavailable,
  type IngestionRunFact,
} from './source-health.ts';
import {
  INITIAL_FRESHNESS_POLICIES,
  type FreshnessPolicy,
} from '../value-objects/freshness-policy.ts';
import { HOUR_MS, MINUTE_MS } from '../value-objects/time.ts';
import type { RunStatus } from '../enums.ts';

/**
 * A fake clock. Every test states an absolute knowledge time and builds run history relative to
 * it, so nothing here depends on the wall clock (docs/TESTING.md: the clock is injected
 * everywhere).
 */
const NOW = new Date('2026-09-19T12:00:00.000Z');
const at = (msBefore: number): Date => new Date(NOW.getTime() - msBefore);

const USGS: FreshnessPolicy = INITIAL_FRESHNESS_POLICIES['usgs:comcat'];
const FIRMS: FreshnessPolicy = INITIAL_FRESHNESS_POLICIES['firms:VIIRS_*'];

let runCounter = 0;
function run(
  status: RunStatus,
  committedMsBefore: number | null,
  extra: Partial<IngestionRunFact> = {},
): IngestionRunFact {
  runCounter += 1;
  const id = `0b6c5f1e-9a2d-4c37-8f11-${String(runCounter).padStart(12, '0')}`;
  const committedAt = committedMsBefore === null ? null : at(committedMsBefore);
  return {
    id,
    status,
    startedAt: committedAt === null ? at(0) : new Date(committedAt.getTime() - 3_000),
    committedAt,
    newestObservedAt: null,
    errorClass: status === 'FAILED' ? 'HTTP_5XX' : null,
    ...extra,
  };
}

function health(
  runs: readonly IngestionRunFact[],
  policy: FreshnessPolicy = USGS,
  options: { enabled?: boolean; asOf?: Date } = {},
) {
  return deriveSourceHealth({
    sourceId: 'usgs',
    productId: 1,
    enabled: options.enabled ?? true,
    policy,
    runs,
    asOf: options.asOf ?? NOW,
  });
}

describe('deriveSourceHealth', () => {
  describe('the four states', () => {
    it('is FRESH when the last poll succeeded within fetchFreshWithinS', () => {
      const result = health([run('SUCCEEDED', 5 * MINUTE_MS)]);
      expect(result.status).toBe('FRESH');
      expect(result.reasons).toStrictEqual(['OK']);
      expect(result.consecutiveFailures).toBe(0);
    });

    it('is DEGRADED when the last success is older than fetchFreshWithinS', () => {
      const result = health([run('SUCCEEDED', 25 * MINUTE_MS)]);
      expect(result.status).toBe('DEGRADED');
      expect(result.reasons).toContain('POLL_AGEING');
    });

    it('is STALE when the last success is older than fetchStaleAfterS', () => {
      const result = health([run('SUCCEEDED', 90 * MINUTE_MS)]);
      expect(result.status).toBe('STALE');
      expect(result.reasons).toStrictEqual(['POLL_STALE']);
    });

    it('is UNAVAILABLE when nothing has succeeded for more than 24 h', () => {
      const result = health([run('SUCCEEDED', 25 * HOUR_MS)]);
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.reasons).toStrictEqual(['NO_SUCCESS_BEYOND_LIMIT']);
    });

    it('is UNAVAILABLE when it has never succeeded', () => {
      const result = health([run('FAILED', 2 * MINUTE_MS)]);
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.reasons).toStrictEqual(['NEVER_SUCCEEDED']);
      expect(result.lastSuccessAt).toBeNull();
      expect(result.consecutiveFailures).toBe(1);
    });

    it('is UNAVAILABLE when the source is disabled, whatever the history says', () => {
      const result = health([run('SUCCEEDED', MINUTE_MS)], USGS, { enabled: false });
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.reasons).toStrictEqual(['DISABLED']);
    });

    it('is UNAVAILABLE when there is no history at all', () => {
      const result = health([]);
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.lastAttemptAt).toBeNull();
      expect(result.evidenceId).toBeNull();
    });
  });

  describe('boundaries (both sides of every threshold)', () => {
    it.each([
      ['exactly fetchFreshWithinS', USGS.fetchFreshWithinS * 1000, 'FRESH'],
      ['one second past fetchFreshWithinS', (USGS.fetchFreshWithinS + 1) * 1000, 'DEGRADED'],
      ['exactly fetchStaleAfterS', USGS.fetchStaleAfterS * 1000, 'DEGRADED'],
      ['one second past fetchStaleAfterS', (USGS.fetchStaleAfterS + 1) * 1000, 'STALE'],
      ['exactly unavailableAfterS', USGS.unavailableAfterS * 1000, 'STALE'],
      ['one second past unavailableAfterS', (USGS.unavailableAfterS + 1) * 1000, 'UNAVAILABLE'],
    ])('%s → %s', (_name, age, expected) => {
      expect(health([run('SUCCEEDED', age)]).status).toBe(expected);
    });
  });

  describe('failures within grace', () => {
    it('is DEGRADED when a poll failed after a recent success', () => {
      const result = health([run('SUCCEEDED', 10 * MINUTE_MS), run('FAILED', 2 * MINUTE_MS)]);
      expect(result.status).toBe('DEGRADED');
      expect(result.reasons).toStrictEqual(['LAST_POLL_FAILED']);
      expect(result.consecutiveFailures).toBe(1);
      expect(result.lastErrorClass).toBe('HTTP_5XX');
    });

    it('counts only failures since the last success', () => {
      const result = health([
        run('FAILED', 40 * MINUTE_MS),
        run('FAILED', 35 * MINUTE_MS),
        run('SUCCEEDED', 10 * MINUTE_MS),
        run('FAILED', 4 * MINUTE_MS),
        run('FAILED', 2 * MINUTE_MS),
      ]);
      expect(result.consecutiveFailures).toBe(2);
    });

    it('clears the failure count when a later run succeeds', () => {
      const result = health([run('FAILED', 10 * MINUTE_MS), run('SUCCEEDED', 2 * MINUTE_MS)]);
      expect(result.status).toBe('FRESH');
      expect(result.consecutiveFailures).toBe(0);
    });

    it('treats SKIPPED (upstream unchanged) as a successful poll', () => {
      const result = health([run('SKIPPED', 2 * MINUTE_MS)]);
      expect(result.status).toBe('FRESH');
    });

    it('does not blame the source for a run we cancelled ourselves (ADR-032)', () => {
      // A deploy restarts the worker and every in-flight run ends ABORTED. If that counted, one
      // routine deploy would light up the whole /data-status panel.
      const result = health([
        run('SUCCEEDED', 10 * MINUTE_MS),
        run('FAILED', 2 * MINUTE_MS, { errorClass: 'ABORTED' }),
      ]);
      expect(result.status).toBe('FRESH');
      expect(result.reasons).toStrictEqual(['OK']);
      expect(result.consecutiveFailures).toBe(0);
      // Still reported, so the run is not invisible — it simply is not held against the source.
      expect(result.lastErrorClass).toBe('ABORTED');
    });

    it('still degrades when GeoNerva itself is misconfigured (ADR-032)', () => {
      // The opposite case: CONFIG_ERROR means we really have no data, so the status must fall.
      // Only the class tells the operator the fault is ours rather than the provider's.
      const result = health([
        run('SUCCEEDED', 10 * MINUTE_MS),
        run('FAILED', 2 * MINUTE_MS, { errorClass: 'CONFIG_ERROR' }),
      ]);
      expect(result.status).toBe('DEGRADED');
      expect(result.reasons).toStrictEqual(['LAST_POLL_FAILED']);
      expect(result.lastErrorClass).toBe('CONFIG_ERROR');
    });

    it('treats PARTIAL as a success that still degrades the source', () => {
      const result = health([run('PARTIAL', 2 * MINUTE_MS)]);
      expect(result.status).toBe('DEGRADED');
      expect(result.reasons).toStrictEqual(['PARTIAL_BATCH']);
    });

    it('does not let a SKIPPED poll erase a partial batch', () => {
      // A skipped poll means "the provider answered with the same bytes", not "the last batch
      // was complete". If it counted, the records that never became facts would stop being
      // visible on /data-status one poll after they were lost.
      const result = health([run('PARTIAL', 10 * MINUTE_MS), run('SKIPPED', 2 * MINUTE_MS)]);
      expect(result.status).toBe('DEGRADED');
      expect(result.reasons).toContain('PARTIAL_BATCH');
    });

    it('clears PARTIAL_BATCH once a complete batch lands', () => {
      const result = health([run('PARTIAL', 10 * MINUTE_MS), run('SUCCEEDED', 2 * MINUTE_MS)]);
      expect(result.status).toBe('FRESH');
      expect(result.reasons).toStrictEqual(['OK']);
    });

    it('reports every applicable reason, not only the worst', () => {
      const result = health([run('PARTIAL', 25 * MINUTE_MS), run('FAILED', 2 * MINUTE_MS)]);
      expect(result.status).toBe('DEGRADED');
      expect(result.reasons).toStrictEqual(['POLL_AGEING', 'LAST_POLL_FAILED', 'PARTIAL_BATCH']);
    });
  });

  describe('data currency (the second dimension, FIRMS)', () => {
    const succeededWithData = (pollAge: number, dataAge: number): IngestionRunFact =>
      run('SUCCEEDED', pollAge, { newestObservedAt: at(dataAge) });

    it('is FRESH when both the poll and the data are current', () => {
      expect(health([succeededWithData(20 * MINUTE_MS, 3 * HOUR_MS)], FIRMS).status).toBe('FRESH');
    });

    it('is DEGRADED when the poll is fine but the data is older than normal', () => {
      const result = health([succeededWithData(20 * MINUTE_MS, 7 * HOUR_MS)], FIRMS);
      expect(result.status).toBe('DEGRADED');
      expect(result.reasons).toStrictEqual(['DATA_AGEING']);
    });

    it('is STALE when the data is older than dataStaleAfterS even though polls succeed', () => {
      const result = health([succeededWithData(20 * MINUTE_MS, 13 * HOUR_MS)], FIRMS);
      expect(result.status).toBe('STALE');
      expect(result.reasons).toStrictEqual(['DATA_STALE']);
    });

    it.each([
      ['exactly dataCurrentWithinS', 6 * HOUR_MS, 'FRESH'],
      ['one second past dataCurrentWithinS', 6 * HOUR_MS + 1_000, 'DEGRADED'],
      ['exactly dataStaleAfterS', 12 * HOUR_MS, 'DEGRADED'],
      ['one second past dataStaleAfterS', 12 * HOUR_MS + 1_000, 'STALE'],
    ])('%s → %s', (_name, dataAge, expected) => {
      expect(health([succeededWithData(20 * MINUTE_MS, dataAge)], FIRMS).status).toBe(expected);
    });

    it('is STALE when a source where silence is abnormal has never delivered data', () => {
      const result = health([run('SUCCEEDED', 20 * MINUTE_MS)], FIRMS);
      expect(result.status).toBe('STALE');
      expect(result.reasons).toStrictEqual(['DATA_NEVER_SEEN']);
    });

    it('ignores data currency for sources where silence is normal', () => {
      // No new earthquakes for a day is not a problem; no successful poll would be.
      const result = health([
        run('SUCCEEDED', 2 * MINUTE_MS, { newestObservedAt: at(5 * HOUR_MS) }),
      ]);
      expect(result.status).toBe('FRESH');
    });

    it('takes the newest observation across runs, not only from the last run', () => {
      const result = health(
        [
          succeededWithData(40 * MINUTE_MS, 2 * HOUR_MS),
          run('SUCCEEDED', 20 * MINUTE_MS, { newestObservedAt: null }),
        ],
        FIRMS,
      );
      expect(result.newestObservedAt).toStrictEqual(at(2 * HOUR_MS));
      expect(result.status).toBe('FRESH');
    });
  });

  describe('replay (invariant I2)', () => {
    const history = [
      run('SUCCEEDED', 3 * HOUR_MS),
      run('FAILED', 2 * HOUR_MS),
      run('SUCCEEDED', 2 * MINUTE_MS),
    ];

    it('never sees a run committed after as_of', () => {
      const earlier = new Date(NOW.getTime() - 90 * MINUTE_MS);
      const result = health(history, USGS, { asOf: earlier });
      expect(result.lastSuccessAt).toStrictEqual(at(3 * HOUR_MS));
      expect(result.status).toBe('STALE');
      // The recovery at NOW-2min is in the future for this knowledge time.
      expect(result.consecutiveFailures).toBe(1);
    });

    it('sees the recovery once as_of passes it', () => {
      expect(health(history).status).toBe('FRESH');
    });

    it('ignores a run that is still RUNNING, because it has not committed', () => {
      const committed = run('SUCCEEDED', 2 * MINUTE_MS);
      const inFlight = run('RUNNING', null);
      const result = health([committed, inFlight]);
      expect(result.status).toBe('FRESH');
      // Evidence and "last attempt" both come from the committed run, never the in-flight one.
      expect(result.evidenceId).toBe(`EV:RUN:${committed.id}`);
      expect(result.lastAttemptAt).toStrictEqual(committed.startedAt);
    });

    it('is insensitive to the order runs are supplied in', () => {
      const shuffled = [...history].reverse();
      expect(health(shuffled)).toStrictEqual(health(history));
    });
  });

  it('points at the most recent visible run as evidence', () => {
    const last = run('SUCCEEDED', 2 * MINUTE_MS);
    const result = health([run('FAILED', 10 * MINUTE_MS), last]);
    expect(result.evidenceId).toBe(`EV:RUN:${last.id}`);
  });

  it('echoes the policy it judged against', () => {
    expect(health([run('SUCCEEDED', MINUTE_MS)], FIRMS).expected).toStrictEqual(FIRMS);
  });
});

describe('aggregateSourceHealth', () => {
  const asOf = NOW;

  it('takes the worst status across products', () => {
    const good = health([run('SUCCEEDED', MINUTE_MS)]);
    const bad = health([run('SUCCEEDED', 90 * MINUTE_MS)]);
    const rollup = aggregateSourceHealth('firms', FIRMS, [good, bad], asOf);
    expect(rollup.status).toBe('STALE');
    expect(rollup.productId).toBeNull();
  });

  it('takes the most recent timestamps across products', () => {
    const older = health([run('SUCCEEDED', 40 * MINUTE_MS)]);
    const newer = health([run('SUCCEEDED', 2 * MINUTE_MS)]);
    const rollup = aggregateSourceHealth('firms', FIRMS, [older, newer], asOf);
    expect(rollup.lastSuccessAt).toStrictEqual(at(2 * MINUTE_MS));
  });

  it('is UNAVAILABLE for a source with no products', () => {
    expect(aggregateSourceHealth('eccc', USGS, [], asOf).status).toBe('UNAVAILABLE');
  });
});

describe('isDataUnavailable', () => {
  it.each([
    ['FRESH', false],
    ['DEGRADED', false],
    ['STALE', true],
    ['UNAVAILABLE', true],
  ] as const)('%s → %s', (status, expected) => {
    expect(isDataUnavailable(status)).toBe(expected);
  });
});
