/**
 * `buildEventDetail(publicId, asOf, location?)` — one canonical event, fully explained, at one
 * knowledge time (`GET /api/v1/events/{publicId}`, DOMAIN_MODEL §4.8).
 *
 * The detail view is where the central claim is cashed out: an event is an identity linking
 * provider records, and every value it shows is projected from those records' versions. So this
 * module shows each source's own statement, how the statements agree, every version that led to
 * them, and every correlation decision — including the ones later withdrawn, which a replay before
 * the withdrawal must still show as open.
 *
 * Nothing here judges anything. The headline comes from `chooseHeadlineMagnitude`, agreement from
 * `assessAgreement`, relevance from the family model through `assessSubject`, the revision
 * sentences from `describeRevision` — the same functions the briefing calls, so an event cannot
 * read one way on its card and another on its page.
 *
 * ### Merged identities redirect
 *
 * An event merged at or before `asOf` has handed its records to the survivor; at that knowledge
 * time it has no members and nothing to project. The migration that created the table says what
 * happens next — "merged events' public ids redirect" — so the result names the survivor and the
 * adapter answers with a redirect. The survivor's own detail then lists the old id among its
 * `supersededPublicIds`.
 */

import { assessAgreement, chooseHeadlineMagnitude } from '@geonerva/correlation';
import {
  aliasesAsOf,
  attributionsFor,
  canonicalEventAsOf,
  eventLinkHistoryAsOf,
  geometriesOfVersions,
  linksAsOf,
  observationsAsOf,
  possibleMatchesAsOf,
  relatedSubjectsAsOf,
  sourceCatalog,
  sourceCutoffsAsOf,
  supersededEventIdsAsOf,
  versionHistoryAsOf,
  type LinkRow,
  type ObservationRow,
  type VersionHistoryRow,
} from '@geonerva/db/asof';
import type { DB } from '@geonerva/db/schema';
import {
  GEOMETRY_KINDS,
  GEOMETRY_ROLES,
  READ_MODEL_SCHEMA_VERSION,
  evidenceId,
  familyOf,
  formatSubjectRef,
  type CorrelationDecisionView,
  type EventDetail,
  type EventObservationView,
  type EventTimelineEntry,
  type EvidenceId,
  type GeoJsonGeometry,
  type GeometryKind,
  type GeometryRole,
  type GeometryView,
  type HazardType,
  type LinkMatchKind,
  type LinkRelation,
  type LocationRef,
  type PossibleMatchView,
  type Reason,
  type RelatedEventRef,
} from '@geonerva/domain';
import { hypocentralDistanceKm } from '@geonerva/relevance';
import type { Kysely } from 'kysely';

import { resolveEvidenceManifest, toAttribution } from './briefing.ts';
import { replayHorizonFor } from './replay-horizon.ts';
import {
  asHazardType,
  asLifecycleStatus,
  asOfContextFor,
  assessSubject,
  factsOf,
  memberSolutionsOf,
  numberOf,
  providerSeverityOf,
  titleOf,
  toAgreementView,
} from './snapshot.ts';
import { describeRevision, type VersionValues } from './timeline.ts';

/** Versions shown in a timeline. Far above any provider's real revision count; reaching it is reported. */
export const TIMELINE_CAP = 500;

/**
 * A radius that contains the planet, for reading members *with* their distance and without a
 * spatial restriction: half the equatorial circumference, rounded up.
 */
const WHOLE_EARTH_M = 20_100_000;

/** Every member read is bounded by the event's own membership; this is a safety net, not a cap. */
const MEMBER_LIMIT = 1_000;

export interface BuildEventDetailOptions {
  readonly db: Kysely<DB>;
  readonly publicId: string;
  readonly asOf: Date;
  /**
   * The caller's present, which decides `isReplay`. Defaults to the wall clock for a
   * caller that has no opinion; every caller in this repository has one, and a fixed
   * clock only reaches the response through it.
   */
  readonly now?: Date;
  /** The rounded location the caller supplied, or `null` for no relevance. */
  readonly location: LocationRef | null;
  readonly retentionProfile?: 'lean' | 'standard';
}

