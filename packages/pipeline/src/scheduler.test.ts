/**
 * The poll loop, the jitter and the circuit breaker.
 *
 * Everything is injected — sleeper, clock, randomness — so a fifteen-minute probe interval is
 * asserted rather than waited for, and the breaker's behaviour is deterministic.
 */
import { describe, expect, it, vi } from 'vitest';

import { createMemoryLogger } from './logging.ts';
import {
  DEFAULT_BREAKER,
  countsAsFailure,
  jitteredDelay,
  runScheduler,
  type ScheduledJob,
} from './scheduler.ts';
import type { RunOutcome } from './run.ts';

const EMPTY_COUNTS = {
  received: 0,
  accepted: 0,
  rejected: 0,
  newRecords: 0,
  newVersions: 0,
  unchanged: 0,
  mergedRecords: 0,
};

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    status: 'SUCCEEDED',
    runId: 'r1',
    errorClass: null,
    detail: null,
    counts: EMPTY_COUNTS,
    stageMs: { fetchMs: 1, parseMs: 1, normalizeMs: 1, persistMs: 1, totalMs: 4 },
    committedAt: new Date('2026-09-19T12:00:00.000Z'),
    httpStatus: 200,
    ...over,
  };
}

/** Records what the scheduler asked to wait for, and never actually waits. */
function recordingSleeper(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe('jitteredDelay', () => {
  it.each([
    [0, 270_000],
    [0.5, 300_000],
    [1, 330_000],
  ])('spreads a 5-minute interval by ±10 %% (random=%p → %p ms)', (random, expected) => {
    expect(jitteredDelay(300_000, 0.1, random)).toBe(expected);
  });

  it('never returns a negative delay', () => {
    expect(jitteredDelay(1_000, 0.5, 0)).toBe(500);
    expect(jitteredDelay(0, 0.5, 0)).toBe(0);
  });
});

describe('countsAsFailure', () => {
  it.each([
    ['SUCCEEDED', null, false],
    ['PARTIAL', null, false],
    // The provider answered and nothing had changed. That is a healthy source.
    ['SKIPPED', null, false],
    ['LEASE_HELD', null, false],
    ['FAILED', 'HTTP_5XX', true],
    ['FAILED', 'SCHEMA_DRIFT', true],
    // A deploy cancelled the run. Counting it would open the breaker on every restart.
    ['FAILED', 'ABORTED', false],
  ] as const)('%s/%s counts as failure: %s', (status, errorClass, expected) => {
    expect(countsAsFailure(outcome({ status, errorClass }))).toBe(expected);
  });
});

describe('runScheduler', () => {
  it('polls on the configured interval with jitter', async () => {
    const { delays, sleep } = recordingSleeper();
    const run = vi.fn(() => Promise.resolve(outcome()));
    const job: ScheduledJob = { name: 'usgs:comcat', intervalMs: 300_000, jitterRatio: 0.1, run };

    const [summary] = await runScheduler({
      jobs: [job],
      signal: new AbortController().signal,
      logger: createMemoryLogger(),
      sleep,
      random: () => 0.5,
      maxIterations: 3,
    });

    expect(run).toHaveBeenCalledTimes(3);
    // The first poll is within the jitter window so a deploy starts working immediately; the
    // rest are on the interval.
    expect(delays).toStrictEqual([15_000, 300_000, 300_000]);
    expect(summary).toMatchObject({ runs: 3, failures: 0, breakerOpen: false });
  });

  it('backs off to the probe interval after five consecutive failures', async () => {
    const { delays, sleep } = recordingSleeper();
    const run = vi.fn(() => Promise.resolve(outcome({ status: 'FAILED', errorClass: 'HTTP_5XX' })));
    const logger = createMemoryLogger();

    const [summary] = await runScheduler({
      jobs: [{ name: 'usgs:comcat', intervalMs: 300_000, jitterRatio: 0, run }],
      signal: new AbortController().signal,
      logger,
      sleep,
      random: () => 0.5,
      maxIterations: 7,
    });

    // A prompt first poll, four more on the interval, then the breaker opens.
    expect(delays.slice(0, 5)).toStrictEqual([0, 300_000, 300_000, 300_000, 300_000]);
    expect(delays.slice(5)).toStrictEqual([
      DEFAULT_BREAKER.probeIntervalMs,
      DEFAULT_BREAKER.probeIntervalMs,
    ]);
    expect(summary?.breakerOpen).toBe(true);
    expect(logger.entries.map((entry) => entry.event)).toContain('scheduler.breaker_open');
  });

  it('closes the breaker as soon as the source answers again', async () => {
    const { delays, sleep } = recordingSleeper();
    let call = 0;
    const run = vi.fn(() => {
      call += 1;
      return Promise.resolve(
        call <= 5 ? outcome({ status: 'FAILED', errorClass: 'HTTP_5XX' }) : outcome(),
      );
    });
    const logger = createMemoryLogger();

    const [summary] = await runScheduler({
      jobs: [{ name: 'usgs:comcat', intervalMs: 300_000, jitterRatio: 0, run }],
      signal: new AbortController().signal,
      logger,
      sleep,
      random: () => 0.5,
      maxIterations: 7,
    });

    expect(delays[5], 'the sixth poll is a probe').toBe(DEFAULT_BREAKER.probeIntervalMs);
    expect(delays[6], 'and after it succeeds, back to the normal interval').toBe(300_000);
    expect(summary?.breakerOpen).toBe(false);
    expect(logger.entries.map((entry) => entry.event)).toContain('scheduler.breaker_closed');
  });

  it('keeps polling after a job throws', async () => {
    // Reaching here means something outside the run lifecycle broke, most likely the database.
    // A worker that exits on the first blip stops polling every other source too.
    const { sleep } = recordingSleeper();
    let call = 0;
    const run = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('connection terminated'));
      return Promise.resolve(outcome());
    });
    const logger = createMemoryLogger();

    const [summary] = await runScheduler({
      jobs: [{ name: 'usgs:comcat', intervalMs: 1_000, jitterRatio: 0, run }],
      signal: new AbortController().signal,
      logger,
      sleep,
      maxIterations: 3,
    });

    expect(run).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ runs: 3, failures: 1 });
    expect(logger.entries.map((entry) => entry.event)).toContain('scheduler.job_threw');
  });

  it('stops every loop when the signal aborts, and only then resolves', async () => {
    const controller = new AbortController();
    const run = vi.fn(() => {
      controller.abort();
      return Promise.resolve(outcome());
    });
    const { sleep } = recordingSleeper();

    const summaries = await runScheduler({
      jobs: [
        { name: 'a', intervalMs: 1_000, jitterRatio: 0, run },
        { name: 'b', intervalMs: 1_000, jitterRatio: 0, run },
      ],
      signal: controller.signal,
      logger: createMemoryLogger(),
      sleep,
    });

    // Resolving only once both loops have stopped is what lets the caller close the pool safely.
    expect(summaries).toHaveLength(2);
    expect(summaries.every((summary) => summary.runs <= 1)).toBe(true);
  });

  it('beats the heartbeat on its own schedule, and survives it failing', async () => {
    const { sleep } = recordingSleeper();
    const beats: Date[] = [];
    let call = 0;
    const logger = createMemoryLogger();

    await runScheduler({
      jobs: [
        { name: 'a', intervalMs: 1_000, jitterRatio: 0, run: () => Promise.resolve(outcome()) },
      ],
      signal: new AbortController().signal,
      logger,
      sleep,
      now: () => new Date('2026-09-19T12:00:00.000Z'),
      heartbeat: (at) => {
        call += 1;
        if (call === 1) return Promise.reject(new Error('database unreachable'));
        beats.push(at);
        return Promise.resolve();
      },
      maxIterations: 3,
    });

    expect(call).toBe(3);
    expect(beats).toHaveLength(2);
    expect(logger.entries.map((entry) => entry.event)).toContain('scheduler.heartbeat_failed');
  });
});
