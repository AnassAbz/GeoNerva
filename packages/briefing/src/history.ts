/**
 * `buildHistory(location, family, metric)` — the "is this unusual here?" answer and the series
 * behind its chart (`GET /api/v1/history`, ARCHITECTURE §8).
 *
 * The statistics are `@geonerva/baselines`', which is pure; this module reads the catalog as of a
 * knowledge time, reduces it to canonical events the way the briefing does — through active
 * links, with the headline magnitude the correlation package chooses — and hands it over.
 *
 * ### Refusing before computing
 *
 * A baseline over a catalog GeoNerva never read is a statement about GeoNerva, not about the
 * ground. So before any count, a metric whose inputs were never read — no committed run for the
 * family's sources, or correlation never having run for earthquakes — is `INSUFFICIENT_COVERAGE`,
 * and the reference period never starts before the catalog GeoNerva actually holds.
 *
 * ### Metrics
 *
 * `EQ_COUNT_7D` (primary) and `EQ_COUNT_30D` for earthquakes; `GDACS_CONTEXT` for floods,
 * cyclones and the volcano/drought family; `FIRE_TREND` for fire activity, read from the daily
 * aggregate of ADR-040 over the days FIRMS ingestion actually covered.
 */

import { chooseHeadlineMagnitude } from '@geonerva/correlation';
import { THERMAL_DETECTION_CAVEAT } from '@geonerva/relevance';
import {
  BASELINE_METHOD_VERSION,
  EARTHQUAKE_BASELINE,
  FIRE_TREND,
  GDACS_CONTEXT,
  RETENTION_FLOOR_MAGNITUDE,
  earthquakeCountBaseline,
  estimateCompleteness,
  fireTrend,
  gdacsContext,
  type EarthquakeCountResult,
  type QuakeRecord,
} from '@geonerva/baselines';
import {
  attributionsFor,
  derivationsAsOf,
  catalogCoverageAsOf,
  fireDailyAsOf,
  fireProductsActiveThroughout,
  linksAsOf,
  observationsAsOf,
  sourceCutoffsAsOf,
  type LinkRow,
  type ObservationRow,
} from '@geonerva/db/asof';
import type { DB } from '@geonerva/db/schema';
import {
  READ_MODEL_SCHEMA_VERSION,
  evidenceId,
  type BaselineMetricView,
  type EvidenceId,
  type HazardFamily,
  type HazardType,
  type HistoryResponse,
  type LocationRef,
} from '@geonerva/domain';
import type { Kysely } from 'kysely';

import { resolveEvidenceManifest, toAttribution } from './briefing.ts';
import { contentSha256 } from './content-hash.ts';
import { COVERAGE_EDGE_TOLERANCE_MS, coveredSince, coveredSinceForEvery } from './coverage-span.ts';
import { replayHorizonFor } from './replay-horizon.ts';
import { asOfContextFor, memberSolutionsOf } from './snapshot.ts';

export const HISTORY_METRICS = {
  EQ_COUNT_7D: { family: 'EARTHQUAKES', windowDays: 7 },
  EQ_COUNT_30D: { family: 'EARTHQUAKES', windowDays: 30 },
  FIRE_TREND: { family: 'FIRE_ACTIVITY' },
  GDACS_CONTEXT: { family: null },
} as const;
export type HistoryMetric = keyof typeof HISTORY_METRICS;

/** The families `GDACS_CONTEXT` describes, with the hazard types and the words it uses. */
const GDACS_FAMILIES: Partial<
  Record<
    HazardFamily,
    { readonly types: readonly HazardType[]; readonly noun: readonly [string, string] }
  >
> = {
  FLOODS: { types: ['FLOOD'], noun: ['flood event', 'flood events'] },
  CYCLONES: {
    types: ['TROPICAL_CYCLONE'],
    noun: ['tropical cyclone event', 'tropical cyclone events'],
  },
  OTHER: {
    types: ['VOLCANO', 'DROUGHT'],
    noun: ['volcano or drought event', 'volcano or drought events'],
  },
};

/** The metrics a family offers; the first is its default. */
export function metricsFor(family: HazardFamily): readonly HistoryMetric[] {
  if (family === 'EARTHQUAKES') return ['EQ_COUNT_7D', 'EQ_COUNT_30D'];
  if (family === 'FIRE_ACTIVITY') return ['FIRE_TREND'];
  if (GDACS_FAMILIES[family] !== undefined) return ['GDACS_CONTEXT'];
  return [];
}

