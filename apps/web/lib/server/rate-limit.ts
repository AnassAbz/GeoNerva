/**
 * Rate limiting (ARCHITECTURE §13.4).
 *
 * > Postgres-backed fixed windows (`rate_limit_buckets`, key = HMAC of IP /24 or /48 with a
 * > daily-rotated secret, so raw IPs are never stored):
 * >
 * > | `places/search` | 10/min/key, **1/s global** (protects our Nominatim standing) |
 * > | `briefing` | 60/min/key |
 * > | everything else | 120/min/key |
 *
 * Three decisions here are security decisions rather than plumbing, and each is the kind that is
 * silently wrong in most implementations.
 *
 * ### 1. The client address is taken from the **right** of `X-Forwarded-For`
 *
 * `X-Forwarded-For` is a client-supplied header. Taking its *leftmost* entry — the usual mistake —
 * lets any caller mint an unlimited supply of buckets by sending `X-Forwarded-For: <random>`, which
 * makes the limiter decorative. A proxy **appends** the address it received from, so with exactly
 * one trusted hop in front of the app the real peer is the *rightmost* entry, and anything to its
 * left is whatever the client chose to claim.
 *
 * `TRUSTED_PROXY_HOPS` is the number of proxies that append. It is a constant rather than
 * configuration because getting it wrong is a security bug, not a preference, and a deployment that
 * adds a CDN in front of the platform must change it deliberately — with the consequence stated:
 * too *few* hops and callers can spoof; too *many* and everyone behind the last proxy shares one
 * bucket, which is a loss of precision rather than a loss of protection.
 *
 * ### 2. An unknown address shares one bucket rather than bypassing the limit
 *
 * With no usable address — no header, a malformed one, direct access in development — the request
 * is counted against a single shared key. That is the fail-closed direction: a caller who strips
 * the header is limited *collectively* instead of being exempted.
 *
 * That bucket is a liability, so **reaching it must not be something a caller can choose.** An
 * earlier version gave up on any header longer than 1 KB, which made the shared bucket
 * caller-selectable: send 2 KB of junk followed by your real address and collect a second full
 * budget, or saturate the shared bucket and refuse every caller whose address the parser cannot
 * read. The header is now read from its **end**, where the trusted hop appended, so an arbitrarily
 * long prefix costs the attacker nothing and buys them nothing.
 *
 * ### 3. A limiter outage fails open — except where a third party is involved
 *
 * If the counter table cannot be written, a limiter that refuses every request converts a problem
 * with one operational table into a total outage of a read-only API. So the default is to log and
 * allow. **`places/search` is the exception**: its 1-per-second global limit exists to protect
 * GeoNerva's standing with Nominatim, which is a commitment to someone else, and breaking that is
 * worse than serving a 503. That endpoint fails closed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { consumeRateLimit } from '@geonerva/db/rate-limit';

import type { Kysely } from './db.ts';
import { logEvent } from './log.ts';
import { ApiProblemError } from './problem.ts';

/**
 * How many proxies in front of this process append to `X-Forwarded-For`.
 *
 * One, for the single platform edge the deployment runs behind (ARCHITECTURE §1). See the header
 * for what changing it costs in each direction.
 */
export const TRUSTED_PROXY_HOPS = 1;

/** §13.4's limits, as (requests, window) pairs. */
export const RATE_LIMITS = {
  briefing: { limit: 60, windowS: 60 },
  placesSearch: { limit: 10, windowS: 60 },
  /** The global ceiling that protects the Nominatim standing. Not per key. */
  placesSearchGlobal: { limit: 1, windowS: 1 },
  default: { limit: 120, windowS: 60 },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** What a limit check decided, for the caller to turn into a header or a problem. */
export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly limit: number;
  /** Never negative: a window 400 requests into a limit of 60 still reports zero remaining. */
  readonly remaining: number;
  /** Seconds until the window rolls over. */
  readonly retryAfterS: number;
}

/**
 * The start of the fixed window containing `now`.
 *
 * Truncation is to the window length from the Unix epoch, so every instance of the app agrees on
 * the boundary without coordinating. A window keyed on "first request seen" would give each
 * instance its own boundary and a caller `n × limit` requests across `n` instances.
 */
