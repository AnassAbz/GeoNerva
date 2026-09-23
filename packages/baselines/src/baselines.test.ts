/**
 * The baselines engine, at every threshold on both sides (TESTING §2: "All reference windows zero;
 * 51 vs 52 windows; 19 vs 20 events; mean 0.99 vs 1.0; sequence context trigger").
 *
 * Expected values are written as literals, not computed from the constants they test, so that
 * widening a threshold changes what these tests accept rather than moving both sides together.
 */

import { describe, expect, it } from 'vitest';

import { estimateCompleteness, maximumCurvature } from './completeness.ts';
import { earthquakeCountBaseline, type QuakeRecord } from './earthquakes.ts';
import { fireTrend, type FireDay } from './fire.ts';
import { gdacsContext } from './gdacs.ts';
import { countPerWindow, mean, midRankPercentile, quantile } from './statistics.ts';

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = new Date('2026-09-21T00:00:00.000Z');

describe('statistics', () => {
  it('gives an observed zero among all-zero weeks the 50th percentile, not 0 or 100', () => {
    expect(midRankPercentile(0, new Array<number>(60).fill(0))).toBe(50);
  });

  it('counts ties at half weight', () => {
    // Two below, two equal, one above: (2 + 1) / 5.
    expect(midRankPercentile(3, [1, 2, 3, 3, 9])).toBe(60);
    expect(midRankPercentile(10, [1, 2, 3])).toBe(100);
    expect(midRankPercentile(0, [1, 2, 3])).toBe(0);
    expect(() => midRankPercentile(1, [])).toThrow();
  });

  it('interpolates quantiles as R and NumPy do (type 7)', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(values, 50)).toBe(5.5);
    expect(quantile(values, 25)).toBe(3.25);
    expect(quantile(values, 90)).toBe(9.1);
    expect(quantile([7], 95)).toBe(7);
    expect(mean([1, 2, 3, 6])).toBe(3);
  });

  it('assigns a boundary instant to the window that starts there', () => {
    const end = AS_OF;
    const counts = countPerWindow(
      [new Date(end.getTime() - 7 * DAY), new Date(end.getTime() - 7 * DAY - 1), end],
      { end, windowDays: 7, windows: 2 },
    );
    // The start of window 0 is in window 0; one millisecond earlier is window 1; `end` is outside.
    expect(counts).toStrictEqual([1, 1]);
  });
});

describe('magnitude of completeness', () => {
  function catalog(counts: Readonly<Record<string, number>>): number[] {
    return Object.entries(counts).flatMap(([magnitude, count]) =>
      new Array<number>(count).fill(Number(magnitude)),
    );
  }

  it('takes the most populated bin plus 0.2', () => {
    expect(maximumCurvature(catalog({ 2.8: 10, 2.9: 40, 3.0: 30, 3.4: 30 }))?.mc).toBe(3.1);
  });

  it('breaks a tie towards the smaller magnitude', () => {
    expect(maximumCurvature(catalog({ 3.0: 20, 3.5: 20 }))?.mc).toBe(3.2);
  });

  it('uses the estimate at 50 events above it, and falls back to M4.5 at 49', () => {
    // Mode at 3.0 → candidate 3.2; exactly 50 events at or above 3.2.
    const fifty = catalog({ 3.0: 60, 3.2: 50 });
    expect(estimateCompleteness(fifty, { referenceBeyondRetention: false })).toStrictEqual({
      threshold: 3.2,
      method: 'MAXIMUM_CURVATURE',
      eventsAboveCandidate: 50,
      referenceBeyondRetention: false,
    });
    const fortyNine = catalog({ 3.0: 60, 3.2: 49 });
    expect(estimateCompleteness(fortyNine, { referenceBeyondRetention: false })).toMatchObject({
      threshold: 4.5,
      method: 'FALLBACK',
    });
  });

  it('never counts below M4.5 when the reference reaches past the 30-day retention', () => {
    // Mode 3.0, candidate 3.2 with 60 events above it: a valid local Mc the floor must raise.
    const rich = catalog({ 3.0: 80, 3.2: 60 });
    expect(estimateCompleteness(rich, { referenceBeyondRetention: true })).toMatchObject({
      threshold: 4.5,
      method: 'RETENTION_FLOOR',
    });
    // A local Mc already above the floor stands.
    const deep = catalog({ 4.6: 80, 4.8: 60 });
    expect(estimateCompleteness(deep, { referenceBeyondRetention: true })).toMatchObject({
      threshold: 4.8,
      method: 'MAXIMUM_CURVATURE',
      // Carried even though the method no longer shows it: largest-recent needs to know.
      referenceBeyondRetention: true,
    });
  });

  it('falls back on an empty catalog', () => {
    expect(estimateCompleteness([], { referenceBeyondRetention: false }).method).toBe('FALLBACK');
  });
});

