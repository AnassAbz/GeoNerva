/**
 * Every threshold the baselines use, transcribed from ARCHITECTURE §8 with the sentence it comes
 * from. One table, so that a boundary test can be written at each value on both sides (TESTING
 * §2: "every rule table … must have a boundary test at each threshold on both sides") and so that
 * nothing is a magic number buried in a function.
 */

/** Bumped whenever a rule below or its implementation changes; carried on every metric. */
export const BASELINE_METHOD_VERSION = 'baselines-1';

export const EARTHQUAKE_BASELINE = {
  /** "radius `max(R, 300 km)`" for the Mc reference region. */
  mcReferenceRadiusKm: 300,
  /** "maximum-curvature method (+0.2 correction)". */
  mcCorrection: 0.2,
  /** Magnitude bin width for the frequency–magnitude histogram. */
  mcBinWidth: 0.1,
  /** "requires ≥ 50 events above the candidate Mc in the reference period". */
  mcMinimumEvents: 50,
  /** "fall back to Mc = 4.5, following the USGS global statement". */
  mcFallback: 4.5,
  /** "default 150 km, user-selectable 50/150/300". */
  radiiKm: [50, 150, 300] as const,
  defaultRadiusKm: 150,
  /** "W = 7 d is primary, 30 d secondary." */
  windowsDays: [7, 30] as const,
  primaryWindowDays: 7,
  /** "Reference period: 10 y". */
  referenceYears: 10,
  /** "`status = OK` needs ≥ 52 reference windows **and** ≥ 20 reference events." */
  minimumWindows: 52,
  minimumEvents: 20,
  /** "`ABOVE_TYPICAL` at ≥ p90 **and** observed ≥ 2." */
  abovePercentile: 90,
  aboveMinimumObserved: 2,
  /** "`WELL_ABOVE_TYPICAL` at ≥ p99 **and** observed ≥ 3." */
  wellAbovePercentile: 99,
  wellAboveMinimumObserved: 3,
  /** "`activity_ratio` … shown only when mean ≥ 1". */
  ratioMinimumMean: 1,
  /** "`largest_recent`: Largest M in the last 30 d". */
  largestRecentDays: 30,
  /** "a canonical event with M ≥ Mc + 1.5 … within R in the last 30 d". */
  sequenceMagnitudeAboveMc: 1.5,
  sequenceDays: 30,
} as const;

export const FIRE_TREND = {
  /** "within R = 100 km". */
  radiusKm: 100,
  /** "over the last 7 d vs the previous 28 d". */
  recentDays: 7,
  previousDays: 28,
  /** "differs … by ≥ 50 % **and** ≥ 10 detections/day absolute". */
  minimumRelativeChange: 0.5,
  minimumAbsolutePerDay: 10,
} as const;

export const GDACS_CONTEXT = {
  /** "within 300 km over the last 5 years". */
  radiusKm: 300,
  years: 5,
} as const;

/** §8.1: mandatory "whenever band ≥ ABOVE_TYPICAL". */
export const EARTHQUAKE_ELEVATED_CAVEAT =
  'Elevated recent activity does not by itself indicate that a larger earthquake will occur.';

/** §8.1 `sequence_context`: "a well-established observation, not a forecast". */
export const AFTERSHOCK_CAVEAT = 'Aftershocks commonly follow large earthquakes.';
