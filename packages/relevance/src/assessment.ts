/**
 * The shape every relevance model produces, and the two operations they share.
 *
 * Deliberately *not* `RelevanceAssessment` from `@geonerva/domain`, and the difference is the
 * whole point: that type carries `authoritativeBasis` and `evidenceIds`, which a pure function
 * over a magnitude and a distance cannot know. A model here reports whether the *condition* for
 * `CRITICAL` is met; the caller, which holds the source name, the verbatim statement and the
 * evidence id, assembles the basis and completes the domain type.
 *
 * That split is what enforces invariant I10 — `CRITICAL` if and only if there is an authoritative
 * basis — structurally rather than by convention. A model cannot emit a `CRITICAL` with nothing
 * behind it, because it cannot emit a basis at all, and a caller that cannot produce one must
 * not promote the level.
 */

import { RELEVANCE_RANK, type RelevanceLevel } from '@geonerva/domain';

/** One stated reason. Mirrors `domain`'s `Reason` minus the evidence ids the caller attaches. */
export interface Reason {
  readonly code: string;
  /** A complete sentence, because it is rendered as one. */
  readonly text: string;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
}

export interface Assessment {
  readonly level: RelevanceLevel;
  /**
   * True only when `level` is `CRITICAL`.
   *
   * The caller must attach an `AuthoritativeBasis` or reduce the level. There is no third option:
   * a `CRITICAL` without a citation is the one thing invariant I10 forbids outright.
   */
  readonly requiresAuthoritativeBasis: boolean;
  readonly reasons: readonly Reason[];
  /** Mandatory qualifications. Always rendered, never summarized away. */
  readonly caveats: readonly string[];
  readonly modelVersion: string;
}

export function reason(
  code: string,
  text: string,
  params: Readonly<Record<string, string | number | boolean | null>>,
): Reason {
  return { code, text, params };
}

/** Ordered lowest to highest, so a rank is an index. */
const ASCENDING: readonly RelevanceLevel[] = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];

/**
 * One level down, with `LOW` as the floor.
 *
 * A demotion cannot remove an item: "less attention" is not "no attention", and an event that
 * reached a band at all is inside the search radius and therefore worth listing. Dropping it
 * would turn a modifier into a filter, and the user would never learn it existed.
 */
export function demote(level: RelevanceLevel): RelevanceLevel {
  const rank = RELEVANCE_RANK[level];
  return ASCENDING[Math.max(0, rank - 1)] ?? 'LOW';
}

/** One level up, with `HIGH` as the ceiling for anything GeoNerva decides for itself. */
export function promoteWithinHeuristics(level: RelevanceLevel): RelevanceLevel {
  const rank = RELEVANCE_RANK[level];
  // Capped at HIGH on purpose: CRITICAL is reachable only through an authoritative basis, so a
  // heuristic promotion must never be able to reach it (invariant I10).
  return ASCENDING[Math.min(RELEVANCE_RANK.HIGH, rank + 1)] ?? level;
}
