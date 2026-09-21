/**
 * The correlation derivation: pure decisions, applied to the database (ARCHITECTURE §6.1).
 *
 * `packages/correlation` decides; this runs. The split is not ceremony — every threshold, veto and
 * tiebreak is a pure function over two solutions, which is what makes the calibration against the
 * labelled set (`docs/reviews/correlation-calibration.md`) mean anything. Nothing here re-decides
 * a match, and nothing here reaches for a value the engine did not return.
 *
 * ### What this loop is careful about
 *
 * **Order.** Records are correlated in origin-time order, so an aftershock is scored against the
 * events that existed before it rather than against whichever row the planner returned first.
 * Within one origin time the id breaks the tie. A correlation run over the same facts produces
 * the same links, which is invariant I14 reaching back from the snapshot into the derivation that
 * feeds it.
 *
 * **Asymmetry.** A wrong `MATCH` destroys the distinction between two earthquakes and then reports
 * the result as corroborated by two sources. A wrong `NO_MATCH` shows two events instead of one.
 * So a `POSSIBLE_MATCH` writes a `correlation_candidates` row and **creates a separate event** —
 * the pair is recorded, not merged, and the UI can say "possibly the same event".
 *
 * **Revisions.** A linked record whose solution moved is re-scored against the event it belongs
 * to, and hysteresis keeps the link unless the new misfit is beyond `HYSTERESIS_MISFIT`. Without
 * it, links flap as solutions are refined and "What Changed?" fills with merges and splits that no
 * earthquake caused.
 *
 * **Non-earthquake GDACS events** are each their own canonical event with a `PRIMARY`, `SEED`
 * link. GeoNerva holds exactly one source for floods, cyclones and volcanoes, so there is nothing
 * to correlate *against*; the canonical event exists so that the read model has a stable subject
 * to point at, not because a decision was made.
 */

import {
  CANDIDATE_WINDOW,
  EARTHQUAKE_ALGORITHM_VERSION,
  IDENTITY_REF_PENDING_HOURS,
  assessAgreement,
  candidateScore,
  chooseHeadlineMagnitude,
  computeMisfit,
  decideIdentityRef,
  decideSpatiotemporal,
  revisionKeepsLink,
  type Candidate,
  type Decision,
  type MemberSolution,
  type Solution,
} from '@geonerva/correlation';
import {
  candidateEventsNear,
  canonicalEventForAlias,
  createCanonicalEvent,
  earthquakeRecordsToCorrelate,
  eventMembers,
  finishAnalysisRun,
  insertCorrelationCandidate,
  linkRecord,
  recordsNeedingSeedEvent,
  startAnalysisRun,
  unlinkRecord,
  upsertCanonicalEventState,
  type CandidateEventRow,
  type CorrelationRecordRow,
  type DB,
} from '@geonerva/db';
import type { Kysely } from 'kysely';

import type { HazardType } from '@geonerva/domain';
import { HAZARD_TYPES_BY_FAMILY } from '@geonerva/domain';

const EARTHQUAKE: HazardType = 'EARTHQUAKE';

export interface CorrelateOptions {
  /** Knowledge time. Facts ingested after this are not considered. Defaults to now. */
  readonly asOf?: Date;
  readonly limit?: number;
  readonly sourceIds?: readonly string[];
}

export interface CorrelateResult {
  readonly runId: string;
  readonly considered: number;
  readonly matched: number;
  readonly identityMatched: number;
  readonly created: number;
  readonly possible: number;
  readonly revisionsKept: number;
  readonly revisionsBroken: number;
  /**
   * Records held back because the provider's cross-reference names an event GeoNerva has not
   * ingested yet, and the 24-hour fallback horizon has not passed.
   */
  readonly pendingIdentityRef: number;
  /** Events whose projection was rebuilt, deduplicated. */
  readonly projected: number;
}

/** A `numeric` column arrives as a string; `null` stays `null` rather than becoming 0. */
function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function solutionOf(row: CorrelationRecordRow): Solution {
  return {
    sourceId: row.source_id,
    epicentre: { lat: row.lat, lon: row.lon },
    originTime: row.observed_at,
    magnitude: num(row.magnitude),
    magnitudeType: row.magnitude_type,
    contributor: row.contributor,
  };
}

