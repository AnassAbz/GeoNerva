/**
 * `EQ_COUNT` — how many earthquakes of M ≥ Mc there have been within R km in the trailing window,
 * against every comparable window in the reference period (ARCHITECTURE §8.1).
 *
 * The rules, each from §8.1:
 *
 *  - **Status.** `OK` needs ≥ 52 reference windows **and** ≥ 20 reference events. With the windows
 *    but not the events the answer is `RARE_ACTIVITY` and a rarity statement, which "is often the
 *    most useful context there is". Otherwise `INSUFFICIENT_HISTORY`, and never the word "normal".
 *  - **Band.** `ABOVE_TYPICAL` at the 90th percentile **and** at least two events;
 *    `WELL_ABOVE_TYPICAL` at the 99th **and** at least three. The percentile is the mid-rank one
 *    this metric reports, so the band and the number shown beside it cannot disagree. There is no
 *    `BELOW_TYPICAL`: a quiet period is not a reportable signal.
 *  - **Ratio.** Only when the reference mean is at least one event per window, so a mean of 0.1
 *    cannot produce "30× the baseline" from three events.
 *
 * Pure: the caller reads the catalog as of a knowledge time and hands it over.
 */

import {
  AFTERSHOCK_CAVEAT,
  BASELINE_METHOD_VERSION,
  EARTHQUAKE_BASELINE,
  EARTHQUAKE_ELEVATED_CAVEAT,
} from './config.ts';
import { RETENTION_FLOOR_MAGNITUDE, type Completeness } from './completeness.ts';
import { countPerWindow, mean, midRankPercentile, quantile } from './statistics.ts';

export type BaselineStatus = 'OK' | 'RARE_ACTIVITY' | 'INSUFFICIENT_HISTORY';
export type EarthquakeBand = 'TYPICAL' | 'ABOVE_TYPICAL' | 'WELL_ABOVE_TYPICAL';

/** One canonical earthquake, reduced to what the baseline reads. */
export interface QuakeRecord {
  readonly observedAt: Date;
  /** The event's preferred (headline) magnitude, or `null` when no source gave one. */
  readonly magnitude: number | null;
  readonly distanceKm: number;
  readonly publicId: string;
}

export interface EarthquakeCountInput {
  readonly asOf: Date;
  readonly radiusKm: number;
  readonly windowDays: number;
  /** Where the reference period starts: the older of the catalog's own start and ten years. */
  readonly referenceFrom: Date;
  readonly completeness: Completeness;
  /** Every event within the radius, current window and reference period together. */
  readonly events: readonly QuakeRecord[];
}

export interface EarthquakeCountReference {
  readonly nWindows: number;
  readonly nEvents: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly mean: number;
  /** Only when `mean` ≥ 1. */
  readonly activityRatio: number | null;
}

