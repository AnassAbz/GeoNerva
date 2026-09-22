/**
 * `buildMapFeatures(bbox, zoom, families, asOf)` — what the map draws for one viewport at one
 * knowledge time (`GET /api/v1/events`, ARCHITECTURE §7.5, §13.1).
 *
 * ### What a feature is
 *
 * The same subject a briefing card lists: a **canonical event** reached through its active links,
 * or a **fire cluster** drawn at its centroid. A source record with no active link has no subject
 * to point at and is not drawn, exactly as it is not a card item — so the map and the briefing
 * can never disagree about what exists, only about where the reader is looking.
 *
 * Every per-subject judgement is borrowed rather than repeated. The headline magnitude comes from
 * `chooseHeadlineMagnitude`, the title from `titleOf`, the provider severity from
 * `providerSeverityOf`, the fire state from `fireClusterState`, and the recency windows from
 * `FAMILY_RECENCY_DAYS` (ADR-037) — all of them the functions `buildSnapshot` calls. A map that
 * computed any of these for itself would be a second opinion nobody reviewed.
 *
 * ### What is deliberately not drawn: individual detections
 *
 * §7.5 asks for individual FIRMS detections at zoom ≥ 8. They are **not** returned at any zoom,
 * and the reason is a contract gap rather than effort: a `MapFeature` must name a subject, a
 * detection's only subject is its cluster, and `fire_detections.cluster_id` is written in place —
 * at assignment and again on merge — with no record of when. At a past knowledge time GeoNerva
 * cannot say which cluster a detection belonged to, or whether it belonged to one at all, so
 * drawing it under a cluster would show a replay the future. ADR-039 sets out the options.
 *
 * ### Truncation and the total
 *
 * Above the cap the response says `truncated: true` rather than dropping features quietly, and
 * `total` is exact: both reads count their qualifying subjects before their `LIMIT`. A subject the
 * read counted but this module could not describe — an out-of-contract enum in a `text` column —
 * is counted and not drawn, which makes `truncated` true. That is the literal meaning of the
 * field, "features were dropped", and it is the honest one.
 */

import { chooseHeadlineMagnitude, type MemberSolution } from '@geonerva/correlation';
import {
  attributionsFor,
  canonicalEventsInViewportAsOf,
  clustersInViewportAsOf,
  linksAsOf,
  observationsAsOf,
  sourceCutoffsAsOf,
  type AttributionRow,
  type ClusterVersionRow,
  type LinkRow,
  type ObservationRow,
} from '@geonerva/db/asof';
import type { DB } from '@geonerva/db/schema';
import { splitViewport } from '@geonerva/db/viewport';
import {
  READ_MODEL_SCHEMA_VERSION,
  evidenceId,
  familyOf,
  formatSubjectRef,
  type Attribution,
  type BoundingBox,
  type EvidenceId,
  type FireClusterStatus,
  type HazardFamily,
  type HazardType,
  type LifecycleStatus,
  type MapFeature,
  type MapFeaturesResponse,
} from '@geonerva/domain';
import { fireClusterState, type FireClusterState } from '@geonerva/relevance';
import type { Kysely } from 'kysely';

import { replayHorizonFor } from './replay-horizon.ts';
import {
  FAMILY_RECENCY_DAYS,
  asHazardType,
  asLifecycleStatus,
  asOfContextFor,
  hazardTypesOf,
  numberOf,
  providerSeverityOf,
  titleOf,
} from './snapshot.ts';

/**
 * Features per response (ARCHITECTURE §7.5: "capped at 2,000 features").
 *
 * §7.5 gives 5,000 for individual detections at zoom ≥ 8, which this module does not serve (see
 * the header), so one cap applies at every zoom.
 */
export const MAP_FEATURE_CAP = 2_000;

/**
 * The FIRMS source id, which a cluster version cites.
 *
 * A cluster version has product ids but no source column; every cluster is computed from FIRMS
 * detections, and `evidenceItemsAsOf` attributes an `EV:FCV` to the same literal.
 */
const FIRE_CLUSTER_SOURCE_ID = 'firms';

/**
 * An upper bound on member reads that is never the thing that limits them.
 *
 * The member reads are already bounded by the events on the page — at most `MAP_FEATURE_CAP` — and
 * a `LIMIT` that bit would silently drop members and move an event's anchor. So the bound is set
 * far above any real membership and reaching it is an error, not a truncation.
 */
const MEMBER_READ_LIMIT = MAP_FEATURE_CAP * 50;

