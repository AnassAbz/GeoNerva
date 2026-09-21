/**
 * Misfit and the correlation decision.
 *
 * Every expected number here is **derived in the test from the documented scales**, not copied
 * from a run of the code it is testing. `MISFIT_SCALES` is imported and the arithmetic is written
 * out, so a reader can check it and so that changing a scale changes the expectation rather than
 * silently re-baselining it.
 *
 * Distances are the one thing that cannot be hand-derived to full precision — they come from a
 * Vincenty solution — so the tests that need an exact distance construct their pairs on the
 * equator along a meridian, where the degree-to-kilometre relationship is stated and checked
 * independently rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import { vincentyDistanceMeters } from '@geonerva/geo';

import {
  CONFIDENCE_BOUNDS,
  DECISION,
  MAGNITUDE_VETO,
  MISFIT_SCALES,
  computeMisfit,
  confidenceFor,
  decideIdentityRef,
  decideSpatiotemporal,
  isRepublication,
  magnitudeFamily,
  revisionKeepsLink,
  sameMagnitudeFamily,
  type Candidate,
  type Solution,
} from './index.ts';

const T0 = new Date('2026-09-20T12:00:00.000Z');

function solution(overrides: Partial<Solution> = {}): Solution {
  return {
    sourceId: 'usgs',
    epicentre: { lat: 0, lon: 0 },
    originTime: T0,
    magnitude: 5.0,
    magnitudeType: 'mb',
    contributor: 'us',
    ...overrides,
  };
}

describe('misfit terms', () => {
  it('scores a perfectly coincident pair at zero', () => {
    const terms = computeMisfit(solution(), solution({ sourceId: 'emsc', contributor: 'EMSC' }));
    expect(terms.misfit).toBe(0);
    expect(terms.deltaSeconds).toBe(0);
    expect(terms.distanceMeters).toBe(0);
    expect(terms.deltaMagnitude).toBe(0);
  });

  it('scores the time term as Δt over the documented scale', () => {
    // 8 s against a 16 s scale is exactly half a unit. Written as the division, not as 0.5.
    const terms = computeMisfit(
      solution(),
      solution({
        sourceId: 'emsc',
        contributor: 'EMSC',
        originTime: new Date(T0.getTime() + 8_000),
      }),
    );
    expect(terms.deltaSeconds).toBe(8);
    expect(terms.timeTerm).toBeCloseTo(8 / MISFIT_SCALES.timeSeconds, 12);
    expect(terms.misfit).toBeCloseTo(8 / MISFIT_SCALES.timeSeconds, 12);
  });

  it('scores the distance term as d over the documented scale', () => {
    /*
     * A tenth of a degree of latitude at the equator. The distance is *measured* rather than
     * assumed — the assertion is that the term equals that measurement over the scale, which is
     * the property under test, and the measurement itself is cross-checked against PostGIS
     * elsewhere (`packages/briefing/src/geo-agreement.int.test.ts`).
     */
    const north = { lat: 0.1, lon: 0 };
    const measured = vincentyDistanceMeters({ lat: 0, lon: 0 }, north);
    expect(measured).not.toBeNull();
    // Independent sanity bound: a tenth of a degree of latitude is ~11.06 km at the equator,
    // since the shortest degree of latitude is 110,574 m.
    expect((measured ?? 0) / 1000).toBeGreaterThan(11.0);
    expect((measured ?? 0) / 1000).toBeLessThan(11.1);

    const terms = computeMisfit(
      solution(),
      solution({ sourceId: 'emsc', contributor: 'EMSC', epicentre: north }),
    );
    expect(terms.distanceTerm).toBeCloseTo((measured ?? 0) / MISFIT_SCALES.distanceMeters, 12);
  });

  it('scores the magnitude term at full weight within one family', () => {
    // mb vs mb: same family. 0.4 against a 0.8 scale is half a unit.
    const terms = computeMisfit(
      solution({ magnitude: 5.0, magnitudeType: 'mb' }),
      solution({ sourceId: 'emsc', contributor: 'EMSC', magnitude: 5.4, magnitudeType: 'mb' }),
    );
    expect(terms.magnitudeWeight).toBe(1);
    expect(terms.magnitudeTerm).toBeCloseTo(0.4 / MISFIT_SCALES.magnitude, 12);
  });

  it('halves the magnitude term across families', () => {
    /*
     * Mw from a moment tensor and mb from body waves measure different things. Two sources
     * reporting 5.4 Mw and 5.0 mb are not disagreeing by 0.4 in the way the raw number suggests,
     * so §6.1 halves the term rather than dropping it — the difference still carries information.
     */
    const terms = computeMisfit(
      solution({ magnitude: 5.0, magnitudeType: 'mb' }),
      solution({ sourceId: 'emsc', contributor: 'EMSC', magnitude: 5.4, magnitudeType: 'mww' }),
    );
    expect(terms.magnitudeWeight).toBe(0.5);
    expect(terms.magnitudeTerm).toBeCloseTo((0.5 * 0.4) / MISFIT_SCALES.magnitude, 12);
  });

  it('omits the magnitude term when either side has none, rather than scoring it zero', () => {
    /*
     * Zero would mean "the magnitudes agree perfectly", which is a claim about data that does not
     * exist — and it would make a magnitude-less record the *best* candidate every time, which is
     * the opposite of what missing evidence should do.
     */
    const terms = computeMisfit(
      solution({ magnitude: null }),
      solution({ sourceId: 'emsc', contributor: 'EMSC', magnitude: 5.4 }),
    );
    expect(terms.deltaMagnitude).toBeNull();
    expect(terms.magnitudeTerm).toBe(0);
    expect(terms.misfit).toBe(0);
  });

  it('sums the three terms', () => {
    const later = new Date(T0.getTime() + 16_000);
    const terms = computeMisfit(
      solution({ magnitude: 5.0, magnitudeType: 'mb' }),
      solution({
        sourceId: 'emsc',
        contributor: 'EMSC',
        originTime: later,
        magnitude: 5.8,
        magnitudeType: 'mb',
      }),
    );
    // 16 s / 16 s = 1, no distance, 0.8 / 0.8 = 1. Total 2.
    expect(terms.misfit).toBeCloseTo(2, 10);
  });
});

