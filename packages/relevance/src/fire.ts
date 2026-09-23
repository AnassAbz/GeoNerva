/**
 * Fire-activity relevance (ARCHITECTURE §9.2).
 *
 * The family where GeoNerva is furthest from what a user assumes it is saying, and the model is
 * shaped around closing that gap rather than around the thresholds.
 *
 * A FIRMS record is **a satellite pixel flagged as containing one or more fires** — not a
 * perimeter, not a fire count, not a confirmed wildfire. NRT VIIRS has no `type` field, so gas
 * flares, industrial roofs and volcanoes arrive as detections indistinguishable from burning
 * vegetation. The caveat is therefore mandatory on every assessment, in the provider's terms, and
 * it is the reason `THERMAL_ACTIVITY` is the hazard type rather than `WILDFIRE`.
 *
 * Relevance is assessed **per cluster**, not per detection, because a detection is a pixel and a
 * cluster is the thing a person would call a fire. `d` is the distance to the *nearest detection*
 * in the cluster, not to its centroid: a 40 km-long fire front whose centroid is 25 km away may
 * have a pixel 3 km from the place, and the centroid distance would understate that by an order
 * of magnitude.
 *
 * **What this model cannot yet be run against.** The cluster facts it takes — `state`, `n24h`,
 * `overpasses24h`, `frpSum24h` — live in `fire_clusters` and `fire_cluster_versions`, which exist
 * (migration 0005) and which **nothing populates**: clustering is `packages/correlation`, still a
 * stub. So this is tested as the pure function it is, against hand-built cluster facts, and it
 * has never been run against real clustered data. That is recorded rather than implied.
 */

import { INITIAL_FRESHNESS_POLICIES, type RelevanceLevel } from '@geonerva/domain';

import type { Assessment, Reason } from './assessment.ts';
import { reason } from './assessment.ts';
import { THERMAL_DETECTION_CAVEAT } from './gdacs-families.ts';

/**
 * `fire-2` since QA round 2, M-2: the `HIGH` rule gained the staleness condition below, so an
 * assessment stamped `fire-1` and one stamped `fire-2` are not the same computation and must not
 * be recorded under one name.
 */
export const FIRE_MODEL_VERSION = 'fire-2';

/** A cluster's activity state, from `fire_cluster_versions`. */
export type FireClusterState = 'ACTIVE' | 'COOLING' | 'DORMANT';

/**
 * `ACTIVE` is "detection ≤ 24 h" (ARCHITECTURE §9.2, stated).
 *
 * The `COOLING`/`DORMANT` boundary is **not** stated there, so it is taken from the one other
 * number the design already fixes: clustering runs over "detections from the last 72 h" (§7), and
 * the detection partitions are dropped on the same horizon (§12). A cluster whose newest detection
 * is older than the window the clusterer can see is history, not activity — which is exactly what
 * `DORMANT` means, and why the model refuses to assess one.
 */
export const FIRE_ACTIVE_HOURS = 24;
export const FIRE_COOLING_HOURS = 72;

/** The cluster's state, from the age of its newest detection. */
export function fireClusterState(hoursSinceLastDetection: number): FireClusterState {
  if (!Number.isFinite(hoursSinceLastDetection) || hoursSinceLastDetection < 0) return 'DORMANT';
  if (hoursSinceLastDetection <= FIRE_ACTIVE_HOURS) return 'ACTIVE';
  if (hoursSinceLastDetection <= FIRE_COOLING_HOURS) return 'COOLING';
  return 'DORMANT';
}

/** §9.2's distance bounds, in km. */
export const FIRE_NEAR_KM = 10;
export const FIRE_MID_KM = 30;
export const FIRE_OUTER_KM = 150;

/** §9.2's HIGH thresholds: either is sufficient, alongside `ACTIVE` and `d ≤ 10`. */
export const FIRE_HIGH_DETECTIONS_24H = 5;
export const FIRE_HIGH_OVERPASSES_24H = 2;

