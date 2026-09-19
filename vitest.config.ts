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
          include: ['{apps,packages}/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['{apps,packages}/*/src/**/*.int.test.ts', 'scripts/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