/**
 * A catalog with `perWindow[i]` events in the i-th 7-day window before the current one (0 = most
 * recent) and `observed` in the current window, all M5.0 at 10 km.
 */
function quakes(perWindow: readonly number[], observed: number): QuakeRecord[] {
  const currentStart = AS_OF.getTime() - 7 * DAY;
  const events: QuakeRecord[] = [];
  perWindow.forEach((count, index) => {
    for (let n = 0; n < count; n += 1) {
      events.push({
        observedAt: new Date(currentStart - index * 7 * DAY - (n + 1) * 60_000),
        magnitude: 5,
        distanceKm: 10,
        publicId: `EQ-26-W${String(index)}N${String(n)}`,
      });
    }
  });
  for (let n = 0; n < observed; n += 1) {
    events.push({
      observedAt: new Date(AS_OF.getTime() - (n + 1) * 60_000),
      magnitude: 5,
      distanceKm: 10,
      publicId: `EQ-26-NOW${String(n)}`,
    });
  }
  return events;
}

function baseline(
  perWindow: readonly number[],
  observed: number,
  extra: readonly QuakeRecord[] = [],
) {
  return earthquakeCountBaseline({
    asOf: AS_OF,
    radiusKm: 150,
    windowDays: 7,
    referenceFrom: new Date(AS_OF.getTime() - 7 * DAY - perWindow.length * 7 * DAY),
    completeness: {
      threshold: 4.5,
      method: 'FALLBACK',
      eventsAboveCandidate: null,
      referenceBeyondRetention: false,
    },
    events: [...quakes(perWindow, observed), ...extra],
  });
}

/** `n` windows with `events` spread one per window from the most recent. */
function windows(n: number, events: number): number[] {
  return Array.from({ length: n }, (_, index) => (index < events ? 1 : 0));
}

describe('EQ_COUNT: the minimum sample', () => {
  it('is OK at 52 windows and 20 events', () => {
    expect(baseline(windows(52, 20), 0).status).toBe('OK');
  });

  it('is RARE_ACTIVITY at 52 windows and 19 events, with a rarity statement instead of a percentile', () => {
    const result = baseline(windows(52, 19), 1);
    expect(result.status).toBe('RARE_ACTIVITY');
    expect(result.percentile).toBeNull();
    expect(result.band).toBeNull();
    expect(result.reference).toBeNull();
    expect(result.rarity).toStrictEqual({
      nEvents: 20,
      sinceYear: 2025,
      text: '20 earthquakes of M4.5+ within 150 km in the past 1 year.',
    });
  });

  it('is INSUFFICIENT_HISTORY at 51 windows, whatever the events', () => {
    const result = baseline(new Array<number>(51).fill(3), 0);
    expect(result.status).toBe('INSUFFICIENT_HISTORY');
    expect(result.interpretation).toBe('Not enough history to establish a baseline.');
    expect(result.interpretation).not.toMatch(/normal/iu);
  });
});

