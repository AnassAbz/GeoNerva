/**
 * `cache.ts` — the cache policies (ARCHITECTURE §13.1, §13.3).
 *
 * Two things are being tested, and only one of them is arithmetic.
 *
 * The arithmetic: the values match §13.1's table. The judgement: the **replay split** — a response
 * for a past knowledge time is immutable because the past does not change, and a live response is
 * not, because hazard intelligence that is silently stale is this product's worst failure. The
 * policy must be decided from the `asOf` the response was *built for*, never from the mere presence
 * of the parameter, or `as_of=<now>` would buy a day-long cache entry for a moving answer.
 */

import { describe, expect, it } from 'vitest';

import {
  CACHE_POLICIES,
  LIVE_BRIEFING_MAX_AGE_S,
  REPLAY_MAX_AGE_S,
  REPLAY_THRESHOLD_MS,
  briefingCacheControl,
  isImmutableReplay,
  jsonResponse,
} from './cache.ts';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('isImmutableReplay', () => {
  it('treats the present as live', () => {
    expect(isImmutableReplay(NOW, NOW)).toBe(false);
  });

  it('treats a knowledge time inside the threshold as live', () => {
    expect(isImmutableReplay(ago(REPLAY_THRESHOLD_MS - 1), NOW)).toBe(false);
  });

  /**
   * The boundary from both sides, which is what makes this a control rather than a smoke test.
   *
   * `>` and `>=` differ by one millisecond here and no test that samples "an hour ago" and "a
   * minute ago" can tell them apart. Exactly at the threshold is still live; one millisecond past
   * it is a replay.
   */
  it('is exclusive at the threshold', () => {
    expect(isImmutableReplay(ago(REPLAY_THRESHOLD_MS), NOW)).toBe(false);
    expect(isImmutableReplay(ago(REPLAY_THRESHOLD_MS + 1), NOW)).toBe(true);
  });

  it('never calls a future knowledge time a replay', () => {
    expect(isImmutableReplay(new Date(NOW.getTime() + 60_000), NOW)).toBe(false);
  });
});

describe('briefingCacheControl', () => {
  it('gives a live briefing §13.1s two minutes with a ten-minute grace window', () => {
    expect(briefingCacheControl(NOW, NOW)).toBe(
      `s-maxage=${String(LIVE_BRIEFING_MAX_AGE_S)}, stale-while-revalidate=600`,
    );
  });

  it('gives a replay a day and marks it immutable', () => {
    expect(briefingCacheControl(ago(2 * REPLAY_THRESHOLD_MS), NOW)).toBe(
      `s-maxage=${String(REPLAY_MAX_AGE_S)}, immutable`,
    );
  });

  /*
   * The rule that costs money if it is wrong in one direction and correctness if it is wrong in
   * the other: `as_of=<now>` is a live answer and must not be cached as immutable merely because
   * the parameter was present.
   */
  it('does not make a request immutable just because it named a knowledge time', () => {
    const justNow = new Date(NOW.getTime() - 1_000);
    expect(briefingCacheControl(justNow, NOW)).toContain('stale-while-revalidate');
    expect(briefingCacheControl(justNow, NOW)).not.toContain('immutable');
  });

  it('never marks a response private, because none of them carry user data', () => {
    expect(briefingCacheControl(NOW, NOW)).not.toContain('private');
    expect(briefingCacheControl(ago(86_400_000), NOW)).not.toContain('private');
  });

  it('shorter than every source poll interval, so a live answer cannot go silently stale', () => {
    /* The most frequent source polls every 5 minutes (FIRMS NRT); 120 s is well inside that. */
    expect(LIVE_BRIEFING_MAX_AGE_S).toBeLessThan(5 * 60);
  });
});

describe('CACHE_POLICIES', () => {
  it('matches §13.1s table', () => {
    expect(CACHE_POLICIES).toEqual({
      places: 's-maxage=86400, stale-while-revalidate=86400',
      events: 's-maxage=120, stale-while-revalidate=600',
      eventDetail: 's-maxage=120, stale-while-revalidate=600',
      fireCluster: 's-maxage=300, stale-while-revalidate=600',
      history: 's-maxage=3600, stale-while-revalidate=3600',
      evidence: 's-maxage=31536000, immutable',
      sourcesStatus: 's-maxage=60, stale-while-revalidate=120',
      replayHorizon: 's-maxage=3600, stale-while-revalidate=3600',
    });
  });

  it('marks only evidence immutable, because only an evidence row cannot change', () => {
    const immutable = Object.entries(CACHE_POLICIES)
      .filter(([, value]) => value.includes('immutable'))
      .map(([key]) => key);
    expect(immutable).toEqual(['evidence']);
  });
});

describe('jsonResponse', () => {
  it('serializes the body with the JSON media type and the given policy', async () => {
    const response = jsonResponse({ ok: true }, { cacheControl: 's-maxage=60' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('s-maxage=60');
    expect(await response.json()).toEqual({ ok: true });
  });

  /*
   * `Vary: Accept-Encoding` and nothing else. A `Vary` on a cookie, an auth header or a language
   * would fragment the CDN key for an API that is read-only, anonymous and single-language — the
   * usual way a shared cache quietly stops working.
   */
  it('varies only on Accept-Encoding', () => {
    expect(jsonResponse({}, { cacheControl: 's-maxage=60' }).headers.get('vary')).toBe(
      'Accept-Encoding',
    );
  });

  it('sets the three headers that stop a JSON body being interpreted as something else', () => {
    const headers = jsonResponse({}, { cacheControl: 's-maxage=60' }).headers;
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('carries no cookie and no auth-related header', () => {
    const headers = [...jsonResponse({}, { cacheControl: 's-maxage=60' }).headers.keys()];
    expect(headers).not.toContain('set-cookie');
    expect(headers).not.toContain('authorization');
  });
});