export type EventDetailResult =
  | { readonly kind: 'found'; readonly detail: EventDetail }
  | { readonly kind: 'merged'; readonly survivorPublicId: string }
  | { readonly kind: 'not_found'; readonly reason: 'UNKNOWN' | 'NO_MEMBERS' };

export async function buildEventDetail(
  options: BuildEventDetailOptions,
): Promise<EventDetailResult> {
  const { db, publicId, asOf, location } = options;

  const event = await canonicalEventAsOf(db, { publicId, asOf });
  if (event === null) return { kind: 'not_found', reason: 'UNKNOWN' };
  if (event.merged_into_public_id !== null) {
    return { kind: 'merged', survivorPublicId: event.merged_into_public_id };
  }
  const hazardType = asHazardType(event.hazard_type);
  if (hazardType === null) return { kind: 'not_found', reason: 'UNKNOWN' };

  const links = await linksAsOf(db, { asOf, canonicalEventIds: [event.id], limit: MEMBER_LIMIT });
  const linkByRecord = new Map(links.map((link) => [link.source_record_id, link]));
  const recordIds = links.map((link) => link.source_record_id);
  if (recordIds.length === 0) return { kind: 'not_found', reason: 'NO_MEMBERS' };

  const [rows, history, decisions, aliases, nearMisses, related, superseded, catalog, cutoffs] =
    await Promise.all([
      observationsAsOf(db, {
        asOf,
        sourceRecordIds: recordIds,
        // A withdrawal is part of what a source says; the detail shows it, the headline does not use it.
        excludeTombstones: false,
        limit: MEMBER_LIMIT,
        ...(location === null
          ? {}
          : { near: { point: { lat: location.lat, lon: location.lon }, radiusM: WHOLE_EARTH_M } }),
      }),
      versionHistoryAsOf(db, { sourceRecordIds: recordIds, asOf, limit: TIMELINE_CAP }),
      eventLinkHistoryAsOf(db, { canonicalEventId: event.id, asOf }),
      aliasesAsOf(db, { sourceRecordIds: recordIds, asOf }),
      possibleMatchesAsOf(db, { sourceRecordIds: recordIds, asOf }),
      relatedSubjectsAsOf(db, {
        subjectRef: formatSubjectRef({ kind: 'canonical_event', publicId: event.public_id }),
        asOf,
      }),
      supersededEventIdsAsOf(db, { canonicalEventId: event.id, asOf }),
      sourceCatalog(db),
      sourceCutoffsAsOf(db, asOf),
    ]);
  if (rows.length === 0) return { kind: 'not_found', reason: 'NO_MEMBERS' };

  const sourceNames = new Map(catalog.sources.map((source) => [source.source_id, source.name]));
  const productCodes = new Map(
    catalog.products.map((product) => [product.product_id, product.code]),
  );
  const nameOf = (sourceId: string): string => sourceNames.get(sourceId) ?? sourceId;

  const members = [...rows].sort((left, right) =>
    compare(left.source_record_id, right.source_record_id),
  );
  const live = members.filter((row) => !isTombstone(row.lifecycle_status));
  const basis = live.length > 0 ? live : members;

  /*
   * The headline, chosen by the documented precedence among the members that still stand. A
   * withdrawn record cannot be the headline: a deleted USGS solution is not what the event is.
   */
  const solutions = memberSolutionsOf(basis, linkByRecord);
  const headline = chooseHeadlineMagnitude(solutions);
  const anchor =
    basis.find((row) => row.source_record_id === headline?.member.sourceRecordId) ?? basis[0];
  if (anchor === undefined) return { kind: 'not_found', reason: 'NO_MEMBERS' };

  const magnitude = headline?.member.magnitude ?? numberOf(anchor.magnitude);
  const depthKm = numberOf(anchor.depth_km);
  const lifecycleStatus = asLifecycleStatus(anchor.lifecycle_status) ?? 'ACTIVE';

  const citations: EvidenceId[] = [
    ...basis.map((row) => evidenceId.observation(row.version_id)),
    ...basis
      .map((row) => linkByRecord.get(row.source_record_id))
      .filter((link): link is LinkRow => link !== undefined)
      .map((link) => evidenceId.correlation(link.link_id)),
  ].sort(compare);

  const agreementAssessment = assessAgreement(solutions);
  const agreement = toAgreementView(agreementAssessment, basis, linkByRecord, citations);
  const family = familyOf(hazardType);

  /*
   * Relevance only with a location, and only through the family's model. When the model declines
   * — a drought has no model — both relevance and the distance are absent: a distance with no
   * assessment beside it is half an answer the contract forbids.
   */
  const distanceM = anchor.distance_m ?? null;
  const relevance =
    location === null || distanceM === null
      ? null
      : assessSubject({
          family,
          location,
          anchor,
          distanceKm: distanceM / 1000,
          depthKm,
          magnitude,
          agreementLevel: agreementAssessment.level,
          corroborated: agreementAssessment.nIndependentSources >= 2,
          evidenceIds: citations,
        });
  const distanceKm = relevance === null || distanceM === null ? null : round(distanceM / 1000, 1);
  const hypocentral =
    distanceKm === null || distanceM === null || hazardType !== 'EARTHQUAKE'
      ? null
      : round(hypocentralDistanceKm(distanceM / 1000, depthKm), 1);

  const detail: Omit<EventDetail, 'evidenceManifest' | 'attribution'> = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    publicId: event.public_id,
    subjectRef: formatSubjectRef({ kind: 'canonical_event', publicId: event.public_id }),
    hazardType,
    family,
    asOfContext: asOfContextFor(
      asOf,
      cutoffs,
      replayHorizonFor(options.retentionProfile ?? 'lean', asOf),
      options.now ?? new Date(),
    ),
    createdAt: event.created_at.toISOString(),
    headline: {
      title: titleOf(hazardType, anchor, magnitude),
      observedAt: anchor.observed_at.toISOString(),
      lifecycleStatus,
      isActive: lifecycleStatus === 'ACTIVE' || lifecycleStatus === 'UPDATED',
      providerSeverity: providerSeverityOf(anchor),
      preferredSourceId: anchor.source_id,
      preferenceReason: preferenceReason(headline?.rank ?? null, nameOf(anchor.source_id), anchor),
      centroid: { lat: anchor.lat, lon: anchor.lon },
      facts: factsOf(anchor, magnitude, depthKm, citations),
      evidenceIds: citations,
    },
    observations: members.map((row) =>
      observationView(row, linkByRecord, nameOf, productCodes, aliases),
    ),
    agreement,
    timeline: timelineOf(history, nameOf),
    correlation: {
      algorithmVersion: decisions[0]?.algorithm_version ?? links[0]?.algorithm_version ?? 'unknown',
      decisions: decisions.map((row) => decisionView(row)),
      possibleMatches: nearMisses
        .map((row) => possibleMatchView(row))
        .filter((view): view is PossibleMatchView => view !== null),
      agreementLevel: agreement.level,
    },
    geometries: geometryViews(
      await geometriesOfVersions(
        db,
        members.map((row) => row.version_id),
      ),
      members,
    ),
    relevance,
    distanceKm,
    hypocentralDistanceKm: hypocentral,
    // Always null on a served detail: a merged id is answered with a redirect, never a body.
    mergedIntoPublicId: null,
    mergedAt: null,
    supersededPublicIds: superseded,
    relatedEvents: related
      .map((row) => relatedView(row))
      .filter((view): view is RelatedEventRef => view !== null),
  };

  const manifest = await resolveEvidenceManifest(db, asOf, [...citedIn(detail)]);
  const sourceIds = [...new Set(members.map((row) => row.source_id))].sort(compare);
  const attribution = (await attributionsFor(db, sourceIds)).map(toAttribution);

  return { kind: 'found', detail: { ...detail, evidenceManifest: manifest, attribution } };
}

