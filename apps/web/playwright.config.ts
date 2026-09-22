import { defineConfig, devices } from '@playwright/test';

import { E2E_DATABASE_URL, SCENARIO_ANCHOR } from './e2e/scenario.ts';

const PORT = 3100;

/**
 * E2E runs against a **production build** (`next build` must have run first), a **seeded scenario
 * database** and a **fixed clock** — the three things docs/TESTING.md §5 asks for, and the three
 * the P9a suite did not have.
 *
 * ### Why the web server needs `NODE_ENV=test`
 *
 * `next start` defaults `NODE_ENV` to `production`, and `packages/config` **refuses**
 * `GEONERVA_FAKE_NOW` when `NODE_ENV=production` — deliberately: a fixed clock in a deployed
 * environment would publish stale data as current. So the variable is set explicitly here. It is
 * not a way of making the build less production-like; the bundle is the one `next build` produced.
 *
 * ### Why the clock is fixed at all
 *
 * Every timestamp in the scenario is written as an offset from `SCENARIO_ANCHOR`, so with the
 * clock frozen there a spec can assert "22 minutes ago" and mean it. Without it the same spec
 * would assert against whatever the wall clock happened to say, and the seeded world would age out
 * of every freshness policy within hours of being written.
 *
 * ### Why the two scenarios are a re-seed rather than a second server
 *
 * `all-fresh` and `firms-stale` describe the same world — the same place, the same public ids —
 * with the fire feeds up or down, so they cannot share a database. Two databases would mean two
 * `next start` processes on two ports; this run has **one** port allocated, and a second server
 * would also double the surface for the two worlds to be confused for each other in a failure
 * message. So the outage projects declare a dependency on the all-fresh ones, a setup project
 * re-seeds between them, and the web process — which holds no data of its own and reads the
 * database per request — is left running. The ordering is Playwright's, not a sleep.
 *
 * `reuseExistingServer` is **false** even locally, unlike the P9a config. A server left over from
 * `pnpm dev` points at the development database on the wall clock, and reusing it would produce a
 * suite that passes or fails for reasons the seed has nothing to do with.
 */
export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'seed all-fresh', testMatch: /seed-all-fresh\.setup\.ts$/u },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['seed all-fresh'],
      testIgnore: /outage\.spec\.ts$/u,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      dependencies: ['seed all-fresh'],
      testIgnore: /outage\.spec\.ts$/u,
    },
    /*
     * After both viewports have finished with the all-fresh world, not before: this truncates it.
     */
    {
      name: 'seed firms-stale',
      testMatch: /seed-firms-stale\.setup\.ts$/u,
      dependencies: ['desktop', 'mobile'],
    },
    {
      name: 'desktop · fire sources stale',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['seed firms-stale'],
      testMatch: /outage\.spec\.ts$/u,
    },
    {
      name: 'mobile · fire sources stale',
      use: { ...devices['Pixel 7'] },
      dependencies: ['seed firms-stale'],
      testMatch: /outage\.spec\.ts$/u,
    },
  ],
  webServer: {
    command: `pnpm exec next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      /* See the header: without this, `packages/config` refuses the fixed clock outright. */
      NODE_ENV: 'test',
      GEONERVA_FAKE_NOW: SCENARIO_ANCHOR,
      DATABASE_URL: E2E_DATABASE_URL,
      /*
       * Test-only values for the two variables `loadWebConfig` requires and the suite never
       * exercises. The rate-limit key has to satisfy the config layer's entropy rule; it is a
       * throw-away string for a loopback process that serves one seeded database.
       */
      RATE_LIMIT_SECRET: 'e2e-rate-limit-key-not-a-real-deployment-secret',
      NOMINATIM_CONTACT: 'e2e@geonerva.invalid',
      /* One structured line per request is noise in a Playwright log; failures still print. */
      LOG_LEVEL: 'warn',
    },
  },
});
