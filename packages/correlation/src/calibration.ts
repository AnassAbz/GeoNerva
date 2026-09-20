/**
 * Calibration against the labelled set (ARCHITECTURE §6.1, docs/TESTING.md).
 *
 * `packages/test-fixtures/sources/correlation/eq-pairs.json` holds 250 USGS↔EMSC pairs, 186
 * labelled `MATCH` and 64 `NO_MATCH`, built from EMSC's EventID service with 38 hand-checked and
 * 4 marked `ambiguous`. The G5 targets are **precision ≥ 0.98** and **recall ≥ 0.95**, with the
 * ambiguous pairs reported separately.
 *
 * ### Two honesty notes about what this can and cannot measure
 *
 * **The ground truth is fallible.** Hand-checking found 2 errors in the reviewed subset, so the
 * EventID service is about 99 % precise — usable as ground truth, not an oracle. A disagreement
 * with it is evidence, not proof, and the calibration report names the disagreements rather than
 * only counting them.
 *
 * **A pair is not a decision.** The algorithm's `MATCH` needs a *uniqueness gap*, which requires
 * competing candidates, and a bare pair has none. So this evaluates in two modes:
 *
 *  - **pairwise** — misfit and veto only, with the gap treated as infinite. This measures the
 *    absolute thresholds.
 *  - **competitive** — pairs grouped by USGS event, so an event appearing in several pairs
 *    supplies its own alternatives and the gap rule is exercised. 53 of the 190 USGS events in
 *    the set have more than one candidate, which is where the hard cases live.
 *
 * Reporting only the pairwise number would overstate what has been verified; reporting only the
 * competitive one would ignore the 137 events that have a single candidate. Both are reported.
 */

import { DECISION, MAGNITUDE_VETO } from './earthquake.config.ts';
import { computeMisfit, magnitudeVeto, type Solution } from './misfit.ts';

/** One labelled pair, as the fixture stores it. */
export interface LabelledPair {
  readonly pair_id: string;
  readonly usgs: {
    readonly id: string;
    readonly time: string;
    readonly lat: number;
    readonly lon: number;
    readonly depth_km: number | null;
    readonly mag: number | null;
    readonly magType: string | null;
  };
  readonly emsc: {
    readonly unid: string;
    readonly time: string;
    readonly lat: number;
    readonly lon: number;
    readonly depth_km: number | null;
    readonly mag: number | null;
    readonly magType: string | null;
    readonly auth: string | null;
  };
  readonly label: 'MATCH' | 'NO_MATCH';
  readonly label_source: string;
  readonly subset: string;
  readonly notes: string;
  readonly ambiguous?: boolean;
}

export interface LabelledSet {
  readonly pairs: readonly LabelledPair[];
}

/** USGS is the record being correlated; EMSC is the existing canonical event's representative. */
function solutionsFor(pair: LabelledPair): { record: Solution; candidate: Solution } {
  return {
    record: {
      sourceId: 'usgs',
      epicentre: { lat: pair.usgs.lat, lon: pair.usgs.lon },
      originTime: new Date(pair.usgs.time),
      magnitude: pair.usgs.mag,
      magnitudeType: pair.usgs.magType,
      // The fixture does not carry USGS `net`, and inventing one would fabricate the very field
      // that decides independence. Absent means "not known to be a republication", which is the
      // conservative reading: the veto stays active.
      contributor: null,
    },
    candidate: {
      sourceId: 'emsc',
      epicentre: { lat: pair.emsc.lat, lon: pair.emsc.lon },
      originTime: new Date(pair.emsc.time),
      magnitude: pair.emsc.mag,
      magnitudeType: pair.emsc.magType,
      contributor: pair.emsc.auth,
    },
  };
}

export interface PairOutcome {
  readonly pairId: string;
  readonly label: 'MATCH' | 'NO_MATCH';
  readonly predicted: 'MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH';
  readonly misfit: number;
  readonly deltaSeconds: number;
  readonly distanceKm: number;
  readonly deltaMagnitude: number | null;
  readonly vetoed: boolean;
  readonly gap: number;
  readonly ambiguous: boolean;
  readonly labelSource: string;
  readonly subset: string;
}

export interface CalibrationResult {
  readonly mode: 'pairwise' | 'competitive';
  readonly outcomes: readonly PairOutcome[];
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  /** `POSSIBLE_MATCH` on a pair labelled `MATCH`: not a merge, so not a true positive either. */
  readonly possibleOnMatch: number;
  readonly possibleOnNoMatch: number;
  readonly precision: number;
  readonly recall: number;
  /** Pairs the fixture marks `ambiguous`, excluded from the scores and reported separately. */
  readonly ambiguousOutcomes: readonly PairOutcome[];
}

/**
 * Scores a pair.
 *
 * `gap` is supplied by the caller: `Infinity` in pairwise mode, and the real margin to the
 * runner-up in competitive mode. Only `MATCH` counts as a positive prediction — a
 * `POSSIBLE_MATCH` merges nothing, so counting it as a hit would score the algorithm for a merge
 * it deliberately refused to make.
 */
