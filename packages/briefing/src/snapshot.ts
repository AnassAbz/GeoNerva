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

import type { Kysely } from 'kysely';

import {
  assessAgreement,
  chooseHeadlineMagnitude,
  type MemberSolution,
} from '@geonerva/correlation';
import {
  clusterVersionsAsOf,
  derivationsAsOf,
  healthAsOf,
  linksAsOf,
  nearestClusterDetections,
  newestDetectionIngestAt,
  observationsAsOf,
  productCoverageFor,
  sourceCutoffsAsOf,
  type ClusterVersionRow,
  type LinkRow,
  type ObservationRow,
  type SourceHealthAsOf,
} from '@geonerva/db/asof';
import type { DB } from '@geonerva/db/schema';
import {
  HAZARD_FAMILIES,
  HAZARD_TYPES,
  LIFECYCLE_STATUSES,
  READ_MODEL_SCHEMA_VERSION,
  RELEVANCE_RANK,
  SEVERITY_SCHEMES,
  familyOf,
  formatSubjectRef,
  evidenceId,
  providerSeveritySchema,
  type Agreement,
  type AsOfContext,
  type DataConfidence,
  type EvidenceId,
  type Fact,
  type FamilyCard,
  type HazardFamily,
  type HazardType,
  type LocationRef,
  type LocationSnapshotView,
  type FieldComparison,
  type LifecycleStatus,
  type ProviderSeverity,
  type Reason,
  type RelevanceAssessment,
  type SnapshotOverall,
  toSourceHealthView,
  type SubjectSummary,
} from '@geonerva/domain';
import {
  CYCLONE_TRACK_KM,
  FIRE_OUTER_KM,
  FLOOD_OUTER_KM,
  VOLCANO_OUTER_KM,
  THERMAL_DETECTION_CAVEAT,
  assessCyclone,
  assessEarthquake,
  assessFire,
  assessFlood,
  assessVolcano,
  fireClusterState,
  highestRelevance,
  hypocentralDistanceKm,
  resolveAvailability,
  resolveDataConfidence,
  type Assessment,
  type AvailabilityVerdict,
  type DerivationStateInput,
  type SourceAvailabilityInput,
  type FireDistanceBasis,
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

/**
 * How far back a family's items reach.
 *
 * A snapshot answers "what is true here now", and without a window it answers "what has ever been
 * true here within the search radius". The 2011 Tōhoku record is 370 km from Tokyo and inside the
 * 1,500 km earthquake radius; assessed on magnitude and distance alone — which is all §9.1's bands
 * use — it ranks `HIGH` forever, and the product's single most load-bearing sentence becomes
 * "There is something here worth your attention", permanently, about an earthquake from 2011.
 *
 * The numbers are not invented here. **30 days** is the recency window the design already uses for
 * earthquakes, in §8's `largest_recent` baseline metric ("largest M in the last 30 d"). **3 days**
 * is the fire detection retention horizon (§12) and the clustering window (§7): beyond it there is
 * nothing to be current about. GDACS families follow the 30-day window for consistency, since a
 * flood or cyclone episode that has had no update in a month is not a current event.
 *
 * This is a product decision that the specification did not previously state, and it is recorded
 * in ADR-037 rather than left implicit in a constant.
 */
export const FAMILY_RECENCY_DAYS: Readonly<Record<HazardFamily, number>> = {
  EARTHQUAKES: 30,
  FIRE_ACTIVITY: 3,
  FLOODS: 30,
  CYCLONES: 30,
  WEATHER_ALERTS: 30,
  OTHER: 30,
};

/**
 * Families whose items are produced by a derivation rather than read from the fact store.
 *
 * The single-source families map to `SEED`, not to `CORRELATION`. They are opened by a derivation
 * that makes no matching decision, and when both wrote the same kind an hourly seed run vouched
 * for an earthquake matcher that had never run.
 */
const DERIVED_FAMILIES: Readonly<Partial<Record<HazardFamily, string>>> = {
  EARTHQUAKES: 'CORRELATION',
  FLOODS: 'SEED',
  CYCLONES: 'SEED',
  OTHER: 'SEED',
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

  /*
   * The build's own clock, taken once.
   *
   * `generatedAt` is what the caller means by "now" — `apps/web` passes the request's single
   * clock, which `serverNow()` may have frozen for an E2E run (docs/TESTING.md §5). Reading
   * `Date.now()` further down for the retention comparison bypassed that: the horizon was decided
   * by the wall clock while everything else in the response was decided by `generatedAt`, so a
   * seeded scenario would silently start reporting `BEYOND_REPLAY_HORIZON` for fire activity
   * three real days after the fixture instant, for no reason a reader of the fixture could see.
   */
  const buildNow = options.generatedAt ?? new Date();

  const coverage = resolveCoverage(coverageRows, asOf);
  const healthByKey = new Map<string, SourceHealthAsOf>();
  for (const entry of health.byProduct) {
    healthByKey.set(healthKey(entry.sourceId, entry.productId), entry);
  }
  const derivationByKind = new Map(derivations.map((entry) => [entry.kind, entry]));

  const replayHorizon = replayHorizonFor(options.retentionProfile ?? 'lean', asOf);
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
      /*
       * The horizon is compared against **now**, not against `asOf`.
       *
       * `replayHorizonFor` expresses the window relative to the knowledge time it is asked about,
       * which is what the response should publish; whether the *data* still exists depends on how
       * long ago that knowledge time was in real terms. Retention has run since.
       */
      beyondReplayHorizon: buildNow.getTime() - asOf.getTime() > FAMILY_RETENTION_MS[family],
    });
    families[family] = card.card;
    for (const id of card.evidenceIds) evidence.add(id);
  }

  const overall = buildOverall(families);
  for (const id of overall.evidenceIds) evidence.add(id);

  /*
   * Only the products that cover this place.
   *
   * `LocationSnapshotView.sourceHealth` is documented as "health of every source relevant to this
   * location". Returning every product in the database put an unrelated feed's cadence, failure
   * count and run UUID into a public cacheable response — and, because `sourceHealth` is inside
   * the hashed content, made an unrelated source's next poll change the content hash of every
   * location's snapshot.
   */
  const relevantKeys = new Set(
    HAZARD_FAMILIES.flatMap((family) =>
      coverage[family].sources.map((source) => healthKey(source.sourceId, source.productId)),
    ),
  );
  const sourceHealth = health.byProduct
    .filter((entry) => relevantKeys.has(healthKey(entry.sourceId, entry.productId)))
    .map(toSourceHealthView)
    .sort(
      (left, right) =>
        compare(left.sourceId, right.sourceId) ||
        compare(String(left.productId ?? ''), String(right.productId ?? '')),
    );
  for (const entry of sourceHealth) {
    if (entry.evidenceId !== null) evidence.add(entry.evidenceId);
  }

  const generatedAt = buildNow.toISOString();

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

  const asOfContext = asOfContextFor(asOf, cutoffs, replayHorizon, buildNow);

  return { snapshot, asOfContext, evidenceIds: [...evidence].sort(compare) };
}