/** The radii a metric accepts; the first is its default. */
export function radiiFor(metric: HistoryMetric): readonly number[] {
  if (metric === 'EQ_COUNT_7D' || metric === 'EQ_COUNT_30D') {
    return [
      EARTHQUAKE_BASELINE.defaultRadiusKm,
      ...EARTHQUAKE_BASELINE.radiiKm.filter((r) => r !== EARTHQUAKE_BASELINE.defaultRadiusKm),
    ];
  }
  if (metric === 'FIRE_TREND') return [100];
  return [GDACS_CONTEXT.radiusKm];
}

export interface BuildHistoryOptions {
  readonly db: Kysely<DB>;
  readonly location: LocationRef;
  readonly family: HazardFamily;
  readonly metric: HistoryMetric;
  readonly radiusKm: number;
  readonly asOf: Date;
  /** The caller's present, which decides `isReplay`. */
  readonly now?: Date;
  readonly retentionProfile?: 'lean' | 'standard';
  /**
   * The catalog read's safety bound. Only tests set it: a bound can be tested only from above it,
   * and a hundred thousand seeded rows is not a unit of work a test should do.
   */
  readonly catalogLimit?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;
/** A bound far above any 300-km, ten-year catalog; reaching it is an error, never a truncation. */
const DEFAULT_CATALOG_LIMIT = 100_000;
const EARTHQUAKE_SOURCES = ['usgs', 'emsc'] as const;

export async function buildHistory(options: BuildHistoryOptions): Promise<HistoryResponse> {
  const cutoffs = await sourceCutoffsAsOf(options.db, options.asOf);
  const asOfContext = asOfContextFor(
    options.asOf,
    cutoffs,
    replayHorizonFor(options.retentionProfile ?? 'lean', options.asOf),
    options.now ?? new Date(),
  );
  const base = { options, asOfContext, cutoffs };
  switch (options.metric) {
    case 'EQ_COUNT_7D':
    case 'EQ_COUNT_30D':
      return await earthquakeHistory(base, HISTORY_METRICS[options.metric].windowDays);
    case 'GDACS_CONTEXT':
      return await gdacsHistory(base);
    case 'FIRE_TREND':
      return await fireTrendHistory(base);
  }
}

/**
 * A UTC day is still inside the FIRMS fetch window for a day after it ends, so the trend's window
 * ends two days before the knowledge time: nothing more recent is final (ADR-040).
 */
const FIRE_FINAL_AFTER_DAYS = 2;

const FIRE_TREND_DAYS = FIRE_TREND.previousDays + FIRE_TREND.recentDays;

/** `YYYY-MM-DD` of a UTC instant. */
function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * `FIRE_TREND` — the last 7 days of thermal detections against the 28 before them, per covered day
 * (ARCHITECTURE §8.2), from the daily aggregate (ADR-040).
 *
 * Three refusals before any comparison, each of which would otherwise read as quiet:
 *
 *  - no FIRMS feed covered the whole window (a sensor added or retired inside it cannot be
 *    compared against itself, ADR-009);
 *  - the aggregate holds no day of one of the two periods;
 *  - a day GeoNerva did not read every hour of, or that FIRMS reported no satellite data for, is
 *    excluded rather than counted as zero.
 */
async function fireTrendHistory(base: Base): Promise<HistoryResponse> {
  const { options } = base;
  const { db, asOf } = options;
  const label = `Fire activity within ${String(FIRE_TREND.radiusKm)} km`;
  const methodologyHref = '/methodology#fire-trend';

  const lastDay = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) -
      FIRE_FINAL_AFTER_DAYS * DAY_MS,
  );
  const firstDay = new Date(lastDay.getTime() - (FIRE_TREND_DAYS - 1) * DAY_MS);

  const productIds = await fireProductsActiveThroughout(db, { from: firstDay, to: lastDay });
  if (productIds.length === 0) {
    return await unavailable(base, {
      label,
      interpretation:
        'No fire-detection sensor covered this whole period, so GeoNerva cannot compare the last week with the four weeks before it.',
      methodologyHref,
      sourceIds: ['firms'],
    });
  }

  const rows = await fireDailyAsOf(db, {
    asOf,
    productIds,
    point: { lat: options.location.lat, lon: options.location.lon },
    radiusM: FIRE_TREND.radiusKm * 1000,
    from: isoDay(firstDay),
    to: isoDay(lastDay),
  });
  const result = fireTrend(rows);

  const params = {
    radiusKm: FIRE_TREND.radiusKm,
    recentDays: FIRE_TREND.recentDays,
    previousDays: FIRE_TREND.previousDays,
    sensors: productIds.length,
    lastDay: isoDay(lastDay),
  };
  const id = baselineId(options, params, result);
  const metric: BaselineMetricView = {
    id,
    family: 'FIRE_ACTIVITY',
    metricCode: 'FIRE_TREND',
    label,
    params,
    asOf: asOf.toISOString(),
    status: result.status === 'OK' ? 'OK' : 'INSUFFICIENT_COVERAGE',
    observedValue:
      result.recentMeanPerDay === null
        ? { kind: 'unavailable', reason: 'NOT_COVERED' }
        : {
            kind: 'number',
            value: Math.round(result.recentMeanPerDay * 10) / 10,
            unit: 'detections/day',
            decimals: 1,
          },
    reference: null,
    percentile: null,
    band: null,
    trendBand: result.band,
    interpretation: result.interpretation,
    // §9.2's mandatory sentence: these are thermal detections, not confirmed fires.
    caveats: [THERMAL_DETECTION_CAVEAT],
    methodVersion: result.methodVersion,
    evidenceIds: [id],
  };

  const response: Omit<HistoryResponse, 'evidenceManifest' | 'attribution'> = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    location: options.location,
    family: 'FIRE_ACTIVITY',
    metricCode: 'FIRE_TREND',
    asOfContext: base.asOfContext,
    metric,
    series: [
      {
        code: 'FIRE_TREND',
        label: 'Thermal detections per day',
        unit: 'detections',
        bucketDays: 1,
        points: rows.map((row) => ({
          t: `${row.day}T00:00:00.000Z`,
          value: row.covered ? row.detections : null,
          // A day not read is not a quiet day, and the chart says which it was.
          missingReason: row.covered ? null : 'NOT_COVERED',
        })),
      },
    ],
    referenceBands: null,
    rarity: null,
    largestRecent: null,
    sequenceContext: null,
    completenessStatement: null,
    caveats: [THERMAL_DETECTION_CAVEAT],
    methodologyHref,
  };
  return await finish(options, response, id, ['firms']);
}

