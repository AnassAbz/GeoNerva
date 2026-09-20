/**
 * Agreement, and the headline value.
 *
 * The tests that matter are the ones about *counting*: a copy agreeing with its original is not
 * corroboration, and the brief's own example got this wrong by reporting "Sources: 3" with a GDACS
 * republication among them. Everything else here is threshold arithmetic.
 */

import { describe, expect, it } from 'vitest';

import {
  AGREEMENT_THRESHOLDS,
  assessAgreement,
  chooseHeadlineMagnitude,
  type MemberSolution,
} from './index.ts';

const AT = { lat: 31.6295, lon: -7.9811 };

function member(overrides: Partial<MemberSolution> = {}): MemberSolution {
  return {
    sourceId: 'usgs',
    sourceRecordId: '1',
    relation: 'PRIMARY',
    epicentre: AT,
    magnitude: 5.0,
    magnitudeType: 'mww',
    depthKm: 10,
    providerStatus: 'reviewed',
    contributor: 'us',
    ...overrides,
  };
}

/** A point `km` north of `AT`, for building controlled location spreads. */
function north(km: number): { lat: number; lon: number } {
  // The shortest degree of latitude is 110.574 km, so this over-states the separation slightly —
  // which is the safe direction for a test that asserts a threshold is *not* exceeded.
  return { lat: AT.lat + km / 110.574, lon: AT.lon };
}

describe('counting sources', () => {
  it('does not count a derived copy as an independent source', () => {
    /*
     * The central rule. A USGS record and a GDACS copy of it are two linked records and **one**
     * independent source; "2 sources, they agree" manufactures corroboration out of a copy
     * agreeing with its original.
     */
    const result = assessAgreement([
      member({ sourceId: 'usgs', sourceRecordId: '1', relation: 'PRIMARY' }),
      member({ sourceId: 'gdacs', sourceRecordId: '2', relation: 'DERIVED_COPY' }),
    ]);
    expect(result.nSources).toBe(2);
    expect(result.nIndependentSources).toBe(1);
    expect(result.level).toBe('DERIVED_ONLY');
    expect(result.reasons[0]?.text).toContain('1 independent source');
  });

  it('reports a lone source as SINGLE_SOURCE, not DERIVED_ONLY', () => {
    // Different facts: "nobody else has reported this" and "the others are copies".
    const result = assessAgreement([member()]);
    expect(result.level).toBe('SINGLE_SOURCE');
    expect(result.nIndependentSources).toBe(1);
  });

  it('names the case where every member is a copy', () => {
    /*
     * Real: GDACS can arrive before USGS, and the identity reference resolves against an alias
     * GeoNerva already holds while the USGS record itself is not yet linked. Without a name, the
     * event would read as independently sourced.
     */
    const result = assessAgreement([
      member({ sourceId: 'gdacs', sourceRecordId: '2', relation: 'DERIVED_COPY' }),
    ]);
    expect(result.level).toBe('DERIVED_ONLY');
    expect(result.nIndependentSources).toBe(0);
  });

  it('counts two records from one source as one source', () => {
    const result = assessAgreement([
      member({ sourceId: 'usgs', sourceRecordId: '1' }),
      member({ sourceId: 'usgs', sourceRecordId: '2' }),
    ]);
    expect(result.nIndependentSources).toBe(1);
  });
});

