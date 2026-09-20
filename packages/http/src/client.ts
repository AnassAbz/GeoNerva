/**
 * The hardened outbound HTTP client — the single place GeoNerva talks to the public internet
 * (ADR-028, docs/SECURITY.md M1/M2).
 *
 * Everything here exists because a provider is untrusted infrastructure, not because fetch is
 * hard:
 *
 *  - **Host allowlist, checked against the resolved address.** A source may only reach the hosts
 *    its descriptor names, and a name that resolves to a private or loopback address is refused
 *    — otherwise a DNS answer we do not control decides what our worker connects to (SSRF).
 *  - **Redirects are not followed.** A 30x to another host would defeat the allowlist; the
 *    caller is told, and a deliberate redirect must be encoded in the descriptor instead.
 *  - **Bounded body.** The response is read incrementally and abandoned the moment it exceeds
 *    the source's cap, so a wrong URL or a hostile body cannot exhaust the worker's memory.
 *  - **Timeout and cancellation.** Every request carries a deadline, and an external
 *    `AbortSignal` (a worker shutting down) cancels in-flight reads promptly.
 *  - **Retries with bounded exponential backoff and jitter**, honouring `Retry-After`. Only
 *    transient classes are retried; a 404 is not going to become a 200.
 *  - **No secrets in errors.** A URL can carry an API key, so errors carry host and path only.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import {
  SourceFetchError,
  classifyStatus,
  classifyTransportError,
  isTransient,
  type FetchErrorClass,
} from './errors.ts';

export interface RetryPolicy {
  /** Total attempts, including the first. `1` disables retrying. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Upper bound on a server-supplied `Retry-After`; beyond it, give up rather than sleep. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
};

export interface HttpClientOptions {
  /** Hosts this client may reach. Exact, lower-case host names; no wildcards, no ports. */
  readonly allowedHosts: readonly string[];
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Injected for tests: the fetch implementation, the clock, the sleeper and DNS resolution. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly resolveHost?: (host: string) => Promise<readonly string[]>;
  /** Deterministic tests need the jitter out of the way. */
  readonly jitter?: () => number;
}

export interface GetOptions {
  /** Sent as `If-None-Match`; a 304 answer becomes `notModified`. */
  readonly etag?: string | null;
  /** Sent as `If-Modified-Since`. */
  readonly lastModified?: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  readonly status: number;
  readonly notModified: boolean;
  readonly body: Uint8Array;
  readonly bytes: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentType: string | null;
  readonly url: string;
  /** Wall-clock milliseconds for the whole call, including retries. */
  readonly durationMs: number;
  readonly attempts: number;
}

const PRIVATE_IPV4 =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|198\.1[89]\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** True for addresses a source must never be able to make the worker connect to. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return PRIVATE_IPV4.test(address);
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // Unique-local (fc00::/7), link-local (fe80::/10), and IPv4-mapped forms.
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(lower)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return PRIVATE_IPV4.test(mapped[1]);
    return false;
  }
  return false;
}

