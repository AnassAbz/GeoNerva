/**
 * Flood, cyclone and volcano relevance, at every boundary in §9.3–§9.5.
 *
 * These three are where the *geometry* decides the answer rather than a magnitude, so the
 * boundaries being probed are containment and distance, and the thing most likely to go wrong is
 * the interaction between the two: GDACS's alert level and where the place sits give different
 * answers for the same situation, and neither alone is the answer.
 */

import { describe, expect, it } from 'vitest';

import {
  CYCLONE_TRACK_KM,
  FLOOD_CENTROID_ONLY_KM,
  FLOOD_MODELLED_AREA_CAVEAT,
  FLOOD_NEAR_AREA_KM,
  FLOOD_OUTER_KM,
  VOLCANO_NEAR_KM,
  VOLCANO_OUTER_KM,
  assessCyclone,
  assessFlood,
  assessVolcano,
  type CycloneInput,
  type FloodInput,
} from './index.ts';

function flood(overrides: Partial<FloodInput> = {}): FloodInput {
  return {
    alertLevel: 'Orange',
    insideArea: false,
    distanceToAreaKm: null,
    centroidDistanceKm: 10,
    hasAreaGeometry: true,
    ...overrides,
  };
}

function cyclone(overrides: Partial<CycloneInput> = {}): CycloneInput {
  return {
    alertLevel: 'Orange',
    insideWind120: false,
    insideWind90: false,
    insideWind60: false,
    insideUncertaintyCone: false,
    trackDistanceKm: null,
    isForecastGeometry: false,
    forecastIssuedAt: null,
    forecastAgency: 'JTWC via GDACS',
    ...overrides,
  };
}

describe('flood, §9.3', () => {
  it.each([
    ['inside, Red', { insideArea: true, alertLevel: 'Red' as const }, 'CRITICAL'],
    ['inside, Orange', { insideArea: true, alertLevel: 'Orange' as const }, 'HIGH'],
    ['inside, Green', { insideArea: true, alertLevel: 'Green' as const }, 'MODERATE'],
  ])('%s is %s', (_name, input, expected) => {
    expect(assessFlood(flood(input))?.level).toBe(expected);
  });

  it.each([
    ['25 km from the area, Red', 'Red' as const, 'HIGH'],
    ['25 km from the area, Orange', 'Orange' as const, 'MODERATE'],
    ['25 km from the area, Green', 'Green' as const, 'LOW'],
  ])('%s is %s', (_name, alertLevel, expected) => {
    expect(assessFlood(flood({ alertLevel, distanceToAreaKm: FLOOD_NEAR_AREA_KM }))?.level).toBe(
      expected,
    );
  });

  it('falls to the outer band one kilometre past the near-area bound', () => {
    // 25 km is near; 26 km is not, and the only thing left is the 500 km outer band.
    expect(
      assessFlood(flood({ alertLevel: 'Red', distanceToAreaKm: FLOOD_NEAR_AREA_KM + 1 }))?.level,
    ).toBe('LOW');
  });

  it('caps a centroid-only event, and says why', () => {
    /*
     * Without an area there is no "inside", so the strongest a Red flood can be is MODERATE. The
     * reason code is `NO_AREA_GEOMETRY`, which is the whole purpose of
     * `FloodAttributes.has_area_geometry` being a required field: it makes this answerable at all,
     * and the GDACS adapter refuses to normalize a flood without it.
     */
    const centroidOnly = assessFlood(
      flood({ hasAreaGeometry: false, alertLevel: 'Red', centroidDistanceKm: 50 }),
    );
    expect(centroidOnly?.level).toBe('MODERATE');
    expect(centroidOnly?.reasons.map((r) => r.code)).toContain('NO_AREA_GEOMETRY');

    // Green stays LOW even close in.
    expect(
      assessFlood(flood({ hasAreaGeometry: false, alertLevel: 'Green', centroidDistanceKm: 5 }))
        ?.level,
    ).toBe('LOW');
  });

  it('probes the centroid-only bound from both sides', () => {
    const at = (km: number): string | undefined =>
      assessFlood(flood({ hasAreaGeometry: false, alertLevel: 'Red', centroidDistanceKm: km }))
        ?.level;
    expect(at(FLOOD_CENTROID_ONLY_KM)).toBe('MODERATE');
    expect(at(FLOOD_CENTROID_ONLY_KM + 1)).toBe('LOW');
  });

  it('has no assessment beyond the outer radius, rather than a LOW one', () => {
    /*
     * `null`, not `LOW`. A flood 600 km away is not a low-relevance hazard for this place, it is
     * not a hazard for this place — and listing it as LOW would fill the card with events that
     * are simply elsewhere.
     */
    expect(assessFlood(flood({ centroidDistanceKm: FLOOD_OUTER_KM }))?.level).toBe('LOW');
    expect(assessFlood(flood({ centroidDistanceKm: FLOOD_OUTER_KM + 1 }))).toBeNull();
  });

  it('always carries the modelled-area caveat, in every band', () => {
    /*
     * A GDACS flood polygon comes from GloFAS and is a modelled impact area, not an observed
     * inundation extent — Copernicus GFM's observed extent is WMS-only. "You are inside the
     * flooded area" is a sentence GeoNerva has no basis for, so the caveat is unconditional.
     */
    for (const input of [
      flood({ insideArea: true }),
      flood({ distanceToAreaKm: 10 }),
      flood({ hasAreaGeometry: false, centroidDistanceKm: 50 }),
      flood({ centroidDistanceKm: 400 }),
    ]) {
      expect(assessFlood(input)?.caveats).toContain(FLOOD_MODELLED_AREA_CAVEAT);
    }
  });

  it('says "modelled" in the reason as well as the caveat', () => {
    const inside = assessFlood(flood({ insideArea: true }));
    expect(inside?.reasons[0]?.text).toContain('modelled');
    expect(inside?.reasons[0]?.text).toContain('not an observed flood extent');
  });

  it('demands a citation for its CRITICAL', () => {
    // GDACS Red *is* an official impact alert, so the basis exists and must be attached.
    expect(
      assessFlood(flood({ insideArea: true, alertLevel: 'Red' }))?.requiresAuthoritativeBasis,
    ).toBe(true);
    expect(
      assessFlood(flood({ insideArea: true, alertLevel: 'Orange' }))?.requiresAuthoritativeBasis,
    ).toBe(false);
  });

  it('ignores an area geometry it was told does not exist', () => {
    // `insideArea: true` with `hasAreaGeometry: false` is a caller bug; the flag that says
    // whether the provider published an area is the one that decides.
    expect(
      assessFlood(
        flood({ insideArea: true, hasAreaGeometry: false, centroidDistanceKm: 50 }),
      )?.reasons.map((r) => r.code),
    ).toContain('NO_AREA_GEOMETRY');
  });
});