export interface BuildMapFeaturesOptions {
  readonly db: Kysely<DB>;
  /** Already validated and quantized by the caller; `west > east` crosses the antimeridian. */
  readonly bbox: BoundingBox;
  readonly zoom: number;
  /** Non-empty, deduplicated, in `HAZARD_FAMILIES` order. */
  readonly families: readonly HazardFamily[];
  readonly asOf: Date;
  readonly retentionProfile?: 'lean' | 'standard';
  /**
   * Features per response. Defaults to `MAP_FEATURE_CAP`, and exists so that a test can exercise
   * the cap and the merge across subject kinds without seeding two thousand subjects.
   */
  readonly cap?: number;
}

/** One feature and the key the page was selected by, so the merge below uses the same order. */
interface Ranked {
  readonly feature: MapFeature;
  readonly sortAt: Date;
}

export async function buildMapFeatures(
  options: BuildMapFeaturesOptions,
): Promise<MapFeaturesResponse> {
  const { db, bbox, asOf } = options;
  const cap = options.cap ?? MAP_FEATURE_CAP;
  const families = new Set(options.families);

  const windows = eventWindows(options.families, asOf);
  const [eventPage, clusterPage, cutoffs] = await Promise.all([
    canonicalEventsInViewportAsOf(db, { asOf, bbox, windows, limit: cap }),
    families.has('FIRE_ACTIVITY')
      ? clustersInViewportAsOf(db, {
          asOf,
          bbox,
          lastDetectedSince: daysBefore(asOf, FAMILY_RECENCY_DAYS.FIRE_ACTIVITY),
          limit: cap,
        })
      : Promise.resolve({ clusters: [] as ClusterVersionRow[], total: 0 }),
    sourceCutoffsAsOf(db, asOf),
  ]);

  const eventFeatures = await describeEvents(db, asOf, eventPage.events, windows);
  const clusterFeatures = clusterPage.clusters.map((cluster) => describeCluster(cluster, asOf));

  const ranked = [...eventFeatures.ranked, ...clusterFeatures].sort(
    (left, right) =>
      right.sortAt.getTime() - left.sortAt.getTime() ||
      compare(left.feature.subjectRef, right.feature.subjectRef),
  );
  const features = ranked.slice(0, cap).map((entry) => entry.feature);
  const total = eventPage.total + clusterPage.total;

  const shownEvents = new Set(
    features.filter((feature) => feature.kind === 'canonical_event').map((f) => f.publicId),
  );
  // Attribution names exactly the providers whose data is on the map, not every one that was read.
  const attributed = new Set<string>();
  for (const [publicId, ids] of eventFeatures.sourceIdsByEvent) {
    if (shownEvents.has(publicId)) for (const id of ids) attributed.add(id);
  }
  if (features.some((feature) => feature.kind === 'fire_cluster')) {
    attributed.add(FIRE_CLUSTER_SOURCE_ID);
  }
  const attribution = (await attributionsFor(db, [...attributed].sort(compare))).map(toAttribution);

  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    asOfContext: asOfContextFor(
      asOf,
      cutoffs,
      replayHorizonFor(options.retentionProfile ?? 'lean', asOf),
    ),
    bbox,
    bboxParts: splitViewport(bbox),
    zoom: options.zoom,
    families: options.families,
    features,
    truncated: total > features.length,
    cap,
    total,
    attribution,
  };
}

/**
 * The event hazard types the requested families draw, each with its family's recency window.
 *
 * `hazardTypesOf` is the snapshot's own mapping, so `FIRE_ACTIVITY` contributes the GDACS
 * burnt-area event and nothing else: thermal clusters are read separately, as the snapshot reads
 * them.
 */
function eventWindows(
  families: readonly HazardFamily[],
  asOf: Date,
): { hazardType: HazardType; observedSince: Date }[] {
  const windows = new Map<HazardType, Date>();
  for (const family of families) {
    const since = daysBefore(asOf, FAMILY_RECENCY_DAYS[family]);
    for (const hazardType of hazardTypesOf(family)) windows.set(hazardType, since);
  }
  return [...windows]
    .sort(([left], [right]) => compare(left, right))
    .map(([hazardType, observedSince]) => ({ hazardType, observedSince }));
}

/**
 * Describes the page of events: every member of each event, as known at `asOf`, grouped and
 * reduced to one feature.
 *
 * Members are read **wherever they are**, not only inside the viewport. The headline magnitude
 * and the anchor position are properties of the event, and computing them from whichever members
 * happened to be on screen would make an earthquake's magnitude change as the reader panned.
 */