/** What one source says, in its own words and numbers. */
function observationView(
  row: ObservationRow,
  linkByRecord: ReadonlyMap<string, LinkRow>,
  nameOf: (sourceId: string) => string,
  productCodes: ReadonlyMap<number, string>,
  aliases: readonly { readonly source_record_id: string; readonly alias: string }[],
): EventObservationView {
  const link = linkByRecord.get(row.source_record_id);
  const relation = asLinkRelation(link?.relation) ?? 'SAME_EVENT';
  const cite = evidenceId.observation(row.version_id);
  return {
    sourceId: row.source_id,
    sourceName: nameOf(row.source_id),
    productCode: row.product_id === null ? null : (productCodes.get(row.product_id) ?? null),
    contributor: row.contributor,
    relation,
    matchKind: asMatchKind(link?.match_kind) ?? 'SEED',
    isDerivedCopy: relation === 'DERIVED_COPY',
    primaryKey: row.primary_key,
    aliases: aliases
      .filter((entry) => entry.source_record_id === row.source_record_id)
      .map((entry) => entry.alias)
      .filter((alias) => alias !== row.primary_key),
    versionId: row.version_id,
    versionSeq: row.version_seq,
    observedAt: row.observed_at.toISOString(),
    validFrom: row.valid_from?.toISOString() ?? null,
    validTo: row.valid_to?.toISOString() ?? null,
    sourceUpdatedAt: row.source_updated_at?.toISOString() ?? null,
    ingestedAt: row.ingested_at.toISOString(),
    lifecycleStatus: asLifecycleStatus(row.lifecycle_status) ?? 'ACTIVE',
    providerSeverity: providerSeverityOf(row),
    providerStatus: row.provider_status,
    title: row.title,
    sourceUrl: httpUrlOrNull(row.source_url),
    facts: factsOf(row, numberOf(row.magnitude), numberOf(row.depth_km), [cite]),
    evidenceId: cite,
  };
}

