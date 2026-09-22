/**
 * `asOfContextFor` — the knowledge-time context every read model carries.
 *
 * One rule, and it has been broken twice in the same file: **the present comes from the caller,
 * never from the wall clock.** `buildSnapshot` compared the replay horizon against `Date.now()`
 * while the rest of the response was built from `generatedAt`, and `isReplay` did the same. Both
 * are invisible until the two clocks disagree — which is exactly what a fixed clock does, and
 * what a replay does.
 *
 * The `isReplay` version was the worse of the two: under `GEONERVA_FAKE_NOW` the anchor is by
 * construction in the past of the real clock, so every live page rendered the replay banner and a
 * "Return to the present" link that went nowhere, on a page that *was* the present.
 */

import { describe, expect, it } from 'vitest';

import { asOfContextFor } from './snapshot.ts';

const HORIZON = {
  profile: 'lean' as const,
  byFamily: {
    EARTHQUAKES: { earliestAsOf: '2026-09-01T00:00:00.000Z', note: 'kept' },
    FIRE_ACTIVITY: { earliestAsOf: '2026-09-19T00:00:00.000Z', note: 'kept' },
    FLOODS: { earliestAsOf: '2026-09-01T00:00:00.000Z', note: 'kept' },
    CYCLONES: { earliestAsOf: '2026-09-01T00:00:00.000Z', note: 'kept' },
    WEATHER_ALERTS: { earliestAsOf: '2026-09-01T00:00:00.000Z', note: 'kept' },
    OTHER: { earliestAsOf: '2026-09-01T00:00:00.000Z', note: 'kept' },
  },
};

const NOW = new Date('2026-09-22T13:06:00.000Z');
const context = (asOf: Date, now: Date) => asOfContextFor(asOf, {}, HORIZON, now);

describe('asOfContextFor', () => {
  it('is not a replay when the knowledge time is the caller present', () => {
    expect(context(NOW, NOW).isReplay).toBe(false);
  });

  /*
   * The wall clock is hours ahead of the anchor whenever a seeded scenario is served. If the
   * function reached for it, this case would be a replay — which is the bug.
   */
  it('is not a replay merely because the wall clock has moved on', () => {
    const anchor = new Date('2020-01-01T00:00:00.000Z');
    expect(context(anchor, anchor).isReplay).toBe(false);
  });

  it('is a replay when the knowledge time is materially before the caller present', () => {
    expect(context(new Date(NOW.getTime() - 60 * 60 * 1000), NOW).isReplay).toBe(true);
  });

  /*
   * Five minutes, because a build takes time: calling a live request a replay because the server
   * was loaded would make an immutable-response header depend on how busy the machine was.
   */
  it.each([
    ['a second of latency', 1_000, false],
    ['four minutes', 4 * 60_000, false],
    ['five minutes exactly', 5 * 60_000, false],
    ['a second past five minutes', 5 * 60_000 + 1_000, true],
  ])('%s: isReplay = %s', (_case, behind, expected) => {
    expect(context(new Date(NOW.getTime() - behind), NOW).isReplay).toBe(expected);
  });

  it('carries the knowledge time and the cutoffs it was given, in a stable order', () => {
    const result = asOfContextFor(
      NOW,
      { usgs: new Date('2026-09-22T13:02:00.000Z'), emsc: null },
      HORIZON,
      NOW,
    );
    expect(result.asOf).toBe(NOW.toISOString());
    expect(Object.keys(result.sourceCutoffs)).toEqual(['emsc', 'usgs']);
    expect(result.sourceCutoffs['emsc']).toBeNull();
  });
});
