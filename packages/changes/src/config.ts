/**
 * Every threshold the change engine uses, in one place (ARCHITECTURE §10.2–§10.4).
 *
 * These are data rather than conditionals scattered through a classifier, for the same reason the
 * relevance bands are: a reader must be able to put this file beside §10 of the document and
 * compare it line by line.
 *
 * ### Two weights the specification names without quantifying
 *
 * §10.4 gives the importance formula as
 * `base(type) + level_weight(max(level_A, level_B)) + delta_weight + recency_weight`, and it
 * quantifies only the first two. `DELTA_WEIGHT` and `RECENCY_WEIGHT` below are therefore
 * **defined here, not transcribed**, and they are deliberately small: the prominence bands
 * (HEADLINE ≥ 70, LISTED ≥ 40, DETAIL ≥ 15) are set against `base + level_weight` alone, so a
 * large unspecified term would move signals across band boundaries the document already fixed.
 * The largest either can contribute is 10, which cannot by itself promote a signal past a band it
 * would otherwise miss by more than 10. This gap is recorded in `docs/reviews/gate-g7.md`.
 */

import type { ChangeType, RelevanceLevel } from '@geonerva/domain';

/**
 * Materiality: what counts as a *revision* rather than noise (§10.2, `EVENT_UPDATED`).
 *
 * Providers restamp and re-solve constantly. Without these, "What Changed?" would fill with
 * hundredth-of-a-magnitude refinements and the section would stop being read — which is the same
 * failure as showing nothing, arrived at from the other direction.
 */
export const MATERIALITY = {
  /** |ΔM| ≥ 0.2 */
  magnitude: 0.2,
  /** Epicentre shift ≥ 10 km */
  epicentreKm: 10,
  /** Depth shift ≥ 15 km */
  depthKm: 15,
  /** Flood/cyclone area change ≥ 20 % */
  areaFraction: 0.2,
} as const;

/**
 * Activity change (§10.2): a band change, **or** `|Δ| ≥ max(abs_min, 50 % of before)`.
 *
 * Unreachable until `packages/baselines` exists — the metrics these compare are not computed yet.
 * The constants are transcribed anyway, so that the classifier is complete and the gap is a
 * missing *input* rather than a missing rule.
 */
export const ACTIVITY_ABS_MIN = {
  earthquakeCount: 3,
  fireClusters: 2,
  fireDetections: 20,
} as const;

export const ACTIVITY_RELATIVE_FRACTION = 0.5;

/** §10.4's `base(type)`, transcribed exactly. */
export const IMPORTANCE_BASE: Readonly<Record<ChangeType, number>> = {
  EVENT_ESCALATED: 30,
  NEW_EVENT: 25,
  SOURCE_STALE: 25,
  SOURCE_CONFLICT: 20,
  ABNORMAL_ACTIVITY: 20,
  ENTERED_AREA: 20,
  RELEVANCE_INCREASE: 15,
  EVENT_UPDATED: 10,
  ACTIVITY_INCREASE: 10,
  ACTIVITY_DECREASE: 10,
  EVENT_RESOLVED: 10,
  EVENT_DEESCALATED: 10,
  SOURCE_RECOVERED: 5,
  /*
   * `LEFT_AREA` and `RELEVANCE_DECREASE` are in the type enum and are not in §10.4's base table.
   * They are given their counterpart's weight — a subject leaving the area is the mirror of one
   * entering it, and a relevance decrease the mirror of an increase — rather than a guess, and
   * both are then held to at most DETAIL by the relevance gate when both states are LOW.
   */
  LEFT_AREA: 20,
  RELEVANCE_DECREASE: 15,
};

/** §10.4's `level_weight`, transcribed exactly. */
export const LEVEL_WEIGHT: Readonly<Record<RelevanceLevel, number>> = {
  CRITICAL: 50,
  HIGH: 35,
  MODERATE: 15,
  LOW: 0,
};

/**
 * The delta term, defined here (see the header).
 *
 * A revision that moved a value far past the materiality threshold matters more than one that
 * barely crossed it. Capped at 10 so it cannot reorder the bands §10.4 fixes.
 */
export const DELTA_WEIGHT = { max: 10, atMultipleOfThreshold: 5 } as const;

/**
 * The recency term, defined here (see the header).
 *
 * A change that happened an hour ago is more actionable than one from the far end of the window.
 * Linear across the window, capped at 10.
 */
export const RECENCY_WEIGHT = { max: 10 } as const;

/** §10.4's prominence bands, transcribed exactly. */
export const PROMINENCE_BANDS = { headline: 70, listed: 40, detail: 15 } as const;

/** §10.4: "HEADLINE ≥ 70 (max 3, ties by level then recency)". */
export const MAX_HEADLINE = 3;
