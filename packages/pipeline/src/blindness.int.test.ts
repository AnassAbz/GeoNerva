/**
 * G3 carry-over 2: being blind must never look like an all-clear.
 *
 * RLS is enabled on every fact table with no policies, so the `geonerva_web` role sees zero rows
 * until a policy is written (P6). The danger is not that reads fail — it is that they *succeed*
 * and return nothing, because "no earthquakes near you" and "we cannot see any earthquakes" are
 * rendered by the same empty array.
 *
 * This file pins what an RLS-blinded reader actually observes, so the briefing engine is built
 * against the measured behaviour rather than an assumption about it. The rule it must honour:
 *
 *   An empty result is only evidence of calm when there is *positive* evidence of coverage.
 *   With no health rows, the answer is DATA_UNAVAILABLE, never NO_HIGH_RELEVANCE_ITEMS.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, healthAsOf, observationsAsOf, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { createSourceClient, usgsAdapter } from '@geonerva/sources';
import { readFixtureBytes } from '@geonerva/test-fixtures';

import { createMemoryLogger } from './logging.ts';
import { runIngestion } from './run.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
});

async function ingestRealFixture(): Promise<void> {
  const client = createSourceClient(usgsAdapter.descriptor, {
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    fetchImpl: () =>
      Promise.resolve(
        new Response(readFixtureBytes('usgs', 'all_day.geojson'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
  const outcome = await runIngestion({
    db,
    adapter: usgsAdapter,
    client,
    trigger: 'MANUAL',
    logger: createMemoryLogger(),
  });
  expect(outcome.status).toBe('SUCCEEDED');
}

/**
 * Runs a read with the privileges the web app will have.
 *
 * `SET LOCAL ROLE` inside a transaction, so the role cannot leak into another pooled connection.
 */
async function asWebRole<T>(read: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE geonerva_web`.execute(trx);
    return read(trx);
  });
}

describe('an RLS-blinded reader', () => {
  it('sees no facts, even though the facts are there', async () => {
    await ingestRealFixture();

    const asOwner = await observationsAsOf(db, { asOf: new Date() });
    expect(asOwner, 'the data really is in the database').toHaveLength(230);

    const asWeb = await asWebRole((trx) => observationsAsOf(trx, { asOf: new Date() }));
    expect(asWeb, 'and the web role can see none of it').toHaveLength(0);
  });

  it('also sees no source health, which is what makes the blindness detectable', async () => {
    await ingestRealFixture();

    const ownerHealth = await healthAsOf(db, { asOf: new Date(), sourceIds: ['usgs'] });
    expect(ownerHealth.bySource.length).toBeGreaterThan(0);
    expect(ownerHealth.bySource[0]?.status).toBe('FRESH');

    const webHealth = await asWebRole((trx) =>
      healthAsOf(trx, { asOf: new Date(), sourceIds: ['usgs'] }),
    );

    // The important part. Health comes back *empty* rather than "UNAVAILABLE", because the
    // `sources` table is behind the same deny-all. So the briefing engine cannot look for a
    // status of UNAVAILABLE to detect blindness — the absence of any health row is the signal,
    // and it must fail closed.
    expect(webHealth.bySource).toHaveLength(0);
    expect(webHealth.byProduct).toHaveLength(0);
  });

  it('cannot be distinguished from a genuinely quiet world by the facts alone', async () => {
    // The two situations that must never render the same sentence, shown here producing byte
    // identical fact arrays. Only the health evidence tells them apart, which is exactly why the
    // headline rule is "no health rows means DATA_UNAVAILABLE".
    const blinded = await asWebRole((trx) => observationsAsOf(trx, { asOf: new Date() }));

    await testDb.truncate();
    const genuinelyEmpty = await observationsAsOf(db, { asOf: new Date() });

    expect(blinded).toStrictEqual(genuinelyEmpty);
    expect(blinded).toHaveLength(0);

    // ...and here is the difference the briefing must key on, in the one case where we do have
    // coverage evidence: an ingested, healthy source with zero relevant observations nearby.
    await ingestRealFixture();
    const health = await healthAsOf(db, { asOf: new Date(), sourceIds: ['usgs'] });
    expect(health.bySource[0]?.status, 'coverage evidence exists here').toBe('FRESH');
  });
});