/**
 * The knowledge-time context every read model carries.
 *
 * One function, so that a map and a briefing at the same `asOf` describe that knowledge time
 * identically — the same replay flag, the same horizon, the same cutoffs in the same order.
 */
export function asOfContextFor(
  asOf: Date,
  cutoffs: Readonly<Record<string, Date | null>>,
  replayHorizon: AsOfContext['replayHorizon'],
  now: Date,
): AsOfContext {
  return {
    asOf: asOf.toISOString(),
    /*
     * "Materially in the past" rather than "before now": every build has some latency between
     * taking the clock and finishing, and calling a live request a replay because of it would
     * make an immutable-response header depend on how loaded the server was.
     *
     * `now` is the caller's present, never `Date.now()`. It used to be the wall clock, which made
     * every response a replay whenever the two disagreed: under `GEONERVA_FAKE_NOW` the fixed
     * instant is by construction in the past of the real clock, so a live page rendered the replay
     * banner and a "Return to the present" link that went nowhere. The request already knows what
     * "now" means; a read model that decides it independently is a second clock (P9b).
     */
    isReplay: now.getTime() - asOf.getTime() > REPLAY_THRESHOLD_MS,
    replayHorizon,
    sourceCutoffs: Object.fromEntries(
      Object.entries(cutoffs)
        .sort(([left], [right]) => compare(left, right))
        .map(([sourceId, at]) => [sourceId, at === null ? null : at.toISOString()]),
    ),
  };
}

/** Five minutes: longer than any build, shorter than any window a user would call a replay. */
const REPLAY_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * How far back the store can actually answer for, per family, on the lean profile.
 *
 * ADR-035 requires that a replay past the horizon report "outside the indexed window, never an
 * empty result": retention has dropped the data, the query returns nothing, and every other axis
 * still reads healthy — source health at that knowledge time is derived from runs that committed
 * normally. Without this check the system says nothing happened when what it means is that it no
 * longer remembers.
 */
const FAMILY_RETENTION_MS: Readonly<Record<HazardFamily, number>> = {
  EARTHQUAKES: 30 * 24 * 60 * 60 * 1000,
  FIRE_ACTIVITY: 3 * 24 * 60 * 60 * 1000,
  FLOODS: 5 * 365 * 24 * 60 * 60 * 1000,
  CYCLONES: 5 * 365 * 24 * 60 * 60 * 1000,
  WEATHER_ALERTS: 30 * 24 * 60 * 60 * 1000,
  OTHER: 5 * 365 * 24 * 60 * 60 * 1000,
};

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
  readonly beyondReplayHorizon: boolean;
}

