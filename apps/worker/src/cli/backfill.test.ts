/**
 * Argument parsing for `geonerva-worker backfill`.
 *
 * A backfill is the one command where a misread argument is expensive: the wrong window silently
 * ingests the wrong slice of history, and nothing downstream would notice the gap.
 */
import { describe, expect, it } from 'vitest';

import { backfillExitCode, describeBackfill, parseBackfillArgs, parseDateArg } from './backfill.ts';
import type { BackfillOutcome } from '@geonerva/pipeline';

const outcome = (over: Partial<BackfillOutcome> = {}): BackfillOutcome => ({
  planId: 'p1',
  status: 'COMPLETED',
  progress: { total: 4, pending: 0, done: 4, split: 0, failed: 0, received: 2266 },
  intervalsProcessed: 4,
  intervalsSplit: 0,
  newVersions: 2266,
  unchanged: 0,
  detail: null,
  ...over,
});

describe('parseDateArg', () => {
  it('reads a bare date as UTC midnight', () => {
    // Not the operator's midnight: a backfill that shifted by the local offset would put a day of
    // earthquakes in the wrong window, and nothing downstream would report the gap.
    expect(parseDateArg('2026-01-01')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts an explicit instant', () => {
    expect(parseDateArg('2026-01-01T06:30:00Z')?.toISOString()).toBe('2026-01-01T06:30:00.000Z');
  });

  it.each(['01/01/2026', 'yesterday', '2026-1-1', '2026-13-01', ''])(
    'refuses the ambiguous or invalid %p rather than guessing',
    (value) => {
      expect(parseDateArg(value)).toBeNull();
    },
  );
});

describe('parseBackfillArgs', () => {
  const base = ['--source', 'usgs', '--from', '2026-01-01', '--to', '2026-02-01'];

  it('reads a complete request', () => {
    const parsed = parseBackfillArgs([...base, '--min-magnitude', '4.5', '--window-days', '7']);
    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.source).toBe('usgs');
    expect(parsed.from?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.minMagnitude).toBe(4.5);
    expect(parsed.windowDays).toBe(7);
    expect(parsed.deletedOnly).toBe(false);
  });

  it.each([
    [[], '--source is required'],
    [['--source', 'usgs'], '--from is required'],
    [['--source', 'firms', '--from', '2026-01-01', '--to', '2026-02-01'], 'unknown source: firms'],
    [
      ['--source', 'usgs', '--from', '2026-02-01', '--to', '2026-01-01'],
      '--from must be strictly before --to',
    ],
    [
      [...['--source', 'usgs'], '--from', 'today', '--to', '2026-02-01'],
      '--from must be an ISO date',
    ],
  ])('refuses %j', (argv, expected) => {
    expect(parseBackfillArgs(argv).errors.join(' ')).toContain(expected);
  });

  it.each([
    ['--min-magnitude', '99'],
    ['--window-days', '0'],
    ['--max-intervals', '-3'],
  ])('refuses an out-of-range %s', (flag, value) => {
    expect(parseBackfillArgs([...base, flag, value]).errors).not.toStrictEqual([]);
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // The dangerous case: a flag accepted and dropped runs something other than what was asked.
    expect(parseBackfillArgs([...base, '--dry-run']).errors.join(' ')).toContain(
      'unknown argument: --dry-run',
    );
  });

  it('refuses a flag whose value was swallowed by the next flag', () => {
    expect(parseBackfillArgs(['--source', '--from', '2026-01-01']).errors.join(' ')).toContain(
      '--source needs a value',
    );
  });

  it('reads the deletion sweep switch', () => {
    expect(parseBackfillArgs([...base, '--deleted-only']).deletedOnly).toBe(true);
  });

  it('allows --help without a complete request', () => {
    expect(parseBackfillArgs(['--help'])).toMatchObject({ help: true, errors: [] });
  });
});

describe('reporting', () => {
  it('summarises a completed backfill', () => {
    expect(describeBackfill(outcome())).toBe(
      'COMPLETED: 4/4 window(s) done — 2266 record(s) received, 2266 new version(s), 0 unchanged',
    );
  });

  it('names what is outstanding when work remains', () => {
    const partial = outcome({
      status: 'INCOMPLETE',
      progress: { total: 10, pending: 6, done: 3, split: 1, failed: 0, received: 900 },
      detail: '6 interval(s) still pending',
    });
    expect(describeBackfill(partial)).toContain('3/10 window(s) done, 1 split, 6 pending');
  });

  it.each([
    ['COMPLETED', 0],
    // Not 0: a backfill that stopped early has not done what was asked, and a caller looping
    // until it finishes needs to be able to tell.
    ['INCOMPLETE', 2],
    ['FAILED', 2],
  ] as const)('exits %s -> %i', (status, expected) => {
    expect(backfillExitCode(outcome({ status }))).toBe(expected);
  });
});