interface Base {
  readonly options: BuildHistoryOptions;
  readonly asOfContext: HistoryResponse['asOfContext'];
  readonly cutoffs: Readonly<Record<string, Date | null>>;
}

async function earthquakeHistory(base: Base, windowDays: number): Promise<HistoryResponse> {
  const { options } = base;
  const { db, asOf, location } = options;
  const label = `Earthquakes within ${String(options.radiusKm)} km, per ${String(windowDays)} days`;
  const methodologyHref = '/methodology#eq-count';

  /*
   * "Was this catalog read?" is a question for the coverage ledger, not for run history.
   *
   * It used to be answered by `sourceCutoffsAsOf`, i.e. by whether any `ingestion_runs` row for the
   * source had committed by `asOf`. That made every earthquake baseline depend on run rows
   * surviving — so ADR-033's 90-day sweep would have turned a read catalog into an unread one, and
   * a replay to any knowledge time older than the retention window would refuse for no reason on
   * the ground. ADR-041's ledger is the durable record of what was read; this reads that instead.
   * `cutoffs` stays on `base`, where it says how fresh each source is, which is a different fact.
   *
   * Any earthquake product of either source counts: they restate one catalog.
   */
  const coverage = await catalogCoverageAsOf(db, {
    asOf,
    sourceIds: [...EARTHQUAKE_SOURCES],
    hazardTypes: ['EARTHQUAKE'],
    maxMinMagnitude: RETENTION_FLOOR_MAGNITUDE,
  });
  const read = EARTHQUAKE_SOURCES.filter((source) =>
    coverage.spans.some((span) => span.sourceId === source),
  );
  const derivations = await derivationsAsOf(db, { asOf });
  const correlated = derivations.some(
    (entry) => entry.kind === 'CORRELATION' && entry.lastSucceededAt !== null,
  );
  if (read.length === 0 || !correlated) {
    return await unavailable(base, {
      label,
      interpretation:
        read.length === 0
          ? 'GeoNerva had not read an earthquake catalog by this time, so it has no history to compare with.'
          : 'GeoNerva had not yet grouped the earthquake records it holds into events, so it cannot count them.',
      methodologyHref,
      sourceIds: [...EARTHQUAKE_SOURCES],
    });
  }

  /*
   * The reference starts where GeoNerva's unbroken reading of the catalog starts — never at the
   * oldest record it happens to hold (P8 review H1). Plans that fetched only above M4.5 do not
   * count: every threshold this metric counts at over a reference older than 30 days is at least
   * the retention floor, and a plan above it would leave M4.5-and-up windows short.
   */
  const coverageStart = coveredSince(coverage.spans, asOf, COVERAGE_EDGE_TOLERANCE_MS);
  /*
   * The current window must be read whole, as well as reached: a seven-day count over the three
   * days since polling resumed is a count of three days presented as seven (P8 fix review).
   */
  if (coverageStart === null || coverageStart.getTime() > asOf.getTime() - windowDays * DAY_MS) {
    return await unavailable(base, {
      label,
      interpretation:
        coverageStart === null
          ? 'GeoNerva had not been reading the earthquake catalog up to this time, so the recent weeks cannot be counted.'
          : `GeoNerva had been reading the earthquake catalog for less than ${String(windowDays)} days at this time, so it cannot count a whole period.`,
      methodologyHref,
      sourceIds: [...EARTHQUAKE_SOURCES],
    });
  }
  const tenYears = new Date(asOf.getTime() - EARTHQUAKE_BASELINE.referenceYears * YEAR_MS);
  const referenceFrom = coverageStart > tenYears ? coverageStart : tenYears;

  const events = await earthquakeEvents(db, {
    asOf,
    location,
    radiusKm: Math.max(options.radiusKm, EARTHQUAKE_BASELINE.mcReferenceRadiusKm),
    since: referenceFrom,
    limit: options.catalogLimit ?? DEFAULT_CATALOG_LIMIT,
  });
  const inMcRegion = events.filter(
    (event) => event.observedAt < new Date(asOf.getTime() - windowDays * DAY_MS),
  );
  const completeness = estimateCompleteness(
    inMcRegion.map((event) => event.magnitude).filter((value): value is number => value !== null),
    { referenceBeyondRetention: referenceFrom.getTime() < asOf.getTime() - 30 * DAY_MS },
  );

  const result = earthquakeCountBaseline({
    asOf,
    radiusKm: options.radiusKm,
    windowDays,
    referenceFrom,
    completeness,
    events,
  });

  const params = {
    radiusKm: options.radiusKm,
    windowDays,
    magnitudeThreshold: result.threshold,
    completenessMethod: completeness.method,
    referenceFrom: referenceFrom.toISOString(),
  };
  const id = baselineId(options, params, result);
  const currentStart = new Date(asOf.getTime() - windowDays * DAY_MS);

  const eventCitations = new Map(events.map((event) => [event.publicId, event.evidenceIds]));
  const metric: BaselineMetricView = {
    id,
    family: 'EARTHQUAKES',
    metricCode: options.metric,
    label,
    params,
    asOf: asOf.toISOString(),
    status: result.status,
    observedValue: { kind: 'count', value: result.observed },
    reference:
      result.reference === null
        ? null
        : {
            nWindows: result.reference.nWindows,
            nEvents: result.reference.nEvents,
            windowDays,
            referenceFrom: referenceFrom.toISOString(),
            referenceTo: currentStart.toISOString(),
            median: result.reference.median,
            p25: result.reference.p25,
            p75: result.reference.p75,
            p90: result.reference.p90,
            p95: result.reference.p95,
            mean: result.reference.mean,
            ratePerWindow: result.reference.mean,
            activityRatio: result.reference.activityRatio,
          },
    percentile: result.percentile === null ? null : Math.round(result.percentile * 10) / 10,
    band: result.band,
    trendBand: null,
    interpretation: result.interpretation,
    caveats: result.caveats,
    methodVersion: result.methodVersion,
    evidenceIds: [id],
  };

  const largest = result.largestRecent;
  const sequence = result.sequenceContext;
  const response: Omit<HistoryResponse, 'evidenceManifest' | 'attribution'> = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    location,
    family: 'EARTHQUAKES',
    metricCode: options.metric,
    asOfContext: base.asOfContext,
    metric,
    series: [
      {
        code: options.metric,
        label,
        unit: null,
        bucketDays: windowDays,
        points: result.series.map((point) => ({
          t: point.start.toISOString(),
          value: point.count,
          missingReason: null,
        })),
      },
    ],
    referenceBands:
      result.reference === null
        ? null
        : {
            windowDays,
            nWindows: result.reference.nWindows,
            nEvents: result.reference.nEvents,
            referenceFrom: referenceFrom.toISOString(),
            referenceTo: currentStart.toISOString(),
            p25: result.reference.p25,
            median: result.reference.median,
            p75: result.reference.p75,
            p90: result.reference.p90,
            p95: result.reference.p95,
            mean: result.reference.mean,
            evidenceIds: [id],
          },
    rarity:
      result.rarity === null
        ? null
        : {
            nEvents: result.rarity.nEvents,
            sinceYear: result.rarity.sinceYear,
            radiusKm: options.radiusKm,
            thresholdLabel: `M${result.threshold.toFixed(1)}+`,
            text: result.rarity.text,
            evidenceIds: [id],
          },
    largestRecent:
      largest === null
        ? null
        : {
            value: { kind: 'number', value: largest.magnitude, unit: null, decimals: 1 },
            observedAt: largest.observedAt.toISOString(),
            subjectPublicId: largest.publicId,
            comparisonSince: largest.comparisonSince.toISOString(),
            text: largest.text,
            evidenceIds: [...(eventCitations.get(largest.publicId) ?? [])],
          },
    sequenceContext:
      sequence === null
        ? null
        : {
            triggerPublicId: sequence.publicId,
            triggerValue: { kind: 'number', value: sequence.magnitude, unit: null, decimals: 1 },
            triggerObservedAt: sequence.observedAt.toISOString(),
            text: sequence.text,
            caveat: sequence.caveat,
            evidenceIds: [...(eventCitations.get(sequence.publicId) ?? [])],
          },
    completenessStatement: result.completenessStatement,
    caveats: result.caveats,
    methodologyHref,
  };
  return await finish(options, response, id, read);
}