/**
 * The timeline, newest first, each version described against the previous version **of the
 * same record**.
 */
function timelineOf(
  history: readonly VersionHistoryRow[],
  nameOf: (sourceId: string) => string,
): EventTimelineEntry[] {
  const oldestFirst = [...history].sort(
    (left, right) =>
      left.ingested_at.getTime() - right.ingested_at.getTime() ||
      left.version_seq - right.version_seq ||
      compare(left.version_id, right.version_id),
  );
  const previousByRecord = new Map<string, VersionValues>();
  const entries: EventTimelineEntry[] = [];
  for (const row of oldestFirst) {
    const values = versionValues(row);
    const described = describeRevision(
      nameOf(row.source_id),
      previousByRecord.get(row.source_record_id) ?? null,
      values,
    );
    previousByRecord.set(row.source_record_id, values);
    entries.push({
      versionId: row.version_id,
      versionSeq: row.version_seq,
      sourceId: row.source_id,
      ingestedAt: row.ingested_at.toISOString(),
      observedAt: row.observed_at.toISOString(),
      sourceUpdatedAt: row.source_updated_at?.toISOString() ?? null,
      lifecycleStatus: values.lifecycleStatus,
      summary: described.summary,
      changedFields: described.changedFields,
      changes: described.changes,
      evidenceId: evidenceId.observation(row.version_id),
    });
  }
  return entries.reverse();
}

function versionValues(row: VersionHistoryRow): VersionValues {
  return {
    observedAt: row.observed_at,
    lifecycleStatus: asLifecycleStatus(row.lifecycle_status) ?? 'ACTIVE',
    magnitude: numberOf(row.magnitude),
    magnitudeType: row.magnitude_type,
    depthKm: numberOf(row.depth_km),
    lat: row.lat,
    lon: row.lon,
    severity: providerSeverityOf(row),
    providerStatus: row.provider_status,
  };
}

