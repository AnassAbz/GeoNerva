/**
 * The earthquake relevance model, tested **at every boundary**, which ARCHITECTURE §9 requires of
 * these thresholds by name.
 *
 * Boundaries rather than midpoints, because a midpoint test passes under almost any off-by-one:
 * `>=` for `>`, 150 for 50, hypocentral for epicentral. Each band is probed from both sides, and
 * the pairs are written next to each other so a reader can see that the pair straddles the number
 * in the document.
 */

import { describe, expect, it } from 'vitest';

import {
  AUTHORITATIVE_ALERT_RADIUS_KM,
  DEEP_FOCUS_KM,
  assessEarthquake,
  hypocentralDistanceKm,
  type EarthquakeInput,
} from './index.ts';

const HERE = { lat: 31.6295, lon: -7.9811 };

function quake(overrides: Partial<EarthquakeInput> = {}): EarthquakeInput {
  return {
    location: HERE,
    epicentre: { lat: 31.8, lon: -8.1 },
    epicentralDistanceKm: 20,
    magnitude: 5.2,
    depthKm: 10,
    providerStatus: 'reviewed',
    severityScheme: null,
    severityValue: null,
    feltReports: null,
    tsunamiFlag: false,
    agreementLevel: null,
    corroborated: true,
    ...overrides,
  };
}

const levelOf = (input: Partial<EarthquakeInput>): string | null =>
  assessEarthquake(quake(input))?.level ?? null;

const codes = (input: Partial<EarthquakeInput>): readonly string[] =>
  (assessEarthquake(quake(input))?.reasons ?? []).map((r) => r.code);

describe('the bands, from both sides of every threshold', () => {
  it.each([
    // §9.1 HIGH: M ≥ 7.0 & d ≤ 400
    ['M7.0 at 400 km', { magnitude: 7.0, epicentralDistanceKm: 400, depthKm: 0 }, 'HIGH'],
    ['M7.0 at 401 km', { magnitude: 7.0, epicentralDistanceKm: 401, depthKm: 0 }, 'MODERATE'],
    ['M6.9 at 400 km', { magnitude: 6.9, epicentralDistanceKm: 400, depthKm: 0 }, 'MODERATE'],
    // HIGH: M ≥ 6.0 & d ≤ 150
    ['M6.0 at 150 km', { magnitude: 6.0, epicentralDistanceKm: 150, depthKm: 0 }, 'HIGH'],
    ['M6.0 at 151 km', { magnitude: 6.0, epicentralDistanceKm: 151, depthKm: 0 }, 'MODERATE'],
    ['M5.9 at 150 km', { magnitude: 5.9, epicentralDistanceKm: 150, depthKm: 0 }, 'MODERATE'],
    // HIGH: M ≥ 5.0 & d ≤ 50
    ['M5.0 at 50 km', { magnitude: 5.0, epicentralDistanceKm: 50, depthKm: 0 }, 'HIGH'],
    ['M5.0 at 51 km', { magnitude: 5.0, epicentralDistanceKm: 51, depthKm: 0 }, 'MODERATE'],
    ['M4.9 at 50 km', { magnitude: 4.9, epicentralDistanceKm: 50, depthKm: 0 }, 'MODERATE'],
    // MODERATE: M ≥ 7.5 & d ≤ 1,500
    ['M7.5 at 1500 km', { magnitude: 7.5, epicentralDistanceKm: 1_500, depthKm: 0 }, 'MODERATE'],
    ['M7.5 at 1501 km', { magnitude: 7.5, epicentralDistanceKm: 1_501, depthKm: 0 }, 'LOW'],
    // MODERATE: M ≥ 6.5 & d ≤ 800
    ['M6.5 at 800 km', { magnitude: 6.5, epicentralDistanceKm: 800, depthKm: 0 }, 'MODERATE'],
    ['M6.5 at 801 km', { magnitude: 6.5, epicentralDistanceKm: 801, depthKm: 0 }, 'LOW'],
    // MODERATE: M ≥ 5.5 & d ≤ 300
    ['M5.5 at 300 km', { magnitude: 5.5, epicentralDistanceKm: 300, depthKm: 0 }, 'MODERATE'],
    ['M5.5 at 301 km', { magnitude: 5.5, epicentralDistanceKm: 301, depthKm: 0 }, 'LOW'],
    // MODERATE: M ≥ 4.5 & d ≤ 100
    ['M4.5 at 100 km', { magnitude: 4.5, epicentralDistanceKm: 100, depthKm: 0 }, 'MODERATE'],
    ['M4.5 at 101 km', { magnitude: 4.5, epicentralDistanceKm: 101, depthKm: 0 }, 'LOW'],
    ['M4.4 at 100 km', { magnitude: 4.4, epicentralDistanceKm: 100, depthKm: 0 }, 'LOW'],
    // Everything inside the radius is at least LOW.
    ['M2.0 at 5 km', { magnitude: 2.0, epicentralDistanceKm: 5, depthKm: 0 }, 'LOW'],
  ])('%s is %s', (_name, input, expected) => {
    expect(levelOf(input)).toBe(expected);
  });

  it('takes the first matching band, not the best one', () => {
    /*
     * M7.2 at 200 km matches HIGH (M ≥ 7.0, d ≤ 400) and would also match MODERATE. §9.1 says
     * first match, so it is HIGH. A `reduce`-to-highest would agree here and disagree the moment
     * a band is reordered or added, which is exactly when nobody would notice.
     */
    expect(levelOf({ magnitude: 7.2, epicentralDistanceKm: 200, depthKm: 0 })).toBe('HIGH');
  });
});