describe('EQ_COUNT: bands', () => {
  // 100 windows: 84 with no event, 15 with one and one with five — 20 events, the minimum.
  const skewed = [
    ...new Array<number>(80).fill(0),
    ...new Array<number>(15).fill(1),
    5,
    0,
    0,
    0,
    0,
  ];

  it('is TYPICAL for a count at or below the bulk of the distribution', () => {
    expect(baseline(skewed, 0).band).toBe('TYPICAL');
  });

  it('needs two events for ABOVE_TYPICAL even at the 90th percentile', () => {
    // One event: (95 below + 15/2) / 100 = 91.5 — past p90, but a single event is not elevated.
    const one = baseline(skewed, 1);
    expect(one.percentile).toBe(91.5);
    expect(one.band).toBe('TYPICAL');
    const two = baseline(skewed, 2);
    expect(two.percentile).toBe(99);
    expect(two.band).toBe('ABOVE_TYPICAL');
    expect(two.caveats).toStrictEqual([
      'Elevated recent activity does not by itself indicate that a larger earthquake will occur.',
    ]);
  });

  it('needs three events for WELL_ABOVE_TYPICAL even at the 99th percentile', () => {
    // Two events sit at p99 exactly, and two is below the three the band requires.
    expect(baseline(skewed, 2).band).toBe('ABOVE_TYPICAL');
    const six = baseline(skewed, 6);
    expect(six.percentile).toBe(100);
    expect(six.band).toBe('WELL_ABOVE_TYPICAL');
  });

  /*
   * The finest quantile n observations can resolve is 1/n, so "the top 1 % of comparable periods"
   * needs a hundred of them. Over 59 windows the product was naming a 1-in-100 rarity that is not
   * in its own sample (QA round 2, M-1), against ARCHITECTURE §8's "refuse to report a statistic
   * that the data cannot support". The band is unchanged; the claim made about it is not.
   */
  it('claims a band only when the sample can resolve its percentile', () => {
    const many = [...new Array<number>(96).fill(0), ...new Array<number>(15).fill(1), 5, 0, 0, 0];
    expect(many.length).toBeGreaterThanOrEqual(100);
    const resolved = baseline(many, 6);
    expect(resolved.band).toBe('WELL_ABOVE_TYPICAL');
    expect(resolved.interpretation).toContain('top 1 %');

    // Fifty-nine windows: the same band, and a sentence the sample can carry.
    /*
     * 59 windows and 25 events: past §8.1's gate of 52 and 20, so the status is OK — and the 99th
     * percentile is not in a sample of 59, whose finest quantile is about the 98th. The band is
     * capped one step rather than dropped: the count is still high against the periods GeoNerva
     * holds, and the 90th percentile *is* resolvable here (ADR-043).
     */
    const few = [...new Array<number>(38).fill(0), ...new Array<number>(20).fill(1), 5];
    expect(few.length).toBe(59);
    const capped = baseline(few, 6);
    expect(capped.status).toBe('OK');
    expect(capped.band).toBe('ABOVE_TYPICAL');
    expect(capped.interpretation).not.toContain('top 1 %');
    expect(capped.interpretation).toContain('top 10 %');
  });

  /* Below ten windows even the 90th percentile is an extrapolation, so no band is claimed. */
  it('claims no band at all when the sample cannot resolve the lowest one', () => {
    const tiny = [...new Array<number>(4).fill(0), ...new Array<number>(4).fill(1), 5];
    expect(tiny.length).toBe(9);
    const result = baseline(tiny, 6);
    if (result.status === 'OK') expect(result.band).toBe('TYPICAL');
  });

  it('carries no caveat when the band is typical', () => {
    expect(baseline(skewed, 0).caveats).toStrictEqual([]);
  });
});

describe('EQ_COUNT: the activity ratio', () => {
  it('is shown at a reference mean of exactly one event per window', () => {
    const result = baseline(new Array<number>(52).fill(1), 2);
    expect(result.reference?.mean).toBe(1);
    expect(result.reference?.activityRatio).toBe(2);
  });

  it('is withheld at a mean just below one', () => {
    // 51 windows of one and one of zero among 52 windows... gives 51/52 ≈ 0.98.
    const result = baseline([...new Array<number>(51).fill(1), 0], 2);
    expect(result.reference?.mean).toBeLessThan(1);
    expect(result.reference?.activityRatio).toBeNull();
  });
});

