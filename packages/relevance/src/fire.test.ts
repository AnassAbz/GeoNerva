/**
 * Fire-activity relevance, at every boundary in §9.2.
 *
 * The family where the gap between what GeoNerva has and what a reader assumes is widest — a
 * satellite pixel flagged as containing fire, not a confirmed wildfire — so several of these tests
 * are about the *caveat* and the *cap* rather than about the level.
 */

import { describe, expect, it } from 'vitest';

import {
  FIRE_GROWTH_FLOOR,
  FIRE_HIGH_DETECTIONS_24H,
  FIRE_HIGH_OVERPASSES_24H,
  FIRE_MID_KM,
  FIRE_NEAR_KM,
  FIRE_OUTER_KM,
  THERMAL_DETECTION_CAVEAT,
  assessFire,
  type FireInput,
} from './index.ts';

function fire(overrides: Partial<FireInput> = {}): FireInput {
  return {
    nearestDetectionKm: 5,
    state: 'ACTIVE',
    n24h: 8,
    nTotal: 30,
    overpasses24h: 2,
    nPrevious24h: 6,
    frpSum24h: 42.5,
    hoursSinceLastDetection: 3,
    officialAlertNearby: false,
    relatedGdacsEventId: null,
    persistentHeatSource: false,
    ...overrides,
  };
}

const levelOf = (input: Partial<FireInput>): string | null =>
  assessFire(fire(input))?.level ?? null;
const codes = (input: Partial<FireInput>): readonly string[] =>
  (assessFire(fire(input))?.reasons ?? []).map((r) => r.code);

describe('the bands, from both sides', () => {
  it.each([
    // HIGH: d ≤ 10 & ACTIVE & (n24h ≥ 5 or overpasses ≥ 2)
    [
      '10 km, active, 5 detections',
      { nearestDetectionKm: FIRE_NEAR_KM, n24h: 5, overpasses24h: 1 },
      'HIGH',
    ],
    [
      '11 km, active, 5 detections',
      { nearestDetectionKm: FIRE_NEAR_KM + 1, n24h: 5, overpasses24h: 1 },
      'MODERATE',
    ],
    [
      '10 km, active, 4 detections, 1 pass',
      { nearestDetectionKm: FIRE_NEAR_KM, n24h: 4, overpasses24h: 1 },
      'MODERATE',
    ],
    [
      '10 km, active, 4 detections, 2 passes',
      { nearestDetectionKm: FIRE_NEAR_KM, n24h: 4, overpasses24h: 2 },
      'HIGH',
    ],
    // MODERATE: d ≤ 30 & ACTIVE
    ['30 km, active', { nearestDetectionKm: FIRE_MID_KM, n24h: 1, overpasses24h: 1 }, 'MODERATE'],
    ['31 km, active', { nearestDetectionKm: FIRE_MID_KM + 1, n24h: 1, overpasses24h: 1 }, 'LOW'],
    // MODERATE: d ≤ 10 & COOLING
    ['10 km, cooling', { nearestDetectionKm: FIRE_NEAR_KM, state: 'COOLING' as const }, 'MODERATE'],
    ['11 km, cooling', { nearestDetectionKm: FIRE_NEAR_KM + 1, state: 'COOLING' as const }, 'LOW'],
    // LOW: d ≤ 150
    ['150 km, active', { nearestDetectionKm: FIRE_OUTER_KM, n24h: 1, overpasses24h: 1 }, 'LOW'],
  ])('%s is %s', (_name, input, expected) => {
    expect(levelOf(input)).toBe(expected);
  });

  it('has no assessment beyond 150 km', () => {
    expect(assessFire(fire({ nearestDetectionKm: FIRE_OUTER_KM + 1 }))).toBeNull();
  });

  it('has no assessment for a dormant cluster', () => {
    /*
     * A dormant cluster is history, not activity. §9.2's bands all require ACTIVE or COOLING, and
     * reporting a fire that stopped burning weeks ago as a LOW-relevance hazard would fill the
     * card with things that are over.
     */
    expect(assessFire(fire({ state: 'DORMANT', nearestDetectionKm: 1 }))).toBeNull();
  });

  it('treats two overpasses as stronger evidence than five pixels from one', () => {
    /*
     * The condition worth understanding rather than just testing: five pixels from a single pass
     * can be one large hot object smeared across a swath, while two independent looks at the same
     * place are two separate observations. §9.2 makes either sufficient, and this pins that they
     * really are alternatives rather than a conjunction.
     */
    expect(
      levelOf({
        nearestDetectionKm: 5,
        state: 'ACTIVE',
        n24h: FIRE_HIGH_DETECTIONS_24H - 1,
        overpasses24h: FIRE_HIGH_OVERPASSES_24H,
      }),
    ).toBe('HIGH');
    expect(
      levelOf({
        nearestDetectionKm: 5,
        state: 'ACTIVE',
        n24h: FIRE_HIGH_DETECTIONS_24H,
        overpasses24h: FIRE_HIGH_OVERPASSES_24H - 1,
      }),
    ).toBe('HIGH');
    // Neither, and it falls to MODERATE.
    expect(
      levelOf({
        nearestDetectionKm: 5,
        state: 'ACTIVE',
        n24h: FIRE_HIGH_DETECTIONS_24H - 1,
        overpasses24h: FIRE_HIGH_OVERPASSES_24H - 1,
      }),
    ).toBe('MODERATE');
  });
});

