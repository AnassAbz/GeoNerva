/**
 * `problem.ts` — the error contract (RFC 9457, ARCHITECTURE §13).
 *
 * An error response is the part of an API that gets the least attention and leaks the most, so
 * these tests are about what must **not** be in one:
 *
 *  - no stack trace, no file path, no connection string, no table name;
 *  - no echo of a submitted value, in `detail` or in `invalidParams[].reason`;
 *  - no query string in `instance`, which is where the coordinates are (invariant I15);
 *  - and no caching, because a cached 400 is a cache-poisoning primitive.
 */

import { describe, expect, it } from 'vitest';

import { PROBLEM_CODES, PROBLEM_MEDIA_TYPE, PROBLEM_STATUS } from '@geonerva/domain';

import {
  ApiProblemError,
  pathOnly,
  problemDocument,
  problemResponse,
  toProblemResponse,
} from './problem.ts';

describe('problemDocument', () => {
  it('fills every field of the frozen contract, with nulls rather than omissions', () => {
    const document = problemDocument({ code: 'NOT_FOUND' });
    expect(Object.keys(document).sort()).toEqual(
      [
        'affectedFamilies',
        'code',
        'detail',
        'earliestAsOf',
        'instance',
        'invalidParams',
        'retryAfterS',
        'status',
        'title',
        'traceId',
        'type',
      ].sort(),
    );
    expect(document.detail).toBeNull();
    expect(document.invalidParams).toEqual([]);
  });

  /** Every code in the frozen list must have a title and the status the contract assigns it. */
  it.each(PROBLEM_CODES)('gives %s its frozen status and a non-empty title', (code) => {
    const document = problemDocument({ code });
    expect(document.status).toBe(PROBLEM_STATUS[code]);
    expect(document.title.length).toBeGreaterThan(0);
    expect(document.code).toBe(code);
    expect(document.type).toContain(code.toLowerCase().replaceAll('_', '-'));
  });

  it('generates a distinct traceId per document when none is supplied', () => {
    const first = problemDocument({ code: 'INTERNAL_ERROR' }).traceId;
    const second = problemDocument({ code: 'INTERNAL_ERROR' }).traceId;
    expect(first).not.toBe(second);
  });

  it('keeps a supplied traceId so the log line and the client agree', () => {
    const document = problemDocument({ code: 'INTERNAL_ERROR', traceId: 'trace-1' });
    expect(document.traceId).toBe('trace-1');
  });

  /*
   * The whole reason `instance` is documented as "the path" rather than "the URL". A query string
   * carries the user's coordinates, and an error body is cached by intermediaries and copied into
   * bug reports.
   */
  it('strips the query string from instance', () => {
    const document = problemDocument({
      code: 'VALIDATION_FAILED',
      instance: '/api/v1/briefing?lat=31.629512&lon=-7.981084',
    });
    expect(document.instance).toBe('/api/v1/briefing');
    expect(JSON.stringify(document)).not.toContain('31.6295');
  });

  it('strips a fragment too', () => {
    expect(problemDocument({ code: 'NOT_FOUND', instance: '/a/b#frag' }).instance).toBe('/a/b');
  });
});