describe('distance is hypocentral, not epicentral', () => {
  it('computes the slant distance through the earth', () => {
    // √(40² + 30²) = 50.
    expect(hypocentralDistanceKm(40, 30)).toBeCloseTo(50, 6);
    expect(hypocentralDistanceKm(20, 0)).toBe(20);
    // A null depth is the epicentral distance: an unknown depth must not make an event look
    // further away, and therefore less relevant, than it might be.
    expect(hypocentralDistanceKm(20, null)).toBe(20);
  });

  it('puts a deep earthquake directly underfoot in the right band', () => {
    /*
     * The case that makes hypocentral distance matter. An M6.2 at 0 km epicentral and 200 km deep
     * is 200 km *away* — outside HIGH's M ≥ 6.0 & d ≤ 150 — while the epicentral distance would
     * put it squarely inside. Using the surface distance would over-rank every deep event in the
     * subduction zones where most of them happen.
     */
    expect(levelOf({ magnitude: 6.2, epicentralDistanceKm: 0, depthKm: 200 })).toBe('MODERATE');
    // The same magnitude at the same surface distance, but shallow, is HIGH.
    expect(levelOf({ magnitude: 6.2, epicentralDistanceKm: 0, depthKm: 10 })).toBe('HIGH');
  });
});

describe('the depth modifier', () => {
  it('demotes one level at the threshold and not before', () => {
    // A 300 km hypocentre is already 300 km away, so the band is MODERATE (M ≥ 5.5 & d ≤ 300),
    // and the deep-focus demotion takes it to LOW.
    expect(levelOf({ magnitude: 6.0, epicentralDistanceKm: 0, depthKm: DEEP_FOCUS_KM })).toBe(
      'LOW',
    );
    expect(codes({ magnitude: 6.0, epicentralDistanceKm: 0, depthKm: DEEP_FOCUS_KM })).toContain(
      'DEEP_FOCUS',
    );
    expect(
      codes({ magnitude: 6.0, epicentralDistanceKm: 0, depthKm: DEEP_FOCUS_KM - 1 }),
    ).not.toContain('DEEP_FOCUS');
  });

  it('cannot demote below LOW, so a modifier never removes an item', () => {
    /*
     * "Less attention" is not "no attention". An event that reached a band at all is inside the
     * search radius and worth listing; dropping it would turn a modifier into a filter and the
     * user would never learn it existed.
     */
    const deep = assessEarthquake(
      quake({ magnitude: 3.0, epicentralDistanceKm: 10, depthKm: 700 }),
    );
    expect(deep?.level).toBe('LOW');
  });
});

