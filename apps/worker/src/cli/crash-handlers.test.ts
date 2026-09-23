/**
 * F-2b: a crash must not print what `describeUnexpectedError` exists to withhold, and it must end
 * the process rather than leave it running on an event loop nobody can vouch for.
 */

import { describe, expect, it, vi } from 'vitest';

import { CRASH_EXIT_CODE, installCrashHandlers } from './crash-handlers.ts';

/** A stand-in for `process` that records its listeners instead of installing them. */
function fakeProcess() {
  const listeners = new Map<string, (value: unknown) => void>();
  return {
    once(event: string, listener: (value: unknown) => void) {
      listeners.set(event, listener);
      return this;
    },
    emit(event: string, value: unknown) {
      const listener = listeners.get(event);
      if (listener === undefined) throw new Error(`no listener for ${event}`);
      listener(value);
    },
    events: () => [...listeners.keys()],
  };
}

const SECRET_URL = 'postgresql://geonerva:hunter2@db.example.com:5432/geonerva';

describe('installCrashHandlers', () => {
  it('handles both ways a process dies unasked', () => {
    const target = fakeProcess();
    installCrashHandlers(target, { report: () => undefined, exit: () => undefined });
    expect(target.events()).toEqual(['unhandledRejection', 'uncaughtException']);
  });

  for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
    it(`withholds the message of an ${event} and exits ${String(CRASH_EXIT_CODE)}`, () => {
      const target = fakeProcess();
      const report = vi.fn<(line: string) => void>();
      const exit = vi.fn<(code: number) => void>();
      installCrashHandlers(target, { report, exit });

      target.emit(event, new Error(`connect failed: ${SECRET_URL}`));

      const line = report.mock.calls[0]?.[0] ?? '';
      expect(line).toContain('Error');
      expect(line).not.toContain('hunter2');
      expect(line).not.toContain('db.example.com');
      /* The reader is told which of the two happened; they are diagnosed differently. */
      expect(line).toContain(event === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught');
      expect(exit).toHaveBeenCalledWith(CRASH_EXIT_CODE);
    });
  }

  it('withholds a rejection that is not an Error at all', () => {
    const target = fakeProcess();
    const report = vi.fn<(line: string) => void>();
    installCrashHandlers(target, { report, exit: () => undefined });

    target.emit('unhandledRejection', SECRET_URL);

    const line = report.mock.calls[0]?.[0] ?? '';
    expect(line).not.toContain('hunter2');
  });

  /*
   * The trap this file exists to avoid: a handler that only sets `process.exitCode` suppresses
   * Node's own exit, so the worker keeps polling after something escaped every `catch` in the
   * codebase. Exiting is the behaviour, and it is asserted rather than assumed.
   */
  it('does not leave the process running after a crash', () => {
    const target = fakeProcess();
    const exit = vi.fn<(code: number) => void>();
    installCrashHandlers(target, { report: () => undefined, exit });

    target.emit('uncaughtException', new Error('boom'));

    expect(exit).toHaveBeenCalledTimes(1);
  });
});