async function describeEvents(
  db: Kysely<DB>,
  asOf: Date,
  page: readonly { readonly canonical_event_id: string; readonly newest_observed_at: Date }[],
  windows: readonly { readonly hazardType: HazardType; readonly observedSince: Date }[],
): Promise<{
  ranked: Ranked[];
  sourceIdsByEvent: [publicId: string, sourceIds: string[]][];
}> {
  if (page.length === 0) return { ranked: [], sourceIdsByEvent: [] };

  const links = await linksAsOf(db, {
    asOf,
    canonicalEventIds: page.map((row) => row.canonical_event_id),
    limit: MEMBER_READ_LIMIT,
  });
  assertBelowLimit(links.length, 'canonical links');

  const sinceByType = new Map(windows.map((window) => [window.hazardType, window.observedSince]));
  const earliest = Math.min(...windows.map((window) => window.observedSince.getTime()));
  const observations = await observationsAsOf(db, {
    asOf,
    sourceRecordIds: links.map((link) => link.source_record_id),
    hazardTypes: [...sinceByType.keys()],
    observedSince: new Date(earliest),
    limit: MEMBER_READ_LIMIT,
  });
  assertBelowLimit(observations.length, 'member observations');

  const linkByRecord = new Map(links.map((link) => [link.source_record_id, link]));
  const membersByEvent = new Map<string, ObservationRow[]>();
  for (const row of observations) {
    // The same per-type window the page was selected with, so no member is admitted by another
    // type's wider window — and none whose own version type was not requested at all.
    const since = sinceByType.get(row.hazard_type as HazardType);
    if (since === undefined || row.observed_at < since) continue;
    const link = linkByRecord.get(row.source_record_id);
    if (link === undefined) continue;
    const group = membersByEvent.get(link.canonical_event_id);
    if (group === undefined) membersByEvent.set(link.canonical_event_id, [row]);
    else group.push(row);
  }

  const ranked: Ranked[] = [];
  const sourceIdsByEvent: [string, string[]][] = [];
  for (const entry of page) {
    const members = membersByEvent.get(entry.canonical_event_id) ?? [];
    const feature = describeEvent(members, linkByRecord);
    if (feature === null) continue;
    ranked.push({ feature, sortAt: entry.newest_observed_at });
    sourceIdsByEvent.push([
      feature.publicId,
      [...new Set(members.map((row) => row.source_id))].sort(compare),
    ]);
  }
  return { ranked, sourceIdsByEvent };
}

/** One canonical event as a feature, or `null` when it cannot be described within the contract. */
function describeEvent(
  rows: readonly ObservationRow[],
  linkByRecord: ReadonlyMap<string, LinkRow>,
): MapFeature | null {
  const members = [...rows].sort((left, right) =>
    compare(left.source_record_id, right.source_record_id),
  );
  const first = members[0];
  if (first === undefined) return null;
  const link = linkByRecord.get(first.source_record_id);
  if (link === undefined) return null;

  const solutions: MemberSolution[] = members.map((row) => ({
    sourceId: row.source_id,
    sourceRecordId: row.source_record_id,
    relation:
      linkByRecord.get(row.source_record_id)?.relation === 'DERIVED_COPY'
        ? 'DERIVED_COPY'
        : 'SAME_EVENT',
    epicentre: { lat: row.lat, lon: row.lon },
    magnitude: numberOf(row.magnitude),
    magnitudeType: row.magnitude_type,
    depthKm: numberOf(row.depth_km),
    providerStatus: row.provider_status,
    contributor: row.contributor,
  }));
  const headline = chooseHeadlineMagnitude(solutions);
  const anchor =
    members.find((row) => row.source_record_id === headline?.member.sourceRecordId) ?? first;

  const hazardType = asHazardType(anchor.hazard_type);
  if (hazardType === null) return null;
  /*
   * No family check here, deliberately. A version whose own hazard type the caller did not ask for
   * never reaches this function: `describeEvents` drops every member whose version type has no
   * requested window, and every requested type maps back to the family that requested it. A
   * mutation run showed a check here could not fail, so it was removed rather than kept as a
   * distinction a reader has to disprove.
   */
  const family = familyOf(hazardType);
  const lifecycleStatus = asLifecycleStatus(anchor.lifecycle_status);
  if (lifecycleStatus === null) return null;

  const magnitude = headline?.member.magnitude ?? numberOf(anchor.magnitude);

  /*
   * The same citations the briefing's card item carries: every member's version and every
   * member's link, because the feature's magnitude and position rest on all of them.
   */
  const evidenceIds: EvidenceId[] = [
    ...members.map((row) => evidenceId.observation(row.version_id)),
    ...members
      .map((row) => linkByRecord.get(row.source_record_id))
      .filter((member): member is LinkRow => member !== undefined)
      .map((member) => evidenceId.correlation(member.link_id)),
  ].sort(compare);

  return {
    subjectRef: formatSubjectRef({ kind: 'canonical_event', publicId: link.canonical_public_id }),
    publicId: link.canonical_public_id,
    kind: 'canonical_event',
    hazardType,
    family,
    geometry: { type: 'Point', coordinates: [anchor.lon, anchor.lat] },
    observedAt: anchor.observed_at.toISOString(),
    isActive: isLive(lifecycleStatus),
    providerSeverity: providerSeverityOf(anchor),
    magnitudeValue: hazardType === 'EARTHQUAKE' ? magnitude : null,
    clusterStatus: null,
    confidence: null,
    label: titleOf(hazardType, anchor, magnitude),
    href: `/events/${link.canonical_public_id}`,
    evidenceIds,
  };
}

