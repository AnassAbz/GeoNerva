/**
 * The soak verdict's rulings, which are the contested part of P10's acceptance criterion.
 *
 * "≥ 99 % non-provider run success" sounds unambiguous and is not: it has to say what a
 * non-provider run is, whether `SKIPPED` and `PARTIAL` count, and what to do when there are barely
 * any runs at all. Those choices are argued in `docs/reviews/p10-plan.md` §2 and pinned here, so
 * that changing one is a deliberate act rather than a passing thought.
 */

import { describe, expect, it } from 'vitest';

import { parseArgs, verdictOf, type SoakTally } from './soak-report.ts';

const OPTIONS = { hours: 24, minRuns: 24, threshold: 0.99 };

function tally(overrides: Partial<SoakTally> = {}): SoakTally {
  return {
    judged: 288,
    succeeded: 288,
    providerFailures: 0,
    aborted: 0,
    builds: ['ef6e970'],
    ...overrides,
  };
}

describe('the soak verdict', () => {
  it('passes a day of clean scheduled runs', () => {
    const verdict = verdictOf(tally(), OPTIONS);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toContain('288 non-provider runs');
  });

  it('fails just below the threshold, and says what the rate was', () => {
    const verdict = verdictOf(tally({ judged: 100, succeeded: 98 }), OPTIONS);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('98.00 %');
    expect(verdict.reason).toContain('99.00 %');
  });

  it('passes exactly at the threshold, because the criterion says "≥"', () => {
    expect(verdictOf(tally({ judged: 100, succeeded: 99 }), OPTIONS).pass).toBe(true);
  });

  /*
   * The failure mode this script exists to prevent. `NETWORK` is a provider class, so a deployment
   * that cannot reach anything — a proxy, DNS, a certificate it does not trust — has every run
   * excluded from the denominator. Without a floor the report would say 100 % while the deployment
   * ingested nothing, which is the most convincing possible way to pass a soak that failed.
   */
  it('refuses to report a rate when everything was blamed on the provider', () => {
    const verdict = verdictOf(tally({ judged: 0, succeeded: 0, providerFailures: 288 }), OPTIONS);
    expect(verdict.pass).toBe(false);
    expect(verdict.rate).toBeNull();
    expect(verdict.reason).toContain('egress');
  });

  it('refuses a rate over too few runs even when all of them succeeded', () => {
    const verdict = verdictOf(tally({ judged: 3, succeeded: 3 }), OPTIONS);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('3 non-provider runs');
  });
});

describe('the soak arguments', () => {
  it('defaults to the criterion in the plan', () => {
    expect(parseArgs([])).toEqual({ hours: 24, minRuns: 24, threshold: 0.99 });
  });

  it('accepts a shorter window for a rehearsal', () => {
    expect(parseArgs(['--hours', '2', '--min-runs', '4'])).toEqual({
      hours: 2,
      minRuns: 4,
      threshold: 0.99,
    });
  });

  it('refuses arguments that would quietly weaken the measurement', () => {
    expect(parseArgs(['--hours'])).toContain('needs a value');
    expect(parseArgs(['--hours', '0'])).toContain('positive');
    expect(parseArgs(['--hours', 'yesterday'])).toContain('positive');
    /* 99 rather than 0.99 would otherwise mean "never pass", silently. */
    expect(parseArgs(['--threshold', '99'])).toContain('fraction');
    expect(parseArgs(['--verbose'])).toContain('unknown argument');
  });
});