describe('cyclone, §9.4', () => {
  it.each([
    ['inside 120, Red', { insideWind120: true, alertLevel: 'Red' as const }, 'CRITICAL'],
    ['inside 120, Orange', { insideWind120: true, alertLevel: 'Orange' as const }, 'HIGH'],
    ['inside 120, Green', { insideWind120: true, alertLevel: 'Green' as const }, 'HIGH'],
    ['inside 90, Red', { insideWind90: true, alertLevel: 'Red' as const }, 'HIGH'],
    ['inside 90, Orange', { insideWind90: true, alertLevel: 'Orange' as const }, 'HIGH'],
    ['inside 90, Green', { insideWind90: true, alertLevel: 'Green' as const }, 'MODERATE'],
    ['inside 60', { insideWind60: true, alertLevel: 'Red' as const }, 'MODERATE'],
    ['inside the cone', { insideUncertaintyCone: true, alertLevel: 'Red' as const }, 'MODERATE'],
  ])('%s is %s', (_name, input, expected) => {
    expect(assessCyclone(cyclone(input))?.level).toBe(expected);
  });

  it('takes the strongest applicable buffer, because they nest', () => {
    /*
     * A place inside the 120 km/h buffer is necessarily inside the 90 and the 60 too. Taking the
     * first match in §9.4's order is what makes the answer the strongest applicable statement; a
     * different order would report a Red cyclone overhead as MODERATE.
     */
    const inAll = assessCyclone(
      cyclone({
        insideWind120: true,
        insideWind90: true,
        insideWind60: true,
        insideUncertaintyCone: true,
        alertLevel: 'Red',
      }),
    );
    expect(inAll?.level).toBe('CRITICAL');
  });

  it('probes the track bound from both sides', () => {
    expect(assessCyclone(cyclone({ trackDistanceKm: CYCLONE_TRACK_KM }))?.level).toBe('LOW');
    expect(assessCyclone(cyclone({ trackDistanceKm: CYCLONE_TRACK_KM + 1 }))).toBeNull();
  });

  it('always states whether the geometry is observed or forecast', () => {
    /*
     * §9.4 requires it, because they are different claims: "the storm is here" and "an agency
     * expects the storm here" cannot be rendered as the same sentence. GeoNerva never computes
     * its own tracks or arrival times, so the agency and the issue time are quoted.
     */
    const forecast = assessCyclone(
      cyclone({
        insideWind120: true,
        isForecastGeometry: true,
        forecastIssuedAt: '2026-09-20T12:00:00Z',
        forecastAgency: 'JTWC via GDACS',
      }),
    );
    const stated = forecast?.reasons.find((r) => r.code === 'FORECAST_GEOMETRY');
    expect(stated?.text).toContain('forecast position');
    expect(stated?.text).toContain('JTWC via GDACS');
    expect(stated?.text).toContain('2026-09-20T12:00:00Z');

    const observed = assessCyclone(cyclone({ insideWind120: true, isForecastGeometry: false }));
    expect(observed?.reasons.map((r) => r.code)).toContain('OBSERVED_GEOMETRY');
    expect(observed?.reasons.map((r) => r.code)).not.toContain('FORECAST_GEOMETRY');
  });

  it('has no assessment for a storm that reaches none of the geometries', () => {
    expect(assessCyclone(cyclone())).toBeNull();
  });
});

