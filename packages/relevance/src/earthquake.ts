/**
 * Earthquake relevance (ARCHITECTURE §9.1).
 *
 * "How much attention does this deserve for this place?" — **not** the probability of harm, and
 * the methodology page says so in those words (ADR-017). The distinction is not pedantry: a
 * number that looks like a probability will be read as one, and GeoNerva has no basis for one.
 * It has a magnitude, a distance, and whether an authority issued an alert.
 *
 * Every threshold here is transcribed from §9.1 rather than invented, and the table is reproduced
 * in `EARTHQUAKE_BANDS` so that a reader can compare the code with the document line by line.
 * They are documented *heuristics*, reviewed against historical scenarios before freeze — which
 * is exactly why they are data in one place rather than conditionals spread through a function.
 *
 * Three rules that are easy to get wrong and matter more than the thresholds:
 *
 *  1. **`CRITICAL` requires an authoritative basis.** Invariant I10. GeoNerva's own heuristics top
 *     out at `HIGH`, whatever the magnitude and however close it is. An M8 next door is `HIGH`
 *     until an authority says otherwise, because "critical" is a claim only an authority can
 *     make — and the `authoritativeBasis` is the citation that proves one did.
 *  2. **Depth demotes by one level, and cannot demote below `LOW`.** A 600 km hypocentre under
 *     your feet is felt far less than a 10 km one 50 km away, and the bands are magnitude-first.
 *  3. **The tsunami flag never changes the level.** USGS documents it as "does not indicate if a
 *     tsunami actually did or will exist"; it is a reason with the provider's own wording and a
 *     pointer to the warning centres, and treating it as a severity signal would be GeoNerva
 *     making the claim USGS explicitly declined to make.
 *
 * `d` is **hypocentral** distance — the slant distance through the earth, not the epicentral
 * distance along the surface. For a deep event those differ enormously: a 600 km-deep earthquake
 * directly beneath a place is 600 km away, not 0 km, and using the epicentral distance would put
 * it in the nearest band and then demote it once for depth, which is not the same answer.
 */

import type { LatLon, RelevanceLevel } from '@geonerva/domain';

import type { Assessment, Reason } from './assessment.ts';
import { demote, reason } from './assessment.ts';

/** Bumped whenever any threshold or rule here changes (ARCHITECTURE §4.14). */
export const EARTHQUAKE_MODEL_VERSION = 'eq-1';

/**
 * §9.1's table, as data.
 *
 * First match wins, in order. Each band is "magnitude at least `minMagnitude` **and** hypocentral
 * distance at most `maxDistanceKm`".
 */
export const EARTHQUAKE_BANDS: readonly {
  readonly level: Exclude<RelevanceLevel, 'CRITICAL'>;
  readonly minMagnitude: number;
  readonly maxDistanceKm: number;
}[] = [
  { level: 'HIGH', minMagnitude: 7.0, maxDistanceKm: 400 },
  { level: 'HIGH', minMagnitude: 6.0, maxDistanceKm: 150 },
  { level: 'HIGH', minMagnitude: 5.0, maxDistanceKm: 50 },
  { level: 'MODERATE', minMagnitude: 7.5, maxDistanceKm: 1_500 },
  { level: 'MODERATE', minMagnitude: 6.5, maxDistanceKm: 800 },
  { level: 'MODERATE', minMagnitude: 5.5, maxDistanceKm: 300 },
  { level: 'MODERATE', minMagnitude: 4.5, maxDistanceKm: 100 },
];

/** Depth at or beyond which the level is demoted once, with reason `DEEP_FOCUS`. */
export const DEEP_FOCUS_KM = 300;

/** Epicentral distance within which an official impact alert can justify `CRITICAL`. */
export const AUTHORITATIVE_ALERT_RADIUS_KM = 100;

/** Felt reports at or above which the count is worth stating. Never a level change. */
export const FELT_REPORTS_THRESHOLD = 10;

/** The provider severities that count as an official impact alert (PAGER and GDACS). */
const ALERT_SEVERITIES: ReadonlySet<string> = new Set(['orange', 'red', 'Orange', 'Red']);

export interface EarthquakeInput {
  readonly location: LatLon;
  readonly epicentre: LatLon;
  /** Along-the-surface distance, in km. Measured by the caller (PostGIS or `packages/geo`). */
  readonly epicentralDistanceKm: number;
  readonly magnitude: number | null;
  readonly depthKm: number | null;
  /** The provider's review state, verbatim: `automatic`, `reviewed`, `manual`. */
  readonly providerStatus: string | null;
  /** PAGER (`green`…`red`) or GDACS (`Green`…`Red`), whichever the item carries. */
  readonly severityScheme: string | null;
  readonly severityValue: string | null;
  readonly feltReports: number | null;
  readonly tsunamiFlag: boolean;
  /** `CONFLICT` when the sources describing this event disagree materially. */
  readonly agreementLevel: string | null;
  /** True when at least two independent sources describe it (ADR-030). */
  readonly corroborated: boolean;
}

/**
 * Hypocentral distance: the slant distance from the place to the hypocentre, in km.
 *
 * √(epicentral² + depth²). A flat-earth Pythagoras over a curved surface, which is correct to
 * well within the precision of either input at the distances the bands use, and which is the
 * standard seismological definition.
 *
 * A null depth is treated as 0 — i.e. the epicentral distance — because an unknown depth must not
 * make an event *look further away* and therefore less relevant. Guessing shallow is the
 * conservative direction.
 */
