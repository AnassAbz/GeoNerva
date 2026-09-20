/**
 * Flood, tropical cyclone and volcano relevance (ARCHITECTURE §9.3–§9.5).
 *
 * The three hazards GDACS is the only v1 source for, and the three where the *geometry* rather
 * than a magnitude decides the answer. They share a file because they share the thing that makes
 * them different from earthquakes: GDACS publishes an **impact alert level** — its own estimate of
 * consequences, from its own model — and a shape, and relevance is a function of where the place
 * sits relative to that shape.
 *
 * Two things this file refuses to do, both of them documented decisions rather than omissions:
 *
 *  - **It never maps a GDACS level onto anything else.** GDACS Green/Orange/Red is an impact
 *    estimate; PAGER has a Yellow and a different model behind it. The two are not
 *    interchangeable and DATA_SOURCES §2.2 says so. The level string is used as itself.
 *  - **It never derives anything from `alertscore`.** RSS and the API disagree about the score for
 *    the same event, so any number computed from it would depend on which endpoint answered.
 *
 * And one piece of language that is not optional. A GDACS flood polygon is a *modelled* area from
 * GloFAS, not an observed inundation extent — Copernicus GFM's observed extent is WMS-only and
 * not ingestible as vectors — so every flood reason says "modelled" and the caveat says it again.
 * "You are inside the flooded area" is a sentence GeoNerva has no basis for.
 */

import type { RelevanceLevel } from '@geonerva/domain';

import type { Assessment, Reason } from './assessment.ts';
import { reason } from './assessment.ts';

export const FLOOD_MODEL_VERSION = 'fl-1';
export const CYCLONE_MODEL_VERSION = 'tc-1';
export const VOLCANO_MODEL_VERSION = 'vo-1';

/** GDACS's three levels, as themselves. A fourth value is drift the adapter already refuses. */
export type GdacsAlertLevel = 'Green' | 'Orange' | 'Red';

/** The caveat every flood assessment carries, verbatim in every rendering. */
export const FLOOD_MODELLED_AREA_CAVEAT =
  'The area shown is GDACS’s modelled flood-event area (from GloFAS), not an observed flood extent. ' +
  'It does not mean this location is flooded.';

/** The caveat every thermal-detection assessment carries (ARCHITECTURE §9.2). */
export const THERMAL_DETECTION_CAVEAT =
  'Satellite thermal detections can include non-vegetation heat sources (e.g. gas flares, ' +
  'industrial sites, volcanoes). They are not confirmed wildfires.';

export interface FloodInput {
  readonly alertLevel: GdacsAlertLevel;
  /** True when the place is inside `Poly_Affected`. */
  readonly insideArea: boolean;
  /** Distance to the modelled area in km, or `null` when no area geometry exists. */
  readonly distanceToAreaKm: number | null;
  /** Distance to the event centroid in km. Always available. */
  readonly centroidDistanceKm: number;
  /** False for a centroid-only event, which changes what the distance means. */
  readonly hasAreaGeometry: boolean;
}

/**
 * §9.3's table, as data. Rows are tried in order and the first match wins.
 *
 * The three GDACS levels give three different answers for the same geometric situation, which is
 * the whole point: the level is GDACS's estimate of consequence and the geometry is where the
 * place is. Neither alone is the answer.
 */
const FLOOD_INSIDE: Readonly<Record<GdacsAlertLevel, RelevanceLevel>> = {
  Red: 'CRITICAL',
  Orange: 'HIGH',
  Green: 'MODERATE',
};
const FLOOD_NEAR_AREA: Readonly<Record<GdacsAlertLevel, RelevanceLevel>> = {
  Red: 'HIGH',
  Orange: 'MODERATE',
  Green: 'LOW',
};
const FLOOD_CENTROID_ONLY: Readonly<Record<GdacsAlertLevel, RelevanceLevel>> = {
  Red: 'MODERATE',
  Orange: 'MODERATE',
  Green: 'LOW',
};

/** §9.3's distance bounds. */
export const FLOOD_NEAR_AREA_KM = 25;
export const FLOOD_CENTROID_ONLY_KM = 100;
export const FLOOD_OUTER_KM = 500;