describe('distance is to the nearest detection, not the centroid', () => {
  it('is what the input means, and the reason says so', () => {
    /*
     * Not a behavioural branch — it is the contract of the field, and it is stated because a
     * centroid distance would understate a long fire front by an order of magnitude: a 40 km
     * front whose centroid is 25 km away can have a pixel 3 km from the place.
     */
    const near = assessFire(fire({ nearestDetectionKm: 3 }));
    expect(near?.reasons.find((r) => r.code === 'DISTANCE')?.text).toContain('nearest detection');
    expect(near?.reasons.find((r) => r.code === 'DISTANCE')?.params['nearestDetectionKm']).toBe(3);
  });
});

describe('the growth signal', () => {
  it('needs both halves of the rule', () => {
    // At least double the previous 24 hours **and** at least ten detections.
    expect(codes({ n24h: FIRE_GROWTH_FLOOR, nPrevious24h: 5 })).toContain('GROWING');
    // Doubled, but too few for the doubling to mean anything.
    expect(codes({ n24h: FIRE_GROWTH_FLOOR - 1, nPrevious24h: 4 })).not.toContain('GROWING');
    // Plenty of detections, but not growing.
    expect(codes({ n24h: 20, nPrevious24h: 15 })).not.toContain('GROWING');
  });

  it('does not call one detection becoming three explosive growth', () => {
    /*
     * The reason the floor exists. A tripling of a number that small is ordinary satellite
     * geometry — a slightly different overpass angle — not a spreading fire, and calling it
     * growth would make the word useless.
     */
    expect(codes({ n24h: 3, nPrevious24h: 1 })).not.toContain('GROWING');
  });
});

describe('the persistent heat source cap', () => {
  it('caps at LOW whatever the counts say', () => {
    /*
     * A gas flare detected every night for a year would otherwise be the *strongest* signal in
     * the model: many detections, many overpasses, always active, always close. Capping it is
     * what stops an industrial site permanently topping a location's fire card.
     */
    const flare = assessFire(
      fire({
        nearestDetectionKm: 1,
        state: 'ACTIVE',
        n24h: 40,
        overpasses24h: 4,
        persistentHeatSource: true,
      }),
    );
    expect(flare?.level).toBe('LOW');
    expect(flare?.reasons.map((r) => r.code)).toContain('PERSISTENT_HEAT_SOURCE');

    // The same cluster without the flag is HIGH, so the cap is doing the work.
    expect(
      levelOf({
        nearestDetectionKm: 1,
        state: 'ACTIVE',
        n24h: 40,
        overpasses24h: 4,
        persistentHeatSource: false,
      }),
    ).toBe('HIGH');
  });

  it('does not suppress an official alert', () => {
    /*
     * An industrial site inside a GDACS wildfire alert area is a real situation, and the alert is
     * about the *region*. Letting the cap suppress it would hide an authority's statement; the
     * alert wins, because the authority is talking about the area rather than the pixel.
     */
    const both = assessFire(
      fire({ persistentHeatSource: true, officialAlertNearby: true, nearestDetectionKm: 2 }),
    );
    expect(both?.level).toBe('CRITICAL');
    expect(both?.reasons.map((r) => r.code)).toContain('PERSISTENT_HEAT_SOURCE');
    expect(both?.reasons.map((r) => r.code)).toContain('OFFICIAL_ALERT_AREA');
  });
});

