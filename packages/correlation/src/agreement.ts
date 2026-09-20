/**
 * Agreement, and the headline value (ARCHITECTURE §6.1).
 *
 * "How well do the sources describing this event agree?" — and the whole difficulty is in the
 * word *sources*, because the obvious count is wrong.
 *
 * GDACS republishes USGS solutions. A canonical event holding a USGS record and a GDACS copy of
 * that same record has **two** linked records and **one** independent source, and reporting it as
 * "2 sources, they agree" would be the most expensive lie this system can tell: it manufactures
 * corroboration out of a copy agreeing with its original. The brief's own example did exactly
 * that. So `nIndependentSources` excludes `DERIVED_COPY` links, and `DERIVED_ONLY` exists as a
 * level so that the case can be *named* rather than silently counted as agreement.
 *
 * The second rule is that conflicting values are **never flattened**. When sources disagree the
 * event exposes every value, the spread between them, and a headline chosen by a documented
 * precedence — and the UI always says which source the headline came from. Picking one silently
 * would turn a disagreement into a fact.
 */

import type { AgreementLevel, LatLon } from '@geonerva/domain';
import { vincentyDistanceMeters } from '@geonerva/geo';

import { magnitudeFamily } from './misfit.ts';

/** One source's contribution to a canonical event. */
export interface MemberSolution {
  readonly sourceId: string;
  readonly sourceRecordId: string;
  /** `DERIVED_COPY` members are excluded from independence and from the headline. */
  readonly relation: 'PRIMARY' | 'SAME_EVENT' | 'DERIVED_COPY';
  readonly epicentre: LatLon;
  readonly magnitude: number | null;
  readonly magnitudeType: string | null;
  readonly depthKm: number | null;
  /** The provider's review state: `reviewed`, `manual`, `automatic`. */
  readonly providerStatus: string | null;
  readonly contributor: string | null;
}

/** §6.1's thresholds. */
export const AGREEMENT_THRESHOLDS = {
  agree: { magnitude: 0.2, locationKm: 15, depthKm: 20 },
  minor: { magnitude: 0.5, locationKm: 50 },
} as const;

export interface AgreementResult {
  readonly level: AgreementLevel;
  readonly nSources: number;
  /** Excludes derived copies. This is the number the UI may describe as corroboration. */
  readonly nIndependentSources: number;
  readonly deltaMagnitude: number | null;
  readonly deltaLocationKm: number | null;
  readonly deltaDepthKm: number | null;
  readonly reasons: readonly { readonly code: string; readonly text: string }[];
}

/**
 * Assesses agreement across the members of one canonical event.
 *
 * The spreads are computed over **independent** members only. Including a derived copy would let
 * a republished stale magnitude register as a disagreement between sources, when it is one source
 * disagreeing with an older version of itself — which is a revision, not a conflict.
 */
