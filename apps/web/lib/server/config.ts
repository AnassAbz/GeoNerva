/**
 * The web process's validated environment.
 *
 * `loadWebConfig` fails fast with a readable error that names variables but never echoes their
 * values (`packages/config`). It is memoized here because it is called per request and the
 * validation is not free, and because a process whose configuration changed mid-flight would be
 * worse than one that needs a restart.
 *
 * A failure to load is raised as a plain `Error`, not a problem document: the API layer turns it
 * into a generic `INTERNAL_ERROR`, so a caller cannot distinguish "misconfigured" from "broken".
 * That difference is information about the deployment.
 */

import { hasFixedClock, loadWebConfig, nowFrom, type WebConfig } from '@geonerva/config';

let cached: WebConfig | null = null;

export function webConfig(): WebConfig {
  cached ??= loadWebConfig(process.env);
  return cached;
}

/** Replaces the configuration. Tests only. */
export function setWebConfigForTesting(replacement: WebConfig | null): void {
  cached = replacement;
}

/**
 * **The web process's clock.** Every server-side read of "now" goes through here.
 *
 * It is a function of the validated configuration, so `GEONERVA_FAKE_NOW` freezes it for the whole
 * process — which is what lets a Playwright run assert on a relative time ("22 minutes ago")
 * instead of on whatever the wall clock happened to say. `packages/config` refuses that variable
 * when `NODE_ENV=production`, so a deployment cannot acquire a frozen clock by accident.
 *
 * It reads the configuration at call time rather than capturing an instant at module load,
 * because a Next.js server module is loaded once and served for the life of the process: a
 * captured instant would freeze the clock in *every* environment, which is the opposite of the
 * intent.
 */
export function serverNow(): Date {
  return nowFrom(webConfig());
}

/** True when this process is running on a fixed clock. Never true in production. */
export function serverClockIsFixed(): boolean {
  return hasFixedClock(webConfig());
}