export function windowStartFor(now: Date, windowS: number): Date {
  const windowMs = windowS * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * The IP prefix a bucket is keyed on: `/24` for IPv4, `/48` for IPv6.
 *
 * A prefix rather than an address, because a single household or mobile carrier legitimately shares
 * one, and because a `/64` of IPv6 is trivially cheap for an attacker to walk — `/48` is the
 * smallest allocation a site is normally given, which is what makes it the right unit.
 *
 * Returns `null` for anything that is not an address, so a hostile value cannot become a key.
 */
export function ipPrefix(address: string): string | null {
  /*
   * Brackets and a zone id are stripped first. `fe80::1%eth0` is a real address a proxy can
   * forward, and rejecting it put its sender in the shared `unknown` bucket — which, with the
   * saturation attack above, meant an attacker could deny service to link-local callers
   * specifically.
   */
  const trimmed = address
    .trim()
    .replace(/^\[|\]$/gu, '')
    .replace(/%[0-9a-z._-]{1,32}$/iu, '');
  if (trimmed === '' || trimmed.length > 45) return null;

  /*
   * An embedded IPv4 tail is an IPv4 address and must key like one. `::ffff:203.0.113.5` is the
   * common form, but the mixed notation is general — `64:ff9b::192.0.2.33` is a valid NAT64
   * address — so the whole prefix is checked rather than just the `::ffff:` case.
   */
  const mapped = /^(?:[0-9a-f:]*:)?(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(trimmed);
  const candidate = mapped?.[1] ?? trimmed;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(candidate)) {
    const octets = candidate.split('.').map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    return `v4:${String(octets[0])}.${String(octets[1])}.${String(octets[2])}.0/24`;
  }

  const groups = expandIpv6(trimmed);
  if (groups === null) return null;
  return `v6:${groups.slice(0, 3).join(':')}::/48`;
}

/** Expands an IPv6 address to eight 4-digit groups, or `null` if it is not one. */
function expandIpv6(value: string): string[] | null {
  if (!/^[0-9a-f:]+$/iu.test(value) || (value.match(/::/gu) ?? []).length > 1) return null;

  const [head, tail] = value.split('::');
  const headGroups = head === undefined || head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;

  const groups = value.includes('::')
    ? [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups]
    : headGroups;

  if (groups.length !== 8 || missing < 0) return null;
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) return null;
  return groups.map((group) => group.toLowerCase().padStart(4, '0'));
}

/**
 * The client address, per decision 1 in the header.
 *
 * `hops` counts proxies that append; the address is taken that many entries from the right. A
 * platform that *overwrites* the header with a single value is the same case with `hops = 1`, which
 * is why one rule serves both deployments.
 */
export function clientAddress(headers: Headers, hops: number = TRUSTED_PROXY_HOPS): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded === null) return null;

  /*
   * The tail, not the whole header, and not a rejection.
   *
   * Bounding the work is still necessary — splitting a megabyte of commas on every request is a
   * gift to an attacker — but bounding it by *refusing* handed the caller the shared bucket. The
   * slice is taken from the right, so the entries that matter are whole: a cut can only damage the
   * leftmost entry in the window, which is the one furthest from the trusted hop.
   */
  const tail =
    forwarded.length > MAX_FORWARDED_LENGTH ? forwarded.slice(-MAX_FORWARDED_LENGTH) : forwarded;

  const entries = tail
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) return null;

  const index = entries.length - Math.max(1, hops);
  return entries[Math.max(0, index)] ?? null;
}

/**
 * How much of `X-Forwarded-For` is read, counting from the right.
 *
 * 512 characters holds well over a dozen addresses, so it accommodates any real proxy chain while
 * bounding the parsing work per request.
 */
export const MAX_FORWARDED_LENGTH = 512;

/**
 * The bucket key: `HMAC(HMAC(secret, day), scope + prefix)`.
 *
 * The inner HMAC is the daily rotation §13.4 requires. Its point is not secrecy of the day — that
 * is public — but that yesterday's key cannot be used to look up today's bucket, so the table
 * cannot become a record of who visited over time even if it were read.
 *
 * The scope is mixed in so that one caller's `briefing` window and their `places/search` window are
 * different rows. Without it the two limits would share a counter and the smaller one would consume
 * the larger.
 */
export function bucketKey(input: {
  readonly secret: string;
  readonly scope: string;
  readonly prefix: string;
  readonly now: Date;
}): Buffer {
  const day = input.now.toISOString().slice(0, 10);
  const daily = createHmac('sha256', input.secret).update(day).digest();
  return createHmac('sha256', daily).update(`${input.scope}\u0000${input.prefix}`).digest();
}