/**
 * The solution that represents an existing event, for scoring.
 *
 * `canonical_event_state` stores the projected centroid, origin time and magnitude; the magnitude
 * *type* and contributor live in the `headline` object this runner writes, because the misfit
 * needs both — the magnitude term is halved across families, and the contributor is what suspends
 * the veto for a republication (ADR-030). Reading them from the projection rather than re-reading
 * the members keeps candidate generation to one indexed query.
 */
function representativeOf(row: CandidateEventRow): Solution {
  const headline =
    typeof row.headline === 'object' && row.headline !== null
      ? (row.headline as Record<string, unknown>)
      : {};
  const magnitudeType =
    typeof headline['magnitudeType'] === 'string' ? headline['magnitudeType'] : null;
  const contributor = typeof headline['contributor'] === 'string' ? headline['contributor'] : null;
  return {
    sourceId: typeof headline['sourceId'] === 'string' ? headline['sourceId'] : 'canonical',
    epicentre: { lat: row.lat, lon: row.lon },
    originTime: row.observed_at,
    magnitude: num(row.magnitude),
    magnitudeType,
    contributor,
  };
}

/** The `derivedFrom` cross-reference a provider published, when it is one we can resolve. */
function upstreamRefOf(derivedFrom: unknown): { source: string; ref: string } | null {
  if (typeof derivedFrom !== 'object' || derivedFrom === null) return null;
  const record = derivedFrom as Record<string, unknown>;
  const source = record['source'];
  const ref = record['ref'];
  if (typeof source !== 'string' || typeof ref !== 'string') return null;
  return { source, ref };
}

/**
 * Correlates every earthquake record that is not up to date.
 *
 * One transaction per record rather than one for the whole run. A correlation run over a backfill
 * touches tens of thousands of records, and a single transaction would hold locks on
 * `canonical_event_state` for its entire duration while making the whole run all-or-nothing — but
 * the run is *resumable by construction*, because what it processes is defined by the database
 * state it reads, not by a cursor it holds. A run that dies halfway leaves correct links for what
 * it finished and the next run picks up the rest.
 */
export async function correlateEarthquakes(
  db: Kysely<DB>,
  options: CorrelateOptions = {},
): Promise<CorrelateResult> {
  const asOf = options.asOf ?? new Date();

  const runId = await startAnalysisRun(db, {
    kind: 'CORRELATION',
    asOf,
    engineVersion: EARTHQUAKE_ALGORITHM_VERSION,
    startedAt: new Date(),
  });

  const stats = {
    considered: 0,
    matched: 0,
    identityMatched: 0,
    created: 0,
    possible: 0,
    revisionsKept: 0,
    revisionsBroken: 0,
    pendingIdentityRef: 0,
  };
  const touched = new Set<string>();

  try {
    const records = await earthquakeRecordsToCorrelate(db, {
      asOf,
      limit: options.limit,
      sourceIds: options.sourceIds,
    });

    for (const row of records) {
      stats.considered += 1;
      const outcome = await correlateOne(db, row, asOf);
      /*
       * The projection is refreshed **immediately**, not at the end of the run.
       *
       * Candidate generation reads `canonical_event_state`, so an event created earlier in this
       * same run is invisible to every later record until its projection exists — a USGS record
       * and the EMSC solution of the same earthquake, correlated in one pass, would each open
       * their own event and the run would silently produce two. Deferring the refresh made the
       * result depend on how the work happened to be batched, which is exactly what the ordering
       * guarantees are for.
       *
       * It stays outside the record's transaction: the links are the facts, the projection is a
       * rebuildable cache, and a cache failure must not roll back a correct link.
       */
      for (const eventId of outcome.touched) {
        touched.add(eventId);
        await projectCanonicalEvent(db, eventId, asOf);
      }
      if (outcome.kind === 'IDENTITY_MATCH') stats.identityMatched += 1;
      if (outcome.kind === 'MATCH') stats.matched += 1;
      if (outcome.kind === 'CREATED') stats.created += 1;
      if (outcome.kind === 'POSSIBLE') stats.possible += 1;
      if (outcome.kind === 'REVISION_KEPT') stats.revisionsKept += 1;
      if (outcome.kind === 'REVISION_BROKEN') stats.revisionsBroken += 1;
      if (outcome.kind === 'PENDING_IDENTITY_REF') stats.pendingIdentityRef += 1;
    }

    await finishAnalysisRun(db, {
      id: runId,
      status: 'SUCCEEDED',
      stats: { ...stats, projected: touched.size },
    });
  } catch (error) {
    await finishAnalysisRun(db, {
      id: runId,
      status: 'FAILED',
      stats,
      errorClass: 'INTERNAL',
    });
    throw error;
  }

  return { runId, ...stats, projected: touched.size };
}