export function assessFlood(input: FloodInput): Assessment | null {
  if (!Number.isFinite(input.centroidDistanceKm) || input.centroidDistanceKm < 0) return null;

  const reasons: Reason[] = [];
  const caveats: string[] = [FLOOD_MODELLED_AREA_CAVEAT];
  let level: RelevanceLevel | null = null;

  if (input.hasAreaGeometry && input.insideArea) {
    level = FLOOD_INSIDE[input.alertLevel];
    reasons.push(
      reason(
        'INSIDE_MODELLED_AREA',
        'This location is inside the GDACS flood-event area (modelled; not an observed flood extent).',
        { alertLevel: input.alertLevel },
      ),
    );
  } else if (
    input.hasAreaGeometry &&
    input.distanceToAreaKm !== null &&
    input.distanceToAreaKm <= FLOOD_NEAR_AREA_KM
  ) {
    level = FLOOD_NEAR_AREA[input.alertLevel];
    reasons.push(
      reason(
        'NEAR_MODELLED_AREA',
        `About ${Math.round(input.distanceToAreaKm)} km from the GDACS flood-event area (modelled).`,
        { alertLevel: input.alertLevel, distanceToAreaKm: Math.round(input.distanceToAreaKm) },
      ),
    );
  } else if (!input.hasAreaGeometry && input.centroidDistanceKm <= FLOOD_CENTROID_ONLY_KM) {
    level = FLOOD_CENTROID_ONLY[input.alertLevel];
    /*
     * A centroid-only event, which is a weaker statement and must read like one.
     *
     * Without an area there is no "inside", so the distance is to a point GDACS chose to
     * represent the event — and the relevance is capped accordingly. `NO_AREA_GEOMETRY` is the
     * reason code §9.3 names for this, and `FloodAttributes.has_area_geometry` exists to make it
     * answerable at all.
     */
    reasons.push(
      reason(
        'NO_AREA_GEOMETRY',
        `GDACS published no area for this flood event, only a location about ${Math.round(input.centroidDistanceKm)} km away.`,
        { centroidDistanceKm: Math.round(input.centroidDistanceKm) },
      ),
    );
  } else if (input.centroidDistanceKm <= FLOOD_OUTER_KM) {
    level = 'LOW';
    reasons.push(
      reason(
        'WITHIN_OUTER_RADIUS',
        `A GDACS flood event about ${Math.round(input.centroidDistanceKm)} km away.`,
        { centroidDistanceKm: Math.round(input.centroidDistanceKm) },
      ),
    );
  }

  if (level === null) return null;

  return {
    level,
    // CRITICAL here is GDACS's Red, which *is* an official impact alert — so a basis exists and
    // the caller must attach it, exactly as for an earthquake.
    requiresAuthoritativeBasis: level === 'CRITICAL',
    reasons,
    caveats,
    modelVersion: FLOOD_MODEL_VERSION,
  };
}

export interface CycloneInput {
  readonly alertLevel: GdacsAlertLevel;
  /** True when the place is inside the ≥ 120 km/h wind buffer, current **or** forecast. */
  readonly insideWind120: boolean;
  readonly insideWind90: boolean;
  readonly insideWind60: boolean;
  readonly insideUncertaintyCone: boolean;
  /** Distance to the track in km, or `null` when no track geometry is held. */
  readonly trackDistanceKm: number | null;
  /** True when the buffer the place sits in is a *forecast* rather than an observed position. */
  readonly isForecastGeometry: boolean;
  /** When the forecast this version carries was issued, for the reason text. */
  readonly forecastIssuedAt: string | null;
  /** The agency GDACS credits, e.g. "JTWC via GDACS". */
  readonly forecastAgency: string | null;
}

export const CYCLONE_TRACK_KM = 300;

