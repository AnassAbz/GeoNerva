/**
 * Earthquake correlation parameters (ARCHITECTURE §6.1).
 *
 * In one place, and named, because the document commits to calibrating them against a labelled
 * set and to versioning the algorithm that uses them. A threshold buried in a conditional cannot
 * be calibrated and cannot be reported.
 *
 * ### Where these numbers come from
 *
 * The unit scales — 16 s, 100 km, 0.8 magnitude — are the ones USGS's own PDL `DefaultAssociator`
 * uses to associate origins from different networks, and EMSC's EventID service uses a misfit of
 * the same *form* with (13 s, 105 km, 0.8). GeoNerva adopts the USGS triple. Whether ComCat's
 * production configuration overrides its own defaults is **unverified** (V9), so these are a
 * documented starting point rather than a claim about what ComCat does.
 *
 * The brief's original 120 s / 50 km / 0.5 is inverted and is not used: 120 s is far too loose in
 * time, because it lets an aftershock match its mainshock, and 50 km is too tight in space for
 * global solutions, which USGS itself says can be "10s of kilometers" off.
 *
 * ### What the labelled set says about them
 *
 * From `packages/test-fixtures/sources/correlation/eq-pairs.json` (250 pairs, 38 hand-checked):
 * true pairs reach **16.4 s / 135 km / ΔM 1.9**, while genuinely distinct events come as close as
 * **21 s / 30 km** — and 46 s / 34 km with *identical* magnitudes.
 *
 * So **no triple of thresholds separates the hardest cases**, and that is not a tuning problem to
 * be solved by moving a number: the distributions overlap. What carries the decision is the
 * **uniqueness gap** — being the best candidate by a clear margin — which is a statement about
 * competition rather than about absolute closeness. A threshold says "these two are close"; the
 * gap says "these two are closer to each other than to anything else", and only the second is
 * evidence of identity.
 */

/** Bumped whenever any value here, or the algorithm using it, changes. Stored on every link. */
export const EARTHQUAKE_ALGORITHM_VERSION = 'eq-corr-1';

/** Candidate generation, which must be indexable. Nothing outside this window is considered. */
export const CANDIDATE_WINDOW = {
  /** Seconds. Deliberately tight: 120 s lets an aftershock match its mainshock. */
  maxDeltaSeconds: 90,
  /** Metres. Global solutions can be tens of kilometres apart for the same earthquake. */
  maxDistanceMeters: 150_000,
} as const;

/** Misfit unit scales. A term of 1.0 means "one unit scale away". */
export const MISFIT_SCALES = {
  timeSeconds: 16,
  distanceMeters: 100_000,
  magnitude: 0.8,
} as const;

/**
 * Decision thresholds.
 *
 * `MATCH` needs both: close in absolute terms **and** clearly better than the runner-up. A
 * candidate that is close but tied with another is a `POSSIBLE_MATCH` — stored as a candidate,
 * never merged — because merging two events that might be one is unrecoverable in a way that
 * failing to merge them is not. A missed match shows as two events; a wrong match destroys the
 * distinction and then reports it as corroboration.
 */
export const DECISION = {
  /** Best misfit at or below this, with a clear gap, is a MATCH. */
  matchMisfit: 1.0,
  /** The runner-up must be at least this much worse. Below it, the answer is ambiguous. */
  uniquenessGap: 0.3,
  /** Best misfit at or below this, without a clear gap, is a POSSIBLE_MATCH. */
  possibleMisfit: 2.0,
} as const;

/**
 * Magnitude veto.
 *
 * Beyond this difference the two are not the same earthquake, whatever the time and distance say.
 * **Suspended when one source is republishing the other's solution**, because a republication can
 * carry a stale magnitude: the labelled set contains a true pair at Δt 0 s and 0 km with ΔM 1.3,
 * which is EMSC republishing an older USGS magnitude. Independence is decided by contributor
 * identity, never by value agreement (ADR-030) — so the veto is suspended on the basis of *who*
 * produced the solution, not on the basis of the values looking wrong.
 */
export const MAGNITUDE_VETO = 1.2;

/**
 * Revision hysteresis (ARCHITECTURE §6.1).
 *
 * A linked record whose new version still fits within this is kept linked. Re-deciding from
 * scratch on every revision would make links flap as solutions are refined, and a link that
 * appears and disappears is worse than a slightly stale one: "What Changed?" would fill with
 * merges and splits that no earthquake caused.
 */
export const HYSTERESIS_MISFIT = 1.5;

/** Confidence bounds for a MATCH. Never 1.0: a deterministic rule is still a judgement. */
export const CONFIDENCE_BOUNDS = { min: 0.5, max: 0.98 } as const;

/** Confidence for a Stage 1 identity match, where the provider stated the cross-reference. */
export const IDENTITY_REF_CONFIDENCE = 0.99;

/**
 * How long a GDACS cross-reference may stay unresolved before falling back to Stage 2.
 *
 * GDACS can publish before USGS has an alias GeoNerva has seen. Waiting is right; waiting forever
 * is not, because the fallback is the only thing that keeps the record from being orphaned.
 */
export const IDENTITY_REF_PENDING_HOURS = 24;

/**
 * Magnitude-type families.
 *
 * `Mw` from a moment tensor, `mb` from body waves and `ML` from local amplitudes measure different
 * things and are not strictly comparable; two sources reporting M5.3 Mw and M4.9 mb for one
 * earthquake are not disagreeing in the way the raw difference suggests. §6.1 therefore **halves**
 * the magnitude term when the families differ, rather than dropping it — the difference still
 * carries information, just less of it.
 *
 * `m` with no qualifier (EMSC uses it) is its own family: it is not a claim about method, so it
 * cannot be asserted to match or to differ from one.
 */
export const MAGNITUDE_FAMILIES: Readonly<Record<string, string>> = {
  mw: 'MW',
  mww: 'MW',
  mwr: 'MW',
  mwc: 'MW',
  mwb: 'MW',
  mwp: 'MW',
  ms: 'MS',
  mst: 'MS',
  ms20: 'MS',
  mb: 'MB',
  mb_lg: 'MB',
  mbl: 'MB',
  ml: 'ML',
  md: 'ML',
  mlv: 'ML',
  me: 'ME',
  m: 'UNSPECIFIED',
};

/** Halving factor applied to the magnitude term when the families differ. */
export const CROSS_FAMILY_MAGNITUDE_WEIGHT = 0.5;

/**
 * The agency codes that mean "this solution is that source's own".
 *
 * Independence is decided by *who computed the solution*, never by whether the values agree
 * (ADR-030) — and a provider names the computing agency in its own vocabulary, not in GeoNerva's.
 * EMSC credits a USGS solution to `NEIC`, which is the National Earthquake Information Center,
 * which *is* USGS's. GDACS credits the same solutions to `NEIC` too (DATA_SOURCES §2.4).
 *
 * So "the same contributor" is not a string comparison between the two records: it is the question
 * *is this record credited to the other source's own agency?* The labelled set contains exactly
 * that case and its note asks for exactly this rule — a hand-checked true pair at Δt 0 s / 0 km
 * where EMSC holds a NEIC-sourced M3.2 and USGS now says mb4.5, because EMSC kept an earlier NEIC
 * magnitude.
 *
 * Uppercase, compared case-insensitively. Codes are added when a provider is observed using one,
 * never speculatively: a wrong entry here suspends a safety check.
 */
export const SOURCE_AGENCY_CODES: Readonly<Record<string, readonly string[]>> = {
  usgs: ['US', 'NEIC', 'USGS'],
  emsc: ['EMSC', 'CSEM'],
};