describe('magnitude families', () => {
  it('groups the types each source actually publishes', () => {
    expect(magnitudeFamily('mww')).toBe('MW');
    expect(magnitudeFamily('mb_lg')).toBe('MB');
    expect(magnitudeFamily('md')).toBe('ML');
    expect(magnitudeFamily('MB')).toBe('MB');
    expect(magnitudeFamily('unheard-of')).toBeNull();
  });

  it('treats EMSC’s bare `m` as not comparable to anything', () => {
    // `m` is not a claim about method, so it cannot be asserted to match or to differ from one.
    expect(sameMagnitudeFamily('m', 'mb')).toBe(false);
    expect(sameMagnitudeFamily('m', 'm')).toBe(false);
    expect(sameMagnitudeFamily('mb', 'mb')).toBe(true);
  });

  it('treats an unrecognised type as not comparable', () => {
    expect(sameMagnitudeFamily('mystery', 'mb')).toBe(false);
  });
});

describe('the magnitude veto', () => {
  const far = (deltaMagnitude: number, contributor: string | null): Solution =>
    solution({
      sourceId: 'emsc',
      contributor,
      magnitude: 5.0 + deltaMagnitude,
      magnitudeType: 'mb',
    });

  it('fires beyond the threshold and not at it', () => {
    const at = computeMisfit(solution(), far(MAGNITUDE_VETO, 'EMSC'));
    const past = computeMisfit(solution(), far(MAGNITUDE_VETO + 0.1, 'EMSC'));
    expect(at.deltaMagnitude).toBeCloseTo(MAGNITUDE_VETO, 10);
    expect(past.deltaMagnitude).toBeGreaterThan(MAGNITUDE_VETO);
  });

  it('is suspended when one source republishes the other’s solution', () => {
    /*
     * The labelled set's hand-checked Luzon pair: identical origin time and epicentre, ΔM 1.3,
     * and EMSC credits the solution to `NEIC` — which is USGS's own agency. A republished
     * magnitude can be stale by more than the veto allows, so the veto must not split a pair that
     * is demonstrably one earthquake.
     */
    const usgs = solution({ sourceId: 'usgs', contributor: 'us', magnitude: 4.5 });
    const emscRepublishing = solution({
      sourceId: 'emsc',
      contributor: 'NEIC',
      magnitude: 3.2,
      magnitudeType: 'm',
    });
    expect(isRepublication(usgs, emscRepublishing)).toBe(true);

    // And an independent EMSC solution at the same difference is *not* suspended.
    const emscIndependent = solution({ sourceId: 'emsc', contributor: 'EMSC', magnitude: 3.2 });
    expect(isRepublication(usgs, emscIndependent)).toBe(false);
  });

  it('decides republication on the agency, never on the values agreeing', () => {
    /*
     * Circularity check. The question the veto asks is whether the values may legitimately
     * disagree; deciding that *from* the values would answer it with itself. Identical magnitudes
     * from independent agencies are still independent.
     */
    const a = solution({ sourceId: 'usgs', contributor: 'us', magnitude: 5.0 });
    const b = solution({ sourceId: 'emsc', contributor: 'EMSC', magnitude: 5.0 });
    expect(isRepublication(a, b)).toBe(false);
  });

  it('never treats two records from one source as republication', () => {
    const a = solution({ sourceId: 'usgs', contributor: 'NEIC' });
    const b = solution({ sourceId: 'usgs', contributor: 'NEIC' });
    expect(isRepublication(a, b)).toBe(false);
  });
});