/**
 * `ACTIVE` and `UPDATED` are live statements about the world; every other status is an ending,
 * a withdrawal or an expiry. Tombstones never reach here — the reads exclude them.
 */
function isLive(status: LifecycleStatus): boolean {
  return status === 'ACTIVE' || status === 'UPDATED';
}

/**
 * One fire cluster as a feature, drawn at its centroid.
 *
 * The state is derived from `last_detected_at` at `asOf` by `fireClusterState`, never read from
 * `fire_clusters.status`: that column is updated in place as a cluster cools, so at a past
 * knowledge time it would report the present.
 */
function describeCluster(cluster: ClusterVersionRow, asOf: Date): Ranked {
  const hours = (asOf.getTime() - cluster.last_detected_at.getTime()) / (60 * 60 * 1000);
  const state = fireClusterState(hours);
  const evidenceIds: EvidenceId[] = [
    evidenceId.fireClusterVersion(cluster.cluster_version_id),
    evidenceId.detectionSet(cluster.cluster_version_id, cluster.n_total),
  ].sort(compare);

  return {
    sortAt: cluster.last_detected_at,
    feature: {
      subjectRef: formatSubjectRef({ kind: 'fire_cluster', publicId: cluster.public_id }),
      publicId: cluster.public_id,
      kind: 'fire_cluster',
      hazardType: 'THERMAL_ACTIVITY',
      family: 'FIRE_ACTIVITY',
      geometry: { type: 'Point', coordinates: [cluster.centroid_lon, cluster.centroid_lat] },
      observedAt: cluster.last_detected_at.toISOString(),
      isActive: state === 'ACTIVE',
      providerSeverity: null,
      // "Cluster detection count" sizes the symbol (`MapFeature.magnitudeValue`).
      magnitudeValue: cluster.n_total,
      clusterStatus: clusterStatusOf(state),
      /*
       * The cluster's strongest detection confidence, which is GeoNerva's normalization of the
       * provider's value. There is no single raw value for a cluster, so `raw` is null rather
       * than one detection's string standing in for all of them.
       */
      confidence:
        cluster.max_confidence === 'LOW' ||
        cluster.max_confidence === 'NOMINAL' ||
        cluster.max_confidence === 'HIGH'
          ? { class: cluster.max_confidence, raw: null }
          : null,
      label: 'Fire activity',
      href: `/fires/${cluster.public_id}`,
      evidenceIds,
    },
  };
}

/**
 * The frozen status enum for a derived state. `DORMANT` is `INACTIVE`; `MERGED` is never
 * produced, because a cluster merged at or before `asOf` is not read at all.
 */
function clusterStatusOf(state: FireClusterState): FireClusterStatus {
  switch (state) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'COOLING':
      return 'COOLING';
    case 'DORMANT':
      return 'INACTIVE';
  }
}

function toAttribution(row: AttributionRow): Attribution {
  return {
    sourceId: row.source_id,
    name: row.name,
    homepage: row.homepage,
    licence: row.licence,
    attributionText: row.attribution_text,
    termsUrl: row.terms_url,
    disclaimer: row.disclaimer,
  };
}

function assertBelowLimit(count: number, what: string): void {
  if (count >= MEMBER_READ_LIMIT) {
    throw new Error(
      `map features: the ${what} read reached its safety bound of ${String(MEMBER_READ_LIMIT)}`,
    );
  }
}

function daysBefore(at: Date, days: number): Date {
  return new Date(at.getTime() - days * 24 * 60 * 60 * 1000);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