describe('EQ_COUNT: what is counted', () => {
  it('counts only events at or above the threshold and within the radius', () => {
    const extra: QuakeRecord[] = [
      {
        observedAt: new Date(AS_OF.getTime() - 1000),
        magnitude: 4.4,
        distanceKm: 10,
        publicId: 'EQ-26-SMALL',
      },
      {
        observedAt: new Date(AS_OF.getTime() - 1000),
        magnitude: 6,
        distanceKm: 151,
        publicId: 'EQ-26-FAR',
      },
      {
        observedAt: new Date(AS_OF.getTime() - 1000),
        magnitude: null,
        distanceKm: 1,
        publicId: 'EQ-26-NOMAG',
      },
      {
        observedAt: new Date(AS_OF.getTime() - 1000),
        magnitude: 4.5,
        distanceKm: 150,
        publicId: 'EQ-26-EDGE',
      },
    ];
    expect(baseline(windows(52, 20), 0, extra).observed).toBe(1);
  });

  it('never counts an event after the knowledge time', () => {
    const future: QuakeRecord = {
      observedAt: new Date(AS_OF.getTime() + 1000),
      magnitude: 6,
      distanceKm: 1,
      publicId: 'EQ-26-LATER',
    };
    expect(baseline(windows(52, 20), 0, [future]).observed).toBe(0);
  });

  it('draws the last 52 windows and the current one', () => {
    const series = baseline(windows(60, 20), 3).series;
    expect(series).toHaveLength(53);
    expect(series[52]?.count).toBe(3);
    expect(series[51]?.count).toBe(1);
  });
});

describe('EQ_COUNT: sequence context', () => {
  function trigger(magnitude: number): QuakeRecord {
    return {
      observedAt: new Date('2026-09-12T08:00:00.000Z'),
      magnitude,
      distanceKm: 20,
      publicId: 'EQ-26-MAIN',
    };
  }

  it('fires at exactly Mc + 1.5, and not a tenth below', () => {
    expect(baseline(windows(52, 20), 0, [trigger(6.0)]).sequenceContext).toStrictEqual({
      magnitude: 6,
      observedAt: new Date('2026-09-12T08:00:00.000Z'),
      publicId: 'EQ-26-MAIN',
      text: 'Activity follows the M6.0 earthquake on 12 Sep.',
      caveat: 'Aftershocks commonly follow large earthquakes.',
    });
    expect(baseline(windows(52, 20), 0, [trigger(5.9)]).sequenceContext).toBeNull();
  });
});

describe('EQ_COUNT: largest recent', () => {
  it('names the last time something as large happened', () => {
    const older: QuakeRecord = {
      observedAt: new Date('2025-03-02T00:00:00.000Z'),
      magnitude: 6.2,
      distanceKm: 40,
      publicId: 'EQ-25-OLD',
    };
    const recent: QuakeRecord = {
      observedAt: new Date('2026-09-15T00:00:00.000Z'),
      magnitude: 6.1,
      distanceKm: 30,
      publicId: 'EQ-26-NEW',
    };
    expect(baseline(windows(52, 20), 0, [older, recent]).largestRecent?.text).toBe(
      'The largest within 150 km since Mar 2025.',
    );
  });
});

describe('FIRE_TREND', () => {
  function days(previous: number, recent: number, uncovered: readonly number[] = []): FireDay[] {
    return Array.from({ length: 35 }, (_, index) => ({
      day: `d${String(index)}`,
      detections: index < 28 ? previous : recent,
      covered: !uncovered.includes(index),
    }));
  }

  it('is INCREASING at +50 % and +10 a day together', () => {
    expect(fireTrend(days(20, 30)).band).toBe('INCREASING');
  });

  it('stays STABLE just under 50 %, however large the absolute change', () => {
    expect(fireTrend(days(100, 149)).band).toBe('STABLE');
  });

  it('stays STABLE just under ten a day, however large the relative change', () => {
    // 1 → 10.9 is a tenfold jump, but only 9.9 more detections a day.
    expect(fireTrend(days(1, 10.9)).band).toBe('STABLE');
  });

  it('is DECREASING at -50 % and -10 a day together', () => {
    expect(fireTrend(days(40, 20)).band).toBe('DECREASING');
  });

  it('excludes a day without satellite coverage instead of counting it as zero', () => {
    // Recent days 28–34 at 30, but three of them uncovered and recorded as 0 detections.
    const series = days(20, 30).map((day, index) =>
      [28, 29, 30].includes(index) ? { ...day, detections: 0, covered: false } : day,
    );
    const result = fireTrend(series);
    expect(result.recentMeanPerDay).toBe(30);
    expect(result.recentCoveredDays).toBe(4);
    expect(result.band).toBe('INCREASING');
  });

  it('reports no trend when a period has no coverage at all', () => {
    const result = fireTrend(days(20, 30, [28, 29, 30, 31, 32, 33, 34]));
    expect(result).toMatchObject({ status: 'INSUFFICIENT_COVERAGE', band: null });
  });

  it('says "trend", never "abnormal"', () => {
    const text = fireTrend(days(20, 30)).interpretation;
    // The full lexicon scan is in `@geonerva/briefing`'s history-copy test, which may import it.
    expect(text).not.toMatch(/abnormal|wildfire/iu);
  });

  it('refuses a series of the wrong length', () => {
    expect(() => fireTrend(days(1, 1).slice(1))).toThrow(/35 days/u);
  });
});

