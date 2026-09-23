/**
 * `buildHistory(location, family, metric)` — the "is this unusual here?" answer and the series
 * behind its chart (`GET /api/v1/history`, ARCHITECTURE §8).
 *
 * The statistics are `@geonerva/baselines`', which is pure. The metric itself — the refusals, the
 * catalog reads, the `EV:BAS:` content address — is `baseline-metrics.ts`, because the family card
 * carries the same `BaselineMetricView` (DOMAIN_MODEL §4.14) and two implementations of §8 would
 * let a card and the chart under it disagree about one number. What is left here is the response
 * around it: the series, the reference bands, the rarity statement, the manifest and the
 * attribution.
 *
 * ### Metrics
 *
 * `EQ_COUNT_7D` (primary) and `EQ_COUNT_30D` for earthquakes; `GDACS_CONTEXT` for floods,
 * cyclones and the volcano/drought family; `FIRE_TREND` for fire activity, read from the daily
 * aggregate of ADR-040 over the days FIRMS ingestion actually covered.
 */

import { THERMAL_DETECTION_CAVEAT } from '@geonerva/relevance';
import { attributionsFor, sourceCutoffsAsOf } from '@geonerva/db/asof';
import type { DB } from '@geonerva/db/schema';
import {
  READ_MODEL_SCHEMA_VERSION,
  type EvidenceId,
  type HazardFamily,
  type HistoryResponse,
  type LocationRef,
} from '@geonerva/domain';
import type { Kysely } from 'kysely';

import {
  HISTORY_METRICS,
  computeBaselineMetric,
  metricsFor,
  primaryMetricFor,
  radiiFor,
  type BaselineMetricComputation,
  type EarthquakeCountResult,
  type HistoryMetric,
} from './baseline-metrics.ts';
import { resolveEvidenceManifest, toAttribution } from './briefing.ts';
import { replayHorizonFor } from './replay-horizon.ts';
import { asOfContextFor } from './snapshot.ts';

export {
  HISTORY_METRICS,
  computeBaselineMetric,
  metricsFor,
  primaryMetricFor,
  radiiFor,
  type BaselineMetricComputation,
  type EarthquakeCountResult,
  type HistoryMetric,
};

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

export async function buildHistory(options: BuildHistoryOptions): Promise<HistoryResponse> {
  const cutoffs = await sourceCutoffsAsOf(options.db, options.asOf);
  const asOfContext = asOfContextFor(
    options.asOf,
    cutoffs,
    replayHorizonFor(options.retentionProfile ?? 'lean', options.asOf),
    options.now ?? new Date(),
  );
  const computed = await computeBaselineMetric({
    db: options.db,
    location: options.location,
    family: options.family,
    metric: options.metric,
    radiusKm: options.radiusKm,
    asOf: options.asOf,
    ...(options.catalogLimit === undefined ? {} : { catalogLimit: options.catalogLimit }),
  });

  const body = assemble(options, asOfContext, computed);
  return await finish(options, body, computed.metric.id, computed.sourceIds);
}

type ResponseBody = Omit<HistoryResponse, 'evidenceManifest' | 'attribution'>;

/** The response around the metric. Pure: every read has already happened. */
function assemble(
  options: BuildHistoryOptions,
  asOfContext: HistoryResponse['asOfContext'],
  computed: BaselineMetricComputation,
): ResponseBody {
  const base = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    location: options.location,
    family: options.family,
    metricCode: options.metric,
    asOfContext,
    metric: computed.metric,
    methodologyHref: computed.methodologyHref,
  } as const;
  const empty = {
    series: [],
    referenceBands: null,
    rarity: null,
    largestRecent: null,
    sequenceContext: null,
    completenessStatement: null,
    caveats: [],
  } as const;

  switch (computed.kind) {
    case 'REFUSED':
      return { ...base, ...empty };
    case 'GDACS':
      return { ...base, ...empty };
    case 'FIRE':
      return {
        ...base,
        ...empty,
        series: [
          {
            code: 'FIRE_TREND',
            label: 'Thermal detections per day',
            unit: 'detections',
            bucketDays: 1,
            points: computed.rows.map((row) => ({
              t: `${row.day}T00:00:00.000Z`,
              value: row.covered ? row.detections : null,
              // A day not read is not a quiet day, and the chart says which it was.
              missingReason: row.covered ? null : 'NOT_COVERED',
            })),
          },
        ],
        caveats: [THERMAL_DETECTION_CAVEAT],
      };
    case 'EARTHQUAKE':
      return earthquakeBody(options, base, computed);
  }
}

function earthquakeBody(
  options: BuildHistoryOptions,
  base: Pick<
    ResponseBody,
    | 'schemaVersion'
    | 'location'
    | 'family'
    | 'metricCode'
    | 'asOfContext'
    | 'metric'
    | 'methodologyHref'
  >,
  computed: Extract<BaselineMetricComputation, { kind: 'EARTHQUAKE' }>,
): ResponseBody {
  const { result, referenceFrom, currentStart, windowDays, eventCitations } = computed;
  const id = computed.metric.id;
  const largest = result.largestRecent;
  const sequence = result.sequenceContext;
  return {
    ...base,
    series: [
      {
        code: options.metric,
        label: computed.metric.label,
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
  };
}

async function finish(
  options: BuildHistoryOptions,
  response: ResponseBody,
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
