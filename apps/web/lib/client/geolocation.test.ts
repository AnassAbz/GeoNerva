/**
 * "Use my location": the rounding is the test.
 *
 * PRODUCT §4.1 capability 1 says *coordinates rounded to ~1 km, never stored*, and invariant I15
 * fixes that at two decimals **before** a log line, a cache key or a query. The assertion that
 * matters is therefore not that a position comes back, but that the metre-accurate pair the
 * browser handed over cannot be observed by anything downstream.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GEOLOCATION_TIMEOUT_MS,
  GeolocationRefused,
  currentCoordinate,
  type PositionSource,
} from './geolocation.ts';

/** A browser that answers with one fixed fix. */
function reporting(latitude: number, longitude: number): PositionSource {
  return {
    getCurrentPosition: vi.fn((success: PositionCallback) => {
      success({
        coords: { latitude, longitude } as GeolocationCoordinates,
        timestamp: 0,
      } as GeolocationPosition);
    }),
  };
}

/** A browser that refuses, with one of the three codes the API defines. */
function refusing(code: number): PositionSource {
  return {
    getCurrentPosition: vi.fn(
      (_success: PositionCallback, failure?: PositionErrorCallback | null) => {
        failure?.({
          code,
          message: 'browser wording that is not ours to show',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        });
      },
    ),
  };
}

describe('currentCoordinate', () => {
  it('rounds to two decimals, so nothing finer ever leaves this function', async () => {
    await expect(currentCoordinate(reporting(48.8566140123, 2.3522219876))).resolves.toEqual({
      lat: 48.86,
      lon: 2.35,
    });
  });

  it('folds a negative zero and normalizes the antimeridian', async () => {
    await expect(currentCoordinate(reporting(-0.0011, 179.999))).resolves.toEqual({
      lat: 0,
      lon: -180,
    });
  });

  it('does not power up GNSS for precision it is about to discard', async () => {
    const source = reporting(31.63, -8);
    await currentCoordinate(source);
    const options = vi.mocked(source.getCurrentPosition).mock.calls[0]?.[2];
    expect(options).toMatchObject({ enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT_MS });
  });

  it('turns each refusal into a code this product owns, not the browser’s wording', async () => {
    const cases: readonly (readonly [number, string])[] = [
      [1, 'DENIED'],
      [2, 'UNAVAILABLE'],
      [3, 'TIMED_OUT'],
      [99, 'UNAVAILABLE'],
    ];
    for (const [code, failure] of cases) {
      const error = await currentCoordinate(refusing(code)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GeolocationRefused);
      expect((error as GeolocationRefused).failure).toBe(failure);
      expect((error as GeolocationRefused).message).not.toContain('browser wording');
    }
  });

  it('reports a browser with no geolocation rather than throwing something unhandled', async () => {
    // This test runs outside a browser, so the default source is the unsupported case.
    const error = await currentCoordinate().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GeolocationRefused);
    expect((error as GeolocationRefused).failure).toBe('UNSUPPORTED');
  });
});
