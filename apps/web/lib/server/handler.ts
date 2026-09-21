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
 */

import { describeError, logRequest } from './log.ts';
import { toProblemResponse, problemResponse } from './problem.ts';

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
  options: { readonly name: string },
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const started = Date.now();
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return problemResponse({
        code: 'METHOD_NOT_ALLOWED',
        detail: 'The GeoNerva API is read-only. Only GET and HEAD are supported.',
        instance: url.pathname,
      });
    }

    try {
      const response = await handler({
        request,
        url,
        search: url.searchParams,
        now: new Date(),
      });
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