export function assessAgreement(members: readonly MemberSolution[]): AgreementResult {
  const independent = members.filter((member) => member.relation !== 'DERIVED_COPY');
  const nSources = new Set(members.map((member) => member.sourceId)).size;
  const nIndependentSources = new Set(independent.map((member) => member.sourceId)).size;

  if (nIndependentSources === 0) {
    /*
     * Every member is a copy and the original is not held. Real: GDACS can arrive before USGS,
     * and the identity reference resolves against an alias GeoNerva already has while the USGS
     * record itself is not yet linked. Naming it stops the event reading as independently sourced.
     */
    return {
      level: 'DERIVED_ONLY',
      nSources,
      nIndependentSources,
      deltaMagnitude: null,
      deltaLocationKm: null,
      deltaDepthKm: null,
      reasons: [
        {
          code: 'DERIVED_ONLY',
          text: 'Every source for this event republishes another provider’s solution, so there is no independent confirmation.',
        },
      ],
    };
  }

  if (nIndependentSources === 1) {
    const hasCopy = members.length > independent.length;
    return {
      level: hasCopy ? 'DERIVED_ONLY' : 'SINGLE_SOURCE',
      nSources,
      nIndependentSources,
      deltaMagnitude: null,
      deltaLocationKm: null,
      deltaDepthKm: null,
      /*
       * The sentence §6.1 asks for, and the reason the level is not `AGREE`: a copy agreeing with
       * its original is not corroboration, however many rows it adds.
       */
      reasons: [
        hasCopy
          ? {
              code: 'DERIVED_ONLY',
              text: '1 independent source; the other reports republish it.',
            }
          : { code: 'SINGLE_SOURCE', text: 'Only one source has reported this event.' },
      ],
    };
  }

  const magnitudes = independent
    .map((member) => member.magnitude)
    .filter((value): value is number => value !== null);
  const depths = independent
    .map((member) => member.depthKm)
    .filter((value): value is number => value !== null);

  /*
   * Spreads rounded to the precision the database actually stores.
   *
   * `magnitude` and `depth_km` are `numeric(_, 2)`, so a real spread between stored values is
   * always a multiple of 0.01. Anything finer is IEEE-754 noise from the subtraction — and it
   * lands exactly on the boundary: `5.2 - 5.0` is 0.20000000000000018, which is greater than the
   * 0.2 `AGREE` threshold, so two sources whose stored magnitudes differ by precisely the
   * permitted amount would be reported as *disagreeing*.
   *
   * Rounding to the stored precision compares what the database holds rather than what floating
   * point produced, which is the same reasoning `roundStored` applies on the ingest side. An
   * epsilon would work too and would be arbitrary; this one is derived from the column.
   */
  const deltaMagnitude =
    magnitudes.length >= 2 ? roundTo(Math.max(...magnitudes) - Math.min(...magnitudes), 2) : null;
  const deltaDepthKm =
    depths.length >= 2 ? roundTo(Math.max(...depths) - Math.min(...depths), 2) : null;
  const deltaLocationKm = maxPairwiseDistanceKm(independent.map((member) => member.epicentre));

  const reasons: { code: string; text: string }[] = [];
  if (deltaMagnitude !== null) {
    reasons.push({
      code: 'MAGNITUDE_SPREAD',
      text: `Magnitudes differ by ${deltaMagnitude.toFixed(1)} across ${String(nIndependentSources)} independent sources.`,
    });
  }
  if (deltaLocationKm !== null) {
    reasons.push({
      code: 'LOCATION_SPREAD',
      text: `Epicentres differ by up to ${deltaLocationKm.toFixed(0)} km.`,
    });
  }

  /*
   * The bands, tried strictest first. A field with no data cannot *fail* a band — two sources
   * that both withheld depth have not disagreed about it — so a null spread is treated as
   * satisfied rather than as a violation.
   */
  const within = (value: number | null, limit: number): boolean => value === null || value <= limit;

  if (
    within(deltaMagnitude, AGREEMENT_THRESHOLDS.agree.magnitude) &&
    within(deltaLocationKm, AGREEMENT_THRESHOLDS.agree.locationKm) &&
    within(deltaDepthKm, AGREEMENT_THRESHOLDS.agree.depthKm)
  ) {
    return {
      level: 'AGREE',
      nSources,
      nIndependentSources,
      deltaMagnitude,
      deltaLocationKm,
      deltaDepthKm,
      reasons,
    };
  }

  if (
    within(deltaMagnitude, AGREEMENT_THRESHOLDS.minor.magnitude) &&
    within(deltaLocationKm, AGREEMENT_THRESHOLDS.minor.locationKm)
  ) {
    return {
      level: 'MINOR_DIFFERENCES',
      nSources,
      nIndependentSources,
      deltaMagnitude,
      deltaLocationKm,
      deltaDepthKm,
      reasons,
    };
  }

  return {
    level: 'CONFLICT',
    nSources,
    nIndependentSources,
    deltaMagnitude,
    deltaLocationKm,
    deltaDepthKm,
    reasons: [
      ...reasons,
      {
        code: 'SOURCES_DISAGREE',
        text: 'The independent sources describing this event differ by more than routine solution differences.',
      },
    ],
  };
}

/** Rounds to `decimals`, for comparing against a threshold at the stored precision. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The largest distance between any two of the epicentres, in km. `null` for fewer than two. */
function maxPairwiseDistanceKm(points: readonly LatLon[]): number | null {
  if (points.length < 2) return null;
  let max = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      if (a === undefined || b === undefined) continue;
      const meters = vincentyDistanceMeters(a, b);
      if (meters !== null) max = Math.max(max, meters / 1000);
    }
  }
  return max;
}

/**
 * Headline precedence for the magnitude (ARCHITECTURE §6.1).
 *
 * > USGS reviewed > EMSC > USGS automatic > derived copies. Mw-family is preferred when two
 * > sources are at the same rank.
 *
 * A **documented** precedence rather than "the highest" or "the most recent", because either of
 * those would silently bias the headline — highest inflates every disagreement upward, and most
 * recent tracks whichever provider happens to poll last. The UI always states which source the
 * headline came from, which is what makes a chosen value honest rather than an averaged one.
 *
 * There is deliberately no averaging anywhere. The mean of an Mw 5.3 and an mb 4.9 is not a
 * measurement of anything.
 */
export function chooseHeadlineMagnitude(
  members: readonly MemberSolution[],
): { readonly member: MemberSolution; readonly rank: number } | null {
  const withMagnitude = members.filter((member) => member.magnitude !== null);
  if (withMagnitude.length === 0) return null;

  const ranked = withMagnitude
    .map((member) => ({ member, rank: precedenceRank(member) }))
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      // Same rank: prefer the Mw family, which is the better-constrained measurement.
      const leftMw = magnitudeFamily(left.member.magnitudeType) === 'MW' ? 0 : 1;
      const rightMw = magnitudeFamily(right.member.magnitudeType) === 'MW' ? 0 : 1;
      if (leftMw !== rightMw) return leftMw - rightMw;
      // Still tied: order by source record id, so the headline does not depend on row order.
      return left.member.sourceRecordId.localeCompare(right.member.sourceRecordId);
    });

  return ranked[0] ?? null;
}

/** Lower is preferred. */
function precedenceRank(member: MemberSolution): number {
  if (member.relation === 'DERIVED_COPY') return 4;
  if (member.sourceId === 'usgs') {
    return member.providerStatus === 'automatic' ? 3 : 1;
  }
  if (member.sourceId === 'emsc') return 2;
  // An unlisted source sits between EMSC and USGS-automatic: it is a real solution, but the
  // precedence has not been decided for it and guessing either extreme would be a claim.
  return 2.5;
}
