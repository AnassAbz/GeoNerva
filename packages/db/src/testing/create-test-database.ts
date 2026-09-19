/**
 * `pnpm --filter @geonerva/db db:test:create` — prepares the integration-test database.
 *
 * The development container hosts several databases; tests get their own (`geonerva_test` by
 * default) so that a test run can never disturb development data, and so that several agents can
 * share one container. This script creates that database if it is missing and applies every
 * migration from empty. It refuses any target the F-6 guard refuses.
 */

import { migrateUp } from '../migrator/runner.ts';
import { describeConnectionTarget } from '../connection-url.ts';
import {
  DEFAULT_TEST_DATABASE_URL,
  ensureTestDatabase,
  resolveTestDatabaseUrl,
  TEST_DATABASE_URL_VAR,
} from './test-database.ts';
import pg from 'pg';

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const url = resolveTestDatabaseUrl(process.env);
  write(`test database: ${describeConnectionTarget(url, TEST_DATABASE_URL_VAR)}`);
  if (process.env[TEST_DATABASE_URL_VAR] === undefined) {
    write(`(${TEST_DATABASE_URL_VAR} is unset; using the default ${DEFAULT_TEST_DATABASE_URL})`);
  }

  const { created } = await ensureTestDatabase(url);
  write(created ? 'created the database' : 'the database already exists');

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const result = await migrateUp(client);
    write(
      result.applied.length === 0
        ? `schema is up to date (${result.alreadyApplied} migrations)`
        : `applied ${result.applied.length} migration(s)`,
    );
  } finally {
    await client.end();
  }
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