type OutcomeKind =
  | 'IDENTITY_MATCH'
  | 'PENDING_IDENTITY_REF'
  | 'MATCH'
  | 'CREATED'
  | 'POSSIBLE'
  | 'REVISION_KEPT'
  | 'REVISION_BROKEN';

interface Outcome {
  readonly kind: OutcomeKind;
  readonly touched: readonly string[];
}

async function correlateOne(
  db: Kysely<DB>,
  row: CorrelationRecordRow,
  asOf: Date,
): Promise<Outcome> {
  const solution = solutionOf(row);

  /*
   * A record that already has a link is a *revision*, and it is re-scored against the event it
   * belongs to before anything else happens. Sending it back through candidate generation would
   * ask "where does this belong?" when the answer is already recorded and the real question is
   * whether that answer survived.
   */
  if (row.canonical_event_id !== null) {
    return await reevaluateRevision(db, row, solution, asOf);
  }

  const upstream = upstreamRefOf(row.derived_from);
  if (upstream !== null) {
    const resolved = await canonicalEventForAlias(db, upstream.source, upstream.ref);
    const decision = decideIdentityRef({
      upstreamRef: upstream.ref,
      resolvedCanonicalEventId: resolved?.canonicalEventId ?? null,
    });
    const identityEventId = decision.canonicalEventId;
    if (decision.verdict === 'MATCH' && identityEventId !== null) {
      await db.transaction().execute(async (trx) => {
        await linkRecord(trx, {
          canonicalEventId: identityEventId,
          sourceRecordId: row.source_record_id,
          relation: decision.relation,
          matchKind: decision.matchKind,
          confidence: decision.confidence,
          reasons: decision.reasons,
          algorithmVersion: decision.algorithmVersion,
          linkedAt: asOf,
        });
      });
      return { kind: 'IDENTITY_MATCH', touched: [identityEventId] };
    }
    /*
     * The reference did not resolve. ARCHITECTURE §6.1 keeps such a record *pending* for 24 hours
     * before falling back to Stage 2, because GDACS can arrive before the USGS record it points
     * at, and correlating it spatiotemporally in the meantime would create an event that a later
     * USGS ingestion has to merge away. Below the horizon it is left alone entirely: the next run
     * re-reads it, which is what "pending" means when the work list is derived from the database.
     */
    const ageMs = asOf.getTime() - row.observed_at.getTime();
    if (ageMs < IDENTITY_REF_PENDING_HOURS * 60 * 60 * 1000) {
      return { kind: 'PENDING_IDENTITY_REF', touched: [] };
    }
  }

  const candidates = await loadCandidates(db, solution);
  const decision = decideSpatiotemporal(solution, candidates);
  return await applySpatiotemporal(db, row, decision, asOf);
}

async function loadCandidates(db: Kysely<DB>, solution: Solution): Promise<Candidate[]> {
  const rows = await candidateEventsNear(db, {
    originTime: solution.originTime,
    epicentre: solution.epicentre,
    maxDeltaSeconds: CANDIDATE_WINDOW.maxDeltaSeconds,
    maxDistanceMeters: CANDIDATE_WINDOW.maxDistanceMeters,
  });
  return rows.map((candidate) => ({
    canonicalEventId: candidate.canonical_event_id,
    representative: representativeOf(candidate),
    memberSourceIds: candidate.member_source_ids,
  }));
}

