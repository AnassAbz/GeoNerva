/**
 * The correlation decision (ARCHITECTURE §6.1, stages 0–2).
 *
 * Deterministic, versioned and explainable, with no model anywhere near it. Given a record and
 * the canonical events it could belong to, this returns one of three answers and the reasons for
 * it — and the asymmetry between the answers is the point:
 *
 *  - **`MATCH`** merges two records into one event. Wrong, this is *unrecoverable*: the
 *    distinction between two earthquakes is destroyed, and the merged event then reports itself
 *    as corroborated by two sources, which is the single most expensive lie this system can tell.
 *  - **`POSSIBLE_MATCH`** stores a candidate and merges nothing. Wrong, the cost is two events
 *    where there was one — visible, fixable, and honest in the meantime.
 *  - **`NO_MATCH`** opens a new canonical event.
 *
 * So the bar for `MATCH` is deliberately high and has two independent parts: close in absolute
 * terms (`misfit ≤ 1.0`) **and** clearly better than the runner-up (`gap ≥ 0.3`). The second is
 * what actually carries the decision, because the labelled set proves the absolute distributions
 * overlap: true pairs reach 16.4 s / 135 km, and distinct events come as close as 21 s / 30 km.
 * Being *closest by a margin* is evidence of identity in a way that being *close* is not.
 */

import {
  CONFIDENCE_BOUNDS,
  DECISION,
  EARTHQUAKE_ALGORITHM_VERSION,
  HYSTERESIS_MISFIT,
  IDENTITY_REF_CONFIDENCE,
} from './earthquake.config.ts';
import { computeMisfit, magnitudeVeto, type MisfitTerms, type Solution } from './misfit.ts';

export type CorrelationVerdict = 'MATCH' | 'POSSIBLE_MATCH' | 'NO_MATCH';
export type MatchKind = 'IDENTITY_REF' | 'SPATIOTEMPORAL' | 'SEED';
export type LinkRelation = 'PRIMARY' | 'SAME_EVENT' | 'DERIVED_COPY';

export interface CorrelationReason {
  readonly code: string;
  readonly text: string;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
}

/** A canonical event this record might belong to, with the solution that represents it. */
export interface Candidate {
  /** `canonical_events.id`, as a decimal string. */
  readonly canonicalEventId: string;
  readonly representative: Solution;
  /** Source ids of the records already linked to it, for the same-source invariant. */
  readonly memberSourceIds: readonly string[];
}

export interface ScoredCandidate {
  readonly canonicalEventId: string;
  readonly terms: MisfitTerms;
  /** Excluded candidates keep their score, so the reason can say why they lost. */
  readonly excluded: null | 'SAME_SOURCE_ALREADY_PRESENT' | 'MAGNITUDE_INCOMPATIBLE';
}

export interface Decision {
  readonly verdict: CorrelationVerdict;
  readonly matchKind: MatchKind;
  readonly relation: LinkRelation;
  /** The event this record joins, or `null` for `NO_MATCH` and `POSSIBLE_MATCH`. */
  readonly canonicalEventId: string | null;
  readonly confidence: number | null;
  readonly reasons: readonly CorrelationReason[];
  /** Every candidate that was scored, best first. Stored, so a decision is auditable. */
  readonly scored: readonly ScoredCandidate[];
  readonly algorithmVersion: string;
}