export function scorePair(pair: LabelledPair, gap: number): PairOutcome {
  const { record, candidate } = solutionsFor(pair);
  const terms = computeMisfit(record, candidate);
  const veto = magnitudeVeto(record, candidate, terms);

  let predicted: PairOutcome['predicted'];
  if (veto.vetoed) {
    predicted = 'NO_MATCH';
  } else if (terms.misfit <= DECISION.matchMisfit && gap >= DECISION.uniquenessGap) {
    predicted = 'MATCH';
  } else if (terms.misfit <= DECISION.possibleMisfit) {
    predicted = 'POSSIBLE_MATCH';
  } else {
    predicted = 'NO_MATCH';
  }

  return {
    pairId: pair.pair_id,
    label: pair.label,
    predicted,
    misfit: terms.misfit,
    deltaSeconds: terms.deltaSeconds,
    distanceKm: terms.distanceMeters / 1000,
    deltaMagnitude: terms.deltaMagnitude,
    vetoed: veto.vetoed,
    gap,
    ambiguous: pair.ambiguous === true,
    labelSource: pair.label_source,
    subset: pair.subset,
  };
}

/**
 * Runs the calibration.
 *
 * In competitive mode, pairs are grouped by USGS event id and each group's members compete: the
 * gap for a pair is its misfit's distance to the best *other* candidate for the same USGS event.
 * A group of one has no competitor, so its gap is infinite — which is the truthful statement that
 * nothing else was in the running, not a shortcut.
 */
export function calibrate(set: LabelledSet, mode: 'pairwise' | 'competitive'): CalibrationResult {
  const gaps = new Map<string, number>();

  if (mode === 'competitive') {
    const byUsgsEvent = new Map<string, LabelledPair[]>();
    for (const pair of set.pairs) {
      const group = byUsgsEvent.get(pair.usgs.id);
      if (group === undefined) byUsgsEvent.set(pair.usgs.id, [pair]);
      else group.push(pair);
    }
    for (const group of byUsgsEvent.values()) {
      const scored = group.map((pair) => {
        const { record, candidate } = solutionsFor(pair);
        const terms = computeMisfit(record, candidate);
        const veto = magnitudeVeto(record, candidate, terms);
        return { pair, misfit: terms.misfit, eligible: !veto.vetoed };
      });
      // Only eligible candidates compete: a vetoed one is not in the running, so it cannot be the
      // runner-up that makes a real match look ambiguous.
      const eligible = scored.filter((entry) => entry.eligible).sort((a, b) => a.misfit - b.misfit);
      for (const entry of scored) {
        const others = eligible.filter((other) => other.pair.pair_id !== entry.pair.pair_id);
        const bestOther = others[0];
        gaps.set(
          entry.pair.pair_id,
          bestOther === undefined ? Number.POSITIVE_INFINITY : bestOther.misfit - entry.misfit,
        );
      }
    }
  }

  const all = set.pairs.map((pair) =>
    scorePair(
      pair,
      mode === 'pairwise'
        ? Number.POSITIVE_INFINITY
        : (gaps.get(pair.pair_id) ?? Number.POSITIVE_INFINITY),
    ),
  );
  const ambiguousOutcomes = all.filter((outcome) => outcome.ambiguous);
  const outcomes = all.filter((outcome) => !outcome.ambiguous);

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let possibleOnMatch = 0;
  let possibleOnNoMatch = 0;

  for (const outcome of outcomes) {
    if (outcome.predicted === 'MATCH') {
      if (outcome.label === 'MATCH') truePositives += 1;
      else falsePositives += 1;
      continue;
    }
    if (outcome.predicted === 'POSSIBLE_MATCH') {
      if (outcome.label === 'MATCH') possibleOnMatch += 1;
      else possibleOnNoMatch += 1;
    }
    /*
     * Anything that is not a MATCH is, for scoring, a non-merge. A `POSSIBLE_MATCH` on a true pair
     * is therefore a false negative — the algorithm did not merge what it should have — and it is
     * *also* counted separately, because "kept apart pending evidence" is a materially different
     * outcome from "declared different" and the report should not blur them.
     */
    if (outcome.label === 'MATCH') falseNegatives += 1;
    else trueNegatives += 1;
  }

  const predictedPositives = truePositives + falsePositives;
  const actualPositives = truePositives + falseNegatives;

  return {
    mode,
    outcomes,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    possibleOnMatch,
    possibleOnNoMatch,
    // An undefined ratio is reported as 0 rather than NaN, so a report cannot print "NaN" at
    // somebody; the counts beside it say why.
    precision: predictedPositives === 0 ? 0 : truePositives / predictedPositives,
    recall: actualPositives === 0 ? 0 : truePositives / actualPositives,
    ambiguousOutcomes,
  };
}

/** The magnitude veto's reach over the labelled set, for the report. */
export function vetoStatistics(set: LabelledSet): {
  readonly vetoedTruePairs: number;
  readonly vetoedDistinctPairs: number;
  readonly maxDeltaMagnitudeAmongTruePairs: number;
} {
  let vetoedTruePairs = 0;
  let vetoedDistinctPairs = 0;
  let maxDeltaMagnitudeAmongTruePairs = 0;
  for (const pair of set.pairs) {
    const { record, candidate } = solutionsFor(pair);
    const terms = computeMisfit(record, candidate);
    const veto = magnitudeVeto(record, candidate, terms);
    if (pair.label === 'MATCH' && terms.deltaMagnitude !== null) {
      maxDeltaMagnitudeAmongTruePairs = Math.max(
        maxDeltaMagnitudeAmongTruePairs,
        terms.deltaMagnitude,
      );
    }
    if (!veto.vetoed) continue;
    if (pair.label === 'MATCH') vetoedTruePairs += 1;
    else vetoedDistinctPairs += 1;
  }
  return { vetoedTruePairs, vetoedDistinctPairs, maxDeltaMagnitudeAmongTruePairs };
}

export { MAGNITUDE_VETO };
