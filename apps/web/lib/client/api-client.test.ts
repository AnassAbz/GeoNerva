/**
 * The test security finding R-7 asks for: the browser's one permitted network module must refuse
 * an absolute URL and anything outside `/api/v1`, **at run time**.
 *
 * It is written as an attack table rather than as a happy path with a couple of negatives,
 * because the interesting inputs are the ones that look like a relative path and are not
 * (`//evil.example/x`), and the ones that pass a prefix check and then climb out of it
 * (`/api/v1/../admin`, and the same climb percent-encoded two different ways). Each row below is
 * a spelling that a plausible weaker implementation would let through.
 */

import { PROBLEM_MEDIA_TYPE, READ_MODEL_SCHEMA_VERSION, problemTypeUri } from '@geonerva/domain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  API_PREFIX,
  ApiClientError,
  MAX_PATH_LENGTH,
  apiGet,
  apiPath,
  isAborted,
  type Transport,
} from './api-client.ts';

/** Inputs that must be refused, and the property of each that makes it dangerous. */
const REFUSED: readonly (readonly [string, unknown])[] = [
  ['an absolute https URL', 'https://evil.example/api/v1/places/suggest'],
  ['an absolute http URL', 'http://evil.example/api/v1/places/suggest'],
  ['a scheme-relative URL, which a browser reads as absolute', '//evil.example/api/v1/places'],
  ['a scheme-relative URL with a backslash', '\\\\evil.example/api/v1/places'],
  ['another scheme entirely', 'data:text/html,<p>x</p>'],
  ['a URL with embedded credentials', 'https://user:pass@evil.example/api/v1/x'],
  ['a same-origin path outside the API', '/admin'],
  ['a different API major version', '/api/v2/places/suggest'],
  ['a prefix that only looks like the API', '/api/v1x/places/suggest'],
  ['the prefix with nothing under it', API_PREFIX],
  ['a relative path with no leading slash', 'api/v1/places/suggest'],
  ['a parent-directory climb out of the prefix', '/api/v1/../admin'],
  ['a climb spelled with percent-encoded dots', '/api/v1/%2e%2e/admin'],
  ['a climb spelled with an upper-case percent-encoding', '/api/v1/%2E%2E/admin'],
  ['a climb spelled with an encoded separator', '/api/v1/..%2fadmin'],
  ['a climb spelled with an encoded backslash', '/api/v1/..%5cadmin'],
  ['a doubled separator, which is an empty segment', '/api/v1//places'],
  ['a fragment, which hides the tail of the URL from a naive check', '/api/v1/places#@evil'],
  ['a space', '/api/v1/pl aces'],
  ['a tab', '/api/v1/pl\taces'],
  ['a newline', '/api/v1/places\n'],
  ['a NUL byte', '/api/v1/places\u0000'],
  ['a zero-width joiner', '/api/v1/pl‍aces'],
  ['a malformed percent-encoding', '/api/v1/%zz'],
  ['an empty string', ''],
  ['a path longer than the cap', `${API_PREFIX}${'a'.repeat(MAX_PATH_LENGTH)}`],
  // Not strings. `String(value)` on any of these produces something that is not what was written.
  ['a number', 42],
  ['null', null],
  ['undefined', undefined],
  ['an array holding a valid path', ['/api/v1/places/suggest']],
  ['an object with a lying toString', { toString: () => '/api/v1/places/suggest' }],
  ['a URL object', new URL('https://evil.example/api/v1/places')],
];

/** The error `apiPath` raised, or `null` when it accepted the input. */
function refusal(candidate: unknown): ApiClientError | null {
  try {
    apiPath(candidate);
    return null;
  } catch (error) {
    return error instanceof ApiClientError ? error : null;
  }
}