describe('GDACS_CONTEXT', () => {
  it('states a count as context, with no band', () => {
    expect(
      gdacsContext({ asOf: AS_OF, noun: ['flood event', 'flood events'], count: 2 }),
    ).toStrictEqual({
      methodVersion: 'baselines-1',
      count: 2,
      sinceYear: 2021,
      interpretation: '2 GDACS flood events within 300 km since 2021.',
    });
    expect(
      gdacsContext({ asOf: AS_OF, noun: ['flood event', 'flood events'], count: 1 }).interpretation,
    ).toBe('1 GDACS flood event within 300 km since 2021.');
  });
});

describe('GDACS_CONTEXT: a record shorter than five years', () => {
  it('names where the record begins instead of claiming five years', () => {
    expect(
      gdacsContext({
        asOf: AS_OF,
        noun: ['flood event', 'flood events'],
        count: 2,
        recordStart: new Date('2026-06-13T00:00:00.000Z'),
      }).interpretation,
    ).toBe(
      "2 GDACS flood events within 300 km since 13 June 2026, when GeoNerva's GDACS record begins.",
    );
  });
});

describe('P8 review fixes', () => {
  it('counts an event at exactly the start of the current window, once', () => {
    const edge: QuakeRecord = {
      observedAt: new Date(AS_OF.getTime() - 7 * DAY),
      magnitude: 5,
      distanceKm: 20,
      publicId: 'EQ-26-EDGE01',
    };
    const without = baseline(windows(52, 20), 0);
    const withEdge = baseline(windows(52, 20), 0, [edge]);
    expect(withEdge.observed).toBe(without.observed + 1);
    expect(withEdge.nEvents).toBe(without.nEvents);
  });

  it('refuses "the largest since" below M4.5 whenever the reference reaches past retention', () => {
    // FALLBACK at M4.5, not RETENTION_FLOOR — the method no longer hides the pruned record.
    const older: QuakeRecord = {
      observedAt: new Date(AS_OF.getTime() - 60 * DAY),
      magnitude: 4.6,
      distanceKm: 20,
      publicId: 'EQ-26-OLDER1',
    };
    const recent: QuakeRecord = {
      observedAt: new Date(AS_OF.getTime() - 2 * DAY),
      magnitude: 3.9,
      distanceKm: 20,
      publicId: 'EQ-26-RECNT1',
    };
    const input = {
      asOf: AS_OF,
      radiusKm: 150,
      windowDays: 7,
      referenceFrom: new Date(AS_OF.getTime() - 60 * 7 * DAY),
      events: [older, recent],
    };
    const beyond = earthquakeCountBaseline({
      ...input,
      completeness: {
        threshold: 4.5,
        method: 'FALLBACK',
        eventsAboveCandidate: null,
        referenceBeyondRetention: true,
      },
    });
    expect(beyond.largestRecent).toBeNull();
    const within = earthquakeCountBaseline({
      ...input,
      completeness: {
        threshold: 4.5,
        method: 'FALLBACK',
        eventsAboveCandidate: null,
        referenceBeyondRetention: false,
      },
    });
    expect(within.largestRecent?.magnitude).toBe(3.9);
  });
});
