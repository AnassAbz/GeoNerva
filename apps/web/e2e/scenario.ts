/**
 * The seeded scenario database the E2E suite runs against (docs/TESTING.md §5).
 *
 * ### Why the seeder is a child process rather than an import
 *
 * `scripts/seed-scenario.ts` is the documented command (`pnpm db:seed:scenario`), and running *it*
 * — rather than calling `seedMarrakechScenario` from here — keeps the suite honest in two ways.
 * It exercises the same entry point a developer uses, so a change that breaks the script breaks
 * the suite; and it keeps `@geonerva/db`'s root barrel out of `apps/web`, where
 * `web-reads-facts-only-through-asof` forbids it outside a `*.test.ts` file. The seeder's own
 * guard (`setupTestDatabase`) is what refuses any database that is not on loopback and named
 * `*_test`, and it truncates before it writes.
 *
 * ### The anchor
 *
 * `SCENARIO_ANCHOR` is the instant every timestamp in the scenario is written relative to, and it
 * is what `GEONERVA_FAKE_NOW` freezes the web process at. It is declared here because
 * `playwright.config.ts` needs it *before* the seed runs — a web server is started before a setup
 * project — and `seedScenario` then **asserts** that the value the seeder printed is the same one.
 * A scenario re-anchored without this file being updated fails the setup project loudly, instead
 * of producing a suite whose relative times are all a few hours out.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Byte-identical to `SCENARIO_ANCHOR` in `packages/test-fixtures/scenarios/marrakech.ts`. */
export const SCENARIO_ANCHOR = '2026-09-22T13:06:00.000Z';

/**
 * The disposable database the suite seeds and serves from.
 *
 * Its own variable, not `DATABASE_URL_TEST`: the integration suite truncates *that* database
 * between tests, so sharing one would make `pnpm test:integration` and `pnpm test:e2e` destroy
 * each other's state if they ever overlapped. The name still ends in `_test`, which is the half of
 * the seeder's guard that says losing it is acceptable.
 */
export const E2E_DATABASE_URL =
  process.env['GEONERVA_E2E_DATABASE_URL'] ??
  'postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva_e2e_test';

const SEEDER = fileURLToPath(new URL('../../../scripts/seed-scenario.ts', import.meta.url));

export type ScenarioName = 'all-fresh' | 'firms-stale';

/**
 * Loads one scenario, replacing whatever was there.
 *
 * The two scenarios describe the same world with the same public ids, so they cannot coexist in
 * one database; see `playwright.config.ts` for how the projects are ordered around that.
 */
export function seedScenario(scenario: ScenarioName): void {
  const output = execFileSync(process.execPath, [SEEDER, scenario], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL_TEST: E2E_DATABASE_URL },
    /* Five minutes: the seed writes ~130,000 coverage hours and runs every migration first. */
    timeout: 300_000,
  });

  const anchor = /^GEONERVA_FAKE_NOW=(.+)$/mu.exec(output)?.[1]?.trim();
  if (anchor !== SCENARIO_ANCHOR) {
    throw new Error(
      `the ${scenario} scenario is anchored at ${anchor ?? '(not printed)'}, but the web server ` +
        `was started with GEONERVA_FAKE_NOW=${SCENARIO_ANCHOR}. Update SCENARIO_ANCHOR in ` +
        'apps/web/e2e/scenario.ts to match, or the suite will assert relative times against a ' +
        'clock the data was not written for.',
    );
  }
}
