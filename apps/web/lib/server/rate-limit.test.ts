/**
 * `rate-limit.ts` — the key derivation and the window arithmetic (ARCHITECTURE §13.4).
 *
 * The counter itself needs a database and is tested through the endpoint. What is testable here is
 * everything that decides *which* bucket a request lands in, and that is where a rate limiter is
 * usually broken rather than absent:
 *
 *  - **A spoofable client address** makes the limiter decorative: one header and a caller owns an
 *    unlimited supply of buckets.
 *  - **An unknown address that bypasses the limit** is the same hole reached by omission.
 *  - **A raw address in the key** turns an operational counter into a visitor log.
 *  - **A per-instance window boundary** multiplies the limit by the number of instances.
 */

import { describe, expect, it } from 'vitest';

import {
  RATE_LIMITS,
  TRUSTED_PROXY_HOPS,
  UNKNOWN_ADDRESS_PREFIX,
  bucketKey,
  clientAddress,
  ipPrefix,
  rateLimitHeaders,
  sameKey,
  windowStartFor,
} from './rate-limit.ts';

const SECRET = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'; // gitleaks:allow
const NOW = new Date('2026-09-21T12:34:56.789Z');

function headers(forwarded?: string): Headers {
  return forwarded === undefined ? new Headers() : new Headers({ 'x-forwarded-for': forwarded });
}

describe('RATE_LIMITS', () => {
  /** Transcribed from §13.4's table. A limit that drifts from the document is a silent change. */
  it('matches §13.4', () => {
    expect(RATE_LIMITS).toEqual({
      briefing: { limit: 60, windowS: 60 },
      placesSearch: { limit: 10, windowS: 60 },
      placesSearchGlobal: { limit: 1, windowS: 1 },
      default: { limit: 120, windowS: 60 },
    });
  });

  it('keeps the global places ceiling at one request per second', () => {
    expect(RATE_LIMITS.placesSearchGlobal.limit).toBe(1);
    expect(RATE_LIMITS.placesSearchGlobal.windowS).toBe(1);
  });
});

describe('windowStartFor', () => {
  it('truncates to the window from the Unix epoch', () => {
    expect(windowStartFor(NOW, 60).toISOString()).toBe('2026-09-21T12:34:00.000Z');
    expect(windowStartFor(NOW, 1).toISOString()).toBe('2026-09-21T12:34:56.000Z');
  });

  /**
   * The property that matters is **agreement**, not the value.
   *
   * Every instance must place the same instant in the same window without coordinating. A boundary
   * derived from "the first request this process saw" would give each instance its own window and
   * a caller `n × limit` requests across `n` instances — which is the usual way a distributed
   * fixed-window limiter turns out not to limit anything.
   */
  it('places every instant in a window that depends only on the instant', () => {
    const inside = new Date('2026-09-21T12:34:00.000Z');
    const edge = new Date('2026-09-21T12:34:59.999Z');
    const next = new Date('2026-09-21T12:35:00.000Z');

    expect(windowStartFor(inside, 60)).toEqual(windowStartFor(NOW, 60));
    expect(windowStartFor(edge, 60)).toEqual(windowStartFor(NOW, 60));
    expect(windowStartFor(next, 60)).not.toEqual(windowStartFor(NOW, 60));
  });

  it('is exact on the boundary', () => {
    const boundary = new Date('2026-09-21T12:35:00.000Z');
    expect(windowStartFor(boundary, 60)).toEqual(boundary);
  });
});

