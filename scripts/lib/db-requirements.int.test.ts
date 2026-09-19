import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REQUIRED_EXTENSIONS,
  checkDatabaseRequirements,
  resolveDatabaseUrl,
} from './db-requirements.ts';

describe('integration database platform', () => {
  const client = new pg.Client({
    connectionString: resolveDatabaseUrl(process.env),
    connectionTimeoutMillis: 10_000,
  });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('runs PostgreSQL ≥ 15 with PostGIS and pg_trgm available', async () => {
    const report = await checkDatabaseRequirements(client);

    expect(report.serverVersionOk).toBe(true);
    expect(report.extensions.map((ext) => ext.name)).toEqual([...REQUIRED_EXTENSIONS]);
    for (const ext of report.extensions) {
      expect(ext.availableVersion, `${ext.name} must be available`).not.toBeNull();
    }
    expect(report.ok).toBe(true);
  });
});
