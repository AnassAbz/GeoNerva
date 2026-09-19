/**
 * Time semantics (docs/DOMAIN_MODEL.md §2) — the most important section of the domain model.
 *
 * Every fact carries *when it happened in the world* (`observed_at`, `valid_from`, `valid_to`,
 * `source_updated_at`, all set by the provider) and *when GeoNerva learned it* (`ingested_at`,
 * a batch timestamp taken immediately before `COMMIT`). Reads are parameterized by an `as_of`
 * knowledge time; the default is `now()`.
 *
 * The domain never reads a clock. Anything that needs "now" receives it as an argument, which is
 * what makes replay, health derivation and the property tests deterministic.
 */

import { z } from 'zod';

/**
 * An instant serialized for transport: an ISO-8601 timestamp in UTC with milliseconds and a `Z`
 * suffix (`2026-09-19T12:17:03.123Z`). Read models use this form; in-process computation uses
 * `Date`. Local times and offsets are never stored — display converts to the location's IANA zone.
 */
export type IsoTimestamp = string;

/** Bitemporal interval during which a provider says a record applies. */
export interface ValidityInterval {
  /** Inclusive start, or `null` for an instantaneous event. */
  readonly validFrom: Date | null;
  /** Exclusive-ish end as the provider means it, or `null` when open-ended. */
  readonly validTo: Date | null;
}

/** Milliseconds in one second, minute, hour and day — used instead of magic numbers. */
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * How far into the future a provider's `observed_at` may sit relative to `ingested_at` before the
 * record is rejected with `FUTURE_OBSERVATION` (docs/DOMAIN_MODEL.md §2; invariant I13). Forecast
 * geometry is modelled through `valid_from`/`valid_to`, never through a future `observed_at`.
 */
export const FUTURE_OBSERVATION_TOLERANCE_MS = 5 * MINUTE_MS;

/** True when `observedAt` is acceptable for a version ingested at `ingestedAt` (invariant I13). */
export function isObservedAtAcceptable(observedAt: Date, ingestedAt: Date): boolean {
  return observedAt.getTime() <= ingestedAt.getTime() + FUTURE_OBSERVATION_TOLERANCE_MS;
}

/** True when a validity interval is ordered (`valid_to >= valid_from`), or partially unset. */
export function isValidityIntervalOrdered(interval: ValidityInterval): boolean {
  const { validFrom, validTo } = interval;
  if (validFrom === null || validTo === null) return true;
  return validTo.getTime() >= validFrom.getTime();
}

/** True when `at` falls inside the interval, treating `null` bounds as unbounded. */
export function isWithinValidity(interval: ValidityInterval, at: Date): boolean {
  const t = at.getTime();
  if (interval.validFrom !== null && t < interval.validFrom.getTime()) return false;
  if (interval.validTo !== null && t > interval.validTo.getTime()) return false;
  return true;
}

/** Serializes an instant to the canonical transport form. Throws on an invalid `Date`. */
export function toIsoTimestamp(value: Date): IsoTimestamp {
  const ms = value.getTime();
  if (Number.isNaN(ms)) throw new RangeError('cannot serialize an invalid Date');
  return value.toISOString();
}

/** Serializes an optional instant, preserving `null`. */
export function toIsoTimestampOrNull(value: Date | null): IsoTimestamp | null {
  return value === null ? null : toIsoTimestamp(value);
}

/**
 * Accepts an ISO-8601 timestamp **that carries an explicit offset or `Z`** and returns a `Date`.
 * Offsetless provider timestamps (GDACS) must be given an explicit UTC offset inside the adapter,
 * so that the choice is visible in the adapter's contract test rather than implied here.
 */
export const isoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/,
    'must be an ISO-8601 timestamp with an explicit UTC offset or Z',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a parseable timestamp');

/** Parses a transport timestamp into a `Date`, or returns `null` when it is unusable. */
export function parseIsoTimestamp(value: string): Date | null {
  const result = isoTimestampSchema.safeParse(value);
  if (!result.success) return null;
  return new Date(result.data);
}

/** Whole seconds between two instants, rounded down and never negative. */
export function elapsedSeconds(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / SECOND_MS));
}