describe('ipPrefix', () => {
  it('reduces IPv4 to a /24', () => {
    expect(ipPrefix('203.0.113.42')).toBe('v4:203.0.113.0/24');
    expect(ipPrefix('203.0.113.1')).toBe('v4:203.0.113.0/24');
  });

  it('puts two addresses in the same /24 in one bucket, and a third elsewhere', () => {
    expect(ipPrefix('203.0.113.7')).toBe(ipPrefix('203.0.113.200'));
    expect(ipPrefix('203.0.114.7')).not.toBe(ipPrefix('203.0.113.7'));
  });

  it('reduces IPv6 to a /48', () => {
    expect(ipPrefix('2001:db8:1234:5678::1')).toBe('v6:2001:0db8:1234::/48');
    expect(ipPrefix('2001:db8:1234:ffff:ffff:ffff:ffff:ffff')).toBe('v6:2001:0db8:1234::/48');
  });

  /*
   * A `/64` is what a single host is normally given and is trivially cheap to walk, so a limiter
   * keyed on one would be defeated by a caller who simply changed the last four groups. A `/48` is
   * the smallest allocation a *site* receives, which is what makes it the right unit.
   */
  it('does not distinguish two addresses inside one /48', () => {
    expect(ipPrefix('2001:db8:1234:0001::1')).toBe(ipPrefix('2001:db8:1234:9999::abcd'));
    expect(ipPrefix('2001:db8:1235::1')).not.toBe(ipPrefix('2001:db8:1234::1'));
  });

  it('expands the compressed forms consistently', () => {
    expect(ipPrefix('2001:db8::1')).toBe('v6:2001:0db8:0000::/48');
    expect(ipPrefix('::1')).toBe('v6:0000:0000:0000::/48');
    expect(ipPrefix('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(ipPrefix('2001:db8::1'));
  });

  /** An IPv4-mapped address is an IPv4 address and must land in the IPv4 caller's bucket. */
  it('treats an IPv4-mapped IPv6 address as IPv4', () => {
    expect(ipPrefix('::ffff:203.0.113.42')).toBe('v4:203.0.113.0/24');
    expect(ipPrefix('::ffff:203.0.113.42')).toBe(ipPrefix('203.0.113.9'));
  });

  it('strips the brackets of a port-form address', () => {
    expect(ipPrefix('[2001:db8:1234::1]')).toBe('v6:2001:0db8:1234::/48');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['a hostname', 'example.org'],
    ['a partial IPv4', '203.0.113'],
    ['an octet above 255', '203.0.113.256'],
    ['a negative octet', '203.0.-1.5'],
    ['an IPv4 with a port', '203.0.113.42:8080'],
    ['two double colons', '2001::db8::1'],
    ['too many groups', '2001:db8:1:2:3:4:5:6:7'],
    ['a non-hex group', '2001:db8:zzzz::1'],
    ['a five-digit group', '2001:db8:12345::1'],
    ['an oversized string', '2001:db8:'.repeat(20)],
    ['a SQL fragment', "203.0.113.1'; DROP TABLE x;--"],
    ['a newline', '203.0.113.1\n203.0.113.2'],
  ])('rejects %s rather than making it a key', (_label, value) => {
    expect(ipPrefix(value)).toBeNull();
  });
});

describe('clientAddress', () => {
  /**
   * The rightmost entry, which is the whole security argument.
   *
   * A proxy appends the address it received from, so the last entry is the only one the app can
   * attribute to its actual peer. Everything to its left is whatever the caller chose to write —
   * and taking the *leftmost* entry, the usual implementation, hands that caller an unlimited
   * supply of buckets.
   */
  it('takes the address the trusted proxy appended, not the one the client claimed', () => {
    expect(clientAddress(headers('9.9.9.9, 203.0.113.42'))).toBe('203.0.113.42');
  });

  it('is not fooled by a forged chain, however long', () => {
    const forged = Array.from({ length: 50 }, (_, index) => `10.0.0.${String(index)}`).join(', ');
    expect(clientAddress(headers(`${forged}, 203.0.113.42`))).toBe('203.0.113.42');
  });

  it('reads a single-value header, which is what an overwriting platform sends', () => {
    expect(clientAddress(headers('203.0.113.42'))).toBe('203.0.113.42');
  });

  it('honours a deeper trusted chain', () => {
    /* Two appending proxies: the peer is one further left, and the CDN hop is discarded. */
    expect(clientAddress(headers('9.9.9.9, 203.0.113.42, 198.51.100.7'), 2)).toBe('203.0.113.42');
  });

  it('never reads past the start of the chain', () => {
    expect(clientAddress(headers('203.0.113.42'), 5)).toBe('203.0.113.42');
  });

  it('treats a hop count below one as one', () => {
    expect(clientAddress(headers('9.9.9.9, 203.0.113.42'), 0)).toBe('203.0.113.42');
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['only separators', ' , , '],
  ])('returns null for %s', (_label, value) => {
    expect(clientAddress(headers(value))).toBeNull();
  });

  /* An unbounded header would be parsed into an unbounded array on every request. */
  it('refuses an oversized header rather than parsing it', () => {
    expect(clientAddress(headers('10.0.0.1, '.repeat(200)))).toBeNull();
  });

  it('defaults to one trusted hop', () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1);
  });
});

