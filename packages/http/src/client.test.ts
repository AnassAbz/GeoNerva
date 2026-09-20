/**
 * The outbound client's failure modes (docs/reviews/p3-plan.md §5).
 *
 * Everything is injected — fetch, clock, sleeper, DNS — so these are deterministic and fast, and
 * so the retry timing can be asserted rather than waited for.
 *
 * The doubles are written as plain functions returning promises rather than `async` ones: they
 * never await anything, and `require-await` is a rule worth keeping sharp in this package.
 */
import { describe, expect, it, vi } from 'vitest';

import { HttpClient, isPrivateAddress, parseRetryAfter } from './client.ts';
import { SourceFetchError } from './errors.ts';

const HOST = 'earthquake.usgs.gov';
const URL_OK = `https://${HOST}/earthquakes/feed/v1.0/summary/all_day.geojson`;

function client(overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}): HttpClient {
  return new HttpClient({
    allowedHosts: [HOST],
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    jitter: () => 1,
    ...overrides,
  });
}

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Records what the client asked us to wait for, so backoff can be asserted instead of slept. */
function recordingSleeper(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

describe('allowlist and SSRF', () => {
  it('refuses a host the source does not declare', async () => {
    const fetchImpl = vi.fn();
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch }).get('https://evil.example/x'),
    ).rejects.toMatchObject({ errorClass: 'CONFIG_ERROR' });
    expect(fetchImpl, 'must not even attempt the request').not.toHaveBeenCalled();
  });

  it('refuses plain http', async () => {
    await expect(client().get(`http://${HOST}/x`)).rejects.toMatchObject({
      errorClass: 'CONFIG_ERROR',
    });
  });

  it('refuses an allowlisted host that resolves to a private address', async () => {
    const fetchImpl = vi.fn();
    const ssrf = client({
      resolveHost: () => Promise.resolve(['10.0.0.5']),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(ssrf.get(URL_OK)).rejects.toMatchObject({ errorClass: 'CONFIG_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a redirect rather than following it off the allowlist', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
      ),
    );
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'CONFIG_ERROR' });
  });

  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['8.8.8.8', false],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true],
    ['2606:4700::1111', false],
  ])('classifies %s as private=%s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('status handling', () => {
  it('returns notModified for 304 without a body', async () => {
    let sent: RequestInit | undefined;
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => {
      sent = init;
      return Promise.resolve(new Response(null, { status: 304, headers: { etag: 'W/"a"' } }));
    });
    const response = await client({ fetchImpl: fetchImpl as unknown as typeof fetch }).get(URL_OK, {
      etag: 'W/"a"',
    });
    expect(response.notModified).toBe(true);
    expect(response.bytes).toBe(0);
    // 304 lives inside the 3xx range the client refuses as a redirect; it must be recognised as
    // the answer to our conditional request instead.
    const headers = sent?.headers as Record<string, string> | undefined;
    expect(headers?.['if-none-match']).toBe('W/"a"');
  });

  it('classifies 404 as HTTP_4XX and does not retry it', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })));
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'HTTP_4XX', transient: false });
    expect(fetchImpl, 'a 404 will not become a 200').toHaveBeenCalledTimes(1);
  });

  it('retries 5xx up to the policy and then fails', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('boom', { status: 503 })));
    const { sleeps, sleep } = recordingSleeper();
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'HTTP_5XX', transient: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('succeeds on a retry after a transient failure', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      return Promise.resolve(
        call === 1 ? new Response('boom', { status: 500 }) : jsonResponse('{"ok":true}'),
      );
    });
    const response = await client({ fetchImpl: fetchImpl as unknown as typeof fetch }).get(URL_OK);
    expect(response.attempts).toBe(2);
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}');
  });

  it('honours Retry-After on 429', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })),
    );
    const { sleeps, sleep } = recordingSleeper();
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'RATE_LIMITED' });
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('does not let a stale Retry-After date turn into no backoff at all', async () => {
    // An HTTP-date Retry-After already in the past parses to 0 ms. Honouring that literally would
    // retry three times instantly against a server that has just said it is overloaded.
    const fetchImpl = vi.fn(
      () =>
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': new Date(Date.now() - 60_000).toUTCString() },
        }),
    );
    const { sleeps, sleep } = recordingSleeper();
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'RATE_LIMITED' });
    expect(sleeps, 'falls back to the exponential schedule').toStrictEqual([500, 1000]);
  });

  it('gives up rather than sleeping longer than a run may stay open', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } }),
      ),
    );
    const { sleeps, sleep } = recordingSleeper();
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'RATE_LIMITED' });
    expect(sleeps, 'a one-hour wait is a failed run, not a sleep').toHaveLength(0);
  });

  it.each([
    ['10', 10_000],
    ['0', 0],
    ['not-a-date', null],
  ])('parses Retry-After %s', (header, expected) => {
    expect(parseRetryAfter(header, 0)).toBe(expected);
  });
});

