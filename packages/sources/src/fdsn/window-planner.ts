/**
 * Deterministic subdivision of a historical range into fetchable windows (P4.3).
 *
 * Pure: no clock, no IO, no randomness. The same range and the same limits always produce the
 * same list of windows in the same order, which is what lets a backfill be checkpointed, resumed
 * on another machine, and re-run without duplicating work.
 *
 * The properties that matter, and why:
 *
 *  - **Half-open windows** `[from, to)`. Adjacent windows share a boundary instant and neither
 *    claims it twice, so an event at exactly midnight is ingested once. (`fdsnQueryUrl` bridges
 *    this to FDSN's inclusive `endtime`.)
 *  - **They tile the range exactly.** No gap, no overlap, first `from` is the range's `from` and
 *    the last `to` is the range's `to` — asserted by a property test, because a one-millisecond
 *    gap would silently lose every earthquake in it.
 *  - **Splitting terminates.** A window at the minimum size is never split again. Instead the
 *    planner says so explicitly, because an over-limit window that cannot be divided is a real
 *    condition — a minute containing more than 20,000 events — and the honest response is to
 *    report it, not to loop.
 */

/** A half-open interval. */
export interface PlannedWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface WindowPlanOptions {
  /** Nominal window length before any splitting. */
  readonly windowMs: number;
  /** A window this small is never split further. */
  readonly minWindowMs: number;
}

export const DEFAULT_WINDOW_PLAN: WindowPlanOptions = {
  // A month of global M2.5+ is comfortably inside the 20,000-row limit; a month of *all*
  // magnitudes is not, which is why `splitWindow` exists rather than a cleverer initial guess.
  windowMs: 30 * 24 * 60 * 60 * 1000,
  // One minute. Below this a split cannot help: the limit is on rows, and no real minute of
  // seismicity approaches 20,000 events, so hitting this means something else is wrong.
  minWindowMs: 60 * 1000,
};

export class WindowPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowPlanError';
  }
}

/**
 * Tiles `[from, to)` into windows of at most `windowMs`.
 *
 * The final window is short rather than overshooting the range, so a backfill never asks for data
 * outside what was requested — which would make "the same range twice" write different rows the
 * second time.
 */
export function planWindows(
  from: Date,
  to: Date,
  options: WindowPlanOptions = DEFAULT_WINDOW_PLAN,
): readonly PlannedWindow[] {
  const start = from.getTime();
  const end = to.getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new WindowPlanError('the range endpoints must be real dates');
  }
  if (start >= end) {
    // An empty or inverted range is a caller error, not an empty plan: returning [] would let a
    // backfill of a mistyped range report success having done nothing.
    throw new WindowPlanError(
      `the range must be non-empty and forward: ${from.toISOString()} → ${to.toISOString()}`,
    );
  }
  if (options.windowMs < options.minWindowMs) {
    throw new WindowPlanError(
      `windowMs (${options.windowMs}) is smaller than minWindowMs (${options.minWindowMs})`,
    );
  }

  const windows: PlannedWindow[] = [];
  for (let cursor = start; cursor < end; cursor += options.windowMs) {
    windows.push({
      from: new Date(cursor),
      to: new Date(Math.min(cursor + options.windowMs, end)),
    });
  }
  return windows;
}

/**
 * Halves a window that the service refused as too large.
 *
 * Returns two half-open windows that tile the original exactly. Throws when the window is already
 * at the floor: that is the "impossible completion" case P4.3 asks to detect explicitly, and it
 * has to be an error rather than a silent give-up, because giving up quietly would leave a hole in
 * the catalogue that nothing would ever report.
 */
export function splitWindow(
  window: PlannedWindow,
  options: WindowPlanOptions = DEFAULT_WINDOW_PLAN,
): readonly [PlannedWindow, PlannedWindow] {
  const span = window.to.getTime() - window.from.getTime();
  if (span <= options.minWindowMs) {
    throw new WindowPlanError(
      `cannot split ${window.from.toISOString()} → ${window.to.toISOString()}: ` +
        `it is already at the ${options.minWindowMs} ms floor and the provider still refuses it`,
    );
  }

  // Integer midpoint, biased to the earlier half, so splitting is deterministic and a resumed
  // backfill recomputes exactly the same boundary.
  const midpoint = window.from.getTime() + Math.floor(span / 2);
  return [
    { from: window.from, to: new Date(midpoint) },
    { from: new Date(midpoint), to: window.to },
  ];
}

/** Total milliseconds a plan covers. Used to assert a plan tiles its range. */
export function planCoverageMs(windows: readonly PlannedWindow[]): number {
  return windows.reduce(
    (total, window) => total + (window.to.getTime() - window.from.getTime()),
    0,
  );
}

/**
 * Checks that a list of windows tiles `[from, to)` with no gap and no overlap.
 *
 * Exported because the orchestrator asserts it on every plan it persists: a plan is the thing a
 * resumed backfill trusts, and a plan with a hole in it produces a catalogue with a hole in it.
 */
export function describePlanDefect(
  windows: readonly PlannedWindow[],
  from: Date,
  to: Date,
): string | null {
  if (windows.length === 0) return 'the plan is empty';

  const first = windows[0];
  const last = windows[windows.length - 1];
  if (first === undefined || last === undefined) return 'the plan is empty';
  if (first.from.getTime() !== from.getTime()) {
    return `the plan starts at ${first.from.toISOString()}, not ${from.toISOString()}`;
  }
  if (last.to.getTime() !== to.getTime()) {
    return `the plan ends at ${last.to.toISOString()}, not ${to.toISOString()}`;
  }

  for (const [index, window] of windows.entries()) {
    if (window.from.getTime() >= window.to.getTime()) {
      return `window ${index} is empty or inverted: ${window.from.toISOString()} → ${window.to.toISOString()}`;
    }
    if (index === 0) continue;
    const previous = windows[index - 1];
    if (previous === undefined) continue;
    if (previous.to.getTime() !== window.from.getTime()) {
      return `windows ${index - 1} and ${index} do not meet: ${previous.to.toISOString()} then ${window.from.toISOString()}`;
    }
  }
  return null;
}