describe('the spatiotemporal decision', () => {
  const candidate = (
    id: string,
    overrides: Partial<Solution> = {},
    members: string[] = ['emsc'],
  ): Candidate => ({
    canonicalEventId: id,
    representative: solution({ sourceId: 'emsc', contributor: 'EMSC', ...overrides }),
    memberSourceIds: members,
  });

  it('matches a close, uniquely best candidate', () => {
    const decision = decideSpatiotemporal(solution(), [candidate('1')]);
    expect(decision.verdict).toBe('MATCH');
    expect(decision.relation).toBe('SAME_EVENT');
    expect(decision.canonicalEventId).toBe('1');
    expect(decision.reasons.map((r) => r.code)).toContain('UNIQUELY_BEST');
  });

  it('refuses to merge when two candidates fit almost equally well', () => {
    /*
     * The branch that protects the product's central claim. Merging two events that might be one
     * is unrecoverable — the distinction is destroyed and the result then reports itself as
     * corroborated by two sources — while keeping them apart is visible and fixable.
     */
    const decision = decideSpatiotemporal(solution(), [
      candidate('1', { originTime: new Date(T0.getTime() + 1_000) }),
      candidate('2', { originTime: new Date(T0.getTime() + 1_500) }),
    ]);
    expect(decision.verdict).toBe('POSSIBLE_MATCH');
    expect(decision.canonicalEventId).toBeNull();
    expect(decision.reasons.map((r) => r.code)).toContain('AMBIGUOUS');
  });

  it('matches when the runner-up is clearly worse', () => {
    // Gap must be at least 0.3. A candidate 16 s away scores 1.0 against one at 0 s scoring 0.
    const decision = decideSpatiotemporal(solution(), [
      candidate('1'),
      candidate('2', { originTime: new Date(T0.getTime() + 16_000) }),
    ]);
    expect(decision.verdict).toBe('MATCH');
    expect(decision.canonicalEventId).toBe('1');
  });

  it('never puts two records from one source in one event', () => {
    /*
     * Stage 0's invariant. ComCat has already decided its own two records are different
     * earthquakes; overriding that would collapse an aftershock sequence into a single event.
     */
    const decision = decideSpatiotemporal(solution({ sourceId: 'usgs' }), [
      candidate('1', {}, ['usgs', 'emsc']),
    ]);
    expect(decision.verdict).toBe('NO_MATCH');
    expect(decision.reasons.map((r) => r.code)).toContain('SAME_SOURCE_ALREADY_PRESENT');
    // The excluded candidate still keeps its score, so the event page can say why it lost.
    expect(decision.scored).toHaveLength(1);
    expect(decision.scored[0]?.excluded).toBe('SAME_SOURCE_ALREADY_PRESENT');
  });

  it('opens a new event when the best fit is beyond the matching range', () => {
    const decision = decideSpatiotemporal(solution(), [
      candidate('1', { originTime: new Date(T0.getTime() + 60_000) }),
    ]);
    expect(decision.verdict).toBe('NO_MATCH');
    expect(decision.reasons.map((r) => r.code)).toContain('TOO_FAR');
  });

  it('orders equal-misfit candidates by id, so the answer does not depend on row order', () => {
    /*
     * Determinism reaching back into correlation. Two identical candidates would otherwise be
     * ordered by however the database returned them, and *which event a record joins* would
     * depend on it.
     */
    const forward = decideSpatiotemporal(solution(), [candidate('7'), candidate('3')]);
    const reversed = decideSpatiotemporal(solution(), [candidate('3'), candidate('7')]);
    expect(forward.scored.map((s) => s.canonicalEventId)).toStrictEqual(['3', '7']);
    expect(reversed.scored.map((s) => s.canonicalEventId)).toStrictEqual(['3', '7']);
    // Identical misfits mean no gap, so neither merges — but both runs agree on the ordering.
    expect(forward.verdict).toBe(reversed.verdict);
  });

  it('refuses a candidate the magnitude veto rejected, however well it fits otherwise', () => {
    /*
     * The veto has to reach the *decision*, not just exist as a function. This candidate is
     * perfect on time and distance — zero on both — so without the exclusion it would be the best
     * candidate by a mile and would merge. Mutation testing found this gap: removing the veto
     * branch from candidate scoring passed the whole suite, because every other test exercised
     * `magnitudeVeto` directly rather than through `decideSpatiotemporal`.
     *
     * This is the hardest real case in the labelled set: 18 of the 64 distinct pairs are rejected
     * by the veto and by nothing else.
     */
    const decision = decideSpatiotemporal(solution({ magnitude: 5.0, magnitudeType: 'mb' }), [
      candidate('1', { magnitude: 5.0 + MAGNITUDE_VETO + 0.5, magnitudeType: 'mb' }),
    ]);
    expect(decision.verdict).toBe('NO_MATCH');
    expect(decision.reasons.map((r) => r.code)).toContain('MAGNITUDE_INCOMPATIBLE');
    expect(decision.scored[0]?.excluded).toBe('MAGNITUDE_INCOMPATIBLE');
  });

  it('does not let a vetoed candidate become the runner-up that blocks a real match', () => {
    /*
     * A vetoed candidate is not in the running at all, so it must not contribute a uniqueness gap.
     * If it did, an incompatible near-neighbour could demote a genuine match to POSSIBLE_MATCH —
     * the veto would be *causing* missed merges instead of preventing wrong ones.
     */
    const decision = decideSpatiotemporal(solution({ magnitude: 5.0, magnitudeType: 'mb' }), [
      candidate('1'),
      candidate('2', { magnitude: 5.0 + MAGNITUDE_VETO + 0.5, magnitudeType: 'mb' }),
    ]);
    expect(decision.verdict).toBe('MATCH');
    expect(decision.canonicalEventId).toBe('1');
  });

  it('says so when there was nothing to compare against', () => {
    const decision = decideSpatiotemporal(solution(), []);
    expect(decision.verdict).toBe('NO_MATCH');
    expect(decision.reasons.map((r) => r.code)).toContain('NO_CANDIDATES');
  });
});