/** A cancellation, as a typed error the pipeline can record. Never retried — see `errors.ts`. */
function abortedError(target: URL, attempt: number, cause?: unknown): SourceFetchError {
  return new SourceFetchError(
    'ABORTED',
    'the caller cancelled the request',
    { host: target.hostname, path: target.pathname, attempt },
    cause === undefined ? {} : { cause },
  );
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` as milliseconds: the header is either seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export class HttpClient {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #retry: RetryPolicy;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #resolveHost: (host: string) => Promise<readonly string[]>;
  readonly #jitter: () => number;

  constructor(options: HttpClientOptions) {
    this.#allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.#userAgent = options.userAgent;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#resolveHost =
      options.resolveHost ??
      (async (host) => (await lookup(host, { all: true })).map((entry) => entry.address));
    this.#jitter = options.jitter ?? Math.random;
  }

  /**
   * A bounded, allowlisted, retrying GET.
   *
   * Throws `SourceFetchError` with a classified `errorClass`; returns `notModified` for a 304 so
   * the caller can record a SKIPPED run rather than treating it as a failure.
   */
  async get(url: string, options: GetOptions = {}): Promise<HttpResponse> {
    const target = this.#validateUrl(url);
    const startedAt = this.#now();
    const maxBytes = options.maxBytes ?? this.#maxBytes;
    let lastError: SourceFetchError | undefined;

    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      // A caller who has already cancelled gets the same typed error as one who cancels mid-flight;
      // `throwIfAborted` would hand the pipeline a bare DOMException it has no class for.
      if (options.signal?.aborted === true) throw abortedError(target, attempt);
      try {
        const response = await this.#attempt(target, options, maxBytes, attempt);
        return {
          ...response,
          durationMs: this.#now() - startedAt,
          attempts: attempt,
        };
      } catch (error) {
        const fetchError = this.#asFetchError(error, target, attempt);
        lastError = fetchError;
        const lastAttempt = attempt === this.#retry.maxAttempts;
        if (!fetchError.transient || lastAttempt) throw fetchError;
        try {
          await this.#sleep(this.#backoffMs(attempt, fetchError), options.signal);
        } catch (sleepError) {
          if (sleepError instanceof SourceFetchError) throw sleepError;
          throw abortedError(target, attempt, sleepError);
        }
      }
    }

    /* c8 ignore next 2 -- the loop either returns or throws; this satisfies the type checker. */
    throw lastError ?? new SourceFetchError('NETWORK', 'request failed', { host: target.hostname });
  }

  /** Checks the URL against the allowlist. Throws `CONFIG_ERROR`, which is never retried. */
  #validateUrl(url: string): URL {
    if (!URL.canParse(url)) {
      throw new SourceFetchError('CONFIG_ERROR', 'not a valid URL', { host: '(unparseable)' });
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new SourceFetchError('CONFIG_ERROR', 'only https is allowed', {
        host: parsed.hostname,
        path: parsed.pathname,
      });
    }
    if (!this.#allowedHosts.has(parsed.hostname.toLowerCase())) {
      throw new SourceFetchError('CONFIG_ERROR', 'host is not allowlisted for this source', {
        host: parsed.hostname,
        path: parsed.pathname,
      });
    }
    return parsed;
  }

  async #attempt(
    target: URL,
    options: GetOptions,
    maxBytes: number,
    attempt: number,
  ): Promise<Omit<HttpResponse, 'durationMs' | 'attempts'>> {
    await this.#assertPublicAddress(target.hostname);

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    // Which of the two clocks fired decides the class, because the thrown `AbortError` looks the
    // same either way and guessing from its name would mislabel a shutdown as a provider timeout.
    const deadline = { expired: false };
    const timer = setTimeout(() => {
      deadline.expired = true;
      controller.abort(new DOMException('request timed out', 'TimeoutError'));
    }, timeoutMs);
    const onExternalAbort = (): void => {
      controller.abort(options.signal?.reason ?? new DOMException('aborted', 'AbortError'));
    };
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        'user-agent': this.#userAgent,
        'accept-encoding': 'gzip, deflate',
        ...options.headers,
      };
      if (options.etag != null) headers['if-none-match'] = options.etag;
      if (options.lastModified != null) headers['if-modified-since'] = options.lastModified;

      const response = await this.#fetch(target, {
        method: 'GET',
        headers,
        signal: controller.signal,
        // A redirect to another host would walk straight around the allowlist.
        redirect: 'manual',
      });

      // 304 first: it sits inside the 3xx range but is an *answer* to our conditional request,
      // not a redirect. Checking the range first would reject every conditional GET.
      if (response.status === 304) {
        return {
          status: 304,
          notModified: true,
          body: new Uint8Array(0),
          bytes: 0,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          contentType: response.headers.get('content-type'),
          url: target.toString(),
        };
      }

      if (response.status >= 300 && response.status < 400) {
        throw new SourceFetchError('CONFIG_ERROR', 'redirect refused', {
          host: target.hostname,
          path: target.pathname,
          status: response.status,
          attempt,
        });
      }

      if (!response.ok) {
        const errorClass = classifyStatus(response.status);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.#now());
        throw new SourceFetchError(errorClass, `upstream responded ${response.status}`, {
          host: target.hostname,
          path: target.pathname,
          status: response.status,
          attempt,
          ...(retryAfterMs === null ? {} : { retryAfterMs }),
        });
      }

      const body = await this.#readBounded(response, maxBytes, target, attempt);
      return {
        status: response.status,
        notModified: false,
        body,
        bytes: body.byteLength,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        contentType: response.headers.get('content-type'),
        url: target.toString(),
      };
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
      if (deadline.expired) {
        throw new SourceFetchError(
          'TIMEOUT',
          `no response within ${timeoutMs}ms`,
          { host: target.hostname, path: target.pathname, attempt },
          { cause: error },
        );
      }
      if (options.signal?.aborted === true) throw abortedError(target, attempt, error);
      throw this.#asFetchError(error, target, attempt);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Reads the body incrementally, abandoning it the moment it passes the cap.
   *
   * `content-length` is only a hint — it can lie or be absent — so the running total is what
   * actually enforces the limit.
   */
  async #readBounded(
    response: Response,
    maxBytes: number,
    target: URL,
    attempt: number,
  ): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new SourceFetchError('TOO_LARGE', 'content-length exceeds the cap', {
        host: target.hostname,
        path: target.pathname,
        status: response.status,
        attempt,
        bytesRead: declared,
      });
    }

    const stream: ReadableStream<Uint8Array> | null = response.body;
    const reader = stream?.getReader();
    if (reader === undefined) return new Uint8Array(0);

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new SourceFetchError('TOO_LARGE', 'response body exceeds the cap', {
            host: target.hostname,
            path: target.pathname,
            status: response.status,
            attempt,
            bytesRead: total,
          });
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }

  /** Refuses a host that resolves to a private or loopback address (SSRF, docs/SECURITY.md M1). */
  async #assertPublicAddress(host: string): Promise<void> {
    if (isIP(host) !== 0) {
      if (isPrivateAddress(host)) {
        throw new SourceFetchError('CONFIG_ERROR', 'refusing a private address', { host });
      }
      return;
    }
    let addresses: readonly string[];
    try {
      addresses = await this.#resolveHost(host);
    } catch (error) {
      throw new SourceFetchError('NETWORK', 'could not resolve host', { host }, { cause: error });
    }
    const priv = addresses.find((address) => isPrivateAddress(address));
    if (priv !== undefined) {
      throw new SourceFetchError('CONFIG_ERROR', 'host resolves to a private address', { host });
    }
  }

  #asFetchError(error: unknown, target: URL, attempt: number): SourceFetchError {
    if (error instanceof SourceFetchError) return error;
    const errorClass: FetchErrorClass = classifyTransportError(error);
    const message = errorClass === 'TIMEOUT' ? 'request timed out or was aborted' : 'network error';
    return new SourceFetchError(
      errorClass,
      message,
      { host: target.hostname, path: target.pathname, attempt },
      { cause: error },
    );
  }

  /** Exponential backoff with full jitter, bounded, and respecting `Retry-After`. */
  #backoffMs(attempt: number, error: SourceFetchError): number {
    const retryAfter = error.context.retryAfterMs;
    if (retryAfter !== undefined) {
      // A `Retry-After` date already in the past parses to 0 ms, and honouring that literally
      // would retry three times instantly — the opposite of backing off — against a server that
      // has just said it is overloaded. The server's wait is a floor, never a licence to hurry.
      if (retryAfter <= 0) return this.#exponentialBackoffMs(attempt);
      if (retryAfter > this.#retry.maxRetryAfterMs) {
        throw new SourceFetchError(
          error.errorClass,
          `upstream asked for a ${Math.round(retryAfter / 1000)}s wait, which is longer than we will hold a run open`,
          error.context,
        );
      }
      return retryAfter;
    }
    return this.#exponentialBackoffMs(attempt);
  }

  #exponentialBackoffMs(attempt: number): number {
    const exponential = Math.min(
      this.#retry.maxDelayMs,
      this.#retry.initialDelayMs * 2 ** (attempt - 1),
    );
    // Full jitter: without it, parallel workers retry in lockstep and re-create the spike.
    return Math.round(exponential * this.#jitter());
  }
}

export { SourceFetchError, isTransient };
export type { FetchErrorClass };