async function gdacsHistory(base: Base): Promise<HistoryResponse> {
  const { options } = base;
  const family = GDACS_FAMILIES[options.family];
  const label = 'GDACS events nearby';
  const methodologyHref = '/methodology#gdacs-context';
  /*
   * The same refusal the earthquake metric makes, for the same reasons (P8 review H2): a count
   * over five years GeoNerva never read, or over records no derivation had opened events for,
   * would be a false zero. GDACS families are opened by `SEED`, not `CORRELATION`.
   */
  const coverageStart =
    family === undefined
      ? null
      : // Every GDACS feed the family draws on, each read in its own right (review round 3).
        coveredSinceForEvery(
          await catalogCoverageAsOf(options.db, {
            asOf: options.asOf,
            sourceIds: ['gdacs'],
            hazardTypes: family.types,
            maxMinMagnitude: null,
          }),
          options.asOf,
          COVERAGE_EDGE_TOLERANCE_MS,
        );
  const seeded = (await derivationsAsOf(options.db, { asOf: options.asOf })).some(
    (entry) => entry.kind === 'SEED' && entry.lastSucceededAt !== null,
  );
  if (family === undefined || coverageStart === null || !seeded) {
    return await unavailable(base, {
      label,
      interpretation:
        coverageStart === null
          ? 'GeoNerva had not been reading GDACS up to this time, so it has no events to count here.'
          : 'GeoNerva had not yet opened events for the GDACS records it holds, so it cannot count them.',
      methodologyHref,
      sourceIds: ['gdacs'],
    });
  }

  const catalogLimit = options.catalogLimit ?? DEFAULT_CATALOG_LIMIT;
  const fiveYears = new Date(
    Date.UTC(
      options.asOf.getUTCFullYear() - GDACS_CONTEXT.years,
      options.asOf.getUTCMonth(),
      options.asOf.getUTCDate(),
    ),
  );
  /*
   * From the first *whole* UTC day covered: a record that began at 23:45 on the 20th is stated as
   * beginning on the 21st, so the sentence never presents the unread part of a day (review round 4).
   */
  const firstWholeDay = new Date(Math.ceil(coverageStart.getTime() / DAY_MS) * DAY_MS);
  const recordStart = coverageStart > fiveYears ? firstWholeDay : null;
  const since = recordStart ?? fiveYears;
  const rows = await observationsAsOf(options.db, {
    asOf: options.asOf,
    hazardTypes: family.types,
    observedSince: since,
    near: {
      point: { lat: options.location.lat, lon: options.location.lon },
      radiusM: GDACS_CONTEXT.radiusKm * 1000,
    },
    limit: catalogLimit,
  });
  assertBelowLimit(rows.length, catalogLimit);
  const links = await linksAsOf(options.db, {
    asOf: options.asOf,
    sourceRecordIds: rows.map((row) => row.source_record_id),
    limit: catalogLimit,
  });
  const count = new Set(links.map((link) => link.canonical_event_id)).size;
  const result = gdacsContext({ asOf: options.asOf, noun: family.noun, count, recordStart });

  const params = {
    radiusKm: GDACS_CONTEXT.radiusKm,
    years: GDACS_CONTEXT.years,
    since: since.toISOString(),
  };
  const id = baselineId(options, params, result);
  const response: Omit<HistoryResponse, 'evidenceManifest' | 'attribution'> = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    location: options.location,
    family: options.family,
    metricCode: options.metric,
    asOfContext: base.asOfContext,
    metric: {
      id,
      family: options.family,
      metricCode: options.metric,
      label,
      params,
      asOf: options.asOf.toISOString(),
      // Context, never an anomaly: there is no distribution for a percentile to be read from.
      status: 'NOT_APPLICABLE',
      observedValue: { kind: 'count', value: count },
      reference: null,
      percentile: null,
      band: null,
      trendBand: null,
      interpretation: result.interpretation,
      caveats: [],
      methodVersion: result.methodVersion,
      evidenceIds: [id],
    },
    series: [],
    referenceBands: null,
    rarity: null,
    largestRecent: null,
    sequenceContext: null,
    completenessStatement: null,
    caveats: [],
    methodologyHref,
  };
  return await finish(options, response, id, ['gdacs']);
}