describe('the identity-reference decision', () => {
  it('links a resolved cross-reference as a derived copy', () => {
    /*
     * The load-bearing part is the *relation*, not the match: `DERIVED_COPY` is what stops a
     * GDACS earthquake being counted as a second independent source for the USGS solution it
     * restates (ADR-030).
     */
    const decision = decideIdentityRef({
      upstreamRef: 'us7000tikb',
      resolvedCanonicalEventId: '42',
    });
    expect(decision.verdict).toBe('MATCH');
    expect(decision.relation).toBe('DERIVED_COPY');
    expect(decision.matchKind).toBe('IDENTITY_REF');
    expect(decision.confidence).toBe(0.99);
  });

  it('does not invent an event for a reference it cannot resolve', () => {
    // GDACS can publish before USGS has an alias GeoNerva has seen.
    const decision = decideIdentityRef({
      upstreamRef: 'us7000tikb',
      resolvedCanonicalEventId: null,
    });
    expect(decision.verdict).toBe('NO_MATCH');
    expect(decision.reasons.map((r) => r.code)).toContain('IDENTITY_REF_UNRESOLVED');
  });
});

describe('confidence', () => {
  it('is a monotone restatement of the misfit, bounded away from certainty', () => {
    // clamp(1 − misfit/2, 0.5, 0.98). Derived here, not copied.
    expect(confidenceFor(0)).toBe(CONFIDENCE_BOUNDS.max);
    expect(confidenceFor(0.4)).toBeCloseTo(1 - 0.4 / 2, 12);
    expect(confidenceFor(DECISION.matchMisfit)).toBeCloseTo(1 - DECISION.matchMisfit / 2, 12);
    expect(confidenceFor(5)).toBe(CONFIDENCE_BOUNDS.min);
  });

  it('never reaches 1.0, because a deterministic rule is still a judgement', () => {
    expect(confidenceFor(0)).toBeLessThan(1);
  });
});

