/**
 * `coveredSince` — where unbroken coverage up to a knowledge time begins (P8 review H1, H2).
 */

import { describe, expect, it } from 'vitest';

import { coveredSince } from './coverage-span.ts';

const at = (day: number): Date => new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
const span = (from: number, to: number) => ({ from: at(from), to: at(to) });

describe('coveredSince', () => {
  it('joins overlapping and exactly adjacent spans', () => {
    expect(coveredSince([span(0, 10), span(10, 20), span(15, 30)], at(30))).toEqual(at(0));
  });

  it('starts after the last gap before the knowledge time', () => {
    // The 5→6 gap was never read, so nothing before day 6 may be compared.
    expect(coveredSince([span(0, 5), span(6, 30)], at(30))).toEqual(at(6));
  });

  it('is null when nothing covered reaches the knowledge time', () => {
    expect(coveredSince([span(0, 20)], at(30))).toBeNull();
    expect(coveredSince([], at(30))).toBeNull();
  });

  it('ignores coverage that begins after the knowledge time', () => {
    expect(coveredSince([span(0, 30), span(40, 50)], at(30))).toEqual(at(0));
    expect(coveredSince([span(40, 50)], at(30))).toBeNull();
  });

  it('does not depend on the order the spans arrive in', () => {
    expect(coveredSince([span(15, 30), span(0, 10), span(10, 20)], at(30))).toEqual(at(0));
  });

  it('keeps the farther end when a short span sits inside a long one', () => {
    // [5, 10) inside [0, 30) must not pull the run's end back to 10 and open a false gap at 12.
    expect(coveredSince([span(0, 30), span(5, 10), span(12, 40)], at(40))).toEqual(at(0));
  });

  it('ignores an empty span', () => {
    expect(coveredSince([span(5, 5), span(6, 30)], at(30))).toEqual(at(6));
  });
});
