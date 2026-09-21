/**
 * The guard clause of `consumeRateLimit`.
 *
 * The counter itself needs a database and is tested through the endpoint
 * (`apps/web/app/api/v1/api.int.test.ts`). What can be tested without one is the argument check,
 * and it is worth testing because of *where* it fails: `rate_limit_buckets.bucket_key` carries
 * `CHECK (octet_length(bucket_key) = 32)`, so a wrong-sized key reaches Postgres, violates a
 * constraint, and surfaces to the caller as a generic `INTERNAL_ERROR` — an error that names
 * nothing and points at the wrong layer. Failing here names the actual mistake.
 *
 * The database handle is never touched, which is what makes this a unit test: the guard runs
 * before any query, and passing a value that would explode if used is the assertion that it does.
 */

import { describe, expect, it } from 'vitest';

import { consumeRateLimit } from './rate-limit.ts';

/** Any use of this would throw, so the test fails loudly if the guard stops guarding. */
const unusableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('consumeRateLimit reached the database before validating its key');
    },
  },
) as never;

const WINDOW_START = new Date('2026-09-21T12:34:00.000Z');

describe('consumeRateLimit', () => {
  it.each([
    ['empty', 0],
    ['too short', 16],
    ['too long', 64],
    ['one byte short', 31],
    ['one byte long', 33],
  ])('refuses a %s key before touching the database', async (_label, size) => {
    await expect(
      consumeRateLimit(unusableDb, { key: Buffer.alloc(size), windowStart: WINDOW_START }),
    ).rejects.toThrow('exactly 32 bytes');
  });

  /*
   * The positive half of the same guard: a 32-byte key must pass it and reach the query. The
   * proxy throwing is the evidence that it did — which is a strange-looking assertion and the only
   * one available without a database.
   */
  it('accepts a 32-byte key and proceeds to the query', async () => {
    await expect(
      consumeRateLimit(unusableDb, { key: Buffer.alloc(32), windowStart: WINDOW_START }),
    ).rejects.toThrow('reached the database');
  });
});