describe('the agreement bands', () => {
  const pair = (overrides: Partial<MemberSolution>) => [
    member({ sourceId: 'usgs', sourceRecordId: '1' }),
    member({ sourceId: 'emsc', sourceRecordId: '2', contributor: 'EMSC', ...overrides }),
  ];

  it('compares at the precision the database stores, not at float precision', () => {
    /*
     * `5.0 + 0.2` is 5.2, and `5.2 - 5.0` is 0.20000000000000018 — greater than the 0.2 threshold.
     * Without rounding to the stored `numeric(_, 2)` precision, two sources whose stored
     * magnitudes differ by exactly the permitted amount are reported as *disagreeing*, which is a
     * boundary every real pair at that spread would hit.
     */
    expect(5.0 + AGREEMENT_THRESHOLDS.agree.magnitude - 5.0).toBeGreaterThan(
      AGREEMENT_THRESHOLDS.agree.magnitude,
    );
    const result = assessAgreement(pair({ magnitude: 5.0 + AGREEMENT_THRESHOLDS.agree.magnitude }));
    expect(result.deltaMagnitude).toBe(AGREEMENT_THRESHOLDS.agree.magnitude);
    expect(result.level).toBe('AGREE');
  });

  it('is AGREE inside every threshold', () => {
    const result = assessAgreement(
      pair({
        magnitude: 5.0 + AGREEMENT_THRESHOLDS.agree.magnitude,
        depthKm: 10 + AGREEMENT_THRESHOLDS.agree.depthKm,
        epicentre: north(AGREEMENT_THRESHOLDS.agree.locationKm - 0.5),
      }),
    );
    expect(result.level).toBe('AGREE');
  });

  it('falls to MINOR_DIFFERENCES when the magnitude spread passes the AGREE bound', () => {
    const result = assessAgreement(
      pair({ magnitude: 5.0 + AGREEMENT_THRESHOLDS.agree.magnitude + 0.1 }),
    );
    expect(result.level).toBe('MINOR_DIFFERENCES');
  });

  it('falls to CONFLICT when the magnitude spread passes the MINOR bound', () => {
    const result = assessAgreement(
      pair({ magnitude: 5.0 + AGREEMENT_THRESHOLDS.minor.magnitude + 0.1 }),
    );
    expect(result.level).toBe('CONFLICT');
    expect(result.reasons.map((r) => r.code)).toContain('SOURCES_DISAGREE');
  });

  it('falls to CONFLICT when the epicentres are far apart, whatever the magnitudes say', () => {
    const result = assessAgreement(
      pair({ epicentre: north(AGREEMENT_THRESHOLDS.minor.locationKm + 10) }),
    );
    expect(result.level).toBe('CONFLICT');
  });

  it('does not let a missing field fail a band', () => {
    /*
     * Two sources that both withheld depth have not *disagreed* about it. Treating a null spread
     * as a violation would report CONFLICT for an event whose sources agree on everything they
     * both published.
     */
    const result = assessAgreement(pair({ depthKm: null }));
    expect(result.deltaDepthKm).toBeNull();
    expect(result.level).toBe('AGREE');
  });

  it('measures the spread over independent members only', () => {
    /*
     * A republished stale magnitude must not register as a disagreement between sources. It is
     * one source disagreeing with an older version of itself, which is a revision, not a conflict.
     */
    const withCopy = assessAgreement([
      member({ sourceId: 'usgs', sourceRecordId: '1', magnitude: 5.0 }),
      member({ sourceId: 'emsc', sourceRecordId: '2', contributor: 'EMSC', magnitude: 5.1 }),
      member({
        sourceId: 'gdacs',
        sourceRecordId: '3',
        relation: 'DERIVED_COPY',
        magnitude: 3.2,
      }),
    ]);
    expect(withCopy.deltaMagnitude).toBeCloseTo(0.1, 10);
    expect(withCopy.level).toBe('AGREE');
  });
});

describe('the headline magnitude', () => {
  it('follows the documented precedence', () => {
    // USGS reviewed > EMSC > USGS automatic > derived copies.
    const members = [
      member({ sourceId: 'gdacs', sourceRecordId: '4', relation: 'DERIVED_COPY', magnitude: 5.9 }),
      member({
        sourceId: 'usgs',
        sourceRecordId: '3',
        providerStatus: 'automatic',
        magnitude: 5.8,
      }),
      member({ sourceId: 'emsc', sourceRecordId: '2', contributor: 'EMSC', magnitude: 5.1 }),
      member({ sourceId: 'usgs', sourceRecordId: '1', providerStatus: 'reviewed', magnitude: 5.3 }),
    ];
    expect(chooseHeadlineMagnitude(members)?.member.sourceRecordId).toBe('1');

    // Without the reviewed USGS solution, EMSC leads — above USGS automatic.
    expect(
      chooseHeadlineMagnitude(members.filter((m) => m.sourceRecordId !== '1'))?.member.sourceId,
    ).toBe('emsc');
  });

  it('prefers the Mw family at equal rank', () => {
    // Better-constrained measurement, and the tiebreak §6.1 names.
    const chosen = chooseHeadlineMagnitude([
      member({ sourceId: 'usgs', sourceRecordId: '1', magnitudeType: 'mb', magnitude: 5.0 }),
      member({ sourceId: 'usgs', sourceRecordId: '2', magnitudeType: 'mww', magnitude: 5.3 }),
    ]);
    expect(chosen?.member.sourceRecordId).toBe('2');
  });

  it('never averages, and never simply takes the highest', () => {
    /*
     * Both alternatives are biased in ways a reader cannot see: the highest inflates every
     * disagreement upward, and the mean of an Mw 5.3 and an mb 4.9 is not a measurement of
     * anything. The headline is a *chosen* value, and the UI says whose it is.
     */
    const chosen = chooseHeadlineMagnitude([
      member({ sourceId: 'usgs', sourceRecordId: '1', providerStatus: 'reviewed', magnitude: 5.0 }),
      member({ sourceId: 'emsc', sourceRecordId: '2', contributor: 'EMSC', magnitude: 6.4 }),
    ]);
    expect(chosen?.member.magnitude).toBe(5.0);
  });

  it('is stable when everything ties, rather than depending on row order', () => {
    const a = member({ sourceId: 'usgs', sourceRecordId: '7' });
    const b = member({ sourceId: 'usgs', sourceRecordId: '3' });
    expect(chooseHeadlineMagnitude([a, b])?.member.sourceRecordId).toBe('3');
    expect(chooseHeadlineMagnitude([b, a])?.member.sourceRecordId).toBe('3');
  });

  it('has no headline when no source published a magnitude', () => {
    expect(chooseHeadlineMagnitude([member({ magnitude: null })])).toBeNull();
  });
});
