/**
 * Availability: whether a family's data may be *shown* at all.
 *
 * This is the single most load-bearing rule in the product, because it is the one that decides
 * whether GeoNerva says "nothing is happening here" or "we cannot tell you what is happening
 * here". Those two sentences look alike on a screen and mean opposite things, and a system that
 * confuses them is worse than no system: it converts an outage into reassurance.
 *
 * **An empty query result decides nothing.** Zero rows is the same answer for "no earthquakes
 * occurred", "the earthquake feed has been down for six hours", and "we have never had a source
 * that covers this place". Availability is therefore resolved from three inputs and never from
 * the row count alone:
 *
 *  1. **Coverage** — do we have *any* source for this place and family? A static property of the
 *     source set and the location, not of the data. Weather warnings in Morocco are
 *     `NOT_COVERED`: ECCC is Canada-only and NWS is US-only, and no amount of healthy polling
 *     changes that.
 *  2. **Health at `asOf`** — is the source that would have told us actually working? Derived from
 *     committed ingestion runs against the seeded freshness policy.
 *  3. **Whether anything was found** — which only ever distinguishes *shades of* `AVAILABLE`.
 *
 * ### The plan's vocabulary, and this one
 *
 * The session plan asks for `AVAILABLE_NO_ACTIVITY`, `AVAILABLE_WITH_ACTIVITY`, `PARTIAL`,
 * `UNAVAILABLE` and `UNKNOWN`, "or equivalent existing domain terminology". The existing
 * terminology is not a flat list of five, and it is deliberately richer:
 *
 * | Plan term | Here |
 * |---|---|
 * | `AVAILABLE_WITH_ACTIVITY` | `AVAILABLE` with a non-empty `items` |
 * | `AVAILABLE_NO_ACTIVITY` | `AVAILABLE` with an empty `items` — a *statement*, and the only case where zero may be rendered |
 * | `PARTIAL` | `CoverageLevel.PARTIAL`, which is a separate axis and always carries a note |
 * | `UNAVAILABLE` | `UNAVAILABLE` |
 * | `UNKNOWN` | `UNAVAILABLE` with the reason that says which — never a fourth value |
 *
 * Three axes rather than one enum, because they answer different questions and a place can be in
 * any combination of them: fully covered but stale, partially covered and healthy, covered and
 * healthy and quiet. Collapsing them would force the UI to reconstruct what was collapsed.
 *
 * `UNKNOWN` deliberately does **not** become its own availability value. Everything it would
 * cover — a source that has never succeeded, a source whose history was pruned, a knowledge time
 * before the source existed — is a case where GeoNerva cannot show data and must say why, which
 * is exactly `UNAVAILABLE` plus a reason. A fourth value would let a caller render "unknown"
 * without saying what is unknown, and every one of these has a specific answer.
 */

import {
  RELEVANCE_RANK,
  type CoverageLevel,
  type DataConfidenceLevel,
  type FamilyAvailability,
  type RelevanceLevel,
  type SourceHealthStatus,
} from '@geonerva/domain';

/**
 * Health statuses that cannot support a claim about the world.
 *
 * `STALE` and `UNAVAILABLE`. `DEGRADED` can: it means the last poll is older than the policy
 * would like but inside its stale threshold, and refusing to show a 20-minute-old earthquake
 * catalogue because the next poll is a few minutes late would make the product unusable for a
 * reason the user does not care about. The lateness is still reported — it reaches
 * `dataConfidence` and the card's caveats — so nothing is hidden; it is graded rather than
 * withheld.
 */
const CANNOT_SUPPORT_A_CLAIM: ReadonlySet<SourceHealthStatus> = new Set<SourceHealthStatus>([
  'STALE',
  'UNAVAILABLE',
]);

/** Why a family is not `AVAILABLE`, or why an `AVAILABLE` one is qualified. */
export const AVAILABILITY_REASONS = [
  /** No source covers this place for this family. */
  'NOT_COVERED_HERE',
  /** Sources exist for this place, but every one of them is STALE or UNAVAILABLE at `asOf`. */
  'ALL_SOURCES_UNUSABLE',
  /** Some of the sources for this family are unusable; the rest answered. */
  'SOME_SOURCES_UNUSABLE',
  /** A source exists and is covered, but has never produced a successful run we can see. */
  'NEVER_SUCCEEDED',
  /** The family is covered and healthy, and there is genuinely nothing to report. */
  'NOTHING_TO_REPORT',
  /** Coverage here is incomplete in a way that changes what an absence means. */
  'PARTIAL_COVERAGE',
  /** Everything is fine and something was found. */
  'OK',
] as const;
export type AvailabilityReason = (typeof AVAILABILITY_REASONS)[number];

/** One source's contribution to a family, as availability needs to see it. */
export interface SourceAvailabilityInput {
  readonly sourceId: string;
  readonly productId: number | null;
  readonly status: SourceHealthStatus;
  /** False when no successful run is visible at `asOf`. */
  readonly hasEverSucceeded: boolean;
}

export interface AvailabilityInput {
  readonly coverage: CoverageLevel;
  /** Every source that feeds this family *for this place*. Empty means nothing covers it. */
  readonly sources: readonly SourceAvailabilityInput[];
  /** How many items the as-of read returned. Never the sole input — see the header. */
  readonly itemCount: number;
}

export interface AvailabilityVerdict {
  readonly availability: FamilyAvailability;
  readonly reason: AvailabilityReason;
  /**
   * Whether a count of zero may be shown to a user.
   *
   * True only when the family is `AVAILABLE` and the sources behind it are usable — that is, when
   * "nothing" is something GeoNerva actually observed. Invariant I11 in one boolean, so that a
   * caller cannot render "0 earthquakes" for a place whose earthquake feed is down by forgetting
   * to check `availability` first.
   */
  readonly mayRenderZero: boolean;
  /** Sources that could not contribute, so a caveat can name them. */
  readonly unusableSources: readonly string[];
}

