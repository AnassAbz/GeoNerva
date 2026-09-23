import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The adversarial QA suite (docs/IMPLEMENTATION_PLAN.md §2.1, `tests/adversarial/**`).
 *
 * ### Why this has a config of its own
 *
 * The root `vitest.config.ts` collects only the `src` of each workspace package, `apps/web/{app,lib}` and
 * `scripts`. `tests/adversarial` is in none of those globs, and the root config is a
 * **foundational file** the orchestrator owns — an adversarial round may not edit it to make its
 * own findings runnable. So the suite carries its own config and is run explicitly:
 *
 * ```
 * DATABASE_URL_TEST=postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva_qa2_test \
 *   pnpm exec vitest run --config tests/adversarial/vitest.config.ts
 * ```
 *
 * These specs are **expected to fail**. Each one is a finding in `docs/reviews/qa-round-2.md`,
 * written as an executable assertion rather than prose. When a finding is fixed its spec turns
 * green; until then a red run is the report. Two of the ten pass, and they say so where they are
 * written — one of them disproved a finding that had been drafted.
 *
 * ### Why it is an integration project
 *
 * Every assertion here is about what the read models say about the seeded PostGIS scenario at one
 * fixed instant, which is the only place a "two surfaces disagree" claim can be settled. It needs
 * `DATABASE_URL_TEST` and runs serially, exactly as the root config's `integration` project does,
 * and for the same reasons.
 *
 * There is deliberately **no `resolve.alias` block**. The spec reaches the four packages it needs
 * by relative path; the header of `qa-round-2.int.test.ts` says why, and an alias for
 * `@geonerva/db` would additionally capture `@geonerva/db/asof` — which `packages/briefing`
 * imports — and break a package that resolves perfectly well on its own.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'adversarial',
          environment: 'node',
          /*
           * Rooted at this directory, not the repository. A repo-wide include glob also collects
           * `.claude/worktrees`, which is a stale checkout of the whole codebase — 1,487 tests of
           * someone else's branch reported as this round's result, which is what happened on the
           * first attempt.
           */
          dir: fileURLToPath(new URL('.', import.meta.url)),
          include: ['**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          /* The seed writes ~130,000 coverage hours through the production writers, per scenario. */
          hookTimeout: 900_000,
        },
      },
      {
        /*
         * The two findings that live in the React layer, in the file beside the suite they belong
         * to — `apps/web/components/hazard-card.qa2.spec.tsx`.
         *
         * It is named `.spec.tsx`, not `.test.tsx`, and that is the whole point: the root config's
         * `components` project collects every `.test.tsx` under `apps/web`, so that suffix here
         * would turn
         * `pnpm check` red. An adversarial round reports findings; it does not take the
         * orchestrator's gate command hostage, and a baseline that is red for this round's reasons
         * cannot be used to spot anyone else's regression. The specs still fail — they are run by
         * this config, which is where this round's results are read from.
         *
         * `root` is `apps/web` so jsdom, React and Testing Library resolve from the web app's own
         * dependencies, exactly as the root config's `components` project does.
         */
        root: fileURLToPath(new URL('../../apps/web', import.meta.url)),
        test: {
          name: 'adversarial-components',
          environment: 'jsdom',
          include: ['**/*.qa2.spec.tsx'],
          exclude: ['**/node_modules/**', '**/.next/**'],
          setupFiles: ['./test/setup-components.ts'],
        },
      },
    ],
  },
});
