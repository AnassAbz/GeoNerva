/**
 * Misfit: how badly two earthquake solutions fit the hypothesis that they are one earthquake.
 *
 * ```text
 * misfit = |Δt| / 16 s  +  d_epi / 100 km  +  w · |ΔM| / 0.8
 * ```
 *
 * A sum of dimensionless terms, each one "how many unit scales apart", so a misfit of 1.0 means
 * the pair is off by one unit scale in total. It is deliberately **not** a probability and is
 * never shown as one: the scales are engineering constants from USGS's associator, not a
 * calibrated likelihood, and dressing the number up as a confidence would claim a statistical
 * basis it does not have.
 *
 * Lower is better, and the decision is made on the *comparison between candidates* rather than on
 * this number alone — see `decide.ts` and the note in `earthquake.config.ts` about why.
 */

import { vincentyDistanceMeters } from '@geonerva/geo';
import type { LatLon } from '@geonerva/domain';

import {
  CROSS_FAMILY_MAGNITUDE_WEIGHT,
  MAGNITUDE_FAMILIES,
  MAGNITUDE_VETO,
  MISFIT_SCALES,
  SOURCE_AGENCY_CODES,
} from './earthquake.config.ts';

/** One source's solution for an earthquake, as correlation needs to see it. */
export interface Solution {
  readonly sourceId: string;
  readonly epicentre: LatLon;
  readonly originTime: Date;
  readonly magnitude: number | null;
  /** The provider's magnitude type, lower-cased. `null` when it published none. */
  readonly magnitudeType: string | null;
  /**
   * The agency credited with *this* solution — USGS `net`, EMSC `auth`.
   *
   * Load-bearing, and not decoration: it is how independence is decided. EMSC republishing an
   * NEIC solution is not a second opinion, and the only way to know that is that the contributor
   * is NEIC rather than EMSC (ADR-030).
   */
  readonly contributor: string | null;
}

/** The magnitude family of a type string, or `null` for one this code does not recognise. */
export function magnitudeFamily(magnitudeType: string | null): string | null {
  if (magnitudeType === null) return null;
  return MAGNITUDE_FAMILIES[magnitudeType.trim().toLowerCase()] ?? null;
}

/**
 * Whether the two solutions are comparable on magnitude at full weight.
 *
 * Same known family, yes. Different known families, no — halved. An *unknown* type on either side
 * is also halved rather than dropped or trusted: an unrecognised type might be anything, and
 * `UNSPECIFIED` (EMSC's bare `m`) is explicitly not a claim about method.
 */
export function sameMagnitudeFamily(a: string | null, b: string | null): boolean {
  const familyA = magnitudeFamily(a);
  const familyB = magnitudeFamily(b);
  if (familyA === null || familyB === null) return false;
  if (familyA === 'UNSPECIFIED' || familyB === 'UNSPECIFIED') return false;
  return familyA === familyB;
}

/**
 * Whether one of these solutions is a republication of the other's.
 *
 * True when the two records come from different sources but are credited to the **same
 * contributor** — EMSC publishing an NEIC solution, for instance. That is a republication, and it
 * is why the magnitude veto is suspended for the pair: a republished magnitude can be stale by
 * more than the veto allows, and the labelled set contains exactly that case at Δt 0 s / 0 km with
 * ΔM 1.3.
 *
 * Decided on *who computed it*, never on the values agreeing. Using value agreement would be
 * circular — the whole question is whether the values may legitimately disagree.
 */
export function isRepublication(a: Solution, b: Solution): boolean {
  if (a.sourceId === b.sourceId) return false;

  /*
   * Either record credited to the *other* source's own agency.
   *
   * This is the form that actually works, and the narrower "same contributor string" version did
   * not: a provider names the computing agency in its own vocabulary, so EMSC credits a USGS
   * solution to `NEIC` while the USGS record itself is credited to `us`. Comparing the two
   * strings finds nothing. Asking "is this credited to the other source's agency?" finds it.
   *
   * The labelled set's one hand-checked case turns on this exactly: Δt 0 s, 0 km, ΔM 1.3, EMSC
   * `auth: NEIC`. Without this rule the magnitude veto splits a pair that is demonstrably one
   * earthquake.
   */
  if (creditedToSource(b.contributor, a.sourceId)) return true;
  if (creditedToSource(a.contributor, b.sourceId)) return true;

  // Or both credited to the same third agency — two providers republishing one regional network.
  if (a.contributor === null || b.contributor === null) return false;
  return a.contributor.trim().toUpperCase() === b.contributor.trim().toUpperCase();
}