describe('body limits', () => {
  it('refuses a declared content-length over the cap without reading', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('x'.repeat(100), { headers: { 'content-length': '999999' } })),
    );
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, maxBytes: 1000 }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'TOO_LARGE' });
  });

  it('stops reading a body that grows past the cap even when content-length lies', async () => {
    const chunk = new Uint8Array(400);
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        if (emitted > 50) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(stream, { headers: { 'content-length': '10' } })),
    );
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, maxBytes: 1000 }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'TOO_LARGE' });
    expect(emitted, 'must abandon the body early, not read it all').toBeLessThan(10);
  });

  it('returns a body at exactly the cap', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse('x'.repeat(1000))));
    const response = await client({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBytes: 1000,
    }).get(URL_OK);
    expect(response.bytes).toBe(1000);
  });
});

/**
 * A request that never answers, cancellable like the real thing.
 *
 * `fetch` rejects immediately when handed an already-aborted signal; a double that only subscribes
 * to the `abort` event misses an abort that happened first and hangs forever. That difference is
 * not academic — it is exactly the ordering a worker shutting down produces.
 */
function pendingUntilAborted(init?: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => {
      const reason: unknown = init?.signal?.reason;
      reject(reason instanceof Error ? reason : new DOMException('aborted', 'AbortError'));
    };
    if (init?.signal?.aborted === true) {
      fail();
      return;
    }
    init?.signal?.addEventListener('abort', fail, { once: true });
  });
}

describe('timeout and cancellation', () => {
  it('classifies a timeout', async () => {
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => pendingUntilAborted(init));
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5 }).get(URL_OK),
    ).rejects.toMatchObject({ errorClass: 'TIMEOUT', transient: true });
  });

  it('propagates an external abort and does not retry after it', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => {
      controller.abort();
      return pendingUntilAborted(init);
    });
    const error = await client({ fetchImpl: fetchImpl as unknown as typeof fetch })
      .get(URL_OK, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error, 'callers only ever see the typed error').toBeInstanceOf(SourceFetchError);
    expect(error).toMatchObject({ errorClass: 'ABORTED', transient: false });
    expect(fetchImpl, 'a cancelled worker does not keep retrying').toHaveBeenCalledTimes(1);
  });

  it('does not report a cancellation as a provider timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => {
      controller.abort();
      return pendingUntilAborted(init);
    });
    // The distinction an operator acts on: TIMEOUT means chase the provider, ABORTED means we
    // stopped it ourselves. The thrown DOMException looks identical in both cases.
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 50 }).get(URL_OK, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ errorClass: 'ABORTED' });
  });

  it('stops retrying when the signal aborts during the backoff sleep', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('boom', { status: 503 })));
    const sleep = (): Promise<void> => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    };
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep }).get(URL_OK, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ errorClass: 'ABORTED', transient: false });
    expect(fetchImpl, 'the second attempt never starts').toHaveBeenCalledTimes(1);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const fetchImpl = vi.fn();
    await expect(
      client({ fetchImpl: fetchImpl as unknown as typeof fetch }).get(URL_OK, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ errorClass: 'ABORTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('errors never leak the URL', () => {
  it('keeps query strings out of the message and context', async () => {
    const secretUrl = `https://${HOST}/api/area/csv/SECRETKEY123/world/1?token=abc`;
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 403 })));
    try {
      await client({ fetchImpl: fetchImpl as unknown as typeof fetch }).get(secretUrl);
      expect.unreachable();
    } catch (error) {
      const text = `${(error as Error).message} ${(error as SourceFetchError).describe()} ${JSON.stringify((error as SourceFetchError).context)}`;
      expect(text).not.toContain('token=abc');
      expect(text).toContain(HOST);
    }
  });
});
