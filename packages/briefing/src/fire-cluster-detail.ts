/**
 * `buildFireClusterDetail(publicId, asOf, location?)` — one area of thermal activity at one
 * knowledge time (`GET /api/v1/fire-clusters/{publicId}`, DOMAIN_MODEL §4.10).
 *
 * The terminology is the contract's and is not softened here: a **fire activity cluster** built
 * from satellite **thermal detections**, never a wildfire, with no perimeter. The mandatory caveat
 * is the relevance package's own constant, so there is one sentence and it cannot drift.
 *
 * ### The detections are shown only when they can be verified
 *
 * A cluster's summary versions are clean facts: each carries the knowledge time it was computed
 * for, and a replay reads the latest one at or before `T`. Its *member detections* are not —
 * `fire_detections.cluster_id` is written in place, at assignment and again on merge, with no
 * record of when (ADR-039). So the set behind a version is **reconstructed** from the present and
 * then checked against the one number the version does record at `T`: `n_total`. When they agree,
 * the reconstruction is that set and is shown. When they do not — a merge since, retention since —
 * the sample and the daily counts are withheld, `truncated` says detections were left out, and
 * `total` is still the version's own count. Showing a plausible set that is not the one the
 * summary counted would be the replay leak in its most convincing form.
 *
 * ### Distance
 *
 * With a location, `distanceKm` is to the centroid and `nearestDetectionKm` is to the nearest
 * *verified* detection. Without verified detections the nearest-detection distance falls back to
 * the distance to the cluster's buffered hull, which can only be *smaller* than the true value —
 * every detection pixel lies inside it — so relevance errs towards "closer", never away.
 */

import {
  clusterWindowCountsAsOf,
  attributionsFor,
  clusterVersionHistoryAsOf,
  fireClusterAsOf,
  mergedFromClustersAsOf,
  missingDataDaysAsOf,
  reconstructClusterDetections,
  relatedSubjectsAsOf,
  sourceCatalog,
  sourceCutoffsAsOf,
  type ClusterDetectionRow,
  type ClusterVersionHistoryRow,
} from '@geonerva/db/asof';
import type { DB } from '@geonerva/db/schema';
import {
  READ_MODEL_SCHEMA_VERSION,
  evidenceId,
  formatSubjectRef,
  type ConfidenceView,
  type EvidenceId,
  type Fact,
  type FireClusterDetail,
  type FireClusterStatus,
  type FireClusterVersionView,
  type FireDetectionView,
  type GeoJsonGeometry,
  type LocationRef,
  type RelatedEventRef,
  type SensorRef,
} from '@geonerva/domain';
import {
  THERMAL_DETECTION_CAVEAT,
  fireClusterState,
  type FireClusterState,
} from '@geonerva/relevance';
import type { Kysely } from 'kysely';

import { resolveEvidenceManifest, toAttribution } from './briefing.ts';
import { relatedView } from './event-detail.ts';
/**
 * How near the present a request must be for its rolling 24-hour figures to be recounted.
 *
 * The same five minutes `asOfContextFor` calls a live request: below it the answer is for now, and
 * counting the window again is both sound and more honest than the worker's last pass. Above it
 * the request is a replay, and today's cluster membership cannot be used to count a past window
 * (ADR-039).
 */
const LIVE_RECOUNT_WITHIN_MS = 5 * 60 * 1000;

/** §9.2's window, and the one `FireClusterSummaryView`'s rolling figures are defined over. */
const FIRE_WINDOW_HOURS = 24;

import { replayHorizonFor } from './replay-horizon.ts';
import { asOfContextFor, assessFireCluster, fireDistanceOf } from './snapshot.ts';

/** Detections in the sample. The total is always the version's own count. */
export const DETECTION_SAMPLE_CAP = 500;

/** Summary versions shown. Far above a cluster's real version count over its 72-hour life. */
export const CLUSTER_VERSION_CAP = 500;

/** FIRMS is the only thermal-detection source; every cluster version is attributed to it. */
const FIRE_CLUSTER_SOURCE_ID = 'firms';

export interface BuildFireClusterDetailOptions {
  readonly db: Kysely<DB>;
  readonly publicId: string;
  readonly asOf: Date;
  /**
   * The caller's present, which decides `isReplay`. Defaults to the wall clock for a
   * caller that has no opinion; every caller in this repository has one, and a fixed
   * clock only reaches the response through it.
   */
  readonly now?: Date;
  readonly location: LocationRef | null;
  readonly retentionProfile?: 'lean' | 'standard';
}