describe('CRITICAL, and the only way to reach it', () => {
  it('is unreachable by magnitude and distance alone', () => {
    /*
     * Invariant I10. An M9 next door is HIGH. "Critical" is a claim only an authority can make,
     * and GeoNerva's own heuristics top out one level below it however extreme the inputs — which
     * is the difference between reporting an earthquake and issuing a warning.
     */
    const enormous = assessEarthquake(
      quake({ magnitude: 9.0, epicentralDistanceKm: 1, depthKm: 5 }),
    );
    expect(enormous?.level).toBe('HIGH');
    expect(enormous?.requiresAuthoritativeBasis).toBe(false);
  });

  it('is reached by an official impact alert within 100 km', () => {
    const alerted = assessEarthquake(
      quake({
        magnitude: 6.2,
        epicentralDistanceKm: 80,
        severityScheme: 'PAGER',
        severityValue: 'orange',
      }),
    );
    expect(alerted?.level).toBe('CRITICAL');
    // And it demands the citation, which the caller must attach or drop the level.
    expect(alerted?.requiresAuthoritativeBasis).toBe(true);
    expect(alerted?.reasons.map((r) => r.code)).toContain('OFFICIAL_IMPACT_ALERT');
  });

  it('accepts GDACS as well as PAGER, at either alert level', () => {
    for (const [scheme, value] of [
      ['PAGER', 'orange'],
      ['PAGER', 'red'],
      ['GDACS_ALERT', 'Orange'],
      ['GDACS_ALERT', 'Red'],
    ] as const) {
      expect(
        levelOf({ epicentralDistanceKm: 50, severityScheme: scheme, severityValue: value }),
      ).toBe('CRITICAL');
    }
  });

  it('refuses a green alert, which is not an alert', () => {
    // GDACS Green and PAGER green mean "we assessed this and it is not significant". Treating
    // them as authoritative bases would make almost every earthquake critical.
    expect(
      levelOf({ epicentralDistanceKm: 10, severityScheme: 'PAGER', severityValue: 'green' }),
    ).not.toBe('CRITICAL');
    expect(
      levelOf({ epicentralDistanceKm: 10, severityScheme: 'GDACS_ALERT', severityValue: 'Green' }),
    ).not.toBe('CRITICAL');
  });

  it('applies the 100 km bound to the epicentral distance, from both sides', () => {
    // §9.1 says epicentral here, not hypocentral: the alert is about the surface footprint the
    // authority modelled, not the slant distance to the hypocentre.
    const at = (km: number): string | null =>
      levelOf({
        epicentralDistanceKm: km,
        depthKm: 400,
        severityScheme: 'PAGER',
        severityValue: 'red',
      });
    expect(at(AUTHORITATIVE_ALERT_RADIUS_KM)).toBe('CRITICAL');
    expect(at(AUTHORITATIVE_ALERT_RADIUS_KM + 1)).not.toBe('CRITICAL');
  });

  it('is not demoted by depth once an authority has spoken', () => {
    /*
     * A deep event with an official alert stays CRITICAL. The authority modelled the surface
     * impact, depth included; GeoNerva demoting it afterwards would be second-guessing the only
     * party entitled to make the call.
     */
    expect(
      levelOf({
        magnitude: 7.0,
        epicentralDistanceKm: 50,
        depthKm: 600,
        severityScheme: 'PAGER',
        severityValue: 'red',
      }),
    ).toBe('CRITICAL');
  });

  it('refuses an alert value from an unknown scheme', () => {
    // A provider inventing `severityScheme: 'SOMETHING'` with the word "red" in it must not be
    // able to produce a CRITICAL.
    expect(
      levelOf({ epicentralDistanceKm: 10, severityScheme: 'SOMETHING', severityValue: 'red' }),
    ).not.toBe('CRITICAL');
  });
});