describe('pathOnly', () => {
  it.each([
    ['/api/v1/briefing', '/api/v1/briefing'],
    ['/api/v1/briefing?lat=1', '/api/v1/briefing'],
    ['/api/v1/briefing#x', '/api/v1/briefing'],
    ['/api/v1/briefing?a=1#x', '/api/v1/briefing'],
    ['/', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(pathOnly(input)).toBe(expected);
  });

  /** A relative path has no base URL, and `new URL('/x')` throws — hence the manual split. */
  it('handles a relative path without throwing', () => {
    expect(() => pathOnly('/api/v1/evidence/EV:OBS:41')).not.toThrow();
  });
});

describe('problemResponse', () => {
  it('uses the problem media type and never caches', async () => {
    const response = problemResponse({ code: 'VALIDATION_FAILED' });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe(PROBLEM_MEDIA_TYPE);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(((await response.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  /**
   * A mutation control for the cache header, stated as the reason rather than the value.
   *
   * Every problem code must be `no-store`. A 429 cached at the edge would extend one caller's
   * rate limit to every visitor behind that CDN node, and a cached 400 would serve one malformed
   * request's error to everyone sharing the key. Asserting it for one code would not catch an
   * edit that special-cased another.
   */
  it.each(PROBLEM_CODES)('never caches a %s', (code) => {
    expect(problemResponse({ code }).headers.get('cache-control')).toBe('no-store');
  });

  it('sets retry-after only when the problem carries one', () => {
    expect(
      problemResponse({ code: 'RATE_LIMITED', retryAfterS: 30 }).headers.get('retry-after'),
    ).toBe('30');
    expect(problemResponse({ code: 'RATE_LIMITED' }).headers.get('retry-after')).toBeNull();
  });

  it('rounds retry-after up and never below zero', () => {
    expect(
      problemResponse({ code: 'RATE_LIMITED', retryAfterS: 0.2 }).headers.get('retry-after'),
    ).toBe('1');
    expect(
      problemResponse({ code: 'RATE_LIMITED', retryAfterS: -5 }).headers.get('retry-after'),
    ).toBe('0');
  });
});

describe('toProblemResponse', () => {
  it('keeps the code of an ApiProblemError and reports no cause to log', async () => {
    const thrown = new ApiProblemError({
      code: 'LOCATION_NOT_FOUND',
      detail: 'GeoNerva does not hold that place.',
    });
    const { response, cause } = toProblemResponse(thrown, '/api/v1/briefing?lat=1');
    const body = (await response.json()) as { code: string; detail: string; instance: string };
    expect(response.status).toBe(404);
    expect(body.code).toBe('LOCATION_NOT_FOUND');
    expect(body.instance).toBe('/api/v1/briefing');
    expect(cause).toBeNull();
  });

  /*
   * The asymmetry that is the point of this module: an unexpected error becomes a fixed sentence
   * plus a traceId, and the original is handed back for the caller to log. The client learns
   * nothing about the shape of the system; the operator loses nothing.
   */
  it('turns anything else into a generic INTERNAL_ERROR and returns the cause', async () => {
    const driverError = new Error(
      'connect ECONNREFUSED 10.0.2.15:5432 while querying geonerva.observation_versions',
    );
    const { response, traceId, cause } = toProblemResponse(driverError, '/api/v1/briefing');
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toContain('10.0.2.15');
    expect(raw).not.toContain('5432');
    expect(raw).not.toContain('observation_versions');
    expect(raw).toContain(traceId);
    expect(cause).toBe(driverError);
  });

  it('never renders a stack trace', async () => {
    const error = new Error('boom');
    const raw = await toProblemResponse(error, '/api/v1/briefing').response.text();
    expect(raw).not.toContain('problem.test.ts');
    expect(raw).not.toContain('at ');
  });

  it('handles a thrown non-error without letting its text through', async () => {
    const raw = await toProblemResponse(
      { secret: 'postgres://user:pw@host/db' },
      '/api/v1/briefing',
    ).response.text();
    expect(raw).not.toContain('postgres://');
    expect(JSON.parse(raw)).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
  });

  /**
   * A mutation control for the `instanceof` branch.
   *
   * If `toProblemResponse` re-used the thrown error's *message* for `detail` — the shape an
   * "improve the error message" edit produces — a driver error's text would reach the client. The
   * `ApiProblemError` path must be the only one that can set `detail`.
   */
  it('does not use a thrown error message as the detail', async () => {
    const body = (await toProblemResponse(
      new Error('relation "geonerva.agent_outputs" does not exist'),
      '/x',
    ).response.json()) as { detail: string };
    expect(body.detail).not.toContain('agent_outputs');
    expect(body.detail).toContain('could not complete this request');
  });
});

describe('ApiProblemError', () => {
  it('carries the problem and a message that names the code', () => {
    const error = new ApiProblemError({ code: 'BBOX_TOO_LARGE', detail: 'too big' });
    expect(error.name).toBe('ApiProblemError');
    expect(error.message).toContain('BBOX_TOO_LARGE');
    expect(error.problem.detail).toBe('too big');
  });

  it('falls back to the title when no detail is given', () => {
    expect(new ApiProblemError({ code: 'RATE_LIMITED' }).message).toContain('Too many requests');
  });
});