/**
 * How old a cluster summary may be and still stand in for the *current* 24 hours (QA round 2,
 * M-2). Ninety minutes, and the number is read from the FIRMS freshness policy rather than chosen
 * here.
 *
 * ### Why the level needs an age at all
 *
 * `n24h` and `overpasses24h` are rolling-window counts computed **when the worker last summarized
 * the cluster**, not when the request was served. They only ever fall as time passes without new
 * detections — a detection leaving the trailing edge of the window is silent — so a summary that
 * has stopped being rewritten reports the busiest version of a window that may since have
 * emptied. QA round 2 measured exactly that: a summary computed at 05:20 said 8 detections on 2
 * overpasses; at 13:06 the rows held 5 on 1. A **live** request recounts the window now that
 * membership carries its knowledge time (ADR-039). A replay still cannot: detections are pruned
 * at 72 h, so recounting an older window would report a smaller fire than GeoNerva reported at
 * the time. For those, the only honest move left is to stop treating a stale window as a
 * current one.
 *
 * ### Why ninety minutes, from the data rather than from taste
 *
 * The summary's cadence *is* the FIRMS cadence: §7.4 runs clustering "after each FIRMS batch", and
 * §6 polls FIRMS every 30 minutes. A new version is written whenever the summary's hash changes —
 * and a rolling 24-hour count changes at nearly every batch of a live cluster, because detections
 * enter and leave the window continuously. So for an `ACTIVE` cluster a summary is expected at
 * every poll, and an old one is not a summary that had nothing to say: it is a summary that was
 * never computed.
 *
 * The boundary is therefore taken from `firms:VIIRS_*`'s own `fetchFreshWithinS` — 90 minutes,
 * three poll intervals, the point at which GeoNerva itself stops calling the FIRMS feed `FRESH`
 * and starts calling it `POLL_AGEING`. Choosing that constant rather than writing a fourth number
 * beside it is deliberate, and it is the lesson of L-6 in the same round: a threshold copied by
 * hand drifts away from the thing it was copied from. If the FIRMS policy is retuned, this moves
 * with it — and `fire.test.ts`'s "it is the FIRMS poll-freshness boundary" spec fails, so that the
 * model version is reconsidered rather than changed silently.
 *
 * `fetchStaleAfterS` (3 h) was the other candidate and is the wrong one: a `HIGH` resting on a
 * 24-hour count should require a feed GeoNerva would call fresh, not merely one it has not yet
 * given up on.
 */
export const FIRE_SUMMARY_VOUCHABLE_HOURS =
  INITIAL_FRESHNESS_POLICIES['firms:VIIRS_*'].fetchFreshWithinS / 3600;

/**
 * True when the 24-hour figures may be read as a statement about the current 24 hours.
 *
 * An unmeasured age (`null`/`undefined`) is **not** vouchable: "the caller did not tell me" is not
 * "it is fresh", and the same rule is already applied to an unmeasured distance and an unmeasured
 * detection age, both of which make `assessFire` decline outright. A negative age — a summary
 * stamped after the knowledge time — is a clock or as-of fault and is not vouchable either.
 */
export function fireSummaryIsCurrent(summaryAgeHours: number | null | undefined): boolean {
  if (typeof summaryAgeHours !== 'number' || !Number.isFinite(summaryAgeHours)) return false;
  return summaryAgeHours >= 0 && summaryAgeHours <= FIRE_SUMMARY_VOUCHABLE_HOURS;
}

/** An official GDACS WF alert area within this distance can justify `CRITICAL`. */
export const FIRE_OFFICIAL_ALERT_KM = 10;

/** `GROWING` requires both: at least double the previous 24 hours, and at least this many. */
export const FIRE_GROWTH_FLOOR = 10;

/**
 * What `nearestDetectionKm` actually measured.
 *
 * `NEAREST_DETECTION` is exact. When the cluster's members cannot be verified — their partitions
 * pruned, or a merge — the caller can only measure to the buffered hull (`CLUSTER_AREA`, never
 * larger than the nearest detection) or, without a hull, to the centre (`CLUSTER_CENTRE`). The
 * level is judged on the same number either way, which errs towards "closer"; what changes is the
 * sentence, which must not state a distance to a detection nobody measured (P8 review H3).
 */