describe('volcano, §9.5', () => {
  it.each([
    ['100 km, Green', { distanceKm: VOLCANO_NEAR_KM, alertLevel: 'Green' as const }, 'MODERATE'],
    ['100 km, Orange', { distanceKm: VOLCANO_NEAR_KM, alertLevel: 'Orange' as const }, 'HIGH'],
    ['100 km, Red', { distanceKm: VOLCANO_NEAR_KM, alertLevel: 'Red' as const }, 'HIGH'],
    ['101 km, Red', { distanceKm: VOLCANO_NEAR_KM + 1, alertLevel: 'Red' as const }, 'LOW'],
    ['300 km, Red', { distanceKm: VOLCANO_OUTER_KM, alertLevel: 'Red' as const }, 'LOW'],
  ])('%s is %s', (_name, input, expected) => {
    expect(assessVolcano({ alertTextVerbatim: null, ...input })?.level).toBe(expected);
  });

  it('has no assessment beyond 300 km', () => {
    expect(
      assessVolcano({
        distanceKm: VOLCANO_OUTER_KM + 1,
        alertLevel: 'Red',
        alertTextVerbatim: null,
      }),
    ).toBeNull();
  });

  it('never reaches CRITICAL, because ash dispersion is deferred', () => {
    /*
     * §9.5 tops this model out at HIGH. Reaching CRITICAL would need an authoritative statement
     * about *this place*, and a GDACS volcano alert level is about the eruption rather than about
     * anywhere in particular — the thing that would bridge the two is ash dispersion, which is
     * explicitly out of scope.
     */
    const closest = assessVolcano({ distanceKm: 1, alertLevel: 'Red', alertTextVerbatim: null });
    expect(closest?.level).toBe('HIGH');
    expect(closest?.requiresAuthoritativeBasis).toBe(false);
  });

  it('quotes the provider’s wording rather than paraphrasing it', () => {
    const statement = 'Ash plume to 25,000 ft reported by Darwin VAAC.';
    const assessed = assessVolcano({
      distanceKm: 50,
      alertLevel: 'Orange',
      alertTextVerbatim: statement,
    });
    const quoted = assessed?.reasons.find((r) => r.code === 'PROVIDER_STATEMENT');
    expect(quoted?.text).toBe(statement);
    expect(quoted?.params['verbatim']).toBe(true);
  });

  it('refuses a distance that is not one', () => {
    expect(
      assessVolcano({ distanceKm: Number.NaN, alertLevel: 'Red', alertTextVerbatim: null }),
    ).toBeNull();
    expect(
      assessVolcano({ distanceKm: -1, alertLevel: 'Red', alertTextVerbatim: null }),
    ).toBeNull();
  });
});
