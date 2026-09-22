/**
 * The one decision `lib/view/failure.ts` makes, from both sides of the client boundary.
 *
 * The values here are the shapes the two callers actually see: a real `ApiProblemError` on the
 * server, the same error's message on a development boundary, and the redacted `Error` a
 * production boundary gets. The last one must classify as a failure — a retention sentence shown
 * for a database outage would be GeoNerva blaming retention for its own fault.
 */

import { describe, expect, it } from 'vitest';

import { ApiProblemError } from '../server/problem.ts';
import { failureKind } from './failure.ts';

describe('failureKind', () => {
  it('reads the code off a thrown problem without importing its class', () => {
    expect(failureKind(new ApiProblemError({ code: 'AS_OF_BEFORE_HORIZON' }))).toBe('RETENTION');
    /* Structural, because a client boundary cannot import the server's module. */
    expect(failureKind({ problem: { code: 'AS_OF_BEFORE_HORIZON' } })).toBe('RETENTION');
  });

  it('classifies every other problem as a failure GeoNerva must own', () => {
    for (const code of ['INTERNAL_ERROR', 'UPSTREAM_UNAVAILABLE', 'AS_OF_IN_FUTURE'] as const) {
      expect(failureKind(new ApiProblemError({ code }))).toBe('UNEXPECTED');
    }
  });

  it('recognises the refusal by message, which is what a development boundary sees', () => {
    expect(failureKind(new Error('AS_OF_BEFORE_HORIZON: that time is before the horizon'))).toBe(
      'RETENTION',
    );
  });

  it('does not read retention into the redacted error a production boundary gets', () => {
    const redacted = Object.assign(
      new Error(
        'An error occurred in the Server Components render. The specific message is omitted in production builds.',
      ),
      { digest: '1234567890' },
    );
    expect(failureKind(redacted)).toBe('UNEXPECTED');
  });

  it('does not swallow the values a framework throws as control flow', () => {
    expect(failureKind(new Error('NEXT_NOT_FOUND'))).toBe('UNEXPECTED');
    expect(failureKind(undefined)).toBe('UNEXPECTED');
    expect(failureKind(null)).toBe('UNEXPECTED');
    expect(failureKind('AS_OF_BEFORE_HORIZON')).toBe('UNEXPECTED');
    expect(failureKind({ problem: { code: 42 } })).toBe('UNEXPECTED');
    expect(failureKind({ problem: null })).toBe('UNEXPECTED');
  });
});
