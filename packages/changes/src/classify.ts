/**
 * The snapshot diff (ARCHITECTURE §10).
 *
 * "What Changed?" is `diff(buildSnapshot(L, T−Δ), buildSnapshot(L, T))` — two runs of the *same*
 * code path at two knowledge times, compared. That is the whole design, and it has one consequence
 * that shapes this file: **a change is a difference between two things GeoNerva believed**, never
 * a provider's own notion of an update. A provider that restamps a record without changing it
 * produces no signal, because both snapshots say the same thing.
 *
 * ### The three failure modes this guards against
 *
 * **Noise.** Providers re-solve constantly. A section filled with hundredth-of-a-magnitude
 * refinements stops being read, which is the same outcome as showing nothing. Sub-threshold
 * revisions are `SUPPRESSED: IMMATERIAL` — returned, counted, and behind "show N minor changes",
 * so the filtering is visible rather than silent.
 *
 * **Invented change.** Every signal names the subject it is about and carries the evidence IDs of
 * both states. Nothing here compares a value against a remembered constant; if a field is absent
 * from either snapshot, there is no signal about it.
 *
 * **Absence read as improvement.** A subject that disappears because its *family* became
 * unavailable has not resolved — GeoNerva merely stopped being able to see it. Those produce no
 * per-subject signal at all; the family's availability transition is the signal.
 */

import {
  RELEVANCE_RANK,
  compareProviderSeverity,
  type ChangeProminence,
  type ChangeType,
  type HazardFamily,
  type LocationSnapshotView,
  type RelevanceLevel,
  type SubjectSummary,
  type SuppressionReason,
} from '@geonerva/domain';

import {
  DELTA_WEIGHT,
  IMPORTANCE_BASE,
  LEVEL_WEIGHT,
  MATERIALITY,
  MAX_HEADLINE,
  PROMINENCE_BANDS,
  RECENCY_WEIGHT,
} from './config.ts';

/** One difference between two snapshots, before it becomes a read model. */
export interface ChangeSignal {
  readonly type: ChangeType;
  readonly family: HazardFamily;
  /** `CE:…`, `FC:…` or `SRC:…`. `null` only for a family-wide signal with no subject. */
  readonly subjectRef: string | null;
  readonly title: string;
  readonly detail: string | null;
  readonly importance: number;
  readonly prominence: ChangeProminence;
  readonly suppressionReason: SuppressionReason | null;
  /** True when the event happened before the window but was only reported inside it. */
  readonly lateReport: boolean;
  readonly facets: readonly ChangeFacetValue[];
  readonly reasonCodes: readonly string[];
  /** Evidence from **both** states, so a reader can check the before as well as the after. */
  readonly evidenceIds: readonly string[];
  /** The levels the importance was computed from, for the report and for tests. */
  readonly levelBefore: RelevanceLevel | null;
  readonly levelAfter: RelevanceLevel | null;
  /**
   * When the change happened, as epoch milliseconds, or 0 when it has no moment.
   *
   * Carried so that §10.4's "ties by level then recency" can actually use recency. It is not part
   * of the read model; it exists to make the ordering total and the tiebreak real.
   */
  readonly recencyMs: number;
}

