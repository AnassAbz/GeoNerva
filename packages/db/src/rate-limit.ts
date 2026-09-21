/**
 * Fixed-window rate-limit counters (ARCHITECTURE §13.4).
 *
 * This module is **not** under `src/repositories/`, and the placement is deliberate rather than
 * tidy. `web-reads-facts-only-through-asof` forbids `apps/web` from reaching a repository, because
 * a repository read returns the newest row instead of the row as of `T` and would turn a replay
 * into the present. A rate-limit counter is neither a provider fact nor something a knowledge time
 * can be applied to — it is an operational counter, and `rate_limit_buckets` is one of exactly two
 * tables migration 0007 grants the web role `INSERT`/`UPDATE` on. So it lives beside `asof.ts` and
 * `client.ts` and is reached through its own subpath, which keeps the rule's letter *and* its
 * intent: no fact reaches the read path except through the as-of layer.
 *
 * ### Why the counter is a single statement
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING n` is atomic. A read-then-write would let two
 * concurrent requests both observe `n = limit - 1` and both proceed, which is the classic way a
 * limit of 60 becomes a limit of 120 under exactly the load it exists for.
 *
 * ### The rejected request is counted
 *
 * `n` is incremented before the limit is compared, so a request that is refused still consumes
 * from its window. That is the intended behaviour for a fixed window protecting a third party: a
 * caller who keeps hammering a refused endpoint does not get a free retry budget, and the window
 * does not reset early because some requests were rejected.
 */

import { sql, type Kysely } from 'kysely';

import type { DB } from './generated/database.ts';

/** The result of consuming one unit from a window. */
export interface RateLimitCount {
  /** Requests recorded in this window, including this one. */
  readonly count: number;
  /** The window this count belongs to, so a caller can compute `Retry-After`. */
  readonly windowStart: Date;
}

/**
 * Records one request against `(key, windowStart)` and returns the new count.
 *
 * The caller owns the policy: this function has no notion of a limit, because the limit differs
 * per endpoint (§13.4) and a counter that also decided the policy would need one row shape per
 * endpoint. It records and reports; the decision is made in the API layer where the endpoint is
 * known.
 */
export async function consumeRateLimit(
  db: Kysely<DB>,
  options: {
    /** HMAC of the IP prefix with a daily-rotated secret. Never a raw address. */
    readonly key: Buffer;
    readonly windowStart: Date;
  },
): Promise<RateLimitCount> {
  if (options.key.length !== 32) {
    /*
     * The column has `CHECK (octet_length(bucket_key) = 32)`, so a wrong-sized key would fail at
     * the database with a constraint error that the API layer would render as a 500. Failing here
     * names the actual mistake.
     */
    throw new Error('a rate-limit bucket key must be exactly 32 bytes');
  }

  const result = await sql<{ n: number }>`
    INSERT INTO geonerva.rate_limit_buckets (bucket_key, window_start, n)
    VALUES (${options.key}, ${options.windowStart}, 1)
    ON CONFLICT (bucket_key, window_start)
      DO UPDATE SET n = geonerva.rate_limit_buckets.n + 1
    RETURNING n
  `.execute(db);

  const count = result.rows[0]?.n;
  if (count === undefined) {
    /* `RETURNING` on an upsert always yields a row; an empty result means the statement changed. */
    throw new Error('the rate-limit counter returned no row');
  }
  return { count, windowStart: options.windowStart };
}

/**
 * Deletes windows that ended before `cutoff`.
 *
 * Called by the worker, not by the read path: a read-path request that also swept the table would
 * pay for other callers' history, and the sweep is a `DELETE`, which the web role cannot perform
 * (migration 0007 grants it `INSERT` and `UPDATE` only). Returning the row count makes the sweep
 * observable rather than silent.
 */
export async function pruneRateLimitWindowsBefore(db: Kysely<DB>, cutoff: Date): Promise<number> {
  const result = await sql`
    DELETE FROM geonerva.rate_limit_buckets WHERE window_start < ${cutoff}
  `.execute(db);
  return Number(result.numAffectedRows ?? 0n);
}