/** True when two keys are the same. Constant-time, so key comparison leaks no timing. */
export function sameKey(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The shared key for a request whose address could not be determined (decision 2). */
export const UNKNOWN_ADDRESS_PREFIX = 'unknown';

export interface RateLimitRequest {
  /**
   * A thunk, not a handle.
   *
   * Acquiring the pool can itself fail — an unset `DATABASE_URL` throws — and that failure is a
   * *limiter* outage, not a request failure. Taking a thunk puts the acquisition inside the same
   * `try` as the counter, so `/replay/horizon`, which reads no facts, still answers when the
   * database is unreachable instead of failing on a counter it did not need.
   */
  readonly db: () => Kysely;
  readonly headers: Headers;
  readonly now: Date;
  readonly name: RateLimitName;
  /** The HMAC secret, from `RATE_LIMIT_SECRET`. Never logged. */
  readonly secret: string;
  /**
   * `false` allows the request when the counter cannot be written, `true` refuses it. The default
   * is `false`; `places/search` passes `true`. See decision 3 in the header.
   */
  readonly failClosed?: boolean;
  /** A fixed prefix instead of the caller's, for a global (not per-key) limit. */
  readonly globalScope?: string;
}

/**
 * Checks and records one request.
 *
 * Returns a verdict rather than throwing, so a caller can attach the headers of an *allowed*
 * request as well as refuse a rejected one. `enforceRateLimit` is the throwing wrapper.
 */
export async function checkRateLimit(request: RateLimitRequest): Promise<RateLimitVerdict> {
  const policy = RATE_LIMITS[request.name];
  const windowStart = windowStartFor(request.now, policy.windowS);
  const retryAfterS = Math.max(
    1,
    Math.ceil((windowStart.getTime() + policy.windowS * 1000 - request.now.getTime()) / 1000),
  );

  const prefix =
    request.globalScope ?? ipPrefix(clientAddress(request.headers) ?? '') ?? UNKNOWN_ADDRESS_PREFIX;

  const key = bucketKey({
    secret: request.secret,
    scope: request.globalScope === undefined ? request.name : `global:${request.name}`,
    prefix,
    now: request.now,
  });

  try {
    const { count } = await consumeRateLimit(request.db(), { key, windowStart });
    return {
      allowed: count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      retryAfterS,
    };
  } catch (error) {
    /*
     * The failure is logged with the endpoint and nothing else: not the key, which is derived from
     * an address, and not the error's own message, which comes from the driver.
     */
    logEvent('error', 'api.rate_limit.unavailable', {
      limit: request.name,
      failClosed: request.failClosed === true,
      errorName: error instanceof Error ? error.name : 'NonError',
    });
    if (request.failClosed === true) {
      throw new ApiProblemError({
        code: 'UPSTREAM_UNAVAILABLE',
        detail:
          'GeoNerva cannot currently check its request budget for this endpoint, and this endpoint is not served without one.',
        retryAfterS: policy.windowS,
      });
    }
    return { allowed: true, limit: policy.limit, remaining: policy.limit, retryAfterS };
  }
}

/** Throws `RATE_LIMITED` when the window is spent. Returns the verdict when it is not. */
export async function enforceRateLimit(request: RateLimitRequest): Promise<RateLimitVerdict> {
  const verdict = await checkRateLimit(request);
  if (verdict.allowed) return verdict;
  throw new ApiProblemError({
    code: 'RATE_LIMITED',
    detail: 'Too many requests. This limit protects GeoNerva and the providers it depends on.',
    retryAfterS: verdict.retryAfterS,
    /*
     * The budget, on the one response where it is true for its reader. A problem document is
     * `no-store`, so unlike an allowed response it cannot be served from a shared cache to a
     * caller it does not describe.
     */
    headers: rateLimitHeaders(verdict),
  });
}

/**
 * The headers that describe a caller's remaining budget.
 *
 * `RateLimit-*` from RFC 9331 rather than the older `X-RateLimit-*`, and deliberately **no**
 * header naming the bucket: that would let a caller confirm which requests share a key, which is
 * information about other callers derived from their addresses.
 */
export function rateLimitHeaders(verdict: RateLimitVerdict): Record<string, string> {
  return {
    'ratelimit-limit': String(verdict.limit),
    'ratelimit-remaining': String(verdict.remaining),
    'ratelimit-reset': String(verdict.retryAfterS),
  };
}