export type FireDistanceBasis = 'NEAREST_DETECTION' | 'CLUSTER_AREA' | 'CLUSTER_CENTRE';

export interface FireInput {
  /** Distance to the **nearest detection** in the cluster, in km — or see `distanceBasis`. */
  readonly nearestDetectionKm: number;
  /** Defaults to `NEAREST_DETECTION`. */
  readonly distanceBasis?: FireDistanceBasis;
  readonly state: FireClusterState;
  /**
   * Detections in the 24 hours **to the moment the cluster was last summarized**, which is not
   * the moment of the request. The worker computes these when it clusters; a reader arriving
   * hours later sees a window that has since moved on, and the sentences below say "the most
   * recent 24-hour window counted" rather than "the last 24 hours" for that reason (QA round
   * 2, M-2). A live request recounts the window — membership is resolved as of a knowledge
   * time since ADR-039 — but a replay keeps the stored figure, because the detections are
   * pruned at 72 h and a recount would report a fire smaller than the one reported then.
   */
  readonly n24h: number;
  /**
   * How long before the assessment's knowledge time the cluster was last summarized, in hours —
   * the age of `n24h`, `overpasses24h` and `frpSum24h`.
   *
   * Optional because it is additive to an engine that already has callers, and `null` and absent
   * mean the same thing: **nobody measured it**. Both are treated as not current, which is what
   * `fireSummaryIsCurrent` is for; a caller that wants the `HIGH` band has to say how old its
   * numbers are. See `FIRE_SUMMARY_VOUCHABLE_HOURS` for why the level depends on this at all.
   */
  readonly summaryAgeHours?: number | null;
  /** Detections over the cluster's whole life. */
  readonly nTotal: number;
  /** Distinct satellite overpasses in the last 24 hours. Two is much stronger than one. */
  readonly overpasses24h: number;
  /** Detections in the 24 hours before last, for the growth comparison. */
  readonly nPrevious24h: number;
  /** Sum of fire radiative power over the last 24 hours, in MW. */
  readonly frpSum24h: number | null;
  /** Hours since the most recent detection. */
  readonly hoursSinceLastDetection: number;
  /** True when a GDACS WF `Orange`/`Red` area covers the location within 10 km. */
  readonly officialAlertNearby: boolean;
  /** A related GDACS wildfire event, for the reason text. */
  readonly relatedGdacsEventId: string | null;
  /**
   * P1: a location repeatedly detected over months, which is a gas flare or an industrial site
   * rather than a wildfire. Caps the level at `LOW`. Nothing computes this yet.
   */
  readonly persistentHeatSource: boolean;
}

function distanceReason(km: number, basis: FireDistanceBasis): Reason {
  const rounded = Math.round(km);
  switch (basis) {
    case 'NEAREST_DETECTION':
      return reason('DISTANCE', `The nearest detection is about ${String(rounded)} km away.`, {
        nearestDetectionKm: rounded,
      });
    case 'CLUSTER_AREA':
      return reason(
        'DISTANCE',
        // Inside only at exactly zero: a point 400 m outside the area is not inside it.
        km === 0
          ? 'This location is inside the area where the cluster was detected; the individual detections could not be checked.'
          : rounded === 0
            ? 'The area where the cluster was detected is less than 1 km away; the individual detections could not be checked.'
            : `The area where the cluster was detected is about ${String(rounded)} km away; the individual detections could not be checked.`,
        { areaDistanceKm: rounded },
      );
    case 'CLUSTER_CENTRE':
      return reason(
        'DISTANCE',
        `The centre of the cluster is about ${String(rounded)} km away; the individual detections could not be checked.`,
        { centreDistanceKm: rounded },
      );
  }
}