export interface EarthquakeCountResult {
  readonly methodVersion: string;
  readonly status: BaselineStatus;
  readonly observed: number;
  readonly threshold: number;
  readonly nWindows: number;
  readonly nEvents: number;
  readonly reference: EarthquakeCountReference | null;
  readonly percentile: number | null;
  readonly band: EarthquakeBand | null;
  readonly interpretation: string;
  readonly completenessStatement: string;
  readonly caveats: readonly string[];
  readonly rarity: {
    readonly nEvents: number;
    readonly sinceYear: number;
    readonly text: string;
  } | null;
  readonly largestRecent: {
    readonly magnitude: number;
    readonly observedAt: Date;
    readonly publicId: string;
    readonly comparisonSince: Date;
    readonly text: string;
  } | null;
  readonly sequenceContext: {
    readonly magnitude: number;
    readonly observedAt: Date;
    readonly publicId: string;
    readonly text: string;
    readonly caveat: string;
  } | null;
  /** The counts the chart draws: the most recent reference windows, oldest first, then the current. */
  readonly series: readonly { readonly start: Date; readonly count: number }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Windows shown in the chart; the distribution still uses every one. */
const SERIES_WINDOWS = 52;

export function earthquakeCountBaseline(input: EarthquakeCountInput): EarthquakeCountResult {
  const config = EARTHQUAKE_BASELINE;
  const threshold = input.completeness.threshold;
  const windowMs = input.windowDays * DAY_MS;
  const currentStart = new Date(input.asOf.getTime() - windowMs);

  const counted = input.events.filter(
    (event) =>
      event.magnitude !== null &&
      event.magnitude >= threshold &&
      event.distanceKm <= input.radiusKm &&
      event.observedAt.getTime() <= input.asOf.getTime(),
  );
  const times = counted.map((event) => event.observedAt);

  // `[currentStart, asOf]`: reference windows are half-open `[start, end)`, so the instant that
  // ends window 0 begins the current one. With `>` an event at exactly that instant was counted in
  // neither (P8 review).
  const observed = times.filter((time) => time.getTime() >= currentStart.getTime()).length;
  const nWindows = Math.max(
    0,
    Math.floor((currentStart.getTime() - input.referenceFrom.getTime()) / windowMs),
  );
  const counts =
    nWindows === 0
      ? []
      : countPerWindow(times, {
          end: currentStart,
          windowDays: input.windowDays,
          windows: nWindows,
        });
  const nEvents = counts.reduce((total, count) => total + count, 0);

  const status: BaselineStatus =
    nWindows >= config.minimumWindows && nEvents >= config.minimumEvents
      ? 'OK'
      : nWindows >= config.minimumWindows
        ? 'RARE_ACTIVITY'
        : 'INSUFFICIENT_HISTORY';

  const label = magnitudeLabel(threshold);
  const sinceYear = input.referenceFrom.getUTCFullYear();
  const completenessStatement = completenessSentence(input.completeness);

  let reference: EarthquakeCountReference | null = null;
  let percentile: number | null = null;
  let band: EarthquakeBand | null = null;
  let interpretation: string;
  let rarity: EarthquakeCountResult['rarity'] = null;

  if (status === 'OK') {
    const average = mean(counts);
    reference = {
      nWindows,
      nEvents,
      p25: quantile(counts, 25),
      median: quantile(counts, 50),
      p75: quantile(counts, 75),
      p90: quantile(counts, 90),
      p95: quantile(counts, 95),
      mean: average,
      activityRatio: average >= config.ratioMinimumMean ? observed / average : null,
    };
    percentile = midRankPercentile(observed, counts);
    /*
     * Each band needs its percentile to be resolvable by the sample it is drawn from, not only
     * met by it (ADR-043). Over 59 windows the 99th percentile is an extrapolation — the finest
     * quantile 59 observations resolve is about the 98th — so the band is capped one step down
     * rather than claimed. The count is still high against the periods GeoNerva holds, which is
     * what the remaining band says.
     */
    const wellAbove =
      percentile >= config.wellAbovePercentile &&
      observed >= config.wellAboveMinimumObserved &&
      nWindows >= config.wellAboveMinimumWindows;
    const above =
      percentile >= config.abovePercentile &&
      observed >= config.aboveMinimumObserved &&
      nWindows >= config.aboveMinimumWindows;
    band = wellAbove ? 'WELL_ABOVE_TYPICAL' : above ? 'ABOVE_TYPICAL' : 'TYPICAL';
    interpretation =
      `${plural(observed, 'earthquake')} of ${label} within ${String(input.radiusKm)} km in the past ` +
      `${String(input.windowDays)} days: ${bandPhrase(band)} for this area, compared with ` +
      `${String(nWindows)} ${String(input.windowDays)}-day periods since ${String(sinceYear)}.`;
  } else if (status === 'RARE_ACTIVITY') {
    const total = nEvents + observed;
    const years = Math.max(
      1,
      Math.round((input.asOf.getTime() - input.referenceFrom.getTime()) / (365.25 * DAY_MS)),
    );
    const text = `${plural(total, 'earthquake')} of ${label} within ${String(input.radiusKm)} km in the past ${plural(years, 'year')}.`;
    rarity = { nEvents: total, sinceYear, text };
    interpretation = `Rare here: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  } else {
    interpretation = 'Not enough history to establish a baseline.';
  }

  const caveats =
    band === 'ABOVE_TYPICAL' || band === 'WELL_ABOVE_TYPICAL' ? [EARTHQUAKE_ELEVATED_CAVEAT] : [];

  return {
    methodVersion: BASELINE_METHOD_VERSION,
    status,
    observed,
    threshold,
    nWindows,
    nEvents,
    reference,
    percentile,
    band,
    interpretation,
    completenessStatement,
    caveats,
    rarity,
    largestRecent: largestRecent(input),
    sequenceContext: sequenceContext(input, threshold),
    series: seriesOf(times, currentStart, input.windowDays, nWindows, observed),
  };
}

/**
 * "The largest within 150 km since 2019" — the largest event of the last 30 days, and the last
 * time something at least as large happened within the radius.
 *
 * Refused for an event below the retention floor when the reference reaches past it: its peers
 * older than 30 days were not kept, so "the largest since" would be a claim about events GeoNerva
 * has forgotten.
 */
function largestRecent(input: EarthquakeCountInput): EarthquakeCountResult['largestRecent'] {
  const config = EARTHQUAKE_BASELINE;
  const recentFrom = input.asOf.getTime() - config.largestRecentDays * DAY_MS;
  const within = input.events.filter(
    (event) =>
      event.magnitude !== null &&
      event.distanceKm <= input.radiusKm &&
      event.observedAt.getTime() <= input.asOf.getTime(),
  );
  const recent = within
    .filter((event) => event.observedAt.getTime() > recentFrom)
    .sort(
      (left, right) =>
        (right.magnitude ?? 0) - (left.magnitude ?? 0) ||
        left.observedAt.getTime() - right.observedAt.getTime(),
    )[0];
  if (recent?.magnitude === undefined || recent.magnitude === null) return null;
  /*
   * Whenever the comparison reaches past retention, not only under the RETENTION_FLOOR method: a
   * FALLBACK at M4.5 compares an M3.9 with a record from which every older M3.9 was pruned, and
   * "the largest since" would then be a claim about events GeoNerva has forgotten (P8 review).
   */
  if (input.completeness.referenceBeyondRetention && recent.magnitude < RETENTION_FLOOR_MAGNITUDE) {
    return null;
  }
  const magnitude = recent.magnitude;
  const previous = within
    .filter(
      (event) =>
        event.observedAt.getTime() <= recentFrom &&
        event.magnitude !== null &&
        event.magnitude >= magnitude,
    )
    .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime())[0];
  const comparisonSince = previous?.observedAt ?? input.referenceFrom;
  const text =
    previous === undefined
      ? `The largest within ${String(input.radiusKm)} km since ${String(comparisonSince.getUTCFullYear())}, the start of the record GeoNerva holds.`
      : `The largest within ${String(input.radiusKm)} km since ${monthYear(comparisonSince)}.`;
  return {
    magnitude,
    observedAt: recent.observedAt,
    publicId: recent.publicId,
    comparisonSince,
    text,
  };
}

/** An event of M ≥ Mc + 1.5 within the radius in the last 30 days: aftershock context. */
function sequenceContext(
  input: EarthquakeCountInput,
  threshold: number,
): EarthquakeCountResult['sequenceContext'] {
  const config = EARTHQUAKE_BASELINE;
  const from = input.asOf.getTime() - config.sequenceDays * DAY_MS;
  const trigger = input.events
    .filter(
      (event) =>
        event.magnitude !== null &&
        // In tenths, so Mc 4.5 + 1.5 is exactly M6.0 rather than 5.999999999.
        Math.round(event.magnitude * 10) >=
          Math.round((threshold + config.sequenceMagnitudeAboveMc) * 10) &&
        event.distanceKm <= input.radiusKm &&
        event.observedAt.getTime() > from &&
        event.observedAt.getTime() <= input.asOf.getTime(),
    )
    .sort(
      (left, right) =>
        (right.magnitude ?? 0) - (left.magnitude ?? 0) ||
        left.observedAt.getTime() - right.observedAt.getTime(),
    )[0];
  if (trigger?.magnitude === undefined || trigger.magnitude === null) return null;
  return {
    magnitude: trigger.magnitude,
    observedAt: trigger.observedAt,
    publicId: trigger.publicId,
    text: `Activity follows the M${trigger.magnitude.toFixed(1)} earthquake on ${dayMonth(trigger.observedAt)}.`,
    caveat: AFTERSHOCK_CAVEAT,
  };
}

function seriesOf(
  times: readonly Date[],
  currentStart: Date,
  windowDays: number,
  nWindows: number,
  observed: number,
): { start: Date; count: number }[] {
  const shown = Math.min(SERIES_WINDOWS, nWindows);
  const counts =
    shown === 0 ? [] : countPerWindow(times, { end: currentStart, windowDays, windows: shown });
  const windowMs = windowDays * DAY_MS;
  const series = counts
    .map((count, index) => ({
      start: new Date(currentStart.getTime() - (index + 1) * windowMs),
      count,
    }))
    .reverse();
  series.push({ start: currentStart, count: observed });
  return series;
}

function completenessSentence(completeness: Completeness): string {
  const label = magnitudeLabel(completeness.threshold);
  switch (completeness.method) {
    case 'MAXIMUM_CURVATURE':
      return `Counts include earthquakes of ${label} (the smallest size reliably recorded here).`;
    case 'FALLBACK':
      return `Counts include earthquakes of ${label}, the size recorded reliably worldwide; there are too few smaller events here to estimate a local threshold.`;
    case 'RETENTION_FLOOR':
      return `Counts include earthquakes of ${label}: GeoNerva keeps smaller earthquakes for 30 days only, so older periods can be compared from ${label} upward.`;
  }
}

/**
 * The band in words.
 *
 * The quantile is safe to quote here because an unresolvable one never reaches this function: a
 * band whose percentile the sample cannot carry is capped one step down where it is computed
 * (ADR-043). "In the top 1 % of comparable periods" over 59 windows was naming a rarity that is
 * not in the sample — ARCHITECTURE §8's third principle is "refuse to report a statistic that the
 * data cannot support" — and §8.1's gate of 52 windows and 20 events governs `status: OK`, not
 * the percentile.
 */
function bandPhrase(band: EarthquakeBand): string {
  switch (band) {
    case 'TYPICAL':
      return 'typical';
    case 'ABOVE_TYPICAL':
      return 'above typical (in the top 10 % of comparable periods)';
    case 'WELL_ABOVE_TYPICAL':
      return 'well above typical (in the top 1 % of comparable periods)';
  }
}

function magnitudeLabel(threshold: number): string {
  return `M${threshold.toFixed(1)}+`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthYear(at: Date): string {
  return `${MONTHS[at.getUTCMonth()] ?? ''} ${String(at.getUTCFullYear())}`;
}

function dayMonth(at: Date): string {
  return `${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''}`;
}