describe('bucketKey', () => {
  const base = { secret: SECRET, scope: 'briefing', prefix: 'v4:203.0.113.0/24', now: NOW };

  it('produces a 32-byte key, matching the column constraint', () => {
    expect(bucketKey(base)).toHaveLength(32);
  });

  it('is deterministic for the same day, scope and prefix', () => {
    expect(sameKey(bucketKey(base), bucketKey({ ...base }))).toBe(true);
  });

  /*
   * Raw addresses are never stored (§13.4). The key is a digest, so the table cannot be read as a
   * list of who visited — and this asserts the *absence* rather than the presence of a hash, which
   * is what a caller of this function actually depends on.
   */
  it('contains no trace of the address it was derived from', () => {
    const key = bucketKey({ ...base, prefix: 'v4:203.0.113.0/24' }).toString('hex');
    expect(key).not.toContain('203');
    expect(key).not.toContain('113');
    expect(Buffer.from('203.0.113.0/24').toString('hex')).not.toBe(key);
  });

  it('separates two prefixes', () => {
    expect(sameKey(bucketKey(base), bucketKey({ ...base, prefix: 'v4:203.0.114.0/24' }))).toBe(
      false,
    );
  });

  /**
   * Scope separation, which is not cosmetic.
   *
   * Without it one caller's `briefing` window and their `places/search` window would share a
   * counter, and the smaller limit (10/min) would consume the larger (60/min) — so ten searches
   * would exhaust a briefing budget six times their size.
   */
  it('separates two scopes for the same caller', () => {
    expect(sameKey(bucketKey(base), bucketKey({ ...base, scope: 'placesSearch' }))).toBe(false);
  });

  /** Daily rotation: yesterday's key cannot address today's bucket (§13.4). */
  it('rotates daily', () => {
    const tomorrow = new Date('2026-09-22T00:00:00.000Z');
    expect(sameKey(bucketKey(base), bucketKey({ ...base, now: tomorrow }))).toBe(false);
  });

  it('does not rotate within a day', () => {
    const laterSameDay = new Date('2026-09-21T23:59:59.000Z');
    expect(sameKey(bucketKey(base), bucketKey({ ...base, now: laterSameDay }))).toBe(true);
  });

  it('separates two secrets, so rotating the secret invalidates every bucket', () => {
    const other = 'a3bf4f1b2b0b822cd15d6c15b0f00a089f86d081884c7d659a2feaa0c55ad015'; // gitleaks:allow
    expect(sameKey(bucketKey(base), bucketKey({ ...base, secret: other }))).toBe(false);
  });

  /*
   * The scope and the prefix are joined with a NUL, which cannot appear in either. Without a
   * separator, scope `ab` + prefix `c` and scope `a` + prefix `bc` would be one bucket.
   */
  it('cannot be confused by concatenation', () => {
    const left = bucketKey({ ...base, scope: 'ab', prefix: 'c' });
    const right = bucketKey({ ...base, scope: 'a', prefix: 'bc' });
    expect(sameKey(left, right)).toBe(false);
  });

  it('gives the unknown-address bucket a key like any other', () => {
    const unknown = bucketKey({ ...base, prefix: UNKNOWN_ADDRESS_PREFIX });
    expect(unknown).toHaveLength(32);
    expect(sameKey(unknown, bucketKey(base))).toBe(false);
  });
});

describe('sameKey', () => {
  it('compares equal keys as equal and different keys as different', () => {
    expect(sameKey(Buffer.alloc(32, 1), Buffer.alloc(32, 1))).toBe(true);
    expect(sameKey(Buffer.alloc(32, 1), Buffer.alloc(32, 2))).toBe(false);
  });

  /* `timingSafeEqual` throws on a length mismatch, so the guard is load-bearing. */
  it('returns false for a length mismatch instead of throwing', () => {
    expect(sameKey(Buffer.alloc(32), Buffer.alloc(16))).toBe(false);
  });
});

describe('rateLimitHeaders', () => {
  it('publishes the limit, the remainder and the reset in RFC 9331 names', () => {
    expect(rateLimitHeaders({ allowed: true, limit: 60, remaining: 59, retryAfterS: 41 })).toEqual({
      'ratelimit-limit': '60',
      'ratelimit-remaining': '59',
      'ratelimit-reset': '41',
    });
  });

  /*
   * No header names the bucket. One would let a caller confirm which requests share a key, which
   * is information about other callers derived from their addresses.
   */
  it('names no bucket and no address', () => {
    const serialized = JSON.stringify(
      rateLimitHeaders({ allowed: false, limit: 60, remaining: 0, retryAfterS: 1 }),
    );
    expect(serialized).not.toContain('bucket');
    expect(serialized).not.toContain('key');
  });
});
