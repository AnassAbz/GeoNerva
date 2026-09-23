/**
 * What the web process does once, before it serves anything (security review **F-12**,
 * `docs/IMPLEMENTATION_PLAN.md` §3a).
 *
 * The worker has validated its environment and said which one it is since P3. The web process did
 * neither. `loadWebConfig` is memoized behind the first *request*, so a deployment with a missing
 * `RATE_LIMIT_SECRET` or an unparseable `MAP_STYLE_URL` booted happily, reported itself healthy,
 * and then answered `INTERNAL_ERROR` to whoever arrived first — with nothing in the logs to say
 * why, because the API layer deliberately flattens a configuration failure into a generic error so
 * that a caller cannot distinguish "misconfigured" from "broken". Correct for the caller, useless
 * for the operator.
 *
 * Next calls `register` once per server process, before the first request, which is the only
 * moment where "fail fast" is still available. So the configuration is parsed here, and the
 * process says what it is:
 *
 *     {"ts":"…","level":"info","event":"web.starting","detail":"NODE_ENV=production retention=lean"}
 *
 * one JSON object on stdout, the same shape the worker writes, because the runtime collecting them
 * does not care which of our processes produced a line.
 *
 * ### Why it throws
 *
 * A process that cannot read its own configuration should not accept requests. Throwing here fails
 * the deploy, which is visible; serving requests that all fail is not. The message names variables
 * and never values — that property belongs to `ConfigError` and is tested in `packages/config`.
 *
 * This file is server-only by construction: Next never bundles `instrumentation.ts` into the
 * client. It must stay that way, since it touches the environment (`docs/SECURITY.md` F-8).
 */

import { loadWebConfig } from '@geonerva/config';

export function register(): void {
  /*
   * Only the Node.js runtime. Next also runs this hook in the edge runtime, where the environment
   * is a different object and the database is unreachable, and validating there would fail a
   * deployment for a process that never serves a page.
   */
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  const config = loadWebConfig(process.env);

  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'web.starting',
      detail: `NODE_ENV=${config.NODE_ENV} retention=${config.RETENTION_PROFILE}`,
    })}\n`,
  );
}
