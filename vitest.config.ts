import { defineConfig } from 'vitest/config';

/**
 * Two test projects (docs/TESTING.md §1):
 *  - unit:        pure, fast, no network, no database   (*.test.ts)
 *  - integration: real PostGIS via DATABASE_URL_TEST    (*.int.test.ts), run serially
 * E2E lives in apps/web (Playwright) and is not run by Vitest.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          /*
           * `apps/web` has no `src/`: Next.js requires `app/` at the project root and the server
           * modules live beside it in `lib/`. Those two directories are listed explicitly rather
           * than by widening the `src` glob, so a stray test outside them is still not collected.
           */
          include: [
            '{apps,packages}/*/src/**/*.test.ts',
            'apps/web/{app,lib}/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            '{apps,packages}/*/src/**/*.int.test.ts',
            'apps/web/{app,lib}/**/*.int.test.ts',
            'scripts/**/*.int.test.ts',
          ],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 30_000,
          /*
           * Hooks here create databases, run every migration, truncate, and drop databases —
           * real work, not setup noise, and vitest's 10 s default is the wrong bound for it. As
           * the suite grew past a hundred seconds the cleanup in `partition-repair.int.test.ts`
           * started crossing that line intermittently, and a timed-out `afterEach` leaves state
           * behind that fails whichever file happens to run next. That presented as unrelated
           * tests failing at random, which is a far more expensive thing to debug than a slow
           * hook.
           */
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