export type FireClusterDetailResult =
  | { readonly kind: 'found'; readonly detail: FireClusterDetail }
  | { readonly kind: 'merged'; readonly survivorPublicId: string }
  | { readonly kind: 'not_found'; readonly reason: 'UNKNOWN' | 'NO_SUMMARY' };

export async function buildFireClusterDetail(
  options: BuildFireClusterDetailOptions,
): Promise<FireClusterDetailResult> {
  const { db, publicId, asOf, location } = options;
  const point = location === null ? undefined : { lat: location.lat, lon: location.lon };

  const cluster = await fireClusterAsOf(db, { publicId, asOf });
  if (cluster === null) return { kind: 'not_found', reason: 'UNKNOWN' };
  if (cluster.merged_into_public_id !== null) {
    return { kind: 'merged', survivorPublicId: cluster.merged_into_public_id };
  }

  const [versions, mergedFrom, related, catalog, cutoffs] = await Promise.all([
    clusterVersionHistoryAsOf(db, {
      clusterId: cluster.id,
      asOf,
      limit: CLUSTER_VERSION_CAP,
      ...(point === undefined ? {} : { point }),
    }),
    mergedFromClustersAsOf(db, { clusterId: cluster.id, asOf }),
    relatedSubjectsAsOf(db, {
      subjectRef: formatSubjectRef({ kind: 'fire_cluster', publicId: cluster.public_id }),
      asOf,
    }),
    sourceCatalog(db),
    sourceCutoffsAsOf(db, asOf),
  ]);
  const latest = versions[0];
  // A cluster identity with no summary computed by `asOf` has nothing to describe yet.
  if (latest === undefined) return { kind: 'not_found', reason: 'NO_SUMMARY' };

  const reconstruction = await reconstructClusterDetections(db, {
    clusterId: cluster.id,
    knownAt: latest.as_of,
    firstDetectedAt: latest.first_detected_at,
    lastDetectedAt: latest.last_detected_at,
    cap: DETECTION_SAMPLE_CAP,
    ...(point === undefined ? {} : { point }),
  });
  const verified = reconstruction.count === latest.n_total;

  const days = verified ? reconstruction.byDay.map((entry) => entry.day) : [];
  const missing = await missingDataDaysAsOf(db, {
    productIds: latest.product_ids,
    days,
    asOf,
  });
  /*
   * A day counts as covered unless **every** product this cluster draws on reported no data for
   * it. One satellite's gap is not a coverage gap when the other looked.
   */
  const uncoveredDays = new Set(
    days.filter((day) =>
      latest.product_ids.every((productId) =>
        missing.some((entry) => entry.day === day && entry.product_id === productId),
      ),
    ),
  );

  const hours = (asOf.getTime() - latest.last_detected_at.getTime()) / (60 * 60 * 1000);
  const state = fireClusterState(hours);
  const versionCite = evidenceId.fireClusterVersion(latest.cluster_version_id);
  const setCite = evidenceId.detectionSet(latest.cluster_version_id, latest.n_total);
  const citations: EvidenceId[] = [versionCite, setCite].sort(compare);

  const distance =
    point === undefined
      ? null
      : fireDistanceOf({
          verifiedNearestM: verified ? reconstruction.nearest_m : null,
          areaDistanceM: latest.area_distance_m,
          hasHull: latest.hull_geojson !== null,
          nTotal: latest.n_total,
        });
  /*
   * The rolling 24-hour figures, recounted to the knowledge time when the request is live.
   *
   * `n_24h` and `overpasses_24h` were computed when the worker last clustered; shown hours later
   * as "the last 24 hours" they overstated the fire — eight detections where the rows held five
   * (QA round 2, M-2). A live read can count them again honestly. A **replay** cannot: membership
   * lives in `fire_detections.cluster_id`, which is updated in place, so counting a past window
   * with today's membership is the leak ADR-039 is open about. There the stored figures stand, and
   * `countedTo` says which twenty-four hours they are.
   */
  const now = options.now ?? new Date();
  const live = now.getTime() - asOf.getTime() <= LIVE_RECOUNT_WITHIN_MS;
  const recounted = live
    ? await clusterWindowCountsAsOf(db, {
        clusterId: cluster.id,
        asOf,
        windowHours: FIRE_WINDOW_HOURS,
      })
    : null;

  const nearestM = distance?.meters ?? null;
  const relevance =
    distance === null || nearestM === null
      ? null
      : assessFireCluster({
          asOf,
          lastDetectedAt: latest.last_detected_at,
          nearestDetectionKm: nearestM / 1000,
          distanceBasis: distance.basis,
          summarizedAt: recounted === null ? latest.as_of : asOf,
          n24h: recounted?.detections ?? latest.n_24h,
          nTotal: latest.n_total,
          overpasses24h: recounted?.overpasses ?? latest.overpasses_24h,
          frpSum24h: latest.frp_sum_24h,
          evidenceIds: citations,
        });
  const distanceKm =
    relevance === null || latest.centroid_distance_m === null
      ? null
      : round(latest.centroid_distance_m / 1000, 1);

  const sensors = sensorsOf(latest.product_ids, catalog.products);
  const sample = verified
    ? reconstruction.sample
        .map(detectionView)
        .filter((view): view is FireDetectionView => view !== null)
    : [];

  const detail: Omit<FireClusterDetail, 'evidenceManifest' | 'attribution'> = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    publicId: cluster.public_id,
    subjectRef: formatSubjectRef({ kind: 'fire_cluster', publicId: cluster.public_id }),
    asOfContext: asOfContextFor(
      asOf,
      cutoffs,
      replayHorizonFor(options.retentionProfile ?? 'lean', asOf),
      now,
    ),
    status: statusOf(state),
    createdAt: cluster.created_at.toISOString(),
    summary: {
      clusterVersionId: latest.cluster_version_id,
      asOf: latest.as_of.toISOString(),
      countedTo: (recounted === null ? latest.as_of : asOf).toISOString(),
      detectionCountTotal: latest.n_total,
      detectionCount24h: recounted?.detections ?? latest.n_24h,
      distinctOverpasses24h: recounted?.overpasses ?? latest.overpasses_24h,
      firstDetectedAt: latest.first_detected_at.toISOString(),
      lastDetectedAt: latest.last_detected_at.toISOString(),
      frpSum24h: recounted === null ? latest.frp_sum_24h : recounted.frpSum,
      frpMax: latest.frp_max,
      maxConfidence: confidenceOf(latest.max_confidence, null),
      sensors,
      facts: summaryFacts(latest, citations),
      evidenceIds: citations,
    },
    hull:
      latest.hull_geojson === null ? null : (JSON.parse(latest.hull_geojson) as GeoJsonGeometry),
    centroid: { type: 'Point', coordinates: [latest.centroid_lon, latest.centroid_lat] },
    relevance,
    distanceKm,
    // Only a measured distance to a detection is reported under that name; a bound is not one.
    nearestDetectionKm:
      distanceKm === null || nearestM === null || distance?.basis !== 'NEAREST_DETECTION'
        ? null
        : round(nearestM / 1000, 1),
    versions: versionViews(versions),
    detections: {
      total: latest.n_total,
      truncated: latest.n_total > sample.length,
      cap: DETECTION_SAMPLE_CAP,
      sample,
      byDay: verified
        ? reconstruction.byDay.map((entry) => ({
            day: entry.day,
            count: entry.count,
            frpSum: entry.frp_sum,
            hasSatelliteCoverage: !uncoveredDays.has(entry.day),
          }))
        : [],
      evidenceId: setCite,
    },
    mergedIntoPublicId: null,
    mergedAt: null,
    mergedFromPublicIds: mergedFrom,
    relatedEvents: related
      .map((row) => relatedView(row))
      .filter((view): view is RelatedEventRef => view !== null),
    mandatoryCaveat: THERMAL_DETECTION_CAVEAT,
  };

  const cited = new Set<EvidenceId>([
    ...citations,
    ...detail.versions.map((view) => view.evidenceId),
  ]);
  if (relevance !== null) {
    for (const id of relevance.evidenceIds) cited.add(id);
    for (const reason of relevance.reasons) for (const id of reason.evidenceIds) cited.add(id);
  }
  const manifest = await resolveEvidenceManifest(db, asOf, [...cited]);
  const attribution = (await attributionsFor(db, [FIRE_CLUSTER_SOURCE_ID])).map(toAttribution);

  return { kind: 'found', detail: { ...detail, evidenceManifest: manifest, attribution } };
}