export function assessCyclone(input: CycloneInput): Assessment | null {
  const reasons: Reason[] = [];
  let level: RelevanceLevel | null = null;

  /*
   * §9.4's table, in order. The wind buffers are nested, so the order is the whole logic: a place
   * inside the 120 km/h buffer is also inside the 90 and the 60, and taking the *first* match is
   * what makes it the strongest applicable statement rather than the weakest.
   */
  if (input.insideWind120) {
    level = input.alertLevel === 'Red' ? 'CRITICAL' : 'HIGH';
    reasons.push(
      reason('INSIDE_WIND_120', 'This location is inside the 120 km/h wind buffer.', {
        threshold: 120,
      }),
    );
  } else if (input.insideWind90) {
    level = input.alertLevel === 'Green' ? 'MODERATE' : 'HIGH';
    reasons.push(
      reason('INSIDE_WIND_90', 'This location is inside the 90 km/h wind buffer.', {
        threshold: 90,
      }),
    );
  } else if (input.insideWind60 || input.insideUncertaintyCone) {
    level = 'MODERATE';
    reasons.push(
      input.insideWind60
        ? reason('INSIDE_WIND_60', 'This location is inside the 60 km/h wind buffer.', {
            threshold: 60,
          })
        : reason(
            'INSIDE_UNCERTAINTY_CONE',
            'This location is inside the forecast uncertainty cone.',
            {},
          ),
    );
  } else if (input.trackDistanceKm !== null && input.trackDistanceKm <= CYCLONE_TRACK_KM) {
    level = 'LOW';
    reasons.push(
      reason('NEAR_TRACK', `About ${Math.round(input.trackDistanceKm)} km from the track.`, {
        trackDistanceKm: Math.round(input.trackDistanceKm),
      }),
    );
  }

  if (level === null) return null;

  /*
   * Observed or forecast, always stated.
   *
   * §9.4 requires it, and the reason is that they are different claims: "the storm is here" and
   * "an agency expects the storm here" cannot be rendered as the same sentence. GeoNerva never
   * computes its own tracks or arrival times, so the agency and the issue time are the provider's
   * and are quoted as such.
   */
  reasons.push(
    input.isForecastGeometry
      ? reason(
          'FORECAST_GEOMETRY',
          `This is a forecast position${input.forecastIssuedAt === null ? '' : `, issued ${input.forecastIssuedAt}`}${
            input.forecastAgency === null ? '' : `, from ${input.forecastAgency}`
          }.`,
          {
            forecast: true,
            issuedAt: input.forecastIssuedAt,
            agency: input.forecastAgency,
          },
        )
      : reason('OBSERVED_GEOMETRY', 'This is an observed position, not a forecast.', {
          forecast: false,
          agency: input.forecastAgency,
        }),
  );

  return {
    level,
    requiresAuthoritativeBasis: level === 'CRITICAL',
    reasons,
    caveats: [],
    modelVersion: CYCLONE_MODEL_VERSION,
  };
}

export interface VolcanoInput {
  readonly alertLevel: GdacsAlertLevel;
  readonly distanceKm: number;
  /** GDACS's own wording, when it published any. */
  readonly alertTextVerbatim: string | null;
}

export const VOLCANO_NEAR_KM = 100;
export const VOLCANO_OUTER_KM = 300;

/**
 * §9.5, which is one line in the document: within 100 km MODERATE, HIGH if Orange/Red; within
 * 300 km LOW. Ash dispersion is deferred, so there is no plume geometry to be inside of and no
 * `CRITICAL` reachable here at all.
 */
export function assessVolcano(input: VolcanoInput): Assessment | null {
  if (!Number.isFinite(input.distanceKm) || input.distanceKm < 0) return null;

  const reasons: Reason[] = [
    reason('DISTANCE', `About ${Math.round(input.distanceKm)} km away.`, {
      distanceKm: Math.round(input.distanceKm),
    }),
  ];
  if (input.alertTextVerbatim !== null && input.alertTextVerbatim.length > 0) {
    reasons.push(
      reason('PROVIDER_STATEMENT', input.alertTextVerbatim, {
        verbatim: true,
        alertLevel: input.alertLevel,
      }),
    );
  }

  let level: RelevanceLevel;
  if (input.distanceKm <= VOLCANO_NEAR_KM) {
    level = input.alertLevel === 'Green' ? 'MODERATE' : 'HIGH';
  } else if (input.distanceKm <= VOLCANO_OUTER_KM) {
    level = 'LOW';
  } else {
    return null;
  }

  return {
    level,
    /*
     * Never `CRITICAL`.
     *
     * §9.5 tops the volcano model out at HIGH, and ash dispersion — the thing that would justify
     * more — is explicitly deferred. Reaching CRITICAL would require an authoritative statement
     * about this place, and GDACS's volcano alert level is about the eruption rather than about
     * anywhere in particular.
     */
    requiresAuthoritativeBasis: false,
    reasons,
    caveats: [],
    modelVersion: VOLCANO_MODEL_VERSION,
  };
}
