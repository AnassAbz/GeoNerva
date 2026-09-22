/**
 * Cache headers (ARCHITECTURE §13.1, §13.3).
 *
 * The per-endpoint values are transcribed from §13.1's table. The one rule that is *reasoning*
 * rather than transcription is the replay split, and it is the rule that matters most:
 *
 * > `GET /briefing` — live: `s-maxage=120, swr=600`; `as_of` older than 1 h:
 * > `s-maxage=86400, immutable`
 *
 * A replay is immutable because the past does not change: the append-only store means a snapshot
 * at a knowledge time in the past is a fixed document, and caching it for a day is free. A *live*
 * response is the opposite — hazard intelligence that is silently stale is the product's worst
 * failure — so it gets two minutes with a ten-minute grace window, which is shorter than every
 * source's poll interval.
 *
 * **The knowledge time is part of the cache key**, because §13.3 keys the CDN on the canonical
 * URL and `as_of` is in the URL. That is what stops a replay and a live answer contaminating each
 * other; this module's job is only to make sure the *freshness* of the two is never confused, by
 * deciding the policy from the same `asOf` the response was built for.
 */

/** §13.1's live briefing policy. Shorter than every source's poll interval. */
export const LIVE_BRIEFING_MAX_AGE_S = 120;
export const LIVE_BRIEFING_STALE_WHILE_REVALIDATE_S = 600;

/** §13.1: an `as_of` older than this is a replay, and replays are immutable. */
export const REPLAY_THRESHOLD_MS = 60 * 60 * 1000;
export const REPLAY_MAX_AGE_S = 86_400;

/** The fixed policies from §13.1's table, for endpoints that do not vary by knowledge time. */
export const CACHE_POLICIES = {
  places: 's-maxage=86400, stale-while-revalidate=86400',
  events: 's-maxage=120, stale-while-revalidate=600',
  eventDetail: 's-maxage=120, stale-while-revalidate=600',
  fireCluster: 's-maxage=300, stale-while-revalidate=600',
  history: 's-maxage=3600, stale-while-revalidate=3600',
  /**
   * §13.1 writes "immutable" for this endpoint, and it is only *conditionally* true — see
   * `evidenceCacheControl`, which is what handlers use.
   */
  evidence: 's-maxage=31536000, immutable',
  sourcesStatus: 's-maxage=60, stale-while-revalidate=120',
  replayHorizon: 's-maxage=3600, stale-while-revalidate=3600',
} as const;

/**
 * Whether a knowledge time is far enough in the past to be treated as an immutable replay.
 *
 * The threshold is one hour, per §13.1. Below it the answer is still moving — a source may commit
 * a run that changes what `as_of` resolves to — so it is cached as live.
 */
export function isImmutableReplay(asOf: Date, now: Date): boolean {
  return now.getTime() - asOf.getTime() > REPLAY_THRESHOLD_MS;
}

/**
 * The `Cache-Control` value for a briefing at one knowledge time.
 *
 * `private` never appears: these responses contain no user data. A rounded coordinate is a
 * 1.1 km cell, which is why rounding at the boundary is what makes shared caching safe at all
 * (ADR-015) — an unrounded position in a CDN key would be one visitor's location stored at the
 * edge.
 */
export function briefingCacheControl(asOf: Date, now: Date): string {
  return isImmutableReplay(asOf, now)
    ? `s-maxage=${String(REPLAY_MAX_AGE_S)}, immutable`
    : `s-maxage=${String(LIVE_BRIEFING_MAX_AGE_S)}, stale-while-revalidate=${String(LIVE_BRIEFING_STALE_WHILE_REVALIDATE_S)}`;
}

/**
 * The `Cache-Control` for one evidence lookup.
 *
 * §13.1 says "immutable", on the premise — written into the route's own doc comment — that "every
 * primary evidence kind points at an append-only row that cannot change once written". **Two of
 * the four kinds do change.** `canonical_links` rows are updated in place by `unlinkRecord`,
 * `linkRecord`'s relink path and `mergeCanonicalEvents`, all setting `unlinked_at` and
 * `unlink_reason`; and `ingestion_runs` rows are updated by `finishRun` and by the lease-expiry
 * path. `correlationEvidenceAsOf` deliberately *reveals* a closure from the moment it happened,
 * which is correct — and fatal in combination with `immutable`:
 *
 *  1. 12:00 — a client resolves `EV:COR:7` with no `as_of`. Body: `unlinkedAt: null`.
 *  2. 14:00 — the worker withdraws the link.
 *  3. For up to a year, every client behind that CDN key still reads the correlation as open, and
 *     `immutable` means a browser will not revalidate even on a hard reload.
 *
 * So `immutable` is claimed only when the caller **pinned a past knowledge time**, which is the
 * condition that actually makes the answer fixed forever. A live lookup gets a short TTL, on the
 * same reasoning as a live briefing.
 */
export function evidenceCacheControl(asOf: Date, now: Date): string {
  /*
   * "Materially in the past" is the whole condition, and it subsumes "the caller pinned a time".
   *
   * A `wasPinned` argument was written here first, on the reasoning that only a pinned knowledge
   * time can be immutable. It could never change the answer: `parseAsOf` returns the request's own
   * clock when `as_of` is absent, so an unpinned `asOf` *is* `now` and is never an hour behind it.
   * A mutation run made the point — flipping the flag to a constant `true` changed no behaviour —
   * and a parameter that cannot affect the result is a distinction a reader has to disprove.
   */
  if (isImmutableReplay(asOf, now)) return CACHE_POLICIES.evidence;
  return `s-maxage=${String(LIVE_EVIDENCE_MAX_AGE_S)}, stale-while-revalidate=${String(LIVE_BRIEFING_STALE_WHILE_REVALIDATE_S)}`;
}

/** As short as a live briefing: a correlation can be withdrawn at any time. */
export const LIVE_EVIDENCE_MAX_AGE_S = 120;

/**
 * A JSON response with the read-model media type and an explicit cache policy.
 *
 * `Vary: Accept-Encoding` only. There is deliberately no `Vary` on a cookie, an auth header or a
 * language: the API is read-only, anonymous and single-language, so a `Vary` on anything
 * request-specific would fragment the CDN key for no benefit and is the usual way a shared cache
 * quietly stops working.
 */
export function jsonResponse(
  body: unknown,
  options: {
    readonly cacheControl: string;
    readonly status?: number;
    /** Merged first, so the four headers below always win. For the `RateLimit-*` family. */
    readonly headers?: Readonly<Record<string, string>>;
  },
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      ...options.headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': options.cacheControl,
      vary: 'Accept-Encoding',
      /*
       * A read-only JSON API should never be interpreted as anything else. `nosniff` stops a
       * browser guessing a content type from the body, which is the shape of the old JSON-as-HTML
       * XSS; the frame headers are cheap and stop the responses being embedded.
       */
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * A permanent redirect to the address a merged subject now lives at.
 *
 * `308`, not `301`: it preserves the method and says the move is permanent, which a merge is —
 * the absorbed id never comes back. The query string is the caller's, so a replay stays a replay
 * at the new address. The same framing headers as every other response, because a redirect is
 * still something a browser renders.
 */
export function redirectResponse(location: string, cacheControl: string): Response {
  return new Response(null, {
    status: 308,
    headers: {
      location,
      'cache-control': cacheControl,
      vary: 'Accept-Encoding',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}
