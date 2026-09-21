/**
 * `buildSnapshot(location, asOf, engineVersion)` — the deterministic view of one place at one
 * knowledge time (DOMAIN_MODEL §4.14, ARCHITECTURE §5).
 *
 * Everything the product shows is derived from this. It is a pure function of the database state,
 * the knowledge time and the engine version — which is invariant I14, and which is what lets a
 * briefing be cached, diffed against an earlier knowledge time, and replayed.
 *
 * ### The three rules that shape this file
 *
 * **There is no second hazard-scoring system here.** Relevance comes from `packages/relevance`,
 * agreement from `packages/correlation`, distance from `packages/geo` or PostGIS. This module
 * reads, groups, and assembles; every judgement it presents was made by a rule that was
 * calibrated and mutation-tested somewhere else. A threshold appearing in this file would be a
 * second opinion nobody reviewed.
 *
 * **An empty family is never an answer on its own.** A card reaches `AVAILABLE` with zero items
 * only when a usable source looked and a derivation ran. Everything else — no source here, every
 * source stale, correlation never run — is `UNAVAILABLE` or `NOT_COVERED` with a reason, and
 * `mayRenderZero` is false (invariant I11).
 *
 * **Order is part of the contract.** Every collection is sorted by an explicit key with a total
 * tiebreak, because a snapshot whose item order depends on the planner hashes differently on
 * every build, and the hash is the cache key for the whole system.
 *
 * ### Subjects come from canonical events, not from source records
 *
 * An item is a *subject* — an earthquake, not USGS's row about an earthquake — so the items of a
 * family are its canonical events, reached through `linksAsOf`. A record with no link has no
 * subject to point at and is therefore **not** shown as an item; that is the case the derivation
 * axis exists to report, and it is why an un-run correlation produces `UNAVAILABLE` rather than a
 * quietly shorter list.
 */

import { createHash } from 'node:crypto';

import type { Kysely } from 'kysely';

import {
  assessAgreement,
  chooseHeadlineMagnitude,
  type MemberSolution,
} from '@geonerva/correlation';
import {
  derivationsAsOf,
  healthAsOf,
  linksAsOf,
  observationsAsOf,
  productCoverageFor,
  sourceCutoffsAsOf,
  type DB,
  type LinkRow,
  type ObservationRow,
  type SourceHealthAsOf,
} from '@geonerva/db';
import {
  HAZARD_FAMILIES,
  READ_MODEL_SCHEMA_VERSION,
  RELEVANCE_RANK,
  SEVERITY_SCHEMES,
  familyOf,
  formatSubjectRef,
  evidenceId,
  type Agreement,
  type AsOfContext,
  type DataConfidence,
  type EvidenceId,
  type Fact,
  type FactValue,
  type FamilyCard,
  type HazardFamily,
  type HazardType,
  type LocationRef,
  type LocationSnapshotView,
  type ProviderSeverity,
  type Reason,
  type RelevanceAssessment,
  type SnapshotOverall,
  type SourceHealthView,
  type SubjectSummary,
} from '@geonerva/domain';
import {
  CYCLONE_TRACK_KM,
  FIRE_OUTER_KM,
  FLOOD_OUTER_KM,
  VOLCANO_OUTER_KM,
  assessCyclone,
  assessEarthquake,
  assessFlood,
  assessVolcano,
  highestRelevance,
  hypocentralDistanceKm,
  resolveAvailability,
  resolveDataConfidence,
  type Assessment,
  type AvailabilityVerdict,
  type DerivationStateInput,
  type SourceAvailabilityInput,
} from '@geonerva/relevance';

import { contentSha256 } from './content-hash.ts';
import { resolveCoverage, familyWords, type FamilyCoverageResult } from './coverage.ts';
import { replayHorizonFor } from './replay-horizon.ts';

/**
 * How far each family looks.
 *
 * Every radius is the outermost distance at which that family's own relevance model can still
 * return an assessment, taken from the model rather than chosen here — `EARTHQUAKE_BANDS` reaches
 * 1,500 km for an M7.5, so anything closer would silently drop events the model would have ranked.
 * A radius invented in this file would be a threshold nobody calibrated.
 */
