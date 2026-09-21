/**
 * The route-handler wrapper (ARCHITECTURE §13).
 *
 * Every handler under `app/api/v1/**` is a thin adapter over `services.ts`, and every one of them
 * needs the same four things: a method check, a single place where a thrown value becomes a
 * problem document, structured logging that cannot leak, and a guarantee that an unexpected error
 * is never rendered to the caller. Putting that here means a new endpoint cannot forget one.
 *
 * ### The method check is part of the read-only claim
 *
 * Next.js only routes the verbs a module exports, so a `POST` to a file exporting `GET` is
 * already a 405 — but it is Next's 405, in HTML, which is not the contract. `METHOD_NOT_ALLOWED`
 * exists in the frozen problem codes precisely because "the API is read-only" should be something
 * a client can *detect* rather than infer, so the wrapper answers it in problem+json.
 *
 * ### Logging
 *
 * One structured line per request, written by `log.ts` — the only module in `apps/web` that may
 * print. What may and may not appear in that line is documented there, because the rule belongs
 * beside the function that could break it.
 *
 * ### Rate limiting
 *
 * Enforced **here**, before the handler runs, so that a refused request costs one counter upsert
 * rather than a spatial query. An endpoint declares which of §13.4's limits applies; omitting the
 * option is a deliberate exemption and every current one is justified at its call site.
 *
 * The budget headers are attached **only to a refusal**. Putting `RateLimit-Remaining` on an
 * allowed response looked friendlier — a client could back off before being refused — but those
 * responses are publicly cacheable, `Vary` is `Accept-Encoding` alone, and the CDN would therefore
 * serve one caller's remaining budget to everyone behind that edge node for up to a year. A number
 * that is wrong for almost every reader is worse than no number, and it also leaked bucket state
 * that `rate-limit.ts` is otherwise careful not to publish. On a 429 the response is `no-store`,
 * so the headers are accurate for exactly the caller they describe.
 */

import { webConfig } from './config.ts';
import { database } from './db.ts';
import { describeError, logRequest } from './log.ts';
import { toProblemResponse, problemResponse } from './problem.ts';
import { enforceRateLimit, type RateLimitName } from './rate-limit.ts';

export interface HandlerContext {
  readonly request: Request;
  readonly url: URL;
  readonly search: URLSearchParams;
  /** One clock for the whole request, so `as_of` validation and the response cannot disagree. */
  readonly now: Date;
}

/** What a handler returns: the body and the cache policy the endpoint's row in §13.1 specifies. */
export type HandlerResult = Response;

/**
 * Wraps a handler.
 *
 * The clock is captured **once** per request and passed through. Two calls to `new Date()` inside
 * one request can straddle a second boundary, which is enough to make an `as_of` that validated as
 * "not in the future" become one that is, or to put two different `generatedAt` values in one
 * response.
 */
export function apiRoute(
  handler: (context: HandlerContext) => Promise<HandlerResult>,
  options: {
    readonly name: string;
    /** Which of §13.4's limits applies. Omitted means no limit; say why at the call site. */
    readonly rateLimit?: RateLimitName;
    /** A limiter outage refuses the request instead of allowing it. See `rate-limit.ts`. */
    readonly failClosed?: boolean;
  },
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const started = Date.now();
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      /*
       * Before the rate limit, not after. A refused verb must not consume the caller's budget for
       * the verb they are allowed to use, and a 405 costs nothing to produce.
       */
      const refused = problemResponse({
        code: 'METHOD_NOT_ALLOWED',
        detail: 'The GeoNerva API is read-only. Only GET and HEAD are supported.',
        instance: url.pathname,
      });
      /*
       * Logged like any other outcome. Returning before `logRequest` made "one structured line per
       * request" false for exactly the requests an operator most wants to see: an attempt to write
       * to a read-only API.
       */
      logRequest({
        endpoint: options.name,
        path: url.pathname,
        status: refused.status,
        durationMs: Date.now() - started,
      });
      return refused;
    }

    const now = new Date();
    try {
      /*
       * Called for its refusal, and its verdict deliberately discarded.
       *
       * `enforceRateLimit` throws when the window is spent, and the 429 it throws carries the
       * budget headers itself. An allowed response gets none — see the header for why publishing
       * one on a shared-cached response was wrong — so there is nothing here to keep.
       */
      if (options.rateLimit !== undefined) {
        await enforceRateLimit({
          db: () => database().db,
          headers: request.headers,
          now,
          name: options.rateLimit,
          secret: webConfig().RATE_LIMIT_SECRET,
          ...(options.failClosed === undefined ? {} : { failClosed: options.failClosed }),
        });
      }

      const response = await handler({ request, url, search: url.searchParams, now });
      logRequest({
        endpoint: options.name,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      const { response, traceId, cause } = toProblemResponse(error, url.pathname);
      /*
       * The cause is logged here and nowhere else. `toProblemResponse` deliberately returns it
       * rather than logging it itself, so that the one place that writes an error to a log is the
       * one place that also knows the request it belonged to.
       */
      logRequest({
        endpoint: options.name,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - started,
        traceId,
        ...(cause === null ? {} : { error: describeError(cause) }),
      });
      return response;
    }
  };
}