async function applySpatiotemporal(
  db: Kysely<DB>,
  row: CorrelationRecordRow,
  decision: Decision,
  asOf: Date,
): Promise<Outcome> {
  if (decision.verdict === 'MATCH' && decision.canonicalEventId !== null) {
    const eventId = decision.canonicalEventId;
    await db.transaction().execute(async (trx) => {
      await linkRecord(trx, {
        canonicalEventId: eventId,
        sourceRecordId: row.source_record_id,
        relation: decision.relation,
        matchKind: decision.matchKind,
        confidence: decision.confidence,
        reasons: decision.reasons,
        algorithmVersion: decision.algorithmVersion,
        linkedAt: asOf,
      });
    });
    return { kind: 'MATCH', touched: [eventId] };
  }

  /*
   * `POSSIBLE_MATCH` and `NO_MATCH` both open a new canonical event. They differ in what else is
   * written: a possible match records the pair it declined to merge, so the event page can say
   * "possibly the same event as …" rather than silently showing two. The candidate row is what
   * makes an unmerged pair *visible* instead of merely unmerged.
   */
  const eventId = await db.transaction().execute(async (trx) => {
    const created = await createCanonicalEvent(trx, {
      hazardType: EARTHQUAKE,
      createdAt: asOf,
    });
    await linkRecord(trx, {
      canonicalEventId: created.id,
      sourceRecordId: row.source_record_id,
      relation: 'PRIMARY',
      matchKind: decision.matchKind,
      confidence: decision.confidence,
      reasons: decision.reasons,
      algorithmVersion: decision.algorithmVersion,
      linkedAt: asOf,
    });
    return created.id;
  });

  if (decision.verdict === 'POSSIBLE_MATCH') {
    const best = decision.scored.find((candidate) => candidate.excluded === null);
    if (best !== undefined) {
      const members = await eventMembers(db, best.canonicalEventId);
      const other = members[0];
      if (other !== undefined) {
        await insertCorrelationCandidate(db, {
          recordA: row.source_record_id,
          recordB: other.source_record_id,
          decision: 'POSSIBLE_MATCH',
          score: candidateScore(best.terms.misfit),
          reasons: decision.reasons,
          algorithmVersion: decision.algorithmVersion,
          evaluatedAt: asOf,
        });
      }
    }
    return { kind: 'POSSIBLE', touched: [eventId] };
  }

  return { kind: 'CREATED', touched: [eventId] };
}

/**
 * Re-scores a linked record whose solution was revised.
 *
 * The event is represented by its *other* members: scoring a record against a projection it is
 * itself the only contributor to would compare it with itself and always keep the link. With no
 * other member, the link is kept — a single-source event cannot disagree with anything.
 */
async function reevaluateRevision(
  db: Kysely<DB>,
  row: CorrelationRecordRow,
  solution: Solution,
  asOf: Date,
): Promise<Outcome> {
  const eventId = row.canonical_event_id;
  if (eventId === null) throw new Error('reevaluateRevision called without a link');

  const members = await eventMembers(db, eventId);
  const others = members.filter((member) => member.source_record_id !== row.source_record_id);

  if (others.length === 0) {
    await relink(db, row, eventId, asOf, [
      {
        code: 'REVISION_SOLE_MEMBER',
        text: 'This record is the only source for the event, so the revision cannot break a match.',
        params: {},
      },
    ]);
    return { kind: 'REVISION_KEPT', touched: [eventId] };
  }

  /*
   * The worst fit among the other members decides, not the best.
   *
   * A revision that still matches one member but has moved far from another has broken the event,
   * and taking the best fit would keep a link that the members themselves no longer support.
   */
  let worst = 0;
  for (const member of others) {
    const terms = computeMisfit(solution, {
      sourceId: member.source_id,
      epicentre: { lat: member.lat, lon: member.lon },
      originTime: member.observed_at,
      magnitude: num(member.magnitude),
      magnitudeType: member.magnitude_type,
      contributor: member.contributor,
    });
    worst = Math.max(worst, terms.misfit);
  }

  const verdict = revisionKeepsLink(worst);
  if (verdict.keep) {
    await relink(db, row, eventId, asOf, [verdict.reason]);
    return { kind: 'REVISION_KEPT', touched: [eventId] };
  }

  await db.transaction().execute(async (trx) => {
    await unlinkRecord(trx, row.source_record_id, asOf, 'REVISION_BROKE_MATCH');
  });
  const candidates = await loadCandidates(db, solution);
  const decision = decideSpatiotemporal(
    solution,
    candidates.filter((candidate) => candidate.canonicalEventId !== eventId),
  );
  const outcome = await applySpatiotemporal(db, row, decision, asOf);
  return { kind: 'REVISION_BROKEN', touched: [...outcome.touched, eventId] };
}

/**
 * Re-records a surviving link with the reasons from the revision.
 *
 * `linkRecord` returns without writing when the record is already linked to this event, which
 * makes a kept link a no-op rather than a new row — re-running correlation over unchanged facts
 * must not produce link churn, and the timestamp on a link is when the *decision* was made, not
 * when it was last re-confirmed.
 */
