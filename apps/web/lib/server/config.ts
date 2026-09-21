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

import { loadWebConfig, type WebConfig } from '@geonerva/config';

let cached: WebConfig | null = null;

export function webConfig(): WebConfig {
  cached ??= loadWebConfig(process.env);
  return cached;
}

/** Replaces the configuration. Tests only. */
export function setWebConfigForTesting(replacement: WebConfig | null): void {
  cached = replacement;
}