/** `DORMANT` is `INACTIVE`; `MERGED` is never produced, because a merged cluster redirects. */
function statusOf(state: FireClusterState): FireClusterStatus {
  switch (state) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'COOLING':
      return 'COOLING';
    case 'DORMANT':
      return 'INACTIVE';
  }
}

/** Every version, newest first, each described against the one before it. */
function versionViews(versions: readonly ClusterVersionHistoryRow[]): FireClusterVersionView[] {
  return versions.map((version, index) => {
    const previous = versions[index + 1];
    return {
      clusterVersionId: version.cluster_version_id,
      asOf: version.as_of.toISOString(),
      detectionCountTotal: version.n_total,
      detectionCount24h: version.n_24h,
      distinctOverpasses24h: version.overpasses_24h,
      frpSum24h: version.frp_sum_24h,
      frpMax: version.frp_max,
      lastDetectedAt: version.last_detected_at.toISOString(),
      summary:
        previous === undefined
          ? `First summary: ${plural(version.n_total, 'detection')}.`
          : previous.n_total === version.n_total
            ? `Detections unchanged at ${String(version.n_total)}; the 24-hour figures moved.`
            : `Detections ${String(previous.n_total)} → ${String(version.n_total)}.`,
      evidenceId: evidenceId.fireClusterVersion(version.cluster_version_id),
    };
  });
}