async function relink(
  db: Kysely<DB>,
  row: CorrelationRecordRow,
  eventId: string,
  asOf: Date,
  reasons: unknown,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await linkRecord(trx, {
      canonicalEventId: eventId,
      sourceRecordId: row.source_record_id,
      relation: 'SAME_EVENT',
      matchKind: 'SPATIOTEMPORAL',
      confidence: null,
      reasons,
      algorithmVersion: EARTHQUAKE_ALGORITHM_VERSION,
      linkedAt: asOf,
    });
  });
}

/**
 * Rebuilds one event's `canonical_event_state` row from its members.
 *
 * The projection is where agreement and the headline are decided, and both come from
 * `packages/correlation` rather than from SQL: the count of independent sources excludes derived
 * copies, and the headline follows the documented precedence. Computing either here would be a
 * second implementation of a rule that has been calibrated once.
 */
export async function projectCanonicalEvent(
  db: Kysely<DB>,
  canonicalEventId: string,
  asOf: Date,
): Promise<void> {
  const members = await eventMembers(db, canonicalEventId);
  if (members.length === 0) return;

  const solutions: MemberSolution[] = members.map((member) => ({
    sourceId: member.source_id,
    sourceRecordId: member.source_record_id,
    relation: member.relation === 'DERIVED_COPY' ? 'DERIVED_COPY' : 'SAME_EVENT',
    epicentre: { lat: member.lat, lon: member.lon },
    magnitude: num(member.magnitude),
    magnitudeType: member.magnitude_type,
    depthKm: num(member.depth_km),
    providerStatus: member.provider_status,
    contributor: member.contributor,
  }));

  const agreement = assessAgreement(solutions);
  const headline = chooseHeadlineMagnitude(solutions);

  /*
   * The projection's own values come from the headline member, never from an average. Where there
   * is no headline magnitude, the first member by record id supplies the geometry and origin time
   * — a deterministic choice rather than an arbitrary one, and one the read model can attribute.
   */
  const anchorRecordId = headline?.member.sourceRecordId ?? members[0]?.source_record_id;
  const anchor = members.find((member) => member.source_record_id === anchorRecordId) ?? members[0];
  if (anchor === undefined) return;

  await upsertCanonicalEventState(db, {
    canonicalEventId,
    hazardType: EARTHQUAKE,
    asOf,
    engineVersion: EARTHQUAKE_ALGORITHM_VERSION,
    observedAt: anchor.observed_at,
    centroid: { lat: anchor.lat, lon: anchor.lon },
    isActive: true,
    magnitude: headline?.member.magnitude ?? null,
    headline: {
      sourceId: anchor.source_id,
      sourceRecordId: anchor.source_record_id,
      magnitude: headline?.member.magnitude ?? null,
      magnitudeType: headline?.member.magnitudeType ?? null,
      contributor: anchor.contributor,
      providerStatus: anchor.provider_status,
      depthKm: num(anchor.depth_km),
      title: anchor.title,
      sourceUrl: anchor.source_url,
    },
    agreement: {
      level: agreement.level,
      deltaMagnitude: agreement.deltaMagnitude,
      deltaLocationKm: agreement.deltaLocationKm,
      deltaDepthKm: agreement.deltaDepthKm,
      reasons: agreement.reasons,
    },
    nSources: agreement.nSources,
    nIndependentSources: agreement.nIndependentSources,
  });
}

/**
 * Hazard types that get a canonical event without being correlated.
 *
 * Floods, cyclones, volcanoes and droughts come from GDACS and from nowhere else, so there is no
 * second solution to agree or disagree with. Thermal activity is excluded because fire clusters
 * are their own subject with their own public ids, and weather alerts because no covered source
 * produces them for v1.
 */
/**
 * Seeding has its own version, because it is its own derivation.
 *
 * Stamping a seed run with the earthquake algorithm's version claimed provenance it does not
 * have: no earthquake rule ran, and no matching decision was made.
 */
export const SEED_ALGORITHM_VERSION = 'seed-1';

export const SEEDED_HAZARD_TYPES: readonly HazardType[] = [
  ...HAZARD_TYPES_BY_FAMILY.FLOODS,
  ...HAZARD_TYPES_BY_FAMILY.CYCLONES,
  'VOLCANO',
  'DROUGHT',
  'WILDFIRE_EVENT',
];