/** True when `contributor` is one of the agency codes belonging to `sourceId`. */
function creditedToSource(contributor: string | null, sourceId: string): boolean {
  if (contributor === null) return false;
  const codes = SOURCE_AGENCY_CODES[sourceId];
  if (codes === undefined) return false;
  const normalized = contributor.trim().toUpperCase();
  return codes.includes(normalized);
}

export interface MisfitTerms {
  readonly deltaSeconds: number;
  readonly distanceMeters: number;
  /** `null` when either solution has no magnitude, in which case the term is omitted. */
  readonly deltaMagnitude: number | null;
  readonly timeTerm: number;
  readonly distanceTerm: number;
  readonly magnitudeTerm: number;
  /** `0.5` when the magnitude types are not comparable, `1` when they are. */
  readonly magnitudeWeight: number;
  readonly misfit: number;
}

/** Raised when a misfit cannot be computed at all, e.g. an unusable position. */
export class MisfitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MisfitError';
  }
}

/**
 * The misfit and every term that made it, so a decision can be explained without recomputation.
 *
 * The terms are returned rather than just the total because they are stored on the link and shown
 * on the event page: "23.6 km apart, 0.7 s apart, magnitudes within 0.1" is an explanation, and
 * "misfit 0.37" is not.
 */
export function computeMisfit(a: Solution, b: Solution): MisfitTerms {
  const distanceMeters = vincentyDistanceMeters(a.epicentre, b.epicentre);
  if (distanceMeters === null) {
    // Nearly antipodal. Not a pair any candidate window would produce, but a misfit of NaN would
    // sort as a best candidate in some comparators, so it is refused rather than propagated.
    throw new MisfitError('the epicentres are too far apart to measure');
  }

  const deltaSeconds = Math.abs(a.originTime.getTime() - b.originTime.getTime()) / 1_000;
  if (!Number.isFinite(deltaSeconds)) throw new MisfitError('an origin time is not an instant');

  const timeTerm = deltaSeconds / MISFIT_SCALES.timeSeconds;
  const distanceTerm = distanceMeters / MISFIT_SCALES.distanceMeters;

  /*
   * A missing magnitude omits the term rather than scoring it as zero.
   *
   * Zero would mean "the magnitudes agree perfectly", which is a claim about data that does not
   * exist, and it would make a magnitude-less record the *best* candidate every time. Omitting it
   * means the decision rests on time and distance, which is all the evidence there is.
   */
  const deltaMagnitude =
    a.magnitude !== null && b.magnitude !== null ? Math.abs(a.magnitude - b.magnitude) : null;
  const magnitudeWeight = sameMagnitudeFamily(a.magnitudeType, b.magnitudeType)
    ? 1
    : CROSS_FAMILY_MAGNITUDE_WEIGHT;
  const magnitudeTerm =
    deltaMagnitude === null ? 0 : (magnitudeWeight * deltaMagnitude) / MISFIT_SCALES.magnitude;

  return {
    deltaSeconds,
    distanceMeters,
    deltaMagnitude,
    timeTerm,
    distanceTerm,
    magnitudeTerm,
    magnitudeWeight,
    misfit: timeTerm + distanceTerm + magnitudeTerm,
  };
}

export interface VetoVerdict {
  readonly vetoed: boolean;
  /** `MAGNITUDE_INCOMPATIBLE` when the veto fired, `null` otherwise. */
  readonly code: 'MAGNITUDE_INCOMPATIBLE' | null;
  /** True when the veto was suspended because one solution republishes the other. */
  readonly suspendedForRepublication: boolean;
}

/**
 * The magnitude veto, and the one case in which it is suspended.
 *
 * Beyond `MAGNITUDE_VETO` the two are not the same earthquake whatever the geometry says — except
 * when one source is republishing the other's solution, where a stale magnitude is expected and
 * the difference says nothing about identity.
 */
export function magnitudeVeto(a: Solution, b: Solution, terms: MisfitTerms): VetoVerdict {
  if (terms.deltaMagnitude === null || terms.deltaMagnitude <= MAGNITUDE_VETO) {
    return { vetoed: false, code: null, suspendedForRepublication: false };
  }
  if (isRepublication(a, b)) {
    return { vetoed: false, code: null, suspendedForRepublication: true };
  }
  return { vetoed: true, code: 'MAGNITUDE_INCOMPATIBLE', suspendedForRepublication: false };
}

/** True when the pair is inside the indexable candidate window. */
export function withinCandidateWindow(
  terms: Pick<MisfitTerms, 'deltaSeconds' | 'distanceMeters'>,
  window: { readonly maxDeltaSeconds: number; readonly maxDistanceMeters: number },
): boolean {
  return (
    terms.deltaSeconds <= window.maxDeltaSeconds && terms.distanceMeters <= window.maxDistanceMeters
  );
}
