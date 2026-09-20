/**
 * The calibration run, asserted against the G5 targets.
 *
 * This is a test rather than a script because the targets are a commitment: precision ≥ 0.98 and
 * recall ≥ 0.95 against the labelled set, with the 4 ambiguous pairs excluded from the scores and
 * reported separately. If a threshold moves and the targets stop being met, this fails.
 */

import { describe, expect, it } from 'vitest';

import { readFixtureJson } from '@geonerva/test-fixtures';

import { calibrate, vetoStatistics, type LabelledSet } from './index.ts';

const SET = readFixtureJson('correlation', 'eq-pairs.json') as LabelledSet;

describe('the labelled set', () => {
  it('is the one the document describes', () => {
    // 250 pairs, 186 MATCH, 64 NO_MATCH, 4 ambiguous. Asserted so that a fixture swap is loud.
    expect(SET.pairs).toHaveLength(250);
    expect(SET.pairs.filter((p) => p.label === 'MATCH')).toHaveLength(186);
    expect(SET.pairs.filter((p) => p.label === 'NO_MATCH')).toHaveLength(64);
    expect(SET.pairs.filter((p) => p.ambiguous === true)).toHaveLength(4);
  });
});

describe('competitive calibration', () => {
  const result = calibrate(SET, 'competitive');

  it('meets the G5 precision target', () => {
    // A false positive is an unrecoverable merge of two distinct earthquakes, which is why the
    // precision bar is the higher of the two.
    expect(result.precision).toBeGreaterThanOrEqual(0.98);
  });

  it('meets the G5 recall target', () => {
    expect(result.recall).toBeGreaterThanOrEqual(0.95);
  });

  it('excludes the ambiguous pairs from the scores', () => {
    expect(result.ambiguousOutcomes).toHaveLength(4);
    expect(result.outcomes).toHaveLength(246);
  });
});

describe('pairwise calibration', () => {
  const result = calibrate(SET, 'pairwise');

  it('is reported too, because most events have a single candidate', () => {
    // Without competitors the gap is infinite, so this measures the absolute thresholds alone.
    expect(result.outcomes).toHaveLength(246);
    expect(result.precision).toBeGreaterThan(0);
  });
});

describe('the magnitude veto', () => {
  it('does not reject a true pair in this set', () => {
    /*
     * The veto is the one rule that can override geometry, so it must not fire on a real pair.
     * The document notes true pairs reaching ΔM 1.9 — above the 1.2 veto — which would be a
     * rejection unless those pairs are republications, where the veto is suspended.
     */
    const stats = vetoStatistics(SET);
    expect(stats.vetoedTruePairs).toBe(0);
  });
});