export interface ChangeFacetValue {
  readonly type: ChangeType;
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface DiffOptions {
  /** The earlier knowledge time. Anything observed at or before this is not new. */
  readonly fromAsOf: Date;
  readonly toAsOf: Date;
}

export interface DiffResult {
  readonly headline: readonly ChangeSignal[];
  readonly listed: readonly ChangeSignal[];
  readonly detail: readonly ChangeSignal[];
  readonly suppressed: readonly ChangeSignal[];
  /** Every signal, in one stable order, for callers that want the whole set. */
  readonly all: readonly ChangeSignal[];
}

/**
 * Diffs two snapshots of the same location.
 *
 * `before` must be the snapshot at the earlier knowledge time and both must have been built with
 * the same engine version — §4.14 is explicit that snapshots of different engine versions are
 * never diffed, and the previous one is recomputed under the current engine instead. That is the
 * caller's responsibility; this function asserts it rather than silently comparing.
 */
export function diffSnapshots(
  before: LocationSnapshotView,
  after: LocationSnapshotView,
  options: DiffOptions,
): DiffResult {
  if (before.engineVersion !== after.engineVersion) {
    throw new Error(
      'refusing to diff snapshots from different engine versions: recompute the earlier one',
    );
  }

  const signals: ChangeSignal[] = [];
  for (const family of Object.keys(after.families) as HazardFamily[]) {
    const beforeCard = before.families[family];
    const afterCard = after.families[family];
    signals.push(...familySignals(family, beforeCard, afterCard, options));
    signals.push(...subjectSignals(family, beforeCard, afterCard, options));
  }

  return rank(signals);
}

/**
 * Availability transitions, which are changes about **GeoNerva** rather than about the world.
 *
 * These matter more than they look. A family going from `AVAILABLE` to `UNAVAILABLE` is the reason
 * its items vanished, and without this signal the disappearance reads as everything having
 * resolved. §10.4 makes the pairing explicit: a `SOURCE_STALE` for a family that held a `HIGH`
 * item is a `HEADLINE`, not a footnote.
 */
function familySignals(
  family: HazardFamily,
  before: LocationSnapshotView['families'][HazardFamily],
  after: LocationSnapshotView['families'][HazardFamily],
  options: DiffOptions,
): ChangeSignal[] {
  if (before.availability === after.availability) return [];

  /*
   * A family that was never covered and still is not has not changed. `NOT_COVERED` is a property
   * of the source set, so a transition into or out of it means the *configuration* changed —
   * worth saying, but it is not a source outage and must not be reported as one.
   */
  const becameUnusable = after.availability !== 'AVAILABLE' && before.availability === 'AVAILABLE';
  const becameUsable = after.availability === 'AVAILABLE' && before.availability !== 'AVAILABLE';
  if (!becameUnusable && !becameUsable) return [];

  const type: ChangeType = becameUnusable ? 'SOURCE_STALE' : 'SOURCE_RECOVERED';
  const highestBefore = highestLevel(before.items);
  const highestAfter = highestLevel(after.items);

  /*
   * The reason is the one the card already computed. Restating it here in different words would
   * be a second explanation of the same fact, and they would eventually disagree.
   *
   * For a **recovery** the code is kept and the prose is not. The card's reasons are written in
   * the present tense — "GeoNerva has the underlying data but has not finished processing it, so
   * it cannot report on them yet" — and `before`'s reason is a description of a state that has
   * just ended. Carried onto a headline reading "GeoNerva can report on fire activity here
   * again", it contradicted it on the same line, on a page where the fire card was reporting 14
   * detections (QA round 2, M-4). The title and the `UNAVAILABLE → AVAILABLE` facet say what
   * changed; the code stays for whoever is reading the signal rather than the sentence.
   */
  const reason = (becameUnusable ? after : before).dataConfidence.reasons[0] ?? null;
  const reasonCode = reason?.code ?? null;

  return [
    finish(
      {
        type,
        family,
        subjectRef: null,
        title: becameUnusable
          ? `GeoNerva can no longer report on ${familyLabel(family)} here`
          : `GeoNerva can report on ${familyLabel(family)} here again`,
        detail: becameUnusable ? (reason?.text ?? null) : null,
        lateReport: false,
        facets: [
          {
            type,
            label: 'Availability',
            before: before.availability,
            after: after.availability,
          },
        ],
        reasonCodes: reasonCode === null ? [] : [reasonCode],
        evidenceIds: [
          ...(becameUnusable ? before : after).sourceHealth
            .map((entry) => entry.evidenceId)
            .filter((id): id is string => id !== null),
        ],
        levelBefore: highestBefore,
        levelAfter: highestAfter,
      },
      options,
      null,
    ),
  ];
}

/**
 * Per-subject signals, matched by `subjectRef`.
 *
 * Subjects are matched by reference and never by position or by provider id: the reference follows
 * merge redirects, so an event ComCat merged into another is still recognised as the same subject
 * rather than appearing as one resolving and another arriving.
 */
function subjectSignals(
  family: HazardFamily,
  before: LocationSnapshotView['families'][HazardFamily],
  after: LocationSnapshotView['families'][HazardFamily],
  options: DiffOptions,
): ChangeSignal[] {
  /*
   * **A family that cannot be shown now produces no per-subject signals.**
   *
   * When availability drops, `items` is empty by invariant I11 — not because the hazards ended.
   * Emitting a per-subject signal for each of them would turn an outage into a page of good news,
   * which is the single worst output this engine could produce. The family-level `SOURCE_STALE`
   * above is the honest signal for that transition.
   */
  if (after.availability !== 'AVAILABLE') return [];

  /*
   * A family that could not be shown *before* is a different case, and conflating the two hid the
   * most important change a briefing can carry.
   *
   * Both sides used to be required to be `AVAILABLE`. So a family that was `UNAVAILABLE` at the
   * earlier knowledge time — a common state, since a source goes `STALE` an hour after its last
   * success — produced exactly one signal on recovery: `SOURCE_RECOVERED`. A new `CRITICAL` flood
   * five kilometres away, arriving in that same window, was invisible to the diff, to the copy and
   * to the AI packet, and the change section read as pure good news.
   *
   * The asymmetry is the fix. Not knowing before means an item present now is **new knowledge**,
   * so arrivals are reported; but it also means nothing can be said to have *departed*, because
   * there was never a list to depart from.
   */
  const knewBefore = before.availability === 'AVAILABLE';
  const beforeByRef = new Map(
    knewBefore ? before.items.map((item) => [item.subjectRef, item] as const) : [],
  );
  const afterByRef = new Map(after.items.map((item) => [item.subjectRef, item]));
  const signals: ChangeSignal[] = [];

  for (const [ref, item] of afterByRef) {
    const previous = beforeByRef.get(ref);
    if (previous === undefined) {
      signals.push(newSubjectSignal(family, item, options));
      continue;
    }
    const grouped = revisionSignals(family, previous, item, options);
    if (grouped !== null) signals.push(grouped);
  }

  if (knewBefore) {
    for (const [ref, item] of beforeByRef) {
      if (afterByRef.has(ref)) continue;
      signals.push(...departedSignal(family, item, options));
    }
  }

  return signals;
}

/**
 * A subject present in the later state and absent from the earlier one.
 *
 * `late_report` is the distinction §10.2 insists on: an event that *happened* before the window
 * but was only *reported* inside it is new knowledge, not a new event, and saying "new earthquake"
 * about a three-day-old one would misdate it.
 */
function newSubjectSignal(
  family: HazardFamily,
  item: SubjectSummary,
  options: DiffOptions,
): ChangeSignal {
  const observedAt = new Date(item.observedAt);
  const lateReport = observedAt.getTime() <= options.fromAsOf.getTime();

  return finish(
    {
      type: 'NEW_EVENT',
      family,
      subjectRef: item.subjectRef,
      title: lateReport ? `${item.title}, newly reported` : item.title,
      detail: `${item.distanceKm.toFixed(0)} km away.`,
      lateReport,
      facets: [
        { type: 'NEW_EVENT', label: 'Relevance', before: null, after: item.relevance.level },
      ],
      reasonCodes: item.relevance.reasons.map((reason) => reason.code),
      evidenceIds: item.evidenceIds,
      levelBefore: null,
      levelAfter: item.relevance.level,
    },
    options,
    observedAt,
  );
}

/**
 * Everything that can change about a subject present in both states, as **one grouped signal**.
 *
 * §10.3's grouping rule: multiple signals about one subject collapse into one item with facets,
 * so a revision that also changed the severity and the relevance reads as one thing that happened
 * rather than three. The signal's `type` is the most consequential of them, because that is what
 * the importance formula keys on — and taking the least consequential would understate an
 * escalation that arrived alongside a routine revision.
 */
function revisionSignals(
  family: HazardFamily,
  before: SubjectSummary,
  after: SubjectSummary,
  options: DiffOptions,
): ChangeSignal | null {
  const facets: ChangeFacetValue[] = [];
  const reasonCodes: string[] = [];
  const types: ChangeType[] = [];

  const severityBefore = before.providerSeverity;
  const severityAfter = after.providerSeverity;
  const sameScheme =
    severityBefore !== null &&
    severityAfter !== null &&
    severityBefore.scheme === severityAfter.scheme;
  /*
   * Severity is compared **within one scheme only**, by the domain's own comparison.
   *
   * GDACS `Orange` and PAGER `orange` are not the same statement, and a scheme change is a
   * provenance change rather than an escalation — so when the scheme differs, no severity signal
   * is emitted. And the direction is `compareProviderSeverity`, which knows all four schemes and
   * returns `null` for a value it has not seen, with the documented contract that callers "must
   * treat null as not comparable and say so".
   *
   * This file used to hard-code `['green','yellow','orange','red']` and rank an unknown value at
   * -1. A `CAP_SEVERITY` alert revised `Moderate → Extreme` therefore compared -1 against -1,
   * `escalated` came out false, and an official alert going to its highest level was published as
   * *"was downgraded by the provider"* — with the de-escalation weight, so it ranked lower on the
   * page too. Latent until an ECCC/NWS adapter lands, which is exactly when nobody would be
   * reading this function.
   */
  const direction =
    severityBefore !== null && severityAfter !== null && sameScheme
      ? compareProviderSeverity(severityBefore, severityAfter)
      : null;
  if (direction !== null && direction !== 0) {
    const escalated = direction < 0;
    types.push(escalated ? 'EVENT_ESCALATED' : 'EVENT_DEESCALATED');
    facets.push({
      type: escalated ? 'EVENT_ESCALATED' : 'EVENT_DEESCALATED',
      label: 'Alert level',
      before: severityBefore?.value ?? null,
      after: severityAfter?.value ?? null,
    });
    reasonCodes.push('PROVIDER_SEVERITY_CHANGED');
  }

  if (before.relevance.level !== after.relevance.level) {
    const up = RELEVANCE_RANK[after.relevance.level] > RELEVANCE_RANK[before.relevance.level];
    types.push(up ? 'RELEVANCE_INCREASE' : 'RELEVANCE_DECREASE');
    facets.push({
      type: up ? 'RELEVANCE_INCREASE' : 'RELEVANCE_DECREASE',
      label: 'Relevance',
      before: before.relevance.level,
      after: after.relevance.level,
    });
  }

  const material = materialFieldChanges(before, after);
  if (material.length > 0) {
    types.push('EVENT_UPDATED');
    facets.push(...material);
    reasonCodes.push('PROVIDER_REVISION');
  }

  const agreementBefore = before.agreement?.level ?? null;
  const agreementAfter = after.agreement?.level ?? null;
  if (agreementAfter === 'CONFLICT' && agreementBefore !== 'CONFLICT') {
    types.push('SOURCE_CONFLICT');
    facets.push({
      type: 'SOURCE_CONFLICT',
      label: 'Source agreement',
      before: agreementBefore,
      after: agreementAfter,
    });
    reasonCodes.push('SOURCES_DISAGREE');
  }

  if (types.length === 0) {
    /*
     * Nothing material moved. An immaterial revision is still *returned* — suppressed with a
     * reason — but only when something actually differed: emitting a suppressed signal for a
     * subject that is byte-identical in both states would make "show N minor changes" a count of
     * nothing.
     */
    const immaterial = immaterialFieldChanges(before, after);
    if (immaterial.length === 0) return null;
    return finish(
      {
        type: 'EVENT_UPDATED',
        family,
        subjectRef: after.subjectRef,
        title: `${after.title} was revised slightly`,
        detail: null,
        lateReport: false,
        facets: immaterial,
        reasonCodes: ['IMMATERIAL_REVISION'],
        evidenceIds: [...before.evidenceIds, ...after.evidenceIds],
        levelBefore: before.relevance.level,
        levelAfter: after.relevance.level,
      },
      options,
      new Date(after.observedAt),
      'IMMATERIAL',
    );
  }

  const primary = mostConsequential(types);
  return finish(
    {
      type: primary,
      family,
      subjectRef: after.subjectRef,
      title: titleFor(primary, after),
      detail: facets
        .map((facet) => `${facet.label} ${facet.before ?? '—'} → ${facet.after ?? '—'}`)
        .join('; '),
      lateReport: false,
      facets,
      reasonCodes,
      evidenceIds: [...before.evidenceIds, ...after.evidenceIds],
      levelBefore: before.relevance.level,
      levelAfter: after.relevance.level,
    },
    options,
    new Date(after.observedAt),
  );
}

/**
 * A subject that was listed before and is not listed now.
 *
 * **Absence is never resolution**, and an earlier version of this function asserted otherwise for
 * every family except earthquakes. §10.2 defines `EVENT_RESOLVED` as a *lifecycle* transition —
 * "GDACS `iscurrent=false`/`todate` passed, cluster → INACTIVE, alert ended/expired/cancelled" —
 * and a diff of two snapshots cannot see any of those. What it can see is that an item left the
 * list, and there are at least four reasons for that which are not the hazard ending:
 *
 *  - **The recency window moved.** Both snapshots filter on `asOf − window` (ADR-037), so the
 *    later one has a later cutoff. A flood observed 29 days and 20 hours ago is in the earlier
 *    snapshot and out of the later one. It has not receded; the window slid past it.
 *  - **The display cap.** A card shows at most `DEFAULT_MAX_ITEMS_PER_FAMILY`; two nearer arrivals
 *    push the two lowest-ranked shown items out.
 *  - **The search radius.** A cyclone whose centroid moved out of range is gone from the list and
 *    very much not over.
 *  - **The relevance model declined it.** A subject that fell below assessment thresholds is
 *    dropped from `items` by the snapshot builder.
 *
 * In the worst case this produced `EVENT_RESOLVED` for a `CRITICAL` flood, which §10.4's hard rule
 * then promoted to `HEADLINE`, and the briefing's lead sentence became *"<flood> is no longer
 * active"* about a flood that was still active.
 *
 * So the signal is emitted, suppressed as `AGED_OUT`, and worded as what is actually known: the
 * subject is no longer listed. Announcing a genuine resolution needs the tombstone in the
 * snapshot — a subject present with a terminal `lifecycleStatus` — which the snapshot builder does
 * not yet carry. That is recorded in the gate report rather than guessed at here.
 */
function departedSignal(
  family: HazardFamily,
  item: SubjectSummary,
  options: DiffOptions,
): ChangeSignal[] {
  return [
    finish(
      {
        type: 'EVENT_RESOLVED',
        family,
        subjectRef: item.subjectRef,
        title: `${item.title} is no longer listed`,
        /*
         * The detail says why this is not a claim that the hazard ended. A reader who sees the
         * suppressed list deserves the distinction, and it is the whole point of the signal.
         */
        detail:
          'It is outside the window, the radius or the list shown here. GeoNerva cannot tell from this whether it has ended.',
        lateReport: false,
        facets: [],
        reasonCodes: ['NO_LONGER_LISTED'],
        evidenceIds: item.evidenceIds,
        levelBefore: item.relevance.level,
        levelAfter: null,
      },
      options,
      new Date(item.observedAt),
      'AGED_OUT',
    ),
  ];
}

/** Field changes at or beyond §10.2's materiality thresholds. */
function materialFieldChanges(before: SubjectSummary, after: SubjectSummary): ChangeFacetValue[] {
  const facets: ChangeFacetValue[] = [];

  const magnitudeBefore = factNumber(before, 'MAGNITUDE');
  const magnitudeAfter = factNumber(after, 'MAGNITUDE');
  if (
    magnitudeBefore !== null &&
    magnitudeAfter !== null &&
    roundStored(Math.abs(magnitudeAfter - magnitudeBefore)) >= MATERIALITY.magnitude
  ) {
    facets.push({
      type: 'EVENT_UPDATED',
      label: 'Magnitude',
      before: `M${magnitudeBefore.toFixed(1)}`,
      after: `M${magnitudeAfter.toFixed(1)}`,
    });
  }

  const depthBefore = factNumber(before, 'DEPTH');
  const depthAfter = factNumber(after, 'DEPTH');
  if (
    depthBefore !== null &&
    depthAfter !== null &&
    roundStored(Math.abs(depthAfter - depthBefore)) >= MATERIALITY.depthKm
  ) {
    facets.push({
      type: 'EVENT_UPDATED',
      label: 'Depth',
      before: `${depthBefore.toFixed(0)} km`,
      after: `${depthAfter.toFixed(0)} km`,
    });
  }

  /*
   * The epicentre shift is measured through the **distance to this location**, which is what the
   * snapshot carries. It is a lower bound on the true shift — a solution that moves tangentially
   * changes distance very little — so it under-reports rather than over-reports, which is the safe
   * direction for a materiality test whose purpose is suppressing noise.
   */
  if (Math.abs(after.distanceKm - before.distanceKm) >= MATERIALITY.epicentreKm) {
    facets.push({
      type: 'EVENT_UPDATED',
      label: 'Distance',
      before: `${before.distanceKm.toFixed(0)} km`,
      after: `${after.distanceKm.toFixed(0)} km`,
    });
  }

  return facets;
}

/** Differences that exist but fall below the thresholds, so suppression can name them. */
function immaterialFieldChanges(before: SubjectSummary, after: SubjectSummary): ChangeFacetValue[] {
  const facets: ChangeFacetValue[] = [];
  const magnitudeBefore = factNumber(before, 'MAGNITUDE');
  const magnitudeAfter = factNumber(after, 'MAGNITUDE');
  if (magnitudeBefore !== null && magnitudeAfter !== null && magnitudeBefore !== magnitudeAfter) {
    facets.push({
      type: 'EVENT_UPDATED',
      label: 'Magnitude',
      before: `M${magnitudeBefore.toFixed(1)}`,
      after: `M${magnitudeAfter.toFixed(1)}`,
    });
  }
  if (before.distanceKm !== after.distanceKm) {
    facets.push({
      type: 'EVENT_UPDATED',
      label: 'Distance',
      before: `${before.distanceKm.toFixed(0)} km`,
      after: `${after.distanceKm.toFixed(0)} km`,
    });
  }
  if (before.lifecycleStatus !== after.lifecycleStatus) {
    facets.push({
      type: 'EVENT_UPDATED',
      label: 'Status',
      before: before.lifecycleStatus,
      after: after.lifecycleStatus,
    });
  }
  return facets;
}

/**
 * Rounds a difference to the precision the database stores, before comparing to a threshold.
 *
 * `magnitude` and `depth_km` are `numeric(_, 2)`, so a real difference between stored values is
 * always a multiple of 0.01 — anything finer is IEEE-754 noise from the subtraction, and it lands
 * exactly on the boundary. `5.3 − 5.1` is 0.19999999999999973, which is **less** than the 0.2
 * materiality threshold, so a revision that moved the magnitude by precisely the amount §10.2 calls
 * material was being suppressed as noise. The same reasoning and the same fix as
 * `assessAgreement`; a mutation control surfaced it here because the test happened to sit on the
 * side of the boundary where the noise pointed the other way.
 */
function roundStored(value: number): number {
  return Math.round(value * 100) / 100;
}

function factNumber(item: SubjectSummary, code: string): number | null {
  const fact = item.facts.find((candidate) => candidate.code === code);
  if (fact === undefined) return null;
  return fact.value.kind === 'number' ? fact.value.value : null;
}

/** The most consequential of the types that fired, by §10.4's own base weights. */
function mostConsequential(types: readonly ChangeType[]): ChangeType {
  let best = types[0] ?? 'EVENT_UPDATED';
  for (const type of types) {
    if (IMPORTANCE_BASE[type] > IMPORTANCE_BASE[best]) best = type;
  }
  return best;
}

/**
 * The sentence a grouped signal leads with.
 *
 * A lookup rather than a switch with a default: every `ChangeType` has to have an answer, and a
 * `default` branch would quietly give a new signal type the words of a revision. The types this
 * engine cannot yet produce — the `ACTIVITY_*` family, which needs baselines — still have their
 * wording here, so adding the input is the only work left.
 */
function titleFor(type: ChangeType, item: SubjectSummary): string {
  const titles: Readonly<Record<ChangeType, string>> = {
    NEW_EVENT: item.title,
    EVENT_UPDATED: `${item.title} was revised`,
    EVENT_ESCALATED: `${item.title} was escalated by the provider`,
    EVENT_DEESCALATED: `${item.title} was downgraded by the provider`,
    EVENT_RESOLVED: `${item.title} is no longer active`,
    RELEVANCE_INCREASE: `${item.title} now deserves more attention`,
    RELEVANCE_DECREASE: `${item.title} now deserves less attention`,
    SOURCE_CONFLICT: `Sources now disagree about ${item.title}`,
    ENTERED_AREA: `${item.title} has moved into range`,
    LEFT_AREA: `${item.title} has moved out of range`,
    ACTIVITY_INCREASE: `Activity around ${item.title} has increased`,
    ACTIVITY_DECREASE: `Activity around ${item.title} has decreased`,
    ABNORMAL_ACTIVITY: `Activity around ${item.title} is unusual for here`,
    SOURCE_STALE: `A source for ${item.title} has gone quiet`,
    SOURCE_RECOVERED: `A source for ${item.title} is reporting again`,
  };
  return titles[type];
}

function highestLevel(items: readonly SubjectSummary[]): RelevanceLevel | null {
  let best: RelevanceLevel | null = null;
  for (const item of items) {
    if (best === null || RELEVANCE_RANK[item.relevance.level] > RELEVANCE_RANK[best]) {
      best = item.relevance.level;
    }
  }
  return best;
}

function familyLabel(family: HazardFamily): string {
  return family.toLowerCase().replaceAll('_', ' ');
}

/** Fills in importance and prominence, which is where §10.4's hard rules live. */
function finish(
  partial: Omit<ChangeSignal, 'importance' | 'prominence' | 'suppressionReason' | 'recencyMs'>,
  options: DiffOptions,
  at: Date | null,
  forcedSuppression: SuppressionReason | null = null,
): ChangeSignal {
  const highest = highestOf(partial.levelBefore, partial.levelAfter);
  const base = IMPORTANCE_BASE[partial.type];
  const level = highest === null ? 0 : LEVEL_WEIGHT[highest];
  const delta = deltaWeight(partial.facets);
  const recency = recencyWeight(at, options);
  const importance = Math.max(0, Math.min(100, base + level + delta + recency));

  /*
   * §10.4's hard rules, applied after the arithmetic because they *override* it:
   *
   *  - anything involving `CRITICAL` is a HEADLINE, whatever it scored;
   *  - a subject that is `LOW` in both states is at most DETAIL, however it scored — a routine
   *    revision to a distant small earthquake must not reach the top of the page;
   *  - an explicit suppression reason wins outright, because it is a statement that the signal
   *    was deliberately filtered rather than merely unimportant.
   */
  const lowInBoth =
    (partial.levelBefore === null || partial.levelBefore === 'LOW') &&
    (partial.levelAfter === null || partial.levelAfter === 'LOW');

  let prominence: ChangeProminence;
  let suppressionReason: SuppressionReason | null = forcedSuppression;

  /*
   * `SOURCE_STALE` for a family that was showing a `HIGH` item is a HEADLINE by §10.4's hard rule,
   * and the arithmetic alone does not get there: 25 + 35 is 60, below the 70 band. That gap is the
   * rule's whole reason for existing — losing sight of a family the user was relying on a moment
   * ago is the most important thing on the page, not the fourth item in a list.
   */
  const outageOverHighItem =
    partial.type === 'SOURCE_STALE' && (highest === 'HIGH' || highest === 'CRITICAL');

  if (forcedSuppression !== null) {
    prominence = 'SUPPRESSED';
  } else if (highest === 'CRITICAL' || outageOverHighItem) {
    prominence = 'HEADLINE';
  } else if (importance >= PROMINENCE_BANDS.headline) {
    prominence = 'HEADLINE';
  } else if (importance >= PROMINENCE_BANDS.listed) {
    prominence = 'LISTED';
  } else if (importance >= PROMINENCE_BANDS.detail) {
    prominence = 'DETAIL';
  } else {
    prominence = 'SUPPRESSED';
    suppressionReason = 'IMMATERIAL';
  }

  if (lowInBoth && prominence !== 'SUPPRESSED' && highest !== 'CRITICAL' && !outageOverHighItem) {
    prominence = 'DETAIL';
    suppressionReason = null;
  }

  return { ...partial, importance, prominence, suppressionReason, recencyMs: at?.getTime() ?? 0 };
}

function highestOf(
  left: RelevanceLevel | null,
  right: RelevanceLevel | null,
): RelevanceLevel | null {
  if (left === null) return right;
  if (right === null) return left;
  return RELEVANCE_RANK[left] >= RELEVANCE_RANK[right] ? left : right;
}

/**
 * The delta term, which counts **measured** movement only.
 *
 * §10.4 places `delta_weight` beside the materiality thresholds, so what it means is "how far past
 * the threshold a value moved". A categorical transition has no magnitude to be far past: an
 * availability flip, a severity change or a relevance change is either true or not. Counting those
 * as delta added 5 to an outage signal for no measurable reason, which is a number the report
 * could not explain — so only `EVENT_UPDATED` facets, the ones that represent a field crossing a
 * threshold, contribute.
 */
function deltaWeight(facets: readonly ChangeFacetValue[]): number {
  const measured = facets.filter((facet) => facet.type === 'EVENT_UPDATED');
  if (measured.length === 0) return 0;
  return Math.min(DELTA_WEIGHT.max, measured.length * DELTA_WEIGHT.atMultipleOfThreshold);
}

/** Linear in position within the window: the most recent change earns the full weight. */
function recencyWeight(at: Date | null, options: DiffOptions): number {
  if (at === null) return 0;
  const span = options.toAsOf.getTime() - options.fromAsOf.getTime();
  if (span <= 0) return 0;
  const position = (at.getTime() - options.fromAsOf.getTime()) / span;
  const clamped = Math.max(0, Math.min(1, position));
  return Math.round(clamped * RECENCY_WEIGHT.max);
}

/**
 * Buckets the signals and applies §10.4's headline cap.
 *
 * Ordering is total and explicit at every level: importance, then level, then recency, then the
 * subject reference. A briefing whose change list reordered between two builds of the same two
 * snapshots would break the same determinism the snapshot hash protects — and "ties by level then
 * recency" from §10.4 is not by itself total, which is why the reference is the last key.
 */
function rank(signals: readonly ChangeSignal[]): DiffResult {
  /*
   * §10.4: "ties by level then recency". Recency was missing entirely — it reached the ordering
   * only through the integer-rounded `recency_weight` inside `importance` — and the third key
   * compared subject references *descending*, which contradicted the comment above it. Both are
   * corrected, and `family` is added so that two family-level signals (which have no subject
   * reference) are totally ordered rather than left to object key order.
   */
  const ordered = [...signals].sort(
    (left, right) =>
      right.importance - left.importance ||
      levelRank(right) - levelRank(left) ||
      right.recencyMs - left.recencyMs ||
      compare(left.family, right.family) ||
      compare(left.subjectRef ?? '', right.subjectRef ?? '') ||
      compare(left.type, right.type),
  );

  const headline: ChangeSignal[] = [];
  const listed: ChangeSignal[] = [];
  const detail: ChangeSignal[] = [];
  const suppressed: ChangeSignal[] = [];
  const all: ChangeSignal[] = [];

  for (const signal of ordered) {
    /*
     * The cap demotes rather than drops. A fourth headline-worthy change is still a real change,
     * and hiding it to keep the list tidy would be the one thing this section cannot do.
     */
    if (signal.prominence === 'HEADLINE' && headline.length >= MAX_HEADLINE) {
      const demoted: ChangeSignal = { ...signal, prominence: 'LISTED' };
      listed.push(demoted);
      all.push(demoted);
      continue;
    }
    if (signal.prominence === 'HEADLINE') headline.push(signal);
    else if (signal.prominence === 'LISTED') listed.push(signal);
    else if (signal.prominence === 'DETAIL') detail.push(signal);
    else suppressed.push(signal);
    all.push(signal);
  }

  return { headline, listed, detail, suppressed, all };
}

function levelRank(signal: ChangeSignal): number {
  const highest = highestOf(signal.levelBefore, signal.levelAfter);
  return highest === null ? -1 : RELEVANCE_RANK[highest];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