export interface SeedResult {
  readonly runId: string;
  readonly considered: number;
  readonly created: number;
}

/**
 * Gives each single-source hazard record its own canonical event (ARCHITECTURE §6.2).
 *
 * The link is `PRIMARY` with match kind `SEED`, and the reason says plainly that no matching was
 * attempted. That distinction matters on the event page: "one source reported this" and "one
 * source matched this" are different claims, and `SEED` is the one that does not pretend a
 * decision was made. `assessAgreement` then reports `SINGLE_SOURCE`, which is the honest level —
 * not `AGREE`, which a lone record must never reach.
 */
export async function seedSingleSourceEvents(
  db: Kysely<DB>,
  options: CorrelateOptions = {},
): Promise<SeedResult> {
  const asOf = options.asOf ?? new Date();
  const runId = await startAnalysisRun(db, {
    kind: 'SEED',
    asOf,
    engineVersion: SEED_ALGORITHM_VERSION,
    startedAt: new Date(),
  });

  let considered = 0;
  let created = 0;
  try {
    const records = await recordsNeedingSeedEvent(db, {
      asOf,
      hazardTypes: SEEDED_HAZARD_TYPES,
      limit: options.limit,
    });

    for (const row of records) {
      considered += 1;
      const hazardType = (row.hazard_type ?? 'OTHER') as HazardType;
      const eventId = await db.transaction().execute(async (trx) => {
        const event = await createCanonicalEvent(trx, { hazardType, createdAt: asOf });
        await linkRecord(trx, {
          canonicalEventId: event.id,
          sourceRecordId: row.source_record_id,
          relation: 'PRIMARY',
          matchKind: 'SEED',
          confidence: null,
          reasons: [
            {
              code: 'SINGLE_SOURCE_FAMILY',
              text: 'Only one source reports this hazard type, so no matching was attempted.',
              params: { hazardType },
            },
          ],
          algorithmVersion: SEED_ALGORITHM_VERSION,
          linkedAt: asOf,
        });
        return event.id;
      });
      created += 1;
      await projectSeededEvent(db, eventId, hazardType, asOf);
    }

    await finishAnalysisRun(db, {
      id: runId,
      status: 'SUCCEEDED',
      stats: { considered, created },
    });
  } catch (error) {
    await finishAnalysisRun(db, {
      id: runId,
      status: 'FAILED',
      stats: { considered, created },
      errorClass: 'INTERNAL',
    });
    throw error;
  }

  return { runId, considered, created };
}

/** The projection for a seeded event: one member, and the agreement rule says so. */
async function projectSeededEvent(
  db: Kysely<DB>,
  canonicalEventId: string,
  hazardType: HazardType,
  asOf: Date,
): Promise<void> {
  const members = await eventMembers(db, canonicalEventId);
  const member = members[0];
  if (member === undefined) return;

  const agreement = assessAgreement([
    {
      sourceId: member.source_id,
      sourceRecordId: member.source_record_id,
      relation: 'PRIMARY',
      epicentre: { lat: member.lat, lon: member.lon },
      magnitude: num(member.magnitude),
      magnitudeType: member.magnitude_type,
      depthKm: num(member.depth_km),
      providerStatus: member.provider_status,
      contributor: member.contributor,
    },
  ]);

  await upsertCanonicalEventState(db, {
    canonicalEventId,
    hazardType,
    asOf,
    engineVersion: SEED_ALGORITHM_VERSION,
    observedAt: member.observed_at,
    centroid: { lat: member.lat, lon: member.lon },
    isActive: true,
    magnitude: num(member.magnitude),
    headline: {
      sourceId: member.source_id,
      sourceRecordId: member.source_record_id,
      magnitude: num(member.magnitude),
      magnitudeType: member.magnitude_type,
      contributor: member.contributor,
      providerStatus: member.provider_status,
      depthKm: num(member.depth_km),
      title: member.title,
      sourceUrl: member.source_url,
    },
    agreement: {
      level: agreement.level,
      deltaMagnitude: null,
      deltaLocationKm: null,
      deltaDepthKm: null,
      reasons: agreement.reasons,
    },
    nSources: agreement.nSources,
    nIndependentSources: agreement.nIndependentSources,
  });
}