/**
 * Resolves availability for one family at one place and knowledge time.
 *
 * Order matters and is not arbitrary: coverage is checked before health, because a place with no
 * source cannot have a *stale* one, and reporting "the feed is down" for weather warnings in
 * Morocco would be describing a feed that was never going to cover it.
 */
export function resolveAvailability(input: AvailabilityInput): AvailabilityVerdict {
  const unusableSources = input.sources
    .filter((source) => CANNOT_SUPPORT_A_CLAIM.has(source.status) || !source.hasEverSucceeded)
    .map((source) =>
      source.productId === null
        ? source.sourceId
        : `${source.sourceId}/${String(source.productId)}`,
    );

  /*
   * No source at all, or an explicit `NOT_COVERED`.
   *
   * `sources.length === 0` is checked as well as the coverage level because they can disagree and
   * the stricter answer is the honest one: a coverage table that says `COVERED` while no source
   * is configured is a misconfiguration, and the user must not be shown "nothing is happening"
   * on the strength of it.
   */
  if (input.coverage === 'NOT_COVERED' || input.sources.length === 0) {
    return {
      availability: 'NOT_COVERED',
      reason: 'NOT_COVERED_HERE',
      mayRenderZero: false,
      unusableSources,
    };
  }

  const usable = input.sources.filter(
    (source) => !CANNOT_SUPPORT_A_CLAIM.has(source.status) && source.hasEverSucceeded,
  );

  if (usable.length === 0) {
    /*
     * Every source is unusable. Which *kind* of unusable is worth distinguishing, because the two
     * sentences a reader needs are different: "we have never managed to read this" is a
     * configuration or launch problem, and "this stopped working" is an outage.
     */
    const neverAny = input.sources.every((source) => !source.hasEverSucceeded);
    return {
      availability: 'UNAVAILABLE',
      reason: neverAny ? 'NEVER_SUCCEEDED' : 'ALL_SOURCES_UNUSABLE',
      mayRenderZero: false,
      unusableSources,
    };
  }

  /*
   * At least one source answered, so data may be shown. What is left is *which* qualified kind of
   * available this is — and every one of these still permits a zero, because a usable source
   * reporting nothing is an observation.
   */
  if (unusableSources.length > 0) {
    return {
      availability: 'AVAILABLE',
      reason: 'SOME_SOURCES_UNUSABLE',
      /*
       * Zero is still renderable, and the caveat is what makes it honest.
       *
       * With two earthquake sources and one down, the surviving one genuinely observed no
       * earthquakes. Refusing to say so would hide a real observation; saying it without naming
       * the missing source would overstate it. So the count stands and `unusableSources` travels
       * with it.
       */
      mayRenderZero: true,
      unusableSources,
    };
  }

  if (input.coverage === 'PARTIAL') {
    return {
      availability: 'AVAILABLE',
      reason: 'PARTIAL_COVERAGE',
      mayRenderZero: true,
      unusableSources,
    };
  }

  return {
    availability: 'AVAILABLE',
    reason: input.itemCount === 0 ? 'NOTHING_TO_REPORT' : 'OK',
    mayRenderZero: true,
    unusableSources,
  };
}

/**
 * Confidence in the data behind a family card. Never a percentage (ARCHITECTURE §9.7).
 *
 * A grade, not a score, because there is no defensible arithmetic that turns "one source, 40
 * minutes late, partial coverage" into a number — and a number invites comparison between cards
 * that were graded on different evidence. Three levels the UI can style and a human can read.
 *
 * The inputs are the ones that actually change how much a reader should trust the card, and each
 * is a fact GeoNerva holds rather than a judgement it makes.
 */
export interface DataConfidenceInput {
  readonly coverage: CoverageLevel;
  readonly sources: readonly SourceAvailabilityInput[];
  /** True when at least two *independent* sources describe the same item (ADR-030). */
  readonly corroborated: boolean;
}

export function resolveDataConfidence(input: DataConfidenceInput): DataConfidenceLevel {
  const usable = input.sources.filter(
    (source) => !CANNOT_SUPPORT_A_CLAIM.has(source.status) && source.hasEverSucceeded,
  );
  if (usable.length === 0) return 'LOW';

  const anyDegraded = usable.some((source) => source.status === 'DEGRADED');
  const anyUnusable = usable.length < input.sources.length;

  /*
   * `HIGH` requires everything to be true at once: full coverage, every source fresh, and more
   * than one independent source agreeing. That is a deliberately high bar — it is the grade that
   * says "you can act on this" — and for most places and families it will not be met, which is
   * the honest outcome rather than a disappointing one.
   */
  if (input.coverage === 'COVERED' && !anyDegraded && !anyUnusable && input.corroborated) {
    return 'HIGH';
  }

  /*
   * `LOW` when the *coverage* is partial or a source is missing, because those change what an
   * absence means. A merely late source is `MEDIUM`: the data it already delivered is as good as
   * it ever was, and only its recency is in question.
   */
  if (input.coverage === 'PARTIAL' || anyUnusable) return 'LOW';
  return 'MEDIUM';
}

/** The highest relevance in a set, or `null` for an empty one. `max()` over a ranked enum. */
export function highestRelevance(levels: readonly RelevanceLevel[]): RelevanceLevel | null {
  let best: RelevanceLevel | null = null;
  for (const level of levels) {
    if (best === null || RELEVANCE_RANK[level] > RELEVANCE_RANK[best]) best = level;
  }
  return best;
}