describe('reasons that never change the level', () => {
  it('states the tsunami flag in USGS’s own terms and leaves the level alone', () => {
    /*
     * USGS documents the flag as "does not indicate if a tsunami actually did or will exist".
     * Treating it as a severity signal would be GeoNerva making exactly the claim USGS declined
     * to make.
     */
    /*
     * Probed at **MODERATE**, not at the default.
     *
     * The default case is M5.2 at 20 km, which is already HIGH — and HIGH is the ceiling for any
     * heuristic promotion, so a mutation that promoted on the tsunami flag produced the same
     * answer and the test passed. Mutation testing found that; a term no test can move is not
     * really being tested. M4.6 at 90 km is MODERATE, where a promotion would show.
     */
    const moderate = { magnitude: 4.6, epicentralDistanceKm: 90, depthKm: 0 };
    expect(levelOf(moderate)).toBe('MODERATE');
    expect(levelOf({ ...moderate, tsunamiFlag: true })).toBe('MODERATE');

    const without = assessEarthquake(quake({ tsunamiFlag: false }));
    const with_ = assessEarthquake(quake({ tsunamiFlag: true }));
    expect(with_?.level).toBe(without?.level);

    const stated = with_?.reasons.find((r) => r.code === 'USGS_TSUNAMI_FLAG');
    expect(stated?.text).toContain('does not indicate if a tsunami actually did or will exist');
    expect(stated?.text).toContain('warning centres');
  });

  it('states felt reports at the threshold, and not below it', () => {
    expect(codes({ feltReports: 10 })).toContain('FELT_REPORTS');
    expect(codes({ feltReports: 9 })).not.toContain('FELT_REPORTS');
    // And it changes nothing.
    expect(levelOf({ feltReports: 10_000 })).toBe(levelOf({ feltReports: null }));
  });

  it('marks an automatic solution as preliminary', () => {
    expect(codes({ providerStatus: 'automatic' })).toContain('PRELIMINARY_SOLUTION');
    expect(codes({ providerStatus: 'reviewed' })).not.toContain('PRELIMINARY_SOLUTION');
  });

  it('raises a caveat, not a level, when the sources disagree', () => {
    const conflicted = assessEarthquake(quake({ agreementLevel: 'CONFLICT' }));
    expect(conflicted?.reasons.map((r) => r.code)).toContain('SOURCES_DISAGREE');
    expect(conflicted?.caveats).toHaveLength(1);
    expect(conflicted?.level).toBe(assessEarthquake(quake({ agreementLevel: null }))?.level);
  });

  it('says when only one independent source has reported the event', () => {
    // One source agreeing with itself is not corroboration — the reason EMSC exists.
    expect(codes({ corroborated: false })).toContain('SINGLE_SOURCE');
    expect(codes({ corroborated: true })).not.toContain('SINGLE_SOURCE');
  });

  it('always states the distance and the magnitude', () => {
    // Every assessment has to be explainable from its own reasons, with no access to the item.
    expect(codes({})).toContain('DISTANCE');
    expect(codes({})).toContain('MAGNITUDE');
  });
});

describe('what cannot be assessed', () => {
  it('returns null for an event with no magnitude, rather than LOW', () => {
    /*
     * A sonic boom, or a record whose magnitude the provider withheld. `LOW` would be a claim
     * that it deserves little attention; `null` says it could not be assessed, and the caller
     * lists it as unassessed rather than as unimportant.
     */
    expect(assessEarthquake(quake({ magnitude: null }))).toBeNull();
  });

  it('returns null for a distance that is not one', () => {
    expect(assessEarthquake(quake({ epicentralDistanceKm: Number.NaN }))).toBeNull();
    expect(assessEarthquake(quake({ epicentralDistanceKm: -1 }))).toBeNull();
  });
});
