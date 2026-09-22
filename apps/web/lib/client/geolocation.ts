/**
 * "Use my location" (docs/PRODUCT.md §4.1, capability 1: *explicit click; coordinates rounded to
 * ~1 km, never stored*).
 *
 * Three rules, all of them here rather than in the component that calls it:
 *
 * **It is never automatic.** Nothing in this module runs on mount or on render. The browser's own
 * permission prompt is the second consent; the click is the first, and a page that asks for a
 * position before being asked trains people to dismiss the prompt.
 *
 * **The position is rounded before it exists anywhere else.** `roundUserCoordinate` is applied
 * inside the success callback, so the metre-accurate pair the browser hands over is never
 * returned, never assigned to state, never interpolated into a URL and never passed to a
 * request. Invariant I15 is about two decimals — roughly 1.1 km — and the cheapest way to hold
 * it is to give the rest of the application no way to see anything finer.
 *
 * **Nothing is stored and nothing is logged.** No `localStorage`, no cookie, no `console`. The
 * rounded pair goes into the route the visitor navigates to and nowhere else; a reload asks
 * again.
 *
 * `enableHighAccuracy` is left off deliberately. It powers up GNSS to buy metres that are thrown
 * away by the very next statement, at a real cost in battery and in time to first answer.
 */

import { roundUserCoordinate, type LatLon } from '@geonerva/domain';

import { normalizeLongitude } from './coordinates.ts';

/** Why a position could not be had. Each one has a plain sentence in `COPY.home`. */
export type GeolocationFailure = 'UNSUPPORTED' | 'DENIED' | 'UNAVAILABLE' | 'TIMED_OUT';

export class GeolocationRefused extends Error {
  readonly failure: GeolocationFailure;

  constructor(failure: GeolocationFailure) {
    super(`geolocation ${failure}`);
    this.name = 'GeolocationRefused';
    this.failure = failure;
  }
}

/** The one method used, so a test can supply a double without a DOM. */
export type PositionSource = Pick<Geolocation, 'getCurrentPosition'>;

/** Ten seconds, then a plain message. A prompt left unanswered must not hang the button. */
export const GEOLOCATION_TIMEOUT_MS = 10_000;

/** A cached fix up to five minutes old is accepted: at 1.1 km it is the same answer. */
export const GEOLOCATION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The visitor's approximate position, already rounded.
 *
 * Rejects with `GeolocationRefused` — never with a raw `GeolocationPositionError`, whose
 * `message` is browser-authored text this product does not control and would not want to show.
 */
export async function currentCoordinate(source?: PositionSource): Promise<LatLon> {
  const geolocation = source ?? browserGeolocation();
  if (geolocation === null) throw new GeolocationRefused('UNSUPPORTED');

  return new Promise<LatLon>((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => {
        // Rounded here, in the callback, so nothing finer than two decimals is ever returned.
        resolve({
          lat: roundUserCoordinate(position.coords.latitude),
          lon: normalizeLongitude(roundUserCoordinate(position.coords.longitude)),
        });
      },
      (error: GeolocationPositionError) => {
        reject(new GeolocationRefused(failureOf(error)));
      },
      {
        enableHighAccuracy: false,
        timeout: GEOLOCATION_TIMEOUT_MS,
        maximumAge: GEOLOCATION_MAX_AGE_MS,
      },
    );
  });
}

/**
 * The constants rather than the numbers, and an unknown code degrades to `UNAVAILABLE`: a
 * browser that invents a fourth code must still reach a sentence, not an unhandled rejection.
 */
function failureOf(error: GeolocationPositionError): GeolocationFailure {
  if (error.code === error.PERMISSION_DENIED) return 'DENIED';
  if (error.code === error.TIMEOUT) return 'TIMED_OUT';
  return 'UNAVAILABLE';
}

/** `null` in a server render, in a non-secure context, and in browsers without the API. */
function browserGeolocation(): PositionSource | null {
  if (typeof navigator === 'undefined') return null;
  const candidate: unknown = navigator.geolocation;
  if (candidate === null || candidate === undefined) return null;
  return navigator.geolocation;
}