function reason(
  code: string,
  text: string,
  params: Readonly<Record<string, string | number | boolean | null>> = {},
): CorrelationReason {
  return { code, text, params };
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * **Stage 1** — an explicit cross-reference the provider published.
 *
 * A GDACS earthquake carries `derived_from.ref`, which is a USGS event id. If that id is in the
 * USGS alias table, the two are the same earthquake *because GDACS said so* — this is an identity
 * match, not a fuzzy one, and it is why the confidence is 0.99 rather than something derived from
 * a misfit.
 *
 * The relation is `DERIVED_COPY`, which is the load-bearing part: it stops the copy being counted
 * as a second independent source (ADR-030). A GDACS earthquake agreeing with the USGS solution it
 * restates is not corroboration, and `Agreement` must never read it as such.
 */
export function decideIdentityRef(input: {
  readonly upstreamRef: string;
  readonly resolvedCanonicalEventId: string | null;
}): Decision {
  if (input.resolvedCanonicalEventId === null) {
    return {
      verdict: 'NO_MATCH',
      matchKind: 'IDENTITY_REF',
      relation: 'PRIMARY',
      canonicalEventId: null,
      confidence: null,
      reasons: [
        reason(
          'IDENTITY_REF_UNRESOLVED',
          `The provider references ${input.upstreamRef}, which GeoNerva has not yet ingested.`,
          { upstreamRef: input.upstreamRef },
        ),
      ],
      scored: [],
      algorithmVersion: EARTHQUAKE_ALGORITHM_VERSION,
    };
  }
  return {
    verdict: 'MATCH',
    matchKind: 'IDENTITY_REF',
    relation: 'DERIVED_COPY',
    canonicalEventId: input.resolvedCanonicalEventId,
    confidence: IDENTITY_REF_CONFIDENCE,
    reasons: [
      reason(
        'IDENTITY_REF_RESOLVED',
        `The provider states that this record describes ${input.upstreamRef}, which GeoNerva already holds.`,
        { upstreamRef: input.upstreamRef },
      ),
    ],
    scored: [],
    algorithmVersion: EARTHQUAKE_ALGORITHM_VERSION,
  };
}

/**
 * **Stage 2** — spatiotemporal matching between independent solutions.
 *
 * Candidates are assumed already narrowed by the indexable window; this scores them, applies the
 * two invariants that can eliminate one outright, and then decides on the best two.
 */
export function decideSpatiotemporal(record: Solution, candidates: readonly Candidate[]): Decision {
  /*
   * Score everything, including what will be eliminated.
   *
   * A candidate excluded by the same-source invariant still had a misfit, and storing it is what
   * lets the event page say "this looked like a match but ComCat had already decided they were
   * different events" instead of silently not mentioning it.
   */
  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    const terms = computeMisfit(record, candidate.representative);
    /*
     * **Stage 0's invariant, enforced here.** A canonical event never holds two active records
     * from the same source. ComCat and EMSC have each already decided that their own two records
     * are different earthquakes, and overriding that would collapse an aftershock sequence into a
     * single event — the exact failure the rule exists to prevent.
     */
    if (candidate.memberSourceIds.includes(record.sourceId)) {
      return {
        canonicalEventId: candidate.canonicalEventId,
        terms,
        excluded: 'SAME_SOURCE_ALREADY_PRESENT' as const,
      };
    }
    const veto = magnitudeVeto(record, candidate.representative, terms);
    if (veto.vetoed) {
      return {
        canonicalEventId: candidate.canonicalEventId,
        terms,
        excluded: 'MAGNITUDE_INCOMPATIBLE' as const,
      };
    }
    return { canonicalEventId: candidate.canonicalEventId, terms, excluded: null };
  });

  /*
   * Sorted by misfit, then by canonical event id as a tiebreak.
   *
   * The tiebreak is not cosmetic: two candidates with identical misfits would otherwise be
   * ordered by however the database returned them, and the decision — including which event a
   * record joins — would depend on row order. That is the determinism requirement (P6.6) reaching
   * back into correlation.
   */
  const eligible = scored
    .filter((candidate) => candidate.excluded === null)
    .sort((left, right) =>
      left.terms.misfit === right.terms.misfit
        ? left.canonicalEventId.localeCompare(right.canonicalEventId)
        : left.terms.misfit - right.terms.misfit,
    );
  const ordered = [...scored].sort((left, right) =>
    left.terms.misfit === right.terms.misfit
      ? left.canonicalEventId.localeCompare(right.canonicalEventId)
      : left.terms.misfit - right.terms.misfit,
  );

  const best = eligible[0];
  if (best === undefined) {
    const vetoed = scored.find((candidate) => candidate.excluded === 'MAGNITUDE_INCOMPATIBLE');
    const sameSource = scored.find(
      (candidate) => candidate.excluded === 'SAME_SOURCE_ALREADY_PRESENT',
    );
    const reasons: CorrelationReason[] = [];
    if (vetoed !== undefined) {
      reasons.push(
        reason(
          'MAGNITUDE_INCOMPATIBLE',
          `The magnitudes differ by ${round(vetoed.terms.deltaMagnitude ?? 0, 2)}, too much for one earthquake.`,
          { deltaMagnitude: round(vetoed.terms.deltaMagnitude ?? 0, 2) },
        ),
      );
    }
    if (sameSource !== undefined) {
      reasons.push(
        reason(
          'SAME_SOURCE_ALREADY_PRESENT',
          'The nearest event already holds a record from this source, which the provider has already decided is a different earthquake.',
          {},
        ),
      );
    }
    if (reasons.length === 0) {
      reasons.push(reason('NO_CANDIDATES', 'No existing event is close enough in time and space.'));
    }
    return {
      verdict: 'NO_MATCH',
      matchKind: 'SPATIOTEMPORAL',
      relation: 'PRIMARY',
      canonicalEventId: null,
      confidence: null,
      reasons,
      scored: ordered,
      algorithmVersion: EARTHQUAKE_ALGORITHM_VERSION,
    };
  }

  const runnerUp = eligible[1];
  const gap =
    runnerUp === undefined ? Number.POSITIVE_INFINITY : runnerUp.terms.misfit - best.terms.misfit;

  const measured = reason(
    'SPATIOTEMPORAL_MISFIT',
    `${round(best.terms.deltaSeconds, 2)} s apart, ${round(best.terms.distanceMeters / 1000, 1)} km apart` +
      (best.terms.deltaMagnitude === null
        ? ', magnitudes not comparable'
        : `, magnitudes within ${round(best.terms.deltaMagnitude, 2)}`) +
      '.',
    {
      deltaSeconds: round(best.terms.deltaSeconds, 2),
      distanceKm: round(best.terms.distanceMeters / 1000, 1),
      deltaMagnitude:
        best.terms.deltaMagnitude === null ? null : round(best.terms.deltaMagnitude, 2),
      misfit: round(best.terms.misfit, 3),
      magnitudeWeight: best.terms.magnitudeWeight,
    },
  );

  if (best.terms.misfit <= DECISION.matchMisfit && gap >= DECISION.uniquenessGap) {
    return {
      verdict: 'MATCH',
      matchKind: 'SPATIOTEMPORAL',
      relation: 'SAME_EVENT',
      canonicalEventId: best.canonicalEventId,
      confidence: confidenceFor(best.terms.misfit),
      reasons: [
        measured,
        reason(
          'UNIQUELY_BEST',
          runnerUp === undefined
            ? 'No other event was a plausible match.'
            : `The next closest event is ${round(gap, 2)} worse, which is a clear margin.`,
          { gap: Number.isFinite(gap) ? round(gap, 3) : null },
        ),
      ],
      scored: ordered,
      algorithmVersion: EARTHQUAKE_ALGORITHM_VERSION,
    };
  }

  if (best.terms.misfit <= DECISION.possibleMisfit) {
    /*
     * Close, but not decisively. Stored as a candidate and **not merged**.
     *
     * This is the branch that protects the product's central claim. Two events that might be one
     * are shown as two, with the candidate recorded, and a human or a later revision can resolve
     * it. Merging on a maybe would produce an event that reports itself as corroborated by two
     * independent sources when it may be two different earthquakes.
     */
    return {
      verdict: 'POSSIBLE_MATCH',
      matchKind: 'SPATIOTEMPORAL',
      relation: 'PRIMARY',
      canonicalEventId: null,
      confidence: null,
      reasons: [
        measured,
        gap < DECISION.uniquenessGap && runnerUp !== undefined
          ? reason(
              'AMBIGUOUS',
              `Two events fit almost equally well (within ${round(gap, 2)}), so they are kept separate.`,
              { gap: round(gap, 3) },
            )
          : reason(
              'NOT_CLOSE_ENOUGH',
              `The fit (${round(best.terms.misfit, 2)}) is not close enough to merge on.`,
              { misfit: round(best.terms.misfit, 3) },
            ),
      ],
      scored: ordered,
      algorithmVersion: EARTHQUAKE_ALGORITHM_VERSION,
    };
  }

  return {
    verdict: 'NO_MATCH',
    matchKind: 'SPATIOTEMPORAL',
    relation: 'PRIMARY',
    canonicalEventId: null,
    confidence: null,
    reasons: [
      measured,
      reason(
        'TOO_FAR',
        `The best fit (${round(best.terms.misfit, 2)}) is beyond the matching range.`,
        {
          misfit: round(best.terms.misfit, 3),
        },
      ),
    ],
    scored: ordered,
    algorithmVersion: EARTHQUAKE_ALGORITHM_VERSION,
  };
}

