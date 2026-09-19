/**
 * `pnpm db:check` — verifies that the configured database can host GeoNerva.
 * Uses DATABASE_URL_WORKER, then DATABASE_URL, then the local compose database.
 */
import pg from 'pg';

import { checkDatabaseRequirements, resolveDatabaseUrl } from './lib/db-requirements.ts';

async function main(): Promise<number> {
  const client = new pg.Client({
    connectionString: resolveDatabaseUrl(process.env),
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
  } catch (error) {
    console.error(`✗ cannot connect to the database: ${(error as Error).message}`);
    console.error('  Is it running? For local development: pnpm db:up');
    return 1;
  }

  try {
    const report = await checkDatabaseRequirements(client);
    console.log(`${report.serverVersionOk ? '✓' : '✗'} ${report.serverVersion}`);
    for (const ext of report.extensions) {
      console.log(
        ext.availableVersion === null
          ? `✗ extension ${ext.name} is not available`
          : `✓ extension ${ext.name} ${ext.availableVersion} available`,
      );
    }
    return report.ok ? 0 : 1;
  } finally {
    await client.end();
  }
}

process.exitCode = await main();