function summaryFacts(
  version: ClusterVersionHistoryRow,
  evidenceIds: readonly EvidenceId[],
): Fact[] {
  return [
    {
      code: 'DETECTIONS_24H',
      label: 'Detections in the last 24 hours',
      value: { kind: 'count', value: version.n_24h },
      evidenceIds: [...evidenceIds],
    },
    {
      code: 'DETECTIONS_TOTAL',
      label: 'Detections in total',
      value: { kind: 'count', value: version.n_total },
      evidenceIds: [...evidenceIds],
    },
    {
      code: 'OVERPASSES_24H',
      label: 'Satellite overpasses in the last 24 hours',
      value: { kind: 'count', value: version.overpasses_24h },
      evidenceIds: [...evidenceIds],
    },
    {
      code: 'FRP_SUM_24H',
      label: 'Fire radiative power, last 24 hours',
      value:
        version.frp_sum_24h === null
          ? { kind: 'unavailable', reason: 'NOT_REPORTED_BY_SOURCE' }
          : { kind: 'number', value: version.frp_sum_24h, unit: 'MW', decimals: 0 },
      evidenceIds: [...evidenceIds],
    },
  ];
}

/**
 * One detection, or `null` when FIRMS gave it no confidence class. The contract's `confidence`
 * is not nullable, and picking a class for the provider would be GeoNerva inventing a judgement;
 * such a detection is left out of the sample, which `truncated` then declares.
 */
function detectionView(row: ClusterDetectionRow): FireDetectionView | null {
  const confidence = confidenceOf(row.confidence_class, row.confidence_raw);
  if (confidence === null) return null;
  return {
    acquiredAt: row.acquired_at.toISOString(),
    lat: row.lat,
    lon: row.lon,
    productId: row.product_id,
    confidence,
    frpMw: row.frp,
    brightnessTi4K: row.bright_ti4,
    brightnessTi5K: row.bright_ti5,
    daynight: row.daynight === 'D' || row.daynight === 'N' ? row.daynight : null,
    scanKm: row.scan,
    trackKm: row.track,
    distanceKm: row.distance_m === null ? null : round(row.distance_m / 1000, 1),
  };
}

function confidenceOf(value: string | null, raw: string | null): ConfidenceView | null {
  return value === 'LOW' || value === 'NOMINAL' || value === 'HIGH' ? { class: value, raw } : null;
}

function sensorsOf(
  productIds: readonly number[],
  products: readonly {
    readonly product_id: number;
    readonly code: string;
    readonly platform: string | null;
    readonly instrument: string | null;
    readonly resolution_m: number | null;
  }[],
): SensorRef[] {
  return [...productIds]
    .sort((left, right) => left - right)
    .map((productId) => products.find((product) => product.product_id === productId))
    .filter((product): product is NonNullable<typeof product> => product !== undefined)
    .map((product) => ({
      productId: product.product_id,
      code: product.code,
      platform: product.platform,
      instrument: product.instrument,
      resolutionM: product.resolution_m,
    }));
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