/**
 * Confidence for a `MATCH`.
 *
 * `clamp(1 − misfit/2, 0.5, 0.98)` — a monotone restatement of the misfit, not a probability, and
 * capped below 1.0 because a deterministic rule applied to imperfect inputs is still a judgement.
 */
export function confidenceFor(misfit: number): number {
  const raw = 1 - misfit / 2;
  return Math.min(CONFIDENCE_BOUNDS.max, Math.max(CONFIDENCE_BOUNDS.min, raw));
}

/**
 * Whether an existing link survives a revision (ARCHITECTURE §6.1).
 *
 * Hysteresis: a link is kept while the new misfit is within `HYSTERESIS_MISFIT`, which is looser
 * than the threshold that created it. Re-deciding from scratch on every revision would make links
 * flap as solutions are refined, and "What Changed?" would fill with merges and splits that no
 * earthquake caused.
 */
export function revisionKeepsLink(newMisfit: number): {
  readonly keep: boolean;
  readonly reason: CorrelationReason;
} {
  if (newMisfit <= HYSTERESIS_MISFIT) {
    return {
      keep: true,
      reason: reason(
        'REVISION_WITHIN_HYSTERESIS',
        `The revised solution still fits this event (${round(newMisfit, 2)}).`,
        { misfit: round(newMisfit, 3) },
      ),
    };
  }
  return {
    keep: false,
    reason: reason(
      'REVISION_BROKE_MATCH',
      `The revised solution no longer fits this event (${round(newMisfit, 2)}); it will be re-correlated.`,
      { misfit: round(newMisfit, 3) },
    ),
  };
}
