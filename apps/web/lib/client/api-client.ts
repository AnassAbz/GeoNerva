/**
 * The browser's only door to GeoNerva's own API (security finding R-7, docs/SECURITY.md M1).
 *
 * Every other module in `apps/web` is forbidden from touching `fetch`, `XMLHttpRequest`,
 * `WebSocket` and `EventSource` by `no-restricted-globals`/`no-restricted-properties` in
 * `eslint.config.js`. This file is the single path the rule exempts, by name. The exemption is
 * only defensible if the module cannot be talked into calling anything except GeoNerva's own
 * same-origin `/api/v1`, so that is a **runtime** check here and not a convention.
 *
 * ### The control, and what it is defending
 *
 * `apiPath` refuses everything that is not a same-origin path under `/api/v1/`. The attacks it
 * closes, in the order a reviewer will want to try them:
 *
 * | Input | Why it is refused |
 * |---|---|
 * | `https://evil.example/x`, `http://…` | absolute: a cross-origin request, and an exfiltration channel for anything the caller interpolates into it |
 * | `//evil.example/x` | scheme-relative — a browser reads this as an absolute URL, and it is the spelling a prefix check written as `startsWith('/')` lets through |
 * | `/api/v2/…`, `/admin`, `/api/v1x` | same origin but outside the audited surface; `/api/v1` is what the contract freezes and what the rate limiter, the parameter validation and the cache policies cover |
 * | `/api/v1/../admin` | climbs out of the prefix after the prefix check passed |
 * | `/api/v1/%2e%2e/admin`, `/api/v1/..%2fadmin` | the same climb, spelled so that a textual `..` scan misses it |
 * | a number, `null`, an object | not a string: `String(value)` would turn `{toString: …}` into a URL the caller never wrote |
 *
 * The check runs **before** the URL reaches `fetch`, and the request itself is pinned three more
 * ways — `mode: 'same-origin'`, `redirect: 'error'` and `credentials: 'same-origin'` — so a
 * redirect or a rewrite cannot move a request off this origin after the check has passed. Those
 * are belt and braces: the Content-Security-Policy's `connect-src 'self'` is the outer bound, and
 * this module never needs the basemap origin that `connect-src` also allows.
 *
 * `api-client.test.ts` is the test R-7 asks for and it is written as the attack table above.
 *
 * ### Two smaller rules that are also security properties
 *
 * **The response is validated against the frozen contract** before a caller sees it. A browser
 * response is untrusted input like any other; without this, a shape change or an intercepted
 * body reaches React as `any`-shaped data.
 *
 * **Nothing here logs.** `no-console` forbids it repository-wide, and the reason matters on this
 * path in particular: a request URL may carry a place the visitor typed, or — in the coordinate
 * case — a position. Invariant I15 keeps that to two decimals; not writing it down at all is the
 * other half.
 */

import { PROBLEM_MEDIA_TYPE, problemDetailsSchema, type ProblemDetails } from '@geonerva/domain';
import type { ZodType } from 'zod';

/** The one prefix this client may address. The trailing slash is part of the rule. */
export const API_PREFIX = '/api/v1/';

/** A generous cap that still bounds anything built from user input. */
export const MAX_PATH_LENGTH = 512;

/**
 * The base a candidate path is resolved against, so that resolution has a definite answer.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so even a bug that let this origin
 * escape into a request could not reach a host. Only `pathname + search` is ever returned.
 */
const RESOLUTION_BASE = 'https://api-client.invalid';

/** How a request failed, for a caller that wants to branch rather than read a sentence. */
export type ApiFailure =
  /** The path was not a same-origin `/api/v1` path. A programming error, never a server state. */
  | 'INVALID_PATH'
  /** The request never produced a response: offline, DNS, a refused redirect. */
  | 'UNREACHABLE'
  /** The caller aborted it, usually because a newer keystroke superseded it. */
  | 'ABORTED'
  /** The API answered with a problem document (RFC 9457). `code` and `detail` carry it. */
  | 'PROBLEM'
  /** The answer was not the shape the frozen contract describes. */
  | 'MALFORMED';

export class ApiClientError extends Error {
  readonly failure: ApiFailure;
  readonly status: number | null;
  /** The API's own explanation, written by GeoNerva and displayable; `null` otherwise. */
  readonly problem: ProblemDetails | null;

  constructor(
    failure: ApiFailure,
    message: string,
    extra: { readonly status?: number; readonly problem?: ProblemDetails } = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.failure = failure;
    this.status = extra.status ?? null;
    this.problem = extra.problem ?? null;
  }
}

/** True when an error is this module's report that a superseded request was cancelled. */
export function isAborted(error: unknown): boolean {
  return error instanceof ApiClientError && error.failure === 'ABORTED';
}

/**
 * Validates a candidate API path and returns the path this client will actually request.
 *
 * Exported because it is the control R-7 names: it is tested directly, and a reviewer should be
 * able to read it without reading the request code around it. It throws rather than returning
 * `null` so that a caller cannot ignore the result by accident.
 */