function decisionView(
  row: Awaited<ReturnType<typeof eventLinkHistoryAsOf>>[number],
): CorrelationDecisionView {
  const cite = evidenceId.correlation(row.link_id);
  return {
    linkId: row.link_id,
    sourceId: row.source_id,
    primaryKey: row.primary_key,
    relation: asLinkRelation(row.relation) ?? 'SAME_EVENT',
    matchKind: asMatchKind(row.match_kind) ?? 'SEED',
    confidence: unitInterval(row.confidence),
    reasons: reasonsOf(row.reasons, [cite]),
    linkedAt: row.linked_at.toISOString(),
    unlinkedAt: row.unlinked_at?.toISOString() ?? null,
    unlinkReason: row.unlinked_at === null ? null : row.unlink_reason,
    evidenceId: cite,
  };
}

/**
 * A near-miss, or `null` when it carries no score. `POSSIBLE_MATCH` is defined by a score, and a
 * near-miss shown without one would be a claim of closeness with nothing behind it.
 */
function possibleMatchView(
  row: Awaited<ReturnType<typeof possibleMatchesAsOf>>[number],
): PossibleMatchView | null {
  const score = unitInterval(row.score);
  if (score === null) return null;
  return {
    otherPublicId: row.other_public_id,
    sourceId: row.other_source_id,
    primaryKey: row.other_primary_key,
    score,
    reasons: reasonsOf(row.reasons, []),
    evaluatedAt: row.evaluated_at.toISOString(),
  };
}

/** A related subject, or `null` when its hazard type is outside the contract. */
export function relatedView(
  row: Awaited<ReturnType<typeof relatedSubjectsAsOf>>[number],
): RelatedEventRef | null {
  const hazardType = asHazardType(row.other_hazard_type ?? '');
  if (hazardType === null) return null;
  const isCluster = row.other_ref.startsWith('FC:');
  const publicId = row.other_ref.slice(row.other_ref.indexOf(':') + 1);
  return {
    subjectRef: row.other_ref,
    publicId,
    hazardType,
    relation: row.relation,
    label: RELATED_LABELS[hazardType],
    href: isCluster ? `/fire/${publicId}` : `/event/${publicId}`,
    reasons: reasonsOf(row.reasons, []),
  };
}

const RELATED_LABELS: Readonly<Record<HazardType, string>> = {
  EARTHQUAKE: 'Earthquake',
  THERMAL_ACTIVITY: 'Fire activity',
  WILDFIRE_EVENT: 'Wildfire event',
  FLOOD: 'Flood',
  TROPICAL_CYCLONE: 'Tropical cyclone',
  VOLCANO: 'Volcanic activity',
  DROUGHT: 'Drought',
  WEATHER_ALERT: 'Weather warning',
  TSUNAMI: 'Tsunami',
  OTHER: 'Hazard',
};

/** Role-tagged geometries, each citing the version it belongs to. Unknown roles are left out. */
function geometryViews(
  rows: Awaited<ReturnType<typeof geometriesOfVersions>>,
  members: readonly ObservationRow[],
): GeometryView[] {
  const kindByVersion = new Map(members.map((row) => [row.version_id, row.geometry_kind]));
  const views: GeometryView[] = [];
  for (const row of rows) {
    if (!(GEOMETRY_ROLES as readonly string[]).includes(row.role)) continue;
    const kind = kindByVersion.get(row.version_id);
    if (kind === undefined || !(GEOMETRY_KINDS as readonly string[]).includes(kind)) continue;
    views.push({
      role: row.role as GeometryRole,
      kind: kind as GeometryKind,
      geometry: JSON.parse(row.geojson) as GeoJsonGeometry,
      validAt: row.valid_at?.toISOString() ?? null,
      isForecast: row.is_forecast,
      evidenceIds: [evidenceId.observation(row.version_id)],
    });
  }
  return views;
}

/**
 * Why the headline source was preferred, in the words of the precedence itself (ARCHITECTURE
 * §6.1): "USGS reviewed > EMSC > USGS automatic > derived copies".
 */
