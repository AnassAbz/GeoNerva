/**
 * Argument parsing for `geonerva-worker run`.
 *
 * Worth testing on its own because the failure mode is quiet: a flag that is accepted and ignored
 * runs something other than what the operator asked for.
 */
import { describe, expect, it } from 'vitest';

import { AVAILABLE_SOURCES, describeOutcome, exitCodeFor, parseRunArgs } from './run-source.ts';
import type { RunOutcome } from '@geonerva/pipeline';

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  status: 'SUCCEEDED',
  runId: '0b6c5f1e-9a2d-4c37-8f11-000000000001',
  errorClass: null,
  detail: null,
  counts: {
    received: 230,
    accepted: 230,
    rejected: 0,
    newRecords: 12,
    newVersions: 30,
    unchanged: 200,
    mergedRecords: 0,
  },
  stageMs: { fetchMs: 1, parseMs: 2, normalizeMs: 3, persistMs: 4, totalMs: 10 },
  committedAt: new Date('2026-09-19T12:00:00.000Z'),
  ...over,
});

describe('parseRunArgs', () => {
  it('reads a source and a feed', () => {
    expect(parseRunArgs(['--source', 'usgs', '--feed', 'all_week'])).toMatchObject({
      source: 'usgs',
      feed: 'all_week',
      errors: [],
    });
  });

  it('requires a source', () => {
    expect(parseRunArgs([]).errors).toContain('--source is required');
  });

  it('refuses a source with no adapter instead of doing nothing quietly', () => {
    const parsed = parseRunArgs(['--source', 'firms']);
    expect(parsed.errors.join(' ')).toContain('unknown source: firms');
    expect(parsed.errors.join(' ')).toContain(AVAILABLE_SOURCES.join(', '));
  });

  it.each([
    [['--source'], '--source needs a value'],
    [['--source', '--feed', 'all_day'], '--source needs a value'],
    [['--source', 'usgs', '--dry-run'], 'unknown argument: --dry-run'],
  ])('refuses %j', (argv, expected) => {
    // An accepted-and-ignored flag is the dangerous case: the operator believes they asked for
    // something the worker never does.
    expect(parseRunArgs(argv).errors).toContain(expected);
  });

  it('allows --help without a source', () => {
    expect(parseRunArgs(['--help'])).toMatchObject({ help: true, errors: [] });
  });
});

describe('exitCodeFor', () => {
  it.each([
    ['HTTP_5XX', 0, 'the provider was down; we recorded that correctly'],
    ['TIMEOUT', 0, 'same'],
    ['SCHEMA_DRIFT', 0, 'the provider changed; the run row says so'],
    ['ABORTED', 0, 'we shut the worker down on purpose'],
    ['DB_ERROR', 0, 'recorded, and the next poll recovers'],
    ['CONFIG_ERROR', 1, 'our own misconfiguration, which never self-heals'],
  ] as const)('exits %s -> %i', (errorClass, expected) => {
    // A misconfigured deployment that exits 0 sits there looking healthy to its scheduler, and
    // CONFIG_ERROR is invisible in source health, so the exit code is the only signal left.
    expect(exitCodeFor(outcome({ status: 'FAILED', errorClass }))).toBe(expected);
  });

  it('exits 0 for a successful run', () => {
    expect(exitCodeFor(outcome())).toBe(0);
  });
});

describe('describeOutcome', () => {
  it('summarises what a successful run did', () => {
    expect(describeOutcome(outcome())).toBe(
      'SUCCEEDED in 10 ms — 230 accepted, 12 new, 30 versions, 200 unchanged, 0 rejected',
    );
  });

  it('gives the reason when a run failed', () => {
    const failed = outcome({ status: 'FAILED', errorClass: 'HTTP_5XX', detail: 'upstream 503' });
    expect(describeOutcome(failed)).toBe('FAILED in 10 ms — upstream 503');
  });
});
