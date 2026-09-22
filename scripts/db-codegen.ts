/**
 * `pnpm db:codegen` — regenerates `packages/db/src/generated/database.ts` from the live schema.
 *
 * It exists because the bare `kysely-codegen` invocation demanded `DATABASE_URL` and threw when it
 * was unset, while every other database script in this repository falls back to the local compose
 * database. The result was silent: after migrations 0017 and 0018 the generated types were missing
 * `feed_coverage_hours`, `fire_daily_counts` and `fire_daily_coverage` and still declared the
 * dropped `fire_daily_cells`, and nothing failed, because the code that uses those tables writes
 * its own SQL. A generated file only stays honest if regenerating it is the easy thing to do.
 *
 * It resolves the connection the same way `pnpm db:check` does, so the two can never disagree
 * about which database is "the" database. Both child processes are started from their JavaScript
 * entry points with `shell: false`: a shell on Windows would need `"geonerva.*"` quoted one way
 * and a POSIX shell another, and the wrong one silently introspects every schema.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { resolveDatabaseUrl } from './lib/db-requirements.ts';

const OUT_FILE = 'src/generated/database.ts';
const packageDir = fileURLToPath(new URL('../packages/db/', import.meta.url));
/*
 * Resolved from `packages/db`, not from here: `kysely-codegen` is that package's own devDependency
 * and pnpm's isolated `node_modules` means it is not reachable from `scripts/`. Prettier is a root
 * devDependency, so it resolves from this file.
 */
const requireFromDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const require = createRequire(import.meta.url);

function runNode(entry: string, args: readonly string[]): number {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: packageDir,
    stdio: 'inherit',
  });
  // A signal leaves `status` null; report that as a failure rather than as a success.
  return result.status ?? 1;
}

const generated = runNode(requireFromDb.resolve('kysely-codegen/dist/cli/bin.js'), [
  '--url',
  resolveDatabaseUrl(process.env),
  '--dialect',
  'postgres',
  '--default-schema',
  'geonerva',
  '--include-pattern',
  'geonerva.*',
  '--out-file',
  OUT_FILE,
]);

if (generated !== 0) {
  console.error('✗ codegen failed. Is the database running and migrated?');
  console.error('  pnpm db:up && pnpm db:migrate');
  process.exitCode = generated;
} else {
  process.exitCode = runNode(require.resolve('prettier/bin/prettier.cjs'), ['--write', OUT_FILE]);
}