describe('CRITICAL', () => {
  it('is unreachable without an official alert, however intense the cluster', () => {
    // Invariant I10 again: GeoNerva's own heuristics top out at HIGH.
    expect(levelOf({ nearestDetectionKm: 0.5, state: 'ACTIVE', n24h: 200, overpasses24h: 6 })).toBe(
      'HIGH',
    );
  });

  it('is reached by a GDACS wildfire alert area, and demands the citation', () => {
    const alerted = assessFire(fire({ officialAlertNearby: true }));
    expect(alerted?.level).toBe('CRITICAL');
    expect(alerted?.requiresAuthoritativeBasis).toBe(true);
  });
});

describe('the caveat', () => {
  it('is on every assessment, in every band', () => {
    /*
     * NRT VIIRS has no `type` field, so gas flares, industrial roofs and volcanoes arrive
     * indistinguishable from burning vegetation. This is why the hazard type is
     * `THERMAL_ACTIVITY` and not `WILDFIRE`, and the caveat is not conditional on anything.
     */
    for (const input of [
      fire({ nearestDetectionKm: 1 }),
      fire({ nearestDetectionKm: 140, n24h: 1 }),
      fire({ state: 'COOLING' }),
      fire({ officialAlertNearby: true }),
      fire({ persistentHeatSource: true }),
    ]) {
      expect(assessFire(input)?.caveats).toStrictEqual([THERMAL_DETECTION_CAVEAT]);
    }
  });

  it('says they are not confirmed wildfires, in those words', () => {
    expect(THERMAL_DETECTION_CAVEAT).toContain('not confirmed wildfires');
    expect(THERMAL_DETECTION_CAVEAT).toContain('gas flares');
  });
});

describe('reasons', () => {
  it('always states distance, counts, overpasses and recency', () => {
    // Every assessment has to be explainable from its own reasons, with no access to the cluster.
    const always = codes({});
    for (const code of ['DISTANCE', 'DETECTION_COUNT', 'OVERPASSES', 'RECENCY']) {
      expect(always).toContain(code);
    }
  });

  it('omits the FRP sum rather than reporting a null one', () => {
    expect(codes({ frpSum24h: null })).not.toContain('FRP_SUM');
    expect(codes({ frpSum24h: 10 })).toContain('FRP_SUM');
  });

  it('mentions a related GDACS wildfire event when there is one', () => {
    expect(codes({ relatedGdacsEventId: 'WF:1023' })).toContain('RELATED_GDACS_EVENT');
    expect(codes({ relatedGdacsEventId: null })).not.toContain('RELATED_GDACS_EVENT');
  });

  it('writes singular and plural correctly, because these are rendered sentences', () => {
    const one = assessFire(fire({ n24h: 1, overpasses24h: 1 }));
    expect(one?.reasons.find((r) => r.code === 'DETECTION_COUNT')?.text).toContain(
      '1 detection in',
    );
    expect(one?.reasons.find((r) => r.code === 'OVERPASSES')?.text).toContain(
      '1 satellite overpass in',
    );
    const many = assessFire(fire({ n24h: 4, overpasses24h: 3 }));
    expect(many?.reasons.find((r) => r.code === 'DETECTION_COUNT')?.text).toContain('4 detections');
    expect(many?.reasons.find((r) => r.code === 'OVERPASSES')?.text).toContain(
      '3 satellite overpasses',
    );
  });
});