export const FAMILY_SEARCH_RADIUS_KM: Readonly<Record<HazardFamily, number>> = {
  EARTHQUAKES: 1_500,
  FIRE_ACTIVITY: FIRE_OUTER_KM,
  FLOODS: FLOOD_OUTER_KM,
  CYCLONES: CYCLONE_TRACK_KM,
  WEATHER_ALERTS: 100,
  OTHER: VOLCANO_OUTER_KM,
};

/** Families whose items are produced by a derivation rather than read from the fact store. */
const DERIVED_FAMILIES: Readonly<Partial<Record<HazardFamily, string>>> = {
  EARTHQUAKES: 'CORRELATION',
  FLOODS: 'CORRELATION',
  CYCLONES: 'CORRELATION',
  OTHER: 'CORRELATION',
  FIRE_ACTIVITY: 'CLUSTERING',
};

/** Items per card before truncation. The total is always reported, so a cap is never silent. */
export const DEFAULT_MAX_ITEMS_PER_FAMILY = 20;

export interface BuildSnapshotOptions {
  readonly db: Kysely<DB>;
  readonly location: LocationRef;
  readonly asOf: Date;
  readonly engineVersion: string;
  /** Wall-clock time of the build. Excluded from the hash; defaults to now. */
  readonly generatedAt?: Date;
  readonly maxItemsPerFamily?: number;
  readonly retentionProfile?: 'lean' | 'standard';
}

export interface SnapshotBuild {
  readonly snapshot: LocationSnapshotView;
  readonly asOfContext: AsOfContext;
  /** Every evidence ID the snapshot references, deduplicated and sorted (invariant I9). */
  readonly evidenceIds: readonly EvidenceId[];
}

/** Builds the snapshot. One bounded set of indexed queries, then pure assembly. */
export async function buildSnapshot(options: BuildSnapshotOptions): Promise<SnapshotBuild> {
  const { db, location, asOf, engineVersion } = options;
  const point = { lat: location.lat, lon: location.lon };
  const maxItems = options.maxItemsPerFamily ?? DEFAULT_MAX_ITEMS_PER_FAMILY;

  const [coverageRows, health, cutoffs, derivations] = await Promise.all([
    productCoverageFor(db, point),
    healthAsOf(db, { asOf }),
    sourceCutoffsAsOf(db, asOf),
    derivationsAsOf(db, { asOf }),
  ]);

  const coverage = resolveCoverage(coverageRows);
  const healthByKey = new Map<string, SourceHealthAsOf>();
  for (const entry of health.byProduct) {
    healthByKey.set(healthKey(entry.sourceId, entry.productId), entry);
  }
  const derivationByKind = new Map(derivations.map((entry) => [entry.kind, entry]));

  const families = {} as Record<HazardFamily, FamilyCard>;
  const evidence = new Set<EvidenceId>();

  for (const family of HAZARD_FAMILIES) {
    const card = await buildFamilyCard({
      db,
      family,
      location,
      asOf,
      engineVersion,
      maxItems,
      coverage: coverage[family],
      healthByKey,
      derivation: derivationStateFor(family, derivationByKind),
    });
    families[family] = card.card;
    for (const id of card.evidenceIds) evidence.add(id);
  }

  const overall = buildOverall(families);
  for (const id of overall.evidenceIds) evidence.add(id);

  const sourceHealth = health.byProduct
    .map(toHealthView)
    .sort(
      (left, right) =>
        compare(left.sourceId, right.sourceId) ||
        compare(String(left.productId ?? ''), String(right.productId ?? '')),
    );
  for (const entry of sourceHealth) {
    if (entry.evidenceId !== null) evidence.add(entry.evidenceId);
  }

  const generatedAt = (options.generatedAt ?? new Date()).toISOString();

  /*
   * The hash covers the snapshot's *content*, with `generatedAt` and the hash field itself left
   * out. Two builds of the same knowledge time a minute apart describe the same world and must
   * produce the same key, or every cache in the system misses on every request.
   */
  const hashable = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    asOf: asOf.toISOString(),
    engineVersion,
    location: location.key,
    families,
    overall,
    sourceHealth,
  };

  const snapshot: LocationSnapshotView = {
    asOf: asOf.toISOString(),
    engineVersion,
    generatedAt,
    sourceHealth,
    families,
    overall,
    contentSha256: contentSha256(hashable),
  };

  const asOfContext: AsOfContext = {
    asOf: asOf.toISOString(),
    /*
     * "Materially in the past" rather than "before now": every build has some latency between
     * taking the clock and finishing, and calling a live request a replay because of it would
     * make an immutable-response header depend on how loaded the server was.
     */
    isReplay: Date.now() - asOf.getTime() > REPLAY_THRESHOLD_MS,
    replayHorizon: replayHorizonFor(options.retentionProfile ?? 'lean', asOf),
    sourceCutoffs: Object.fromEntries(
      Object.entries(cutoffs)
        .sort(([left], [right]) => compare(left, right))
        .map(([sourceId, at]) => [sourceId, at === null ? null : at.toISOString()]),
    ),
  };

  return { snapshot, asOfContext, evidenceIds: [...evidence].sort(compare) };
}