/** A metric whose inputs GeoNerva does not hold at this knowledge time. */
async function unavailable(
  base: Base,
  copy: {
    readonly label: string;
    readonly interpretation: string;
    readonly methodologyHref: string;
    readonly sourceIds: readonly string[];
  },
): Promise<HistoryResponse> {
  const { options } = base;
  const params = { radiusKm: options.radiusKm };
  const id = baselineId(options, params, { status: 'INSUFFICIENT_COVERAGE' });
  const response: Omit<HistoryResponse, 'evidenceManifest' | 'attribution'> = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    location: options.location,
    family: options.family,
    metricCode: options.metric,
    asOfContext: base.asOfContext,
    metric: {
      id,
      family: options.family,
      metricCode: options.metric,
      label: copy.label,
      params,
      asOf: options.asOf.toISOString(),
      status: 'INSUFFICIENT_COVERAGE',
      observedValue: { kind: 'unavailable', reason: 'SOURCE_UNAVAILABLE' },
      reference: null,
      percentile: null,
      band: null,
      trendBand: null,
      interpretation: copy.interpretation,
      caveats: [],
      methodVersion: BASELINE_METHOD_VERSION,
      evidenceIds: [id],
    },
    series: [],
    referenceBands: null,
    rarity: null,
    largestRecent: null,
    sequenceContext: null,
    completenessStatement: null,
    caveats: [],
    methodologyHref: copy.methodologyHref,
  };
  return await finish(options, response, id, copy.sourceIds);
}