function preferenceReason(rank: number | null, sourceName: string, anchor: ObservationRow): Reason {
  const cite = [evidenceId.observation(anchor.version_id)];
  if (rank === null) {
    return {
      code: 'NO_MAGNITUDE_REPORTED',
      text: `No source reported a magnitude, so ${sourceName}'s record is shown.`,
      params: { sourceId: anchor.source_id },
      evidenceIds: cite,
    };
  }
  const why =
    rank === 1
      ? 'a reviewed USGS solution comes first'
      : rank === 2
        ? 'EMSC comes after a reviewed USGS solution'
        : rank === 3
          ? 'an automatic USGS solution comes after EMSC'
          : rank === 4
            ? 'a copy of another provider comes last'
            : 'this source has no decided place in the order, so it sits between EMSC and an automatic USGS solution';
  return {
    code: 'HEADLINE_PRECEDENCE',
    text: `${sourceName}'s values are shown because ${why}.`,
    params: { sourceId: anchor.source_id, rank },
    evidenceIds: cite,
  };
}

/**
 * Reasons as stored by the correlation writer: `{ code, text, params }` in a `jsonb` column.
 *
 * Validated rather than trusted — the column has no schema — and each is given the citation of
 * the decision it explains. An entry that is not that shape is dropped, not coerced: a reason
 * rendered from half an object would put words in the correlation engine's mouth.
 */
function reasonsOf(raw: unknown, evidenceIds: readonly EvidenceId[]): Reason[] {
  if (!Array.isArray(raw)) return [];
  const reasons: Reason[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record['code'] !== 'string' || typeof record['text'] !== 'string') continue;
    const params: Record<string, string | number | boolean | null> = {};
    const rawParams = record['params'];
    if (typeof rawParams === 'object' && rawParams !== null && !Array.isArray(rawParams)) {
      for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        ) {
          params[key] = value;
        }
      }
    }
    reasons.push({
      code: record['code'],
      text: record['text'],
      params,
      evidenceIds: [...evidenceIds],
    });
  }
  return reasons;
}

/** Every evidence id the detail cites, for the manifest (I9). */
function citedIn(detail: Omit<EventDetail, 'evidenceManifest' | 'attribution'>): Set<EvidenceId> {
  const ids = new Set<EvidenceId>(detail.headline.evidenceIds);
  for (const view of detail.observations) ids.add(view.evidenceId);
  for (const entry of detail.timeline) ids.add(entry.evidenceId);
  for (const decision of detail.correlation.decisions) ids.add(decision.evidenceId);
  for (const geometry of detail.geometries) for (const id of geometry.evidenceIds) ids.add(id);
  for (const fact of detail.headline.facts) for (const id of fact.evidenceIds) ids.add(id);
  for (const reason of detail.agreement.reasons) for (const id of reason.evidenceIds) ids.add(id);
  for (const comparison of detail.agreement.comparisons) {
    for (const value of comparison.values) ids.add(value.evidenceId);
  }
  if (detail.relevance !== null) {
    for (const id of detail.relevance.evidenceIds) ids.add(id);
    for (const reason of detail.relevance.reasons) for (const id of reason.evidenceIds) ids.add(id);
  }
  return ids;
}

function isTombstone(status: string): boolean {
  return status === 'DELETED' || status === 'MISSING_FROM_SOURCE';
}

function asLinkRelation(value: string | undefined): LinkRelation | null {
  return value === 'PRIMARY' || value === 'SAME_EVENT' || value === 'DERIVED_COPY' ? value : null;
}

function asMatchKind(value: string | undefined): LinkMatchKind | null {
  return value === 'IDENTITY_REF' || value === 'SPATIOTEMPORAL' || value === 'SEED' ? value : null;
}

/** A `numeric` in [0, 1], or `null` — never a value outside the range the contract allows. */
function unitInterval(value: string | null): number | null {
  const parsed = numberOf(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

/** A provider URL is served only when it is an http(s) URL; anything else is dropped. */
function httpUrlOrNull(value: string | null): string | null {
  return value !== null && /^https?:\/\//iu.test(value) ? value : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
