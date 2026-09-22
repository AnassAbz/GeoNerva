#!/usr/bin/env node
/**
 * Loads an E2E scenario into a disposable database (docs/TESTING.md §5).
 *
 *   node scripts/seed-scenario.ts all-fresh
 *   node scripts/seed-scenario.ts firms-stale
 *
 * The target is `DATABASE_URL_TEST`, and nothing else — not `DATABASE_URL`, not
 * `DATABASE_URL_WORKER`, not even as a fallback. This script **truncates** before it seeds, so it
 * goes through `setupTestDatabase`, whose guard refuses any database that is not both on loopback
 * and named `*_test` (security finding F-6). A developer with a production URL in their shell
 * cannot lose their data to a mistyped `pnpm` script.
 *
 * It also applies every migration from empty, so the database does not have to exist beforehand.
 * Point the web process's `DATABASE_URL` at the same URL and set
 * `GEONERVA_FAKE_NOW` to the anchor this prints.
 */

import {
  seedMarrakechScenario,
  isScenarioName,
  SCENARIO_NAMES,
} from '@geonerva/test-fixtures/scenarios';
import { createDb } from '@geonerva/db';
import { setupTestDatabase } from '@geonerva/db/testing';

async function main(): Promise<void> {
  const requested = process.argv[2] ?? 'all-fresh';
  if (!isScenarioName(requested)) {
    process.stderr.write(
      `unknown scenario "${requested}"; expected one of ${SCENARIO_NAMES.join(', ')}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const testDb = await setupTestDatabase();
  const db = createDb(testDb.pool);
  try {
    await testDb.truncate();
    const result = await seedMarrakechScenario(db, requested);
    process.stdout.write(`scenario:        ${result.scenario}\n`);
    process.stdout.write(`GEONERVA_FAKE_NOW=${result.anchor}\n`);
    for (const [table, count] of Object.entries(result.counts)) {
      process.stdout.write(`${table.padEnd(34)} ${String(count).padStart(7)}\n`);
    }
  } finally {
    await db.destroy();
  }
}

await main();
