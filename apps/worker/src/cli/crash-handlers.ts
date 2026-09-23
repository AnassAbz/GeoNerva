/**
 * Last-resort handlers for the two ways a long-running process dies without being asked
 * (security review **F-2b**, `docs/IMPLEMENTATION_PLAN.md` §3a).
 *
 * `main.ts` wraps its own `await` in a `try`/`catch`, which covers everything the command awaits.
 * It does not cover a rejection created outside that chain — a timer, an event handler, a floating
 * promise in a library — and it does not cover a synchronous throw on a later tick. Node handles
 * both by printing the value and exiting, and *printing the value* is precisely what
 * `describeUnexpectedError` exists to prevent: the worker's errors routinely carry connection
 * strings and API keys inside their messages.
 *
 * ### Why these handlers exit, explicitly
 *
 * Installing a handler for either event **suppresses Node's own exit**. That is the trap in this
 * pattern: a handler that logs and sets `process.exitCode` leaves the worker running on an event
 * loop whose state nobody can vouch for — still polling, still writing runs, after something went
 * wrong badly enough to escape every `catch` in the codebase. So each handler ends the process
 * itself. The supervisor restarts it, which is the honest recovery, and the run it abandoned is
 * released by its lease rather than by a tidy shutdown.
 *
 * `process.exit` truncates a pending asynchronous write, and container stdout is a pipe, so the
 * final line can be lost. It is written to **stderr** first for that reason — the crash line
 * matters more than the run lines still buffered behind it — and the alternative, waiting for a
 * drain that may never come while the process is broken, is worse.
 */

import { describeUnexpectedError } from './unexpected-error.ts';

/** `EX_SOFTWARE`, the same code `main.ts` uses for an unexpected throw. */
export const CRASH_EXIT_CODE = 70;

export interface CrashHandlerTarget {
  once: (event: string, listener: (value: unknown) => void) => unknown;
}

export interface CrashHandlerOptions {
  /** Where the description goes. Defaults to `console.error`, i.e. stderr. */
  readonly report?: (line: string) => void;
  /** How the process ends. Injected so the behaviour can be tested without ending the test run. */
  readonly exit?: (code: number) => void;
}

/**
 * Installs both handlers on `target`. Returns nothing: this is a process-level side effect, and a
 * handle would invite a caller to believe it could be taken back.
 *
 * `once` rather than `on`, because a second unhandled rejection while the first is being reported
 * says nothing new and would race the same exit.
 */
export function installCrashHandlers(
  target: CrashHandlerTarget,
  options: CrashHandlerOptions = {},
): void {
  const report =
    options.report ??
    ((line: string) => {
      console.error(line);
    });
  const exit = options.exit ?? ((code: number) => process.exit(code));

  target.once('unhandledRejection', (reason: unknown) => {
    report(`${describeUnexpectedError(reason)} (unhandled rejection)`);
    exit(CRASH_EXIT_CODE);
  });
  target.once('uncaughtException', (error: unknown) => {
    report(`${describeUnexpectedError(error)} (uncaught exception)`);
    exit(CRASH_EXIT_CODE);
  });
}