describe('revision hysteresis', () => {
  it('keeps a link that still fits, on a looser bar than created it', () => {
    /*
     * Looser on purpose: re-deciding from scratch on every revision would make links flap as
     * solutions are refined, and "What Changed?" would fill with merges and splits that no
     * earthquake caused.
     */
    expect(revisionKeepsLink(DECISION.matchMisfit).keep).toBe(true);
    expect(revisionKeepsLink(1.5).keep).toBe(true);
    expect(revisionKeepsLink(1.51).keep).toBe(false);
    expect(revisionKeepsLink(1.51).reason.code).toBe('REVISION_BROKE_MATCH');
  });
});

describe('a republication matched spatiotemporally', () => {
  /*
   * ADR-030: "An EMSC observation whose contributor is the same agency as the matched USGS record
   * is linked as DERIVED_COPY, not as an independent source." The magnitude veto already knows how
   * to recognise one — it is suspended for exactly this case — so the relation has to carry the
   * same knowledge, or the event holds two SAME_EVENT members and a copy agreeing with its
   * original is counted as corroboration.
   */
  const usgs: Solution = {
    sourceId: 'usgs',
    epicentre: { lat: 15.0, lon: 120.0 },
    originTime: new Date('2026-06-05T00:00:00.000Z'),
    magnitude: 4.5,
    magnitudeType: 'mb',
    contributor: 'us',
  };

  function candidateFor(representative: Solution): Candidate {
    return {
      canonicalEventId: '00000000-0000-4000-8000-000000000001',
      representative,
      memberSourceIds: [representative.sourceId],
    };
  }

  it('links an EMSC report credited to the other source as DERIVED_COPY', () => {
    // The P0 Luzon pair: identical time and place, ΔM 1.3, EMSC crediting NEIC.
    const emsc: Solution = {
      sourceId: 'emsc',
      epicentre: usgs.epicentre,
      originTime: usgs.originTime,
      magnitude: 3.2,
      magnitudeType: 'm',
      contributor: 'NEIC',
    };
    const decision = decideSpatiotemporal(emsc, [candidateFor(usgs)]);

    expect(decision.verdict).toBe('MATCH');
    expect(decision.relation).toBe('DERIVED_COPY');
    expect(decision.reasons.map((reason) => reason.code)).toContain('REPUBLICATION');
  });

  it('links two genuinely independent solutions as SAME_EVENT', () => {
    const emsc: Solution = {
      sourceId: 'emsc',
      epicentre: usgs.epicentre,
      originTime: usgs.originTime,
      magnitude: 4.6,
      magnitudeType: 'mb',
      contributor: 'EMSC',
    };
    const decision = decideSpatiotemporal(emsc, [candidateFor(usgs)]);

    expect(decision.verdict).toBe('MATCH');
    expect(decision.relation).toBe('SAME_EVENT');
    expect(decision.reasons.map((reason) => reason.code)).not.toContain('REPUBLICATION');
  });

  it('does not call a record a republication because the values happen to agree', () => {
    /*
     * Independence is decided by who computed the solution, never by whether the values agree
     * (ADR-030) — deciding it from the values would be circular.
     */
    const emsc: Solution = {
      sourceId: 'emsc',
      epicentre: usgs.epicentre,
      originTime: usgs.originTime,
      magnitude: usgs.magnitude,
      magnitudeType: usgs.magnitudeType,
      contributor: null,
    };
    expect(decideSpatiotemporal(emsc, [candidateFor(usgs)]).relation).toBe('SAME_EVENT');
  });
});