async function finish(
  options: BuildHistoryOptions,
  response: Omit<HistoryResponse, 'evidenceManifest' | 'attribution'>,
  id: EvidenceId,
  sourceIds: readonly string[],
): Promise<HistoryResponse> {
  const cited = new Set<EvidenceId>([id]);
  for (const view of [response.largestRecent, response.sequenceContext]) {
    for (const citation of view?.evidenceIds ?? []) cited.add(citation);
  }
  const manifest = await resolveEvidenceManifest(
    options.db,
    options.asOf,
    [...cited],
    new Set([id]),
  );
  const attribution = (await attributionsFor(options.db, [...new Set(sourceIds)].sort())).map(
    toAttribution,
  );
  return { ...response, evidenceManifest: manifest, attribution };
}

/**
 * `EV:BAS:<sha>` — content-addressed by the method, the metric, its parameters, the knowledge
 * time and the result, so the same computation always has the same id and a different one never
 * does (DOMAIN_MODEL §4.11).
 */
function baselineId(options: BuildHistoryOptions, params: unknown, result: unknown): EvidenceId {
  return evidenceId.baseline(
    contentSha256({
      methodVersion: BASELINE_METHOD_VERSION,
      metric: options.metric,
      family: options.family,
      location: options.location.key,
      asOf: options.asOf.toISOString(),
      params,
      result: summarize(result),
    }),
  );
}