export function apiPath(path: unknown): string {
  if (typeof path !== 'string') {
    throw invalidPath('the path must be a string');
  }
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw invalidPath(`the path must be between 1 and ${String(MAX_PATH_LENGTH)} characters`);
  }
  /*
   * Control characters, every kind of space, the backslash Windows paths use, and `#`. A fragment
   * is meaningless to `fetch` and is the classic way to make the tail of a URL invisible to a
   * check that reads the whole string.
   */
  if (/[\p{Cc}\p{Cf}\p{Zs}\s\\#]/u.test(path)) {
    throw invalidPath('the path must not contain spaces, control characters, a backslash or #');
  }
  /*
   * The literal prefix test is what rejects every absolute form in one line: `https://…`,
   * `http://…`, `//evil.example/x`, `javascript:…` and a bare relative `api/v1/x` all fail it,
   * because none of them begins with `/api/v1/`.
   */
  if (!path.startsWith(API_PREFIX)) {
    throw invalidPath(`the path must begin with ${API_PREFIX}`);
  }

  let url: URL;
  try {
    url = new URL(path, RESOLUTION_BASE);
  } catch {
    throw invalidPath('the path is not a valid URL');
  }
  /*
   * Resolution is what catches a path that *climbs out* of the prefix after passing the test
   * above: `/api/v1/../admin` resolves to `/admin`, and so does `/api/v1/%2e%2e/admin`, because
   * the URL parser treats `%2e` as a dot when it decides what a double-dot segment is.
   */
  if (url.origin !== RESOLUTION_BASE || url.username !== '' || url.password !== '') {
    throw invalidPath('the path must stay on this origin');
  }
  if (!url.pathname.startsWith(API_PREFIX)) {
    throw invalidPath(`the path must stay within ${API_PREFIX}`);
  }
  if (url.hash !== '') {
    throw invalidPath('the path must not carry a fragment');
  }

  /*
   * A second, independent pass over the decoded segments. The resolution above already handles
   * `%2e%2e`, but it does not handle `..%2fadmin`, where the *slash* is encoded and the segment
   * therefore never looks like a double-dot segment to the parser. Decoding each segment and
   * refusing one that is empty, is a dot segment, or still contains a separator, closes that and
   * does not depend on a subtlety of the URL specification staying true.
   */
  for (const segment of url.pathname.slice(1).split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw invalidPath('the path contains a malformed percent-encoding');
    }
    if (decoded === '' || decoded === '.' || decoded === '..') {
      throw invalidPath('the path must not contain an empty or relative segment');
    }
    if (decoded.includes('/') || decoded.includes('\\')) {
      throw invalidPath('a path segment must not contain an encoded separator');
    }
  }

  return `${url.pathname}${url.search}`;
}

function invalidPath(reason: string): ApiClientError {
  /*
   * The rejected value is deliberately not echoed. It is the same rule the server's
   * `invalidParams[].reason` follows: the value is attacker-influenced, and this message may
   * reach a DOM node.
   */
  return new ApiClientError('INVALID_PATH', `Refused to request a path: ${reason}.`);
}

/** `fetch`'s shape, narrowed to what this module uses. Injected in tests; never in the app. */
export type Transport = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiRequest {
  /** Aborts a superseded request; the rejection is `ApiClientError` with `failure: 'ABORTED'`. */
  readonly signal?: AbortSignal;
  /** Injected in tests. The default is the browser's own `fetch`. */
  readonly transport?: Transport;
}

/**
 * A validated `GET` against GeoNerva's own API.
 *
 * The response is parsed with the caller's schema — which is always one of the frozen read-model
 * schemas from `@geonerva/domain`, never a local restatement of it — so a caller receives the
 * contract's type or an error, and never a partially-shaped object.
 */
export async function apiGet<T>(
  path: string,
  schema: ZodType<T>,
  request: ApiRequest = {},
): Promise<T> {
  const url = apiPath(path);
  const transport = request.transport ?? browserTransport();

  let response: Response;
  try {
    response = await transport(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      /* Pinned so that a redirect cannot move the request off this origin after `apiPath` ran. */
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'same-origin',
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal?.aborted === true || isAbortError(error)) {
      throw new ApiClientError('ABORTED', 'The request was superseded and was cancelled.');
    }
    throw new ApiClientError('UNREACHABLE', 'GeoNerva could not be reached.');
  }

  if (!response.ok) {
    throw new ApiClientError('PROBLEM', `The API answered ${String(response.status)}.`, {
      status: response.status,
      ...(await readProblem(response)),
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json\b/u.test(contentType)) {
    throw new ApiClientError('MALFORMED', 'The API answered with an unexpected content type.', {
      status: response.status,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiClientError('MALFORMED', 'The API answer was not valid JSON.', {
      status: response.status,
    });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    /* The validation issues are not attached: they quote the body, which is not ours to display. */
    throw new ApiClientError('MALFORMED', 'The API answer did not match the published contract.', {
      status: response.status,
    });
  }
  return parsed.data;
}

/** Reads an RFC 9457 body, when there is one. A body that is not one is simply absent. */
async function readProblem(response: Response): Promise<{ problem?: ProblemDetails }> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith(PROBLEM_MEDIA_TYPE)) return {};
  try {
    const parsed = problemDetailsSchema.safeParse(await response.json());
    return parsed.success ? { problem: parsed.data } : {};
  } catch {
    return {};
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The browser's `fetch`, bound once.
 *
 * Read lazily rather than captured at module load, so that the module can be imported in a
 * server render (where the component tree is built but no request is made) without depending on
 * a global that may not be the one the browser will use.
 */
function browserTransport(): Transport {
  const candidate: unknown = globalThis.fetch;
  if (typeof candidate !== 'function') {
    throw new ApiClientError('UNREACHABLE', 'This environment cannot make requests.');
  }
  return globalThis.fetch.bind(globalThis);
}