/** Five minutes: longer than any build, shorter than any window a user would call a replay. */
const REPLAY_THRESHOLD_MS = 5 * 60 * 1000;

function healthKey(sourceId: string, productId: number | null): string {
  return `${sourceId}/${productId === null ? '-' : String(productId)}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The derivation a family's items depend on, or `undefined` for families read straight through. */
function derivationStateFor(
  family: HazardFamily,
  derivations: ReadonlyMap<string, { readonly lastSucceededAt: Date | null }>,
): { readonly kind: string; readonly lastSucceededAt: Date | null } | undefined {
  const kind = DERIVED_FAMILIES[family];
  if (kind === undefined) return undefined;
  return { kind, lastSucceededAt: derivations.get(kind)?.lastSucceededAt ?? null };
}

interface FamilyCardInput {
  readonly db: Kysely<DB>;
  readonly family: HazardFamily;
  readonly location: LocationRef;
  readonly asOf: Date;
  readonly engineVersion: string;
  readonly maxItems: number;
  readonly coverage: FamilyCoverageResult;
  readonly healthByKey: ReadonlyMap<string, SourceHealthAsOf>;
  readonly derivation: { readonly kind: string; readonly lastSucceededAt: Date | null } | undefined;
}

async function buildFamilyCard(
  input: FamilyCardInput,
): Promise<{ card: FamilyCard; evidenceIds: readonly EvidenceId[] }> {
  const evidence = new Set<EvidenceId>();
  const sourceHealth = input.coverage.sources
    .map((source) => input.healthByKey.get(healthKey(source.sourceId, source.productId)))
    .filter((entry): entry is SourceHealthAsOf => entry !== undefined)
    .map(toHealthView);
  for (const entry of sourceHealth) {
    if (entry.evidenceId !== null) evidence.add(entry.evidenceId);
  }

  const availabilitySources: SourceAvailabilityInput[] = sourceHealth.map((entry) => ({
    sourceId: entry.sourceId,
    productId: entry.productId,
    status: entry.status,
    hasEverSucceeded: entry.lastSuccessAt !== null,
  }));

  /*
   * The subjects are read **before** availability is resolved, because `itemCount` is one of its
   * inputs — but the result is discarded when the verdict is not `AVAILABLE`. Invariant I11 is
   * not "hide the items"; it is that a card which cannot support a claim shows none, and a
   * shorter list would be a claim.
   */
  const found =
    input.coverage.sources.length === 0
      ? { items: [] as SubjectSummary[], newestIngestAt: null as Date | null }
      : await readSubjects(input);
  for (const item of found.items) for (const id of item.evidenceIds) evidence.add(id);

  const derivation: DerivationStateInput | undefined =
    input.derivation === undefined
      ? undefined
      : {
          kind: input.derivation.kind,
          lastSucceededAt: input.derivation.lastSucceededAt,
          newestInputAt: found.newestIngestAt,
        };

  const verdict: AvailabilityVerdict = resolveAvailability({
    coverage: input.coverage.coverage.level,
    sources: availabilitySources,
    itemCount: found.items.length,
    ...(derivation === undefined ? {} : { derivation }),
  });

  const shown = verdict.availability === 'AVAILABLE' ? found.items : [];
  const visible = shown.slice(0, input.maxItems);

  const dataConfidence = buildDataConfidence(input, availabilitySources, shown, verdict);

  return {
    card: {
      family: input.family,
      availability: verdict.availability,
      coverage: input.coverage.coverage,
      items: visible,
      truncated: shown.length > visible.length,
      /*
       * `itemsTotal` is the number of items *behind the card*, which is zero whenever the card is
       * not `AVAILABLE`. Reporting the count of a family GeoNerva has just said it cannot describe
       * would be the zero invariant I11 forbids, wearing a different name.
       */
      itemsTotal: shown.length,
      metrics: [],
      dataConfidence,
      sourceHealth,
      caveats: caveatsFor(input, verdict),
    },
    evidenceIds: [...evidence],
  };
}

/**
 * Confidence in the card, graded by the pure rule.
 *
 * `corroborated` is true only when some item on the card has **two independent sources** by
 * `assessAgreement`'s count, which excludes derived copies — so a GDACS republication of a USGS
 * solution cannot raise a card to `HIGH` by agreeing with the thing it copied (ADR-030).
 */
function buildDataConfidence(
  input: FamilyCardInput,
  sources: readonly SourceAvailabilityInput[],
  items: readonly SubjectSummary[],
  verdict: AvailabilityVerdict,
): DataConfidence {
  const corroborated = items.some((item) => (item.agreement?.nIndependentSources ?? 0) >= 2);
  const level = resolveDataConfidence({
    coverage: input.coverage.coverage.level,
    sources,
    corroborated,
  });

  const reasons: Reason[] = [
    {
      code: `AVAILABILITY_${verdict.reason}`,
      text: availabilitySentence(input, verdict),
      params: {
        family: input.family,
        availability: verdict.availability,
        nSources: sources.length,
        nUnusable: verdict.unusableSources.length,
      },
      evidenceIds: [],
    },
  ];
  return { level, reasons };
}

/** The sentence a card leads with when it is not simply reporting what it found. */
function availabilitySentence(input: FamilyCardInput, verdict: AvailabilityVerdict): string {
  const words = familyWords(input.family);
  switch (verdict.reason) {
    case 'NOT_COVERED_HERE':
      return input.coverage.coverage.note ?? `GeoNerva does not cover ${words} here.`;
    case 'ALL_SOURCES_UNUSABLE':
      return `Every source for ${words} is unavailable, so GeoNerva cannot say what is happening here.`;
    case 'NEVER_SUCCEEDED':
      return `GeoNerva has never successfully read a source for ${words}.`;
    case 'SOME_SOURCES_UNUSABLE':
      return `Some sources for ${words} could not be read: ${verdict.unusableSources.join(', ')}.`;
    case 'DERIVATION_NOT_RUN':
      return `GeoNerva has the underlying data for ${words} but has not finished processing it, so it cannot report on them yet.`;
    case 'DERIVATION_STALE':
      return `GeoNerva is still processing the most recent ${words} data, so this list may be incomplete.`;
    case 'PARTIAL_COVERAGE':
      return input.coverage.coverage.note ?? `Coverage for ${words} here is incomplete.`;
    case 'NOTHING_TO_REPORT':
      return `No ${words} to report here.`;
    case 'OK':
      return `Reporting ${words} from ${String(input.coverage.sources.length)} source${input.coverage.sources.length === 1 ? '' : 's'}.`;
  }
}

function caveatsFor(input: FamilyCardInput, verdict: AvailabilityVerdict): readonly string[] {
  const caveats: string[] = [];
  if (input.coverage.coverage.note !== null) caveats.push(input.coverage.coverage.note);
  if (verdict.reason === 'SOME_SOURCES_UNUSABLE' || verdict.reason === 'DERIVATION_STALE') {
    caveats.push(availabilitySentence(input, verdict));
  }
  return [...new Set(caveats)];
}

/**
 * Reads a family's subjects at `asOf`.
 *
 * Two queries, both indexed: the observations inside the family's radius, and the links that put
 * them into canonical events. Records without an active link contribute **nothing** — they have
 * no subject — but their ingestion times still count toward `newestInputAt`, which is precisely
 * how an un-run correlation becomes visible instead of becoming a short list.
 */
async function readSubjects(
  input: FamilyCardInput,
): Promise<{ items: SubjectSummary[]; newestIngestAt: Date | null }> {
  const hazardTypes = hazardTypesOf(input.family);
  if (hazardTypes.length === 0) return { items: [], newestIngestAt: null };

  const observations = await observationsAsOf(input.db, {
    asOf: input.asOf,
    hazardTypes,
    near: {
      point: { lat: input.location.lat, lon: input.location.lon },
      radiusM: FAMILY_SEARCH_RADIUS_KM[input.family] * 1000,
    },
    limit: 2_000,
  });
  if (observations.length === 0) return { items: [], newestIngestAt: null };

  let newestIngestAt: Date | null = null;
  for (const row of observations) {
    if (newestIngestAt === null || row.ingested_at > newestIngestAt)
      newestIngestAt = row.ingested_at;
  }

  const links = await linksAsOf(input.db, {
    asOf: input.asOf,
    sourceRecordIds: observations.map((row) => row.source_record_id),
    limit: 5_000,
  });
  const linkByRecord = new Map(links.map((link) => [link.source_record_id, link]));

  const byEvent = new Map<string, { link: LinkRow; rows: ObservationRow[] }>();
  for (const row of observations) {
    const link = linkByRecord.get(row.source_record_id);
    if (link === undefined) continue;
    const group = byEvent.get(link.canonical_event_id);
    if (group === undefined) byEvent.set(link.canonical_event_id, { link, rows: [row] });
    else group.rows.push(row);
  }

  const items = [...byEvent.entries()]
    .map(([canonicalEventId, group]) =>
      buildSubject(input, canonicalEventId, group.rows, linkByRecord),
    )
    .filter((item): item is SubjectSummary => item !== null);

  /*
   * Sorted by relevance, then by distance, then by subject reference.
   *
   * The final key is what makes the order total: two equally relevant events at the same distance
   * would otherwise be ordered by the planner, and the snapshot's hash would change between
   * identical builds.
   */
  items.sort(
    (left, right) =>
      RELEVANCE_RANK[right.relevance.level] - RELEVANCE_RANK[left.relevance.level] ||
      left.distanceKm - right.distanceKm ||
      compare(left.subjectRef, right.subjectRef),
  );

  return { items, newestIngestAt };
}

function hazardTypesOf(family: HazardFamily): readonly HazardType[] {
  switch (family) {
    case 'EARTHQUAKES':
      return ['EARTHQUAKE'];
    case 'FLOODS':
      return ['FLOOD'];
    case 'CYCLONES':
      return ['TROPICAL_CYCLONE'];
    case 'OTHER':
      return ['VOLCANO', 'DROUGHT'];
    case 'FIRE_ACTIVITY':
      // Thermal clusters are their own subject with their own public ids; only the GDACS
      // burnt-area event is a canonical event, and it is the one this path can describe.
      return ['WILDFIRE_EVENT'];
    case 'WEATHER_ALERTS':
      return ['WEATHER_ALERT'];
  }
}

/** Assembles one subject from the members of its canonical event. */
function buildSubject(
  input: FamilyCardInput,
  canonicalEventId: string,
  rows: readonly ObservationRow[],
  linkByRecord: ReadonlyMap<string, LinkRow>,
): SubjectSummary | null {
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

  const assessment = assessAgreement(solutions);
  const headline = chooseHeadlineMagnitude(solutions);
  const anchor =
    members.find((row) => row.source_record_id === headline?.member.sourceRecordId) ?? first;

  const distanceKm = (anchor.distance_m ?? 0) / 1000;
  const hazardType = anchor.hazard_type as HazardType;
  const depthKm = numberOf(anchor.depth_km);
  const magnitude = headline?.member.magnitude ?? numberOf(anchor.magnitude);

  const evidenceIds: EvidenceId[] = [
    ...members.map((row) => evidenceId.observation(row.version_id)),
    evidenceId.correlation(link.link_id),
  ].sort(compare);

  const relevance = assessSubject({
    family: input.family,
    location: input.location,
    anchor,
    distanceKm,
    depthKm,
    magnitude,
    agreementLevel: assessment.level,
    corroborated: assessment.nIndependentSources >= 2,
    evidenceIds,
  });
  if (relevance === null) return null;

  return {
    subjectRef: formatSubjectRef({ kind: 'canonical_event', publicId: link.canonical_public_id }),
    hazardType,
    family: familyOf(hazardType),
    publicId: link.canonical_public_id,
    title: titleOf(hazardType, anchor, magnitude),
    observedAt: anchor.observed_at.toISOString(),
    lifecycleStatus: anchor.lifecycle_status as SubjectSummary['lifecycleStatus'],
    providerSeverity: providerSeverityOf(anchor),
    distanceKm: round(distanceKm, 1),
    hypocentralDistanceKm:
      hazardType === 'EARTHQUAKE' ? round(hypocentralDistanceKm(distanceKm, depthKm), 1) : null,
    facts: factsOf(anchor, magnitude, depthKm, evidenceIds),
    relevance,
    agreement: toAgreementView(assessment, evidenceIds),
    evidenceIds,
    href: `/events/${link.canonical_public_id}`,
  };
}

interface SubjectAssessmentInput {
  readonly family: HazardFamily;
  readonly location: LocationRef;
  readonly anchor: ObservationRow;
  readonly distanceKm: number;
  readonly depthKm: number | null;
  readonly magnitude: number | null;
  readonly agreementLevel: string;
  readonly corroborated: boolean;
  readonly evidenceIds: readonly EvidenceId[];
}

/**
 * Hands the subject to its family's relevance model.
 *
 * `CRITICAL` never survives this function without an `authoritativeBasis`: the models return
 * `requiresAuthoritativeBasis` and this is where invariant I10 is enforced, by demoting rather
 * than by trusting the caller to attach one. Nothing here re-scores or overrides a level.
 */
function assessSubject(input: SubjectAssessmentInput): RelevanceAssessment | null {
  const location = { lat: input.location.lat, lon: input.location.lon };
  const severityValue = input.anchor.severity_value;

  /*
   * The GDACS models band on the alert level, so a record without one cannot be assessed by them.
   * Returning `null` drops the subject rather than substituting `Green`, which would be GeoNerva
   * inventing an official judgement that the provider did not publish.
   */
  const alertLevel = alertLevelOf(severityValue);

  let assessment: Assessment | null = null;
  switch (input.family) {
    case 'EARTHQUAKES':
      assessment = assessEarthquake({
        location,
        epicentre: { lat: input.anchor.lat, lon: input.anchor.lon },
        epicentralDistanceKm: input.distanceKm,
        magnitude: input.magnitude,
        depthKm: input.depthKm,
        providerStatus: input.anchor.provider_status,
        severityScheme: input.anchor.severity_scheme,
        severityValue,
        feltReports: feltReportsOf(input.anchor.attributes),
        tsunamiFlag: tsunamiFlagOf(input.anchor.attributes),
        agreementLevel: input.agreementLevel,
        corroborated: input.corroborated,
      });
      break;
    case 'FLOODS':
      assessment =
        alertLevel === null
          ? null
          : assessFlood({
              alertLevel,
              /*
               * Without the affected-area polygon, GeoNerva knows only where the event's centroid
               * is. `hasAreaGeometry: false` selects the centroid-only band, which is deliberately
               * more cautious — an unknown area must not be treated as an area the place is
               * outside of.
               */
              insideArea: false,
              distanceToAreaKm: null,
              centroidDistanceKm: input.distanceKm,
              hasAreaGeometry: false,
            });
      break;
    case 'CYCLONES':
      assessment =
        alertLevel === null
          ? null
          : assessCyclone({
              alertLevel,
              // No wind buffers are held yet, so only the track distance can be stated.
              insideWind120: false,
              insideWind90: false,
              insideWind60: false,
              insideUncertaintyCone: false,
              trackDistanceKm: input.distanceKm,
              isForecastGeometry: false,
              forecastIssuedAt: null,
              forecastAgency: null,
            });
      break;
    case 'OTHER':
      assessment =
        input.anchor.hazard_type === 'VOLCANO' && alertLevel !== null
          ? assessVolcano({
              alertLevel,
              distanceKm: input.distanceKm,
              alertTextVerbatim: null,
            })
          : null;
      break;
    case 'FIRE_ACTIVITY':
    case 'WEATHER_ALERTS':
      assessment = null;
      break;
  }

  if (assessment === null) return null;

  /*
   * Invariant I10, enforced rather than assumed.
   *
   * A model that asks for an authoritative basis has said "this is only CRITICAL if an authority
   * says so". GeoNerva does not hold the authority's statement for these families yet, so the
   * level is demoted to `HIGH` and the reason says why. Returning `CRITICAL` with a null basis
   * would be the one thing the invariant forbids outright.
   */
  const needsBasis = assessment.requiresAuthoritativeBasis;
  const level = needsBasis ? 'HIGH' : assessment.level;
  const reasons: Reason[] = assessment.reasons.map((reason) => ({
    code: reason.code,
    text: reason.text,
    params: reason.params,
    evidenceIds: input.evidenceIds,
  }));
  if (needsBasis) {
    reasons.push({
      code: 'NO_AUTHORITATIVE_BASIS',
      text: 'An official alert would be needed to call this critical, and GeoNerva does not hold one.',
      params: {},
      evidenceIds: input.evidenceIds,
    });
  }

  return {
    level,
    reasons,
    authoritativeBasis: null,
    caveats: assessment.caveats,
    evidenceIds: input.evidenceIds,
    modelVersion: assessment.modelVersion,
  };
}

/**
 * The provider severity, only when GeoNerva knows the scheme it is on.
 *
 * A scheme it does not recognise is dropped rather than passed through: `ProviderSeverity` exists
 * so that a value is never compared across scales, and a scheme string nobody has defined an
 * ordering for would let one be.
 */
function providerSeverityOf(anchor: ObservationRow): ProviderSeverity | null {
  const scheme = anchor.severity_scheme;
  const value = anchor.severity_value;
  if (scheme === null || value === null) return null;
  if (!(SEVERITY_SCHEMES as readonly string[]).includes(scheme)) return null;
  return { scheme: scheme as ProviderSeverity['scheme'], value };
}

/**
 * GDACS's alert level, exactly as GDACS spells it.
 *
 * Case-sensitive on purpose. `orange` is USGS PAGER's spelling and belongs to a different scheme
 * with a different meaning, and accepting either here would quietly compare two scales — which is
 * the one thing `ProviderSeverity` exists to prevent.
 */
function alertLevelOf(value: string | null): 'Green' | 'Orange' | 'Red' | null {
  if (value === 'Green' || value === 'Orange' || value === 'Red') return value;
  return null;
}

function feltReportsOf(attributes: unknown): number | null {
  if (typeof attributes !== 'object' || attributes === null) return null;
  const felt = (attributes as Record<string, unknown>)['felt'];
  return typeof felt === 'number' && Number.isFinite(felt) ? felt : null;
}

function tsunamiFlagOf(attributes: unknown): boolean {
  if (typeof attributes !== 'object' || attributes === null) return false;
  const tsunami = (attributes as Record<string, unknown>)['tsunami'];
  return tsunami === 1 || tsunami === true;
}

/** A deterministic title. Never the provider's own string, which may carry markup. */
function titleOf(hazardType: HazardType, anchor: ObservationRow, magnitude: number | null): string {
  if (hazardType === 'EARTHQUAKE') {
    return magnitude === null ? 'Earthquake' : `M${magnitude.toFixed(1)} earthquake`;
  }
  const titles: Readonly<Record<HazardType, string>> = {
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
  return titles[hazardType];
}

function factsOf(
  anchor: ObservationRow,
  magnitude: number | null,
  depthKm: number | null,
  evidenceIds: readonly EvidenceId[],
): readonly Fact[] {
  const facts: Fact[] = [];
  if (anchor.hazard_type === 'EARTHQUAKE') {
    facts.push({
      code: 'MAGNITUDE',
      label: 'Magnitude',
      value:
        magnitude === null
          ? { kind: 'unavailable', reason: 'NOT_REPORTED_BY_SOURCE' }
          : { kind: 'number', value: magnitude, unit: null, decimals: 1 },
      evidenceIds,
    });
    facts.push({
      code: 'DEPTH',
      label: 'Depth',
      value:
        depthKm === null
          ? { kind: 'unavailable', reason: 'NOT_REPORTED_BY_SOURCE' }
          : { kind: 'number', value: depthKm, unit: 'km', decimals: 0 },
      evidenceIds,
    });
  }
  const severity = providerSeverityOf(anchor);
  if (severity !== null) {
    facts.push({
      code: 'SEVERITY',
      label: 'Alert level',
      value: { kind: 'severity', severity },
      evidenceIds,
    });
  }
  facts.push({
    code: 'OBSERVED_AT',
    label: 'Reported',
    value: { kind: 'timestamp', value: anchor.observed_at.toISOString() },
    evidenceIds,
  });
  return facts;
}

function toAgreementView(
  assessment: ReturnType<typeof assessAgreement>,
  evidenceIds: readonly EvidenceId[],
): Agreement {
  return {
    level: assessment.level,
    nSources: assessment.nSources,
    nIndependentSources: assessment.nIndependentSources,
    reasons: assessment.reasons.map((reason) => ({
      code: reason.code,
      text: reason.text,
      params: {},
      evidenceIds,
    })),
    comparisons: [],
  };
}

/**
 * The single answer to "is something meaningful happening here?" (ARCHITECTURE §9.8).
 *
 * The order of the tests is the whole design. **Unavailability outranks quiet**: a place whose
 * earthquake feed is down must not lead with "nothing significant", because that sentence and
 * "we cannot tell you" look alike on a screen and mean opposite things. So a family GeoNerva
 * cannot describe produces `DATA_UNAVAILABLE` even when every other family is calm.
 */
function buildOverall(families: Readonly<Record<HazardFamily, FamilyCard>>): SnapshotOverall {
  const cards = HAZARD_FAMILIES.map((family) => families[family]);
  const unavailableFamilies = cards
    .filter((card) => card.availability === 'UNAVAILABLE')
    .map((card) => card.family);
  const notCoveredFamilies = cards
    .filter((card) => card.availability === 'NOT_COVERED')
    .map((card) => card.family);

  const levels = cards.flatMap((card) => card.items.map((item) => item.relevance.level));
  const headlineRelevance = highestRelevance(levels);
  const evidenceIds = [
    ...new Set(
      cards.flatMap((card) =>
        card.items
          .filter((item) => item.relevance.level === headlineRelevance)
          .flatMap((item) => item.evidenceIds),
      ),
    ),
  ].sort(compare);

  const coverageStatement =
    notCoveredFamilies.length === 0
      ? 'All hazard types GeoNerva tracks are covered here.'
      : `Not covered here: ${notCoveredFamilies.map(familyWords).join(', ')}.`;

  if (unavailableFamilies.length > 0) {
    return {
      headlineCode: 'DATA_UNAVAILABLE',
      headlineRelevance,
      headlineText: `GeoNerva cannot currently report on ${unavailableFamilies.map(familyWords).join(', ')} here.`,
      coverageStatement,
      unavailableFamilies,
      notCoveredFamilies,
      reasons: cards
        .filter((card) => card.availability === 'UNAVAILABLE')
        .flatMap((card) => card.dataConfidence.reasons),
      evidenceIds,
    };
  }

  if (headlineRelevance === 'CRITICAL' || headlineRelevance === 'HIGH') {
    return {
      headlineCode: 'HIGH_RELEVANCE_PRESENT',
      headlineRelevance,
      headlineText: 'There is something here worth your attention.',
      coverageStatement,
      unavailableFamilies,
      notCoveredFamilies,
      reasons: [],
      evidenceIds,
    };
  }

  return {
    headlineCode: 'NO_HIGH_RELEVANCE_ITEMS',
    headlineRelevance,
    headlineText: 'Nothing here currently needs your attention.',
    coverageStatement,
    unavailableFamilies,
    notCoveredFamilies,
    reasons: [],
    evidenceIds,
  };
}

function toHealthView(entry: SourceHealthAsOf): SourceHealthView {
  return {
    sourceId: entry.sourceId,
    productId: entry.productId,
    status: entry.status,
    lastAttemptAt: entry.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: entry.lastSuccessAt?.toISOString() ?? null,
    newestObservedAt: entry.newestObservedAt?.toISOString() ?? null,
    consecutiveFailures: entry.consecutiveFailures,
    lastErrorClass: entry.lastErrorClass,
    reasons: entry.reasons,
    expected: {
      pollIntervalS: entry.expected.pollIntervalS,
      fetchFreshWithinS: entry.expected.fetchFreshWithinS,
      fetchStaleAfterS: entry.expected.fetchStaleAfterS,
      unavailableAfterS: entry.expected.unavailableAfterS,
      dataCurrentWithinS: entry.expected.dataCurrentWithinS,
      dataStaleAfterS: entry.expected.dataStaleAfterS,
      quietIsNormal: entry.expected.quietIsNormal,
    },
    evidenceId: entry.evidenceId,
  };
}

/** A `numeric` column arrives as a string; an unparseable one is absent, never zero. */
function numberOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Re-exported so a caller can hash a value the same way the snapshot does. */
export { contentSha256, createHash };

/** A `FactValue` helper for callers assembling copy against the same contract. */
export type { FactValue };