describe('apiPath (security finding R-7)', () => {
  it('accepts a same-origin path under the API prefix, with its query', () => {
    expect(apiPath('/api/v1/places/suggest?q=Marr&limit=8')).toBe(
      '/api/v1/places/suggest?q=Marr&limit=8',
    );
  });

  it('accepts a percent-encoded query value without decoding it', () => {
    expect(apiPath('/api/v1/places/search?q=Saint-Louis%20du%20Nord')).toBe(
      '/api/v1/places/search?q=Saint-Louis%20du%20Nord',
    );
  });

  for (const [description, candidate] of REFUSED) {
    it(`refuses ${description}`, () => {
      expect(() => apiPath(candidate)).toThrow(ApiClientError);
      expect(refusal(candidate)?.failure).toBe('INVALID_PATH');
    });
  }

  it('never echoes the refused value, which is attacker-influenced', () => {
    for (const [, candidate] of REFUSED) {
      const message = refusal(candidate)?.message ?? '';
      expect(message).not.toBe('');
      expect(message).not.toContain('evil.example');
      expect(message).not.toContain('admin');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

const bodySchema = z.object({ schemaVersion: z.literal(READ_MODEL_SCHEMA_VERSION) });
const goodBody = { schemaVersion: READ_MODEL_SCHEMA_VERSION };

function jsonTransport(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): Transport {
  return vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': init.contentType ?? 'application/json; charset=utf-8' },
      }),
    ),
  );
}

describe('apiGet', () => {
  it('never reaches the transport with a refused path', async () => {
    const transport = jsonTransport(goodBody);
    await expect(apiGet('https://evil.example/x', bodySchema, { transport })).rejects.toThrow(
      ApiClientError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns the validated body', async () => {
    const transport = jsonTransport(goodBody);
    await expect(
      apiGet('/api/v1/places/suggest?q=Marr', bodySchema, { transport }),
    ).resolves.toEqual(goodBody);
  });

  it('pins the request to this origin and refuses to follow a redirect', async () => {
    const transport = jsonTransport(goodBody);
    await apiGet('/api/v1/places/suggest?q=Marr', bodySchema, { transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(transport).mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/places/suggest?q=Marr');
    expect(init).toMatchObject({
      method: 'GET',
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
    });
  });

  it('refuses an answer that is not JSON', async () => {
    const transport = jsonTransport('<html></html>', { contentType: 'text/html' });
    await expect(
      apiGet('/api/v1/places/suggest?q=Marr', bodySchema, { transport }),
    ).rejects.toMatchObject({ failure: 'MALFORMED' });
  });

  it('refuses an answer that does not match the frozen contract', async () => {
    const transport = jsonTransport({ schemaVersion: 'made-up' });
    await expect(
      apiGet('/api/v1/places/suggest?q=Marr', bodySchema, { transport }),
    ).rejects.toMatchObject({ failure: 'MALFORMED' });
  });

  it('carries the problem document through, so the UI can show GeoNerva’s own sentence', async () => {
    const problem = {
      type: problemTypeUri('RATE_LIMITED'),
      title: 'Too many requests',
      status: 429,
      detail: 'The place-search provider is asking GeoNerva to slow down.',
      instance: '/api/v1/places/search',
      code: 'RATE_LIMITED',
      invalidParams: [],
      retryAfterS: 60,
      earliestAsOf: null,
      affectedFamilies: [],
      traceId: null,
    };
    const transport = jsonTransport(problem, { status: 429, contentType: PROBLEM_MEDIA_TYPE });
    await expect(
      apiGet('/api/v1/places/search?q=Marr', bodySchema, { transport }),
    ).rejects.toMatchObject({
      failure: 'PROBLEM',
      status: 429,
      problem: { code: 'RATE_LIMITED', retryAfterS: 60 },
    });
  });

  it('reports an unreachable API rather than the underlying error', async () => {
    const transport: Transport = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await apiGet('/api/v1/places/suggest?q=Marr', bodySchema, {
      transport,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).failure).toBe('UNREACHABLE');
  });

  it('reports an aborted request distinctly, so a superseded keystroke is not an error', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport: Transport = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    };
    const error = await apiGet('/api/v1/places/suggest?q=Marr', bodySchema, {
      transport,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);
    expect(isAborted(error)).toBe(true);
  });
});