export function assessFire(input: FireInput): Assessment | null {
  if (!Number.isFinite(input.nearestDetectionKm) || input.nearestDetectionKm < 0) return null;
  // A dormant cluster is history, not activity. §9.2's bands all require ACTIVE or COOLING.
  if (input.state === 'DORMANT') return null;
  if (input.nearestDetectionKm > FIRE_OUTER_KM) return null;

  const reasons: Reason[] = [
    distanceReason(input.nearestDetectionKm, input.distanceBasis ?? 'NEAREST_DETECTION'),
    reason(
      'DETECTION_COUNT',
      `${input.n24h} detection${input.n24h === 1 ? '' : 's'} in the most recent 24-hour window ` +
        `counted for this cluster (${input.nTotal} in total).`,
      { n24h: input.n24h, nTotal: input.nTotal },
    ),
    reason(
      'OVERPASSES',
      `Seen on ${input.overpasses24h} satellite overpass${input.overpasses24h === 1 ? '' : 'es'} ` +
        'in that window.',
      { overpasses24h: input.overpasses24h },
    ),
    reason(
      'RECENCY',
      `Most recent detection about ${Math.round(input.hoursSinceLastDetection)} hours ago.`,
      { hoursSinceLastDetection: Math.round(input.hoursSinceLastDetection) },
    ),
  ];

  if (input.frpSum24h !== null) {
    reasons.push(
      reason('FRP_SUM', `Total fire radiative power over 24 hours: ${input.frpSum24h} MW.`, {
        frpSum24h: input.frpSum24h,
      }),
    );
  }

  /*
   * `GROWING` needs both halves of §9.2's rule.
   *
   * At least double the previous 24 hours **and** at least ten detections. The floor is what
   * stops "one detection became three" reading as explosive growth — a tripling of a number that
   * small is ordinary satellite geometry, not a spreading fire.
   */
  if (input.n24h >= 2 * input.nPrevious24h && input.n24h >= FIRE_GROWTH_FLOOR) {
    reasons.push(
      reason(
        'GROWING',
        `Detections have at least doubled since the previous 24 hours (${input.nPrevious24h} → ${input.n24h}).`,
        { nPrevious24h: input.nPrevious24h, n24h: input.n24h },
      ),
    );
  }

  if (input.relatedGdacsEventId !== null) {
    reasons.push(
      reason('RELATED_GDACS_EVENT', 'GDACS has published a wildfire event for this area.', {
        gdacsEventId: input.relatedGdacsEventId,
      }),
    );
  }

  /*
   * §9.2's bands, first match wins.
   *
   * `HIGH` needs three things at once: close, active, and either five detections or two distinct
   * overpasses in 24 hours. The overpass condition is the interesting one — two independent looks
   * at the same place is much stronger evidence than five pixels from one pass, which can be a
   * single large hot object smeared across a swath.
   *
   * And a fourth, which §9.2 leaves implicit and QA round 2 (M-2) showed cannot be: the 24-hour
   * figures must still be a statement about the current 24 hours. They are a rolling window
   * computed when the worker last summarized the cluster, so a cluster whose feed went quiet would
   * otherwise hold a `HIGH` on a window that has since emptied — the level outliving its evidence.
   * The distance and state conditions are untouched by this: `d` is measured at request time and
   * `state` comes from the age of the newest detection, so both are current by construction. It is
   * only the counts that are historical, so it is only the counts that need vouching for.
   */
  const summaryIsCurrent = fireSummaryIsCurrent(input.summaryAgeHours);
  const countsMeetHighThreshold =
    input.n24h >= FIRE_HIGH_DETECTIONS_24H || input.overpasses24h >= FIRE_HIGH_OVERPASSES_24H;
  let level: RelevanceLevel;
  if (
    input.nearestDetectionKm <= FIRE_NEAR_KM &&
    input.state === 'ACTIVE' &&
    countsMeetHighThreshold &&
    summaryIsCurrent
  ) {
    level = 'HIGH';
  } else if (
    (input.nearestDetectionKm <= FIRE_MID_KM && input.state === 'ACTIVE') ||
    (input.nearestDetectionKm <= FIRE_NEAR_KM && input.state === 'COOLING')
  ) {
    level = 'MODERATE';
  } else {
    level = 'LOW';
  }

  /*
   * A withheld raise is stated, never silent.
   *
   * Only when the staleness is the thing that kept the cluster out of `HIGH` — everything else
   * about the band held. A reader looking at "6 detections on 2 overpasses" beside a `MODERATE`
   * would otherwise have no way to tell whether the model had misread its own rule, and an
   * unexplained demotion is the mirror image of the finding this fixes: a data gap presented as
   * less hazard. The counts themselves are left in place and stay qualified by their own wording
   * ("the most recent 24-hour window counted"); what this sentence adds is why they did not lift
   * the level.
   */
  if (
    !summaryIsCurrent &&
    countsMeetHighThreshold &&
    input.state === 'ACTIVE' &&
    input.nearestDetectionKm <= FIRE_NEAR_KM
  ) {
    /*
     * A negative age takes the unmeasured wording, not "about −1 hours ago".
     *
     * A summary stamped after the knowledge time means the clock or the as-of is wrong, and what
     * GeoNerva then knows about the window's age is nothing. Stating a negative number as though
     * it were a measurement would dress that up as one.
     */
    const statedAge =
      typeof input.summaryAgeHours === 'number' &&
      Number.isFinite(input.summaryAgeHours) &&
      input.summaryAgeHours >= 0
        ? Math.round(input.summaryAgeHours)
        : null;
    reasons.push(
      statedAge !== null
        ? reason(
            'SUMMARY_NOT_CURRENT',
            'Those counts were computed when this cluster was last summarized, about ' +
              `${String(statedAge)} hour${statedAge === 1 ? '' : 's'} ` +
              'before this reading, so GeoNerva does not treat them as a count for the current ' +
              '24 hours and does not raise this cluster on them.',
            {
              summaryAgeHours: statedAge,
              vouchableWithinHours: FIRE_SUMMARY_VOUCHABLE_HOURS,
            },
          )
        : reason(
            'SUMMARY_NOT_CURRENT',
            'GeoNerva cannot tell how long ago this cluster was last summarized, so it does not ' +
              'treat those counts as a count for the current 24 hours and does not raise this ' +
              'cluster on them.',
            { summaryAgeHours: null, vouchableWithinHours: FIRE_SUMMARY_VOUCHABLE_HOURS },
          ),
    );
  }

  /*
   * A persistent heat source caps at `LOW`, whatever the counts say.
   *
   * A gas flare detected every night for a year is not a wildfire, and it would otherwise be the
   * *strongest* signal in the model: many detections, many overpasses, always active, always
   * close. Capping it is what stops an industrial site permanently topping a location's fire card.
   */
  if (input.persistentHeatSource) {
    level = 'LOW';
    reasons.push(
      reason(
        'PERSISTENT_HEAT_SOURCE',
        'This location has been detected repeatedly over a long period, which is characteristic of a gas flare or industrial heat source rather than a wildfire.',
        { persistent: true },
      ),
    );
  }

  /*
   * `CRITICAL` only from an official alert, and only when it is not a persistent source.
   *
   * The ordering matters: a persistent heat source inside a GDACS wildfire alert area is a real
   * situation — an industrial site in a region that is genuinely burning — and the alert is about
   * the region. Letting the cap suppress the alert would hide an authority's statement; letting
   * the alert override the cap is the right way round, because the authority is talking about the
   * area rather than about the pixel.
   */
  const criticalEligible = input.officialAlertNearby;
  if (criticalEligible) {
    reasons.push(
      reason(
        'OFFICIAL_ALERT_AREA',
        `An official GDACS wildfire alert area covers this location within ${FIRE_OFFICIAL_ALERT_KM} km.`,
        { radiusKm: FIRE_OFFICIAL_ALERT_KM },
      ),
    );
  }

  return {
    level: criticalEligible ? 'CRITICAL' : level,
    requiresAuthoritativeBasis: criticalEligible,
    reasons,
    // Never optional, never summarized away. A detection is not a confirmed wildfire.
    caveats: [THERMAL_DETECTION_CAVEAT],
    modelVersion: FIRE_MODEL_VERSION,
  };
}