export function hypocentralDistanceKm(epicentralKm: number, depthKm: number | null): number {
  const depth = depthKm === null ? 0 : Math.max(0, depthKm);
  return Math.sqrt(epicentralKm * epicentralKm + depth * depth);
}

/**
 * Assesses one earthquake for one place.
 *
 * Returns `null` when the event cannot be assessed at all, which is not the same as `LOW`: an
 * event with no magnitude has no band, and inventing one would be GeoNerva asserting a
 * measurement the provider withheld. The caller lists it as unassessed rather than as unimportant.
 */
export function assessEarthquake(input: EarthquakeInput): Assessment | null {
  if (input.magnitude === null || !Number.isFinite(input.magnitude)) return null;
  if (!Number.isFinite(input.epicentralDistanceKm) || input.epicentralDistanceKm < 0) return null;

  const magnitude = input.magnitude;
  const hypocentralKm = hypocentralDistanceKm(input.epicentralDistanceKm, input.depthKm);
  const reasons: Reason[] = [];
  const caveats: string[] = [];

  reasons.push(
    reason('DISTANCE', `About ${Math.round(input.epicentralDistanceKm)} km away.`, {
      epicentralDistanceKm: Math.round(input.epicentralDistanceKm),
      hypocentralDistanceKm: Math.round(hypocentralKm),
    }),
  );
  reasons.push(reason('MAGNITUDE', `Magnitude ${magnitude.toFixed(1)}.`, { magnitude }));

  /*
   * The band, on hypocentral distance. First match in §9.1's order.
   *
   * `LOW` is the floor rather than a band: anything the caller handed us is inside the search
   * radius by construction, and "within the search radius" is what §9.1 gives as the LOW rule.
   */
  let level: RelevanceLevel = 'LOW';
  for (const band of EARTHQUAKE_BANDS) {
    if (magnitude >= band.minMagnitude && hypocentralKm <= band.maxDistanceKm) {
      level = band.level;
      break;
    }
  }

  /*
   * Depth demotes once.
   *
   * Applied *after* the band and before the authoritative upgrade, because a deep event with an
   * official alert is still critical — the authority has already accounted for the depth in a way
   * GeoNerva has not.
   */
  if (input.depthKm !== null && input.depthKm >= DEEP_FOCUS_KM) {
    level = demote(level);
    reasons.push(
      reason(
        'DEEP_FOCUS',
        `The hypocentre is ${Math.round(input.depthKm)} km deep, so shaking at the surface is much weaker than the magnitude alone suggests.`,
        { depthKm: Math.round(input.depthKm) },
      ),
    );
  }

  if (input.providerStatus === 'automatic') {
    reasons.push(
      reason(
        'PRELIMINARY_SOLUTION',
        'This is an automatic solution and has not been reviewed by a seismologist; it may be revised.',
        { providerStatus: 'automatic' },
      ),
    );
  }

  if (input.feltReports !== null && input.feltReports >= FELT_REPORTS_THRESHOLD) {
    reasons.push(
      reason('FELT_REPORTS', `${input.feltReports} people reported feeling it.`, {
        feltReports: input.feltReports,
      }),
    );
  }

  if (input.tsunamiFlag) {
    /*
     * The provider's own caveat, and nothing added to it.
     *
     * USGS documents this flag as "does not indicate if a tsunami actually did or will exist" —
     * it marks an event as large and oceanic, no more. It never changes the level, because doing
     * so would be GeoNerva making precisely the claim USGS declined to make.
     */
    reasons.push(
      reason(
        'USGS_TSUNAMI_FLAG',
        'USGS has flagged this event as one for which tsunami information may exist. Per USGS, the flag "does not indicate if a tsunami actually did or will exist". Consult the official tsunami warning centres.',
        { tsunami: true },
      ),
    );
  }

  if (input.agreementLevel === 'CONFLICT') {
    reasons.push(
      reason('SOURCES_DISAGREE', 'The sources describing this event do not agree materially.', {}),
    );
    caveats.push(
      'Two or more sources describe this earthquake differently; the figures shown are one source’s.',
    );
  }

  if (!input.corroborated) {
    reasons.push(
      reason('SINGLE_SOURCE', 'Only one independent source has reported this event.', {}),
    );
  }

  /*
   * `CRITICAL`, and the only way to reach it.
   *
   * An official impact alert at `orange`/`red`, within 100 km **epicentral** — the document says
   * epicentral here, not hypocentral, because the alert is about the surface footprint the
   * authority modelled.
   *
   * The `authoritativeBasis` is assembled by the caller, which has the source name, the verbatim
   * statement and the evidence id; this function reports that the *condition* is met. A caller
   * that cannot produce the basis must not produce a `CRITICAL` (invariant I10), so the flag and
   * the level travel together.
   */
  const hasOfficialAlert =
    input.severityValue !== null &&
    ALERT_SEVERITIES.has(input.severityValue) &&
    (input.severityScheme === 'PAGER' || input.severityScheme === 'GDACS_ALERT');
  const criticalEligible =
    hasOfficialAlert && input.epicentralDistanceKm <= AUTHORITATIVE_ALERT_RADIUS_KM;

  if (criticalEligible) {
    reasons.push(
      reason(
        'OFFICIAL_IMPACT_ALERT',
        `An official impact alert (${input.severityScheme} ${input.severityValue}) covers this event.`,
        { scheme: input.severityScheme, value: input.severityValue },
      ),
    );
  }

  return {
    level: criticalEligible ? 'CRITICAL' : level,
    requiresAuthoritativeBasis: criticalEligible,
    reasons,
    caveats,
    modelVersion: EARTHQUAKE_MODEL_VERSION,
  };
}