/** Dates to strings, so the hash is of the values rather than of object identity. */
function summarize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * Canonical earthquakes within a radius observed since a time, as known at `asOf`: every linked
 * record's latest version, grouped by event, sized by the correlation package's headline
 * magnitude and placed at that member's epicentre.
 */
async function earthquakeEvents(
  db: Kysely<DB>,
  options: {
    readonly asOf: Date;
    readonly location: LocationRef;
    readonly radiusKm: number;
    readonly since: Date;
    readonly limit: number;
  },
): Promise<(QuakeRecord & { readonly evidenceIds: readonly EvidenceId[] })[]> {
  const rows = await observationsAsOf(db, {
    asOf: options.asOf,
    hazardTypes: ['EARTHQUAKE'],
    observedSince: options.since,
    near: {
      point: { lat: options.location.lat, lon: options.location.lon },
      radiusM: options.radiusKm * 1000,
    },
    limit: options.limit,
  });
  assertBelowLimit(rows.length, options.limit);
  if (rows.length === 0) return [];
  const links = await linksAsOf(db, {
    asOf: options.asOf,
    sourceRecordIds: rows.map((row) => row.source_record_id),
    limit: options.limit,
  });
  const linkByRecord = new Map(links.map((link) => [link.source_record_id, link]));
  const byEvent = new Map<string, { publicId: string; rows: ObservationRow[] }>();
  for (const row of rows) {
    const link = linkByRecord.get(row.source_record_id);
    if (link === undefined) continue;
    const group = byEvent.get(link.canonical_event_id);
    if (group === undefined)
      byEvent.set(link.canonical_event_id, { publicId: link.canonical_public_id, rows: [row] });
    else group.rows.push(row);
  }

  const events: (QuakeRecord & { readonly evidenceIds: readonly EvidenceId[] })[] = [];
  for (const { publicId, rows: members } of byEvent.values()) {
    const sorted = [...members].sort((left, right) =>
      left.source_record_id < right.source_record_id
        ? -1
        : left.source_record_id > right.source_record_id
          ? 1
          : 0,
    );
    const headline = chooseHeadlineMagnitude(memberSolutionsOf(sorted, linkByRecord));
    const anchor =
      sorted.find((row) => row.source_record_id === headline?.member.sourceRecordId) ?? sorted[0];
    const distanceM = anchor?.distance_m;
    if (anchor === undefined || distanceM === null || distanceM === undefined) continue;
    events.push({
      observedAt: anchor.observed_at,
      magnitude: headline?.member.magnitude ?? null,
      distanceKm: distanceM / 1000,
      publicId,
      evidenceIds: [
        ...sorted.map((row) => evidenceId.observation(row.version_id)),
        ...sorted
          .map((row) => linkByRecord.get(row.source_record_id))
          .filter((link): link is LinkRow => link !== undefined)
          .map((link) => evidenceId.correlation(link.link_id)),
      ].sort(),
    });
  }
  return events;
}

function assertBelowLimit(count: number, limit: number): void {
  if (count >= limit) {
    throw new Error(`history: the catalog read reached its safety bound of ${String(limit)}`);
  }
}

export type { EarthquakeCountResult };