async function buildFamilyCard(
  input: FamilyCardInput,
): Promise<{ card: FamilyCard; evidenceIds: readonly EvidenceId[] }> {
  const evidence = new Set<EvidenceId>();
  const sourceHealth = input.coverage.sources
    .map((source) => input.healthByKey.get(healthKey(source.sourceId, source.productId)))
    .filter((entry): entry is SourceHealthAsOf => entry !== undefined)
    .map(toSourceHealthView);
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
      ? {
          items: [] as SubjectSummary[],
          newestInputAt: null as Date | null,
          unassessed: 0,
          capped: false,
        }
      : await readSubjects(input);

  const derivation: DerivationStateInput | undefined =
    input.derivation === undefined
      ? undefined
      : {
          kind: input.derivation.kind,
          lastSucceededAt: input.derivation.lastSucceededAt,
          newestInputAt: found.newestInputAt,
        };

  const verdict: AvailabilityVerdict = resolveAvailability({
    coverage: input.coverage.coverage.level,
    sources: availabilitySources,
    itemCount: found.items.length,
    unassessedCount: found.unassessed,
    beyondReplayHorizon: input.beyondReplayHorizon,
    ...(derivation === undefined ? {} : { derivation }),
  });

  const shown = verdict.availability === 'AVAILABLE' ? found.items : [];
  const visible = shown.slice(0, input.maxItems);

  /*
   * `mayRenderZero` carried into the contract, through the field that already means it.
   *
   * The verdict says whether a count of zero is something GeoNerva observed. `FamilyCard` has no
   * field for that bit, but it does not need one: invariant I11 states that a card which is not
   * `AVAILABLE` shows no items *and* no zero. So an `AVAILABLE` card with nothing to show and no
   * right to claim emptiness is reported as `UNAVAILABLE` — the truthful reading, not a
   * workaround. A stale derivation with three real clusters still shows them; the same stale
   * derivation with none of them must not say "none".
   *
   * Only `AVAILABLE` is downgraded. `NOT_COVERED` already carries `mayRenderZero: false` and is
   * the *more specific* answer — "no source covers this place" says more than "unavailable" — so
   * rewriting it would lose information rather than protect anything.
   */
  const mustNotClaimEmpty =
    verdict.availability === 'AVAILABLE' && !verdict.mayRenderZero && visible.length === 0;
  const availability = mustNotClaimEmpty ? 'UNAVAILABLE' : verdict.availability;
  const items = availability === 'AVAILABLE' ? visible : [];

  for (const item of items) for (const id of item.evidenceIds) evidence.add(id);

  const dataConfidence = buildDataConfidence(input, availabilitySources, items, verdict);

  return {
    card: {
      family: input.family,
      availability,
      coverage: input.coverage.coverage,
      items,
      /*
       * Truncation covers **both** caps: the display cap and the query cap. Reporting only the
       * first would let a card say `truncated: false` with `itemsTotal: 2000` when the real total
       * is forty thousand — a number presented as a total that is in fact a floor.
       */
      truncated: shown.length > items.length || found.capped,
      /*
       * `itemsTotal` is the number of items *behind the card*, which is zero whenever the card is
       * not `AVAILABLE`. Reporting the count of a family GeoNerva has just said it cannot describe
       * would be the zero invariant I11 forbids, wearing a different name.
       */
      itemsTotal: availability === 'AVAILABLE' ? shown.length : 0,
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
      /*
       * Not "never". `healthAsOf` reads a bounded run window, so what this verdict actually knows
       * is that no successful run is *visible* at this knowledge time — a source that worked until
       * last month and has failed since produces the same verdict. Claiming "never" would be a
       * false statement about the system's own history, and it is exactly the distinction the
       * availability model draws between a configuration problem and an outage.
       */
      return `GeoNerva has no successful read of a source for ${words} within the period it can see.`;
    case 'SOME_SOURCES_UNUSABLE':
      return `Some sources for ${words} could not be read: ${verdict.unusableSources.join(', ')}.`;
    case 'DERIVATION_NOT_RUN':
      return `GeoNerva has the underlying data for ${words} but has not finished processing it, so it cannot report on them yet.`;
    case 'DERIVATION_STALE':
      return `GeoNerva is still processing the most recent ${words} data, so this list may be incomplete.`;
    case 'PARTIAL_COVERAGE':
      return input.coverage.coverage.note ?? `Coverage for ${words} here is incomplete.`;
    case 'SUBJECTS_NOT_ASSESSED':
      return `GeoNerva is holding ${words} here that it has no model to describe, so this list is not complete.`;
    case 'BEYOND_REPLAY_HORIZON':
      return `This knowledge time is outside the window GeoNerva still holds ${words} data for, so it cannot say what was happening.`;
    case 'NOTHING_TO_REPORT':
      return `No ${words} to report here.`;
    case 'OK':
      return `Reporting ${words} from ${String(input.coverage.sources.length)} source${input.coverage.sources.length === 1 ? '' : 's'}.`;
  }
}

function caveatsFor(input: FamilyCardInput, verdict: AvailabilityVerdict): readonly string[] {
  const caveats: string[] = [];
  if (input.coverage.coverage.note !== null) caveats.push(input.coverage.coverage.note);
  for (const note of input.coverage.notes) caveats.push(note);
  if (
    verdict.reason === 'SOME_SOURCES_UNUSABLE' ||
    verdict.reason === 'DERIVATION_STALE' ||
    verdict.reason === 'SUBJECTS_NOT_ASSESSED'
  ) {
    caveats.push(availabilitySentence(input, verdict));
  }
  return [...new Set(caveats)];
}

/** What one family's read returned, including what it could *not* turn into an item. */
interface FoundSubjects {
  readonly items: SubjectSummary[];
  /**
   * The newest fact the family's derivation would have had to read, as known at `asOf`. This is
   * the derivation's **own** input — FIRMS detections for clustering, observation versions for
   * correlation — not whatever the item query happened to return.
   */
  readonly newestInputAt: Date | null;
  /** Subjects found here that no relevance model could assess. Never silently dropped. */
  readonly unassessed: number;
  /** True when the query cap bit, so the card cannot report a floor as a total. */
  readonly capped: boolean;
}

/**
 * Reads a family's subjects at `asOf`.
 *
 * Fire activity takes a different path from every other family, because its subject is different:
 * a fire cluster is computed from FIRMS detections and has its own public id, while every other
 * family's subject is a canonical event reached through `linksAsOf`. Both paths report the
 * derivation input their own derivation actually reads.
 */
async function readSubjects(input: FamilyCardInput): Promise<FoundSubjects> {
  return input.family === 'FIRE_ACTIVITY'
    ? await readFireSubjects(input)
    : await readEventSubjects(input);
}

/** The per-family query cap. Reaching it sets `capped`, so a floor is never shown as a total. */
const SUBJECT_QUERY_LIMIT = 2_000;

function hoursSince(at: Date, asOf: Date): number {
  return (asOf.getTime() - at.getTime()) / (60 * 60 * 1000);
}

/**
 * Fire clusters.
 *
 * `newestInputAt` comes from the **detections**, which is the whole point. An earlier version
 * measured the clustering derivation against GDACS wildfire *events* — a different provider, a
 * different table, and usually empty — so `newestInputAt` was null, the derivation axis could
 * never fire, and a place with 235,707 ingested detections and no clustering run reported "no fire
 * activity to report". That is the exact defect the axis was added to prevent, one layer up.
 */
async function readFireSubjects(input: FamilyCardInput): Promise<FoundSubjects> {
  const near = {
    point: { lat: input.location.lat, lon: input.location.lon },
    radiusM: FAMILY_SEARCH_RADIUS_KM.FIRE_ACTIVITY * 1000,
  };
  const [clusters, newestInputAt] = await Promise.all([
    clusterVersionsAsOf(input.db, { asOf: input.asOf, near, limit: SUBJECT_QUERY_LIMIT }),
    newestDetectionIngestAt(input.db, { asOf: input.asOf, near }),
  ]);

  /*
   * The distance `assessFire` asks for is to the **nearest detection**, not to the centroid. It is
   * exact when the cluster's members can be reconstructed and verified against the version's own
   * count; otherwise it is the distance to the buffered hull, which is never larger than the true
   * value, so a card errs towards "closer" rather than away.
   */
  const nearest = await nearestClusterDetections(input.db, {
    clusters: clusters.map((cluster) => ({
      clusterId: cluster.cluster_id,
      knownAt: cluster.as_of,
      firstDetectedAt: cluster.first_detected_at,
      lastDetectedAt: cluster.last_detected_at,
    })),
    point: near.point,
  });
  const nearestByCluster = new Map(nearest.map((row) => [row.cluster_id, row]));

  let unassessed = 0;
  const items: SubjectSummary[] = [];
  for (const cluster of clusters) {
    const members = nearestByCluster.get(cluster.cluster_id);
    const distance = fireDistanceOf({
      verifiedNearestM:
        members?.count === cluster.n_total && members.nearest_m !== null ? members.nearest_m : null,
      areaDistanceM: cluster.area_distance_m ?? null,
      hasHull: cluster.hull_geojson !== null,
      nTotal: cluster.n_total,
    });
    const item = buildFireSubject(input, cluster, distance);
    if (item === null) {
      /*
       * A `DORMANT` cluster is not an *unassessed* subject. `assessFire` declines it because it is
       * history — a complete answer, not a missing model — so counting it would make every quiet
       * card refuse to render its zero forever, which is the opposite failure.
       */
      const state = fireClusterState(hoursSince(cluster.last_detected_at, input.asOf));
      if (state !== 'DORMANT') unassessed += 1;
      continue;
    }
    items.push(item);
  }

  sortItems(items);
  return {
    items,
    newestInputAt,
    unassessed,
    capped: clusters.length >= SUBJECT_QUERY_LIMIT,
  };
}

/** Canonical-event subjects: earthquakes, floods, cyclones, volcanoes, droughts. */
async function readEventSubjects(input: FamilyCardInput): Promise<FoundSubjects> {
  const hazardTypes = hazardTypesOf(input.family);
  if (hazardTypes.length === 0) {
    return { items: [], newestInputAt: null, unassessed: 0, capped: false };
  }

  /*
   * The recency window. Without it a snapshot answers "what has ever been true here within the
   * search radius", and a 2011 record 370 km from Tokyo ranks `HIGH` forever (ADR-037).
   */
  const observedSince = new Date(
    input.asOf.getTime() - FAMILY_RECENCY_DAYS[input.family] * 24 * 60 * 60 * 1000,
  );

  const observations = await observationsAsOf(input.db, {
    asOf: input.asOf,
    hazardTypes,
    observedSince,
    near: {
      point: { lat: input.location.lat, lon: input.location.lon },
      radiusM: FAMILY_SEARCH_RADIUS_KM[input.family] * 1000,
    },
    limit: SUBJECT_QUERY_LIMIT,
  });
  if (observations.length === 0) {
    return { items: [], newestInputAt: null, unassessed: 0, capped: false };
  }

  let newestInputAt: Date | null = null;
  for (const row of observations) {
    if (newestInputAt === null || row.ingested_at > newestInputAt) newestInputAt = row.ingested_at;
  }

  const links = await linksAsOf(input.db, {
    asOf: input.asOf,
    sourceRecordIds: observations.map((row) => row.source_record_id),
    limit: SUBJECT_QUERY_LIMIT * 3,
  });
  const linkByRecord = new Map(links.map((link) => [link.source_record_id, link]));

  const byEvent = new Map<string, ObservationRow[]>();
  for (const row of observations) {
    const link = linkByRecord.get(row.source_record_id);
    if (link === undefined) continue;
    const group = byEvent.get(link.canonical_event_id);
    if (group === undefined) byEvent.set(link.canonical_event_id, [row]);
    else group.push(row);
  }

  let unassessed = 0;
  const items: SubjectSummary[] = [];
  for (const [canonicalEventId, rows] of byEvent) {
    const item = buildSubject(input, canonicalEventId, rows, linkByRecord);
    /*
     * A subject the models decline is **counted, not dropped**.
     *
     * `assessEarthquake` states this in its own contract: "Returns null when the event cannot be
     * assessed at all, which is not the same as LOW … The caller lists it as unassessed rather
     * than as unimportant." A GDACS Red drought alert 30 km away has no drought model; removing it
     * silently and then reporting `itemCount: 0` turns "we have no model for this" into "nothing
     * is happening", through a channel availability could not otherwise see.
     */
    if (item === null) unassessed += 1;
    else items.push(item);
  }

  sortItems(items);
  return {
    items,
    newestInputAt,
    unassessed,
    capped: observations.length >= SUBJECT_QUERY_LIMIT,
  };
}

/**
 * Sorted by relevance, then by distance, then by subject reference.
 *
 * The final key is what makes the order total: two equally relevant subjects at the same distance
 * would otherwise be ordered by the planner, and the snapshot's hash would change between
 * identical builds.
 */
function sortItems(items: SubjectSummary[]): void {
  items.sort(
    (left, right) =>
      RELEVANCE_RANK[right.relevance.level] - RELEVANCE_RANK[left.relevance.level] ||
      left.distanceKm - right.distanceKm ||
      compare(left.subjectRef, right.subjectRef),
  );
}

/**
 * One fire cluster as a subject.
 *
 * The growth signal is deliberately **not** claimed: `assessFire` compares the last 24 hours with
 * the 24 before, and `ClusterVersionRow` does not carry the earlier count. Passing `0` would make
 * every cluster look as though it had doubled, so the previous count is reported as equal to the
 * current one, which states no growth rather than a growth that was never measured.
 */
function buildFireSubject(
  input: FamilyCardInput,
  cluster: ClusterVersionRow,
  distance: FireDistance,
): SubjectSummary | null {
  // Unknown is `NaN`, which `assessFire` declines: never a distance of zero.
  const nearestDetectionKm = (distance.meters ?? Number.NaN) / 1000;

  const evidenceIds: EvidenceId[] = [
    evidenceId.fireClusterVersion(cluster.cluster_version_id),
    evidenceId.detectionSet(cluster.cluster_version_id, cluster.n_total),
  ].sort(compare);

  const relevance = assessFireCluster({
    asOf: input.asOf,
    lastDetectedAt: cluster.last_detected_at,
    nearestDetectionKm,
    distanceBasis: distance.basis,
    n24h: cluster.n_24h,
    nTotal: cluster.n_total,
    overpasses24h: cluster.overpasses_24h,
    frpSum24h: cluster.frp_sum_24h,
    evidenceIds,
  });
  if (relevance === null) return null;

  return {
    subjectRef: formatSubjectRef({ kind: 'fire_cluster', publicId: cluster.public_id }),
    hazardType: 'THERMAL_ACTIVITY',
    family: 'FIRE_ACTIVITY',
    publicId: cluster.public_id,
    title: 'Fire activity',
    observedAt: cluster.last_detected_at.toISOString(),
    lifecycleStatus: 'ACTIVE',
    providerSeverity: null,
    distanceKm: round(nearestDetectionKm, 1),
    hypocentralDistanceKm: null,
    facts: [
      {
        code: 'DETECTIONS_24H',
        label: 'Detections in the last 24 hours',
        value: { kind: 'count', value: cluster.n_24h },
        evidenceIds,
      },
      {
        code: 'DETECTIONS_TOTAL',
        label: 'Detections in total',
        value: { kind: 'count', value: cluster.n_total },
        evidenceIds,
      },
      {
        code: 'OVERPASSES_24H',
        label: 'Satellite overpasses in the last 24 hours',
        value: { kind: 'count', value: cluster.overpasses_24h },
        evidenceIds,
      },
      {
        code: 'FRP_SUM_24H',
        label: 'Fire radiative power, last 24 hours',
        value:
          cluster.frp_sum_24h === null
            ? { kind: 'unavailable', reason: 'NOT_REPORTED_BY_SOURCE' }
            : { kind: 'number', value: cluster.frp_sum_24h, unit: 'MW', decimals: 0 },
        evidenceIds,
      },
      {
        code: 'LAST_DETECTED_AT',
        label: 'Most recent detection',
        value: { kind: 'timestamp', value: cluster.last_detected_at.toISOString() },
        evidenceIds,
      },
    ],
    relevance,
    agreement: null,
    evidenceIds,
    href: `/fire/${cluster.public_id}`,
  };
}

/** A distance from a place to a fire cluster, and what it was measured to. */
export interface FireDistance {
  readonly meters: number | null;
  readonly basis: FireDistanceBasis;
}

/**
 * The distance `assessFire` is given, and its honest name.
 *
 * Exact to the nearest detection when the members were verified. Otherwise the buffered hull,
 * which every detection pixel lies inside and so is never farther than the nearest one. Without a
 * hull a single-detection cluster's centroid *is* its detection, so that is still exact; for a
 * larger cluster the centroid is only its centre — possibly farther than its nearest detection —
 * and is named as such.
 */
export function fireDistanceOf(input: {
  readonly verifiedNearestM: number | null;
  readonly areaDistanceM: number | null;
  readonly hasHull: boolean;
  readonly nTotal: number;
}): FireDistance {
  if (input.verifiedNearestM !== null) {
    return { meters: input.verifiedNearestM, basis: 'NEAREST_DETECTION' };
  }
  if (input.hasHull) return { meters: input.areaDistanceM, basis: 'CLUSTER_AREA' };
  return {
    meters: input.areaDistanceM,
    basis: input.nTotal === 1 ? 'NEAREST_DETECTION' : 'CLUSTER_CENTRE',
  };
}

export interface FireClusterAssessmentInput {
  readonly asOf: Date;
  readonly lastDetectedAt: Date;
  /** The distance `distanceBasis` names; see `fireDistanceOf`. */
  readonly nearestDetectionKm: number;
  readonly distanceBasis: FireDistanceBasis;
  readonly n24h: number;
  readonly nTotal: number;
  readonly overpasses24h: number;
  readonly frpSum24h: number | null;
  readonly evidenceIds: readonly EvidenceId[];
}

/**
 * A fire cluster's relevance to a place, through `assessFire`, shaped for the read model.
 *
 * One function for the briefing card and the cluster page, so the two cannot disagree about the
 * same cluster. The growth signal is deliberately not claimed — the previous 24-hour count is not
 * held, so it is passed as equal to the current one, which states no growth rather than a growth
 * nobody measured — and `persistentHeatSource` is `false` because nothing sets the flag yet (P1).
 */
export function assessFireCluster(input: FireClusterAssessmentInput): RelevanceAssessment | null {
  const hoursSinceLastDetection = hoursSince(input.lastDetectedAt, input.asOf);
  const assessment = assessFire({
    nearestDetectionKm: input.nearestDetectionKm,
    distanceBasis: input.distanceBasis,
    state: fireClusterState(hoursSinceLastDetection),
    n24h: input.n24h,
    nTotal: input.nTotal,
    overpasses24h: input.overpasses24h,
    nPrevious24h: input.n24h,
    frpSum24h: input.frpSum24h,
    hoursSinceLastDetection,
    officialAlertNearby: false,
    relatedGdacsEventId: null,
    persistentHeatSource: false,
  });
  if (assessment === null) return null;

  const evidenceIds = [...input.evidenceIds];
  return {
    level: assessment.requiresAuthoritativeBasis ? 'HIGH' : assessment.level,
    reasons: assessment.reasons.map((reason) => ({
      code: reason.code,
      text: reason.text,
      params: reason.params,
      evidenceIds,
    })),
    authoritativeBasis: null,
    /*
     * §9.2's caveat is mandatory, and it is asserted here as well as inside the model: a thermal
     * detection is not a confirmed wildfire, and this is the one sentence that must survive
     * every refactor of the card.
     */
    caveats: assessment.caveats.includes(THERMAL_DETECTION_CAVEAT)
      ? assessment.caveats
      : [...assessment.caveats, THERMAL_DETECTION_CAVEAT],
    evidenceIds,
    modelVersion: assessment.modelVersion,
  };
}

export function hazardTypesOf(family: HazardFamily): readonly HazardType[] {
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

/**
 * The members of an event as the correlation package describes them.
 *
 * Shared by the briefing card, the map and the event page, because the headline magnitude and the
 * agreement are computed from exactly this, and three copies of the mapping would be three
 * chances for a derived copy to be counted as a second opinion (ADR-006).
 */
export function memberSolutionsOf(
  rows: readonly ObservationRow[],
  linkByRecord: ReadonlyMap<string, LinkRow>,
): MemberSolution[] {
  return rows.map((row) => ({
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

  const solutions = memberSolutionsOf(members, linkByRecord);

  const assessment = assessAgreement(solutions);
  const headline = chooseHeadlineMagnitude(solutions);
  const anchor =
    members.find((row) => row.source_record_id === headline?.member.sourceRecordId) ?? first;

  /*
   * An unknown distance is not "at your location".
   *
   * Zero is the most alarming value this field can take: it feeds straight into the relevance
   * bands and renders as `0 km`. `near` is always supplied, so `ST_Distance` cannot be null — and
   * if that ever changes, the subject is reported as unassessed rather than as adjacent.
   */
  const distanceM = anchor.distance_m;
  if (distanceM === null || distanceM === undefined || !Number.isFinite(distanceM)) return null;
  const distanceKm = distanceM / 1000;
  /*
   * The column is `text`. A value outside the union — a new adapter, a widened CHECK, a
   * hand-edited row — would otherwise land in the frozen read model as an out-of-contract enum,
   * and `familyOf` would return `undefined` for it. Unrecognised is reported as unassessed.
   */
  const hazardType = asHazardType(anchor.hazard_type);
  if (hazardType === null) return null;
  const lifecycleStatus = asLifecycleStatus(anchor.lifecycle_status);
  if (lifecycleStatus === null) return null;
  const depthKm = numberOf(anchor.depth_km);
  const magnitude = headline?.member.magnitude ?? numberOf(anchor.magnitude);

  /*
   * Every member's link, not just the first.
   *
   * The agreement claim — "2 independent sources agree" — rests on all of the correlation
   * decisions that put these records into one event. Citing one of them leaves the rest of the
   * claim unresolvable, which is a citation that looks like proof and is not.
   */
  const evidenceIds: EvidenceId[] = [
    ...members.map((row) => evidenceId.observation(row.version_id)),
    ...members
      .map((row) => linkByRecord.get(row.source_record_id))
      .filter((member): member is LinkRow => member !== undefined)
      .map((member) => evidenceId.correlation(member.link_id)),
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
    lifecycleStatus,
    providerSeverity: providerSeverityOf(anchor),
    distanceKm: round(distanceKm, 1),
    hypocentralDistanceKm:
      hazardType === 'EARTHQUAKE' ? round(hypocentralDistanceKm(distanceKm, depthKm), 1) : null,
    facts: factsOf(anchor, magnitude, depthKm, evidenceIds),
    relevance,
    agreement: toAgreementView(assessment, members, linkByRecord, evidenceIds),
    evidenceIds,
    href: `/event/${link.canonical_public_id}`,
  };
}

export interface SubjectAssessmentInput {
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
export function assessSubject(input: SubjectAssessmentInput): RelevanceAssessment | null {
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
export function providerSeverityOf(
  anchor: Pick<ObservationRow, 'severity_scheme' | 'severity_value'>,
): ProviderSeverity | null {
  const scheme = anchor.severity_scheme;
  const value = anchor.severity_value;
  if (scheme === null || value === null) return null;
  if (!(SEVERITY_SCHEMES as readonly string[]).includes(scheme)) return null;
  /*
   * Validated through `providerSeveritySchema`, which exists for exactly this and was not being
   * called. `severity_value` is provider-controlled with no CHECK behind it; the schema trims it
   * and bounds it at 64 characters, so an untrimmed or unbounded provider string cannot reach a
   * field the UI renders as a badge — or churn the content hash on whitespace alone.
   */
  const parsed = providerSeveritySchema.safeParse({ scheme, value });
  return parsed.success ? parsed.data : null;
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
export function titleOf(
  hazardType: HazardType,
  anchor: ObservationRow,
  magnitude: number | null,
): string {
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

export function factsOf(
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

/**
 * The agreement block, with the per-field comparisons that make a `CONFLICT` explainable.
 *
 * `FieldComparison` is documented as "what makes `CONFLICT` explainable", and an empty array made
 * it the opposite: an event could ship `{ level: 'CONFLICT', nIndependentSources: 2,
 * comparisons: [] }` alongside a single chosen magnitude presented as the value — which is
 * precisely the "picking one silently would turn a disagreement into a fact" that the agreement
 * module forbids in its own header.
 *
 * Only **independent** members are compared. A derived copy restating a stale magnitude is not a
 * source disagreeing; including it would manufacture a conflict out of a republication.
 */
export function toAgreementView(
  assessment: ReturnType<typeof assessAgreement>,
  members: readonly ObservationRow[],
  linkByRecord: ReadonlyMap<string, LinkRow>,
  evidenceIds: readonly EvidenceId[],
): Agreement {
  const independent = members.filter(
    (row) => linkByRecord.get(row.source_record_id)?.relation !== 'DERIVED_COPY',
  );

  const comparisons: FieldComparison[] = [
    fieldComparison('MAGNITUDE', 'Magnitude', independent, assessment.deltaMagnitude, 1, null),
    fieldComparison('DEPTH', 'Depth', independent, assessment.deltaDepthKm, 0, 'km'),
  ].filter((comparison): comparison is FieldComparison => comparison !== null);

  return {
    level: assessment.level,
    nSources: assessment.nSources,
    nIndependentSources: assessment.nIndependentSources,
    /*
     * `params` carries the numbers the sentence quotes. `Reason.params` is documented as existing
     * "so the AI validator can check that no number was invented" — handing it an empty object
     * leaves every number in the agreement block ungrounded.
     */
    reasons: assessment.reasons.map((reason) => ({
      code: reason.code,
      text: reason.text,
      params: {
        nSources: assessment.nSources,
        nIndependentSources: assessment.nIndependentSources,
        deltaMagnitude: assessment.deltaMagnitude,
        deltaLocationKm:
          assessment.deltaLocationKm === null ? null : round(assessment.deltaLocationKm, 1),
        deltaDepthKm: assessment.deltaDepthKm,
      },
      evidenceIds,
    })),
    comparisons,
  };
}

/** One field across the independent sources, or `null` when fewer than two of them published it. */
function fieldComparison(
  code: 'MAGNITUDE' | 'DEPTH',
  label: string,
  members: readonly ObservationRow[],
  spread: number | null,
  decimals: number,
  unit: string | null,
): FieldComparison | null {
  const values = members
    .map((row) => {
      const raw = code === 'MAGNITUDE' ? row.magnitude : row.depth_km;
      const value = numberOf(raw);
      if (value === null) return null;
      return {
        sourceId: row.source_id,
        contributor: row.contributor,
        value: { kind: 'number' as const, value, unit, decimals },
        evidenceId: evidenceId.observation(row.version_id),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => compare(left.evidenceId, right.evidenceId));

  if (values.length < 2) return null;

  return {
    code,
    label,
    values,
    spread: spread === null ? null : { kind: 'number', value: spread, unit, decimals },
    isConflict: spread !== null && spread > 0,
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

/** The column is `text`; only a value the domain declares may enter the read model. */
export function asHazardType(value: string): HazardType | null {
  return (HAZARD_TYPES as readonly string[]).includes(value) ? (value as HazardType) : null;
}

export function asLifecycleStatus(value: string): LifecycleStatus | null {
  return (LIFECYCLE_STATUSES as readonly string[]).includes(value)
    ? (value as LifecycleStatus)
    : null;
}

/** A `numeric` column arrives as a string; an unparseable one is absent, never zero. */
export function numberOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
