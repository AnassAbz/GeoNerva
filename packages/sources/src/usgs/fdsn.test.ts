/**
 * The FDSN query layer and the window planner.
 *
 * Both are pure, so these run without a network. The captured P0 fixtures are what make them
 * worth trusting: the count-over-limit body, the 400 and 503 bodies, and the deletion sweep whose
 * majority of entries carry no identity at all.
 */
import { describe, expect, it } from 'vitest';

import { SourceFetchError } from '@geonerva/http';
import { readFixtureBytes, readFixtureText } from '@geonerva/test-fixtures';

import {
  FDSN_MAX_ROWS,
  FdsnQueryError,
  fdsnCountUrl,
  fdsnQueryUrl,
  isWindowTooLarge,
  parseDeletionSweep,
  parseFdsnCount,
} from './fdsn.ts';
import {
  DEFAULT_WINDOW_PLAN,
  WindowPlanError,
  describePlanDefect,
  planCoverageMs,
  planWindows,
  splitWindow,
} from '../fdsn/window-planner.ts';

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-02-01T00:00:00.000Z');

describe('query construction', () => {
  it('builds a bounded, closed parameter set', () => {
    const url = new URL(fdsnQueryUrl({ from: FROM, to: TO, minMagnitude: 2.5 }));
    expect(url.host).toBe('earthquake.usgs.gov');
    expect(url.pathname).toBe('/fdsnws/event/1/query');
    expect([...url.searchParams.keys()].sort()).toStrictEqual([
      'endtime',
      'format',
      'minmagnitude',
      'orderby',
      'starttime',
    ]);
    expect(url.searchParams.get('format')).toBe('geojson');
    expect(url.searchParams.get('orderby')).toBe('time-asc');
  });

  it('bridges our half-open window to FDSN’s inclusive endtime', () => {
    // Ours is [from, to); theirs is closed. Without the one-millisecond shift two adjacent
    // windows would both claim an event at exactly the boundary.
    const url = new URL(fdsnQueryUrl({ from: FROM, to: TO }));
    expect(url.searchParams.get('starttime')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('endtime')).toBe('2026-01-31T23:59:59.999Z');
  });

  it('asks for deletions only when told to', () => {
    expect(new URL(fdsnQueryUrl({ from: FROM, to: TO })).searchParams.has('includedeleted')).toBe(
      false,
    );
    expect(
      new URL(fdsnQueryUrl({ from: FROM, to: TO }, 'deleted-only')).searchParams.get(
        'includedeleted',
      ),
    ).toBe('only');
  });

  it('points the count endpoint at the same question', () => {
    const query = new URL(fdsnQueryUrl({ from: FROM, to: TO, minMagnitude: 4.5 }));
    const count = new URL(fdsnCountUrl({ from: FROM, to: TO, minMagnitude: 4.5 }));
    expect(count.pathname).toBe('/fdsnws/event/1/count');
    // A count that asked a different question than the fetch would be worse than no count.
    expect(count.search).toBe(query.search);
  });

  it.each([
    ['an inverted range', { from: TO, to: FROM }],
    ['an empty range', { from: FROM, to: FROM }],
    ['an invalid date', { from: new Date(Number.NaN), to: TO }],
    ['an impossible magnitude', { from: FROM, to: TO, minMagnitude: 99 }],
  ])('refuses %s before it reaches the network', (_name, window) => {
    expect(() => fdsnQueryUrl(window)).toThrow(FdsnQueryError);
  });
});

describe('the count endpoint', () => {
  it('reads the real over-limit answer, which arrives as HTTP 200', () => {
    // The trap: a client checking only the status code would read this as a successful count.
    const count = parseFdsnCount(readFixtureBytes('usgs', 'fdsn-count-over-limit.json'));
    expect(count.count).toBe(101_674);
    expect(count.maxAllowed).toBe(FDSN_MAX_ROWS);
    expect(count.overLimit).toBe(true);
  });

  it('accepts a normal count', () => {
    const body = new TextEncoder().encode(JSON.stringify({ count: 1234, maxAllowed: 20000 }));
    expect(parseFdsnCount(body)).toStrictEqual({
      count: 1234,
      maxAllowed: 20_000,
      overLimit: false,
    });
  });

  it('treats a count above the limit as over-limit even with no error field', () => {
    const body = new TextEncoder().encode(JSON.stringify({ count: 20_001, maxAllowed: 20_000 }));
    expect(parseFdsnCount(body).overLimit).toBe(true);
  });

  it.each([
    ['HTML instead of JSON', '<html>maintenance</html>'],
    ['a missing count', '{"maxAllowed":20000}'],
    ['a count of the wrong type', '{"count":"lots"}'],
  ])('fails loudly on %s', (_name, text) => {
    expect(() => parseFdsnCount(new TextEncoder().encode(text))).toThrow(FdsnQueryError);
  });
});

describe('recognising a window that is too large', () => {
  const failure = (status: number): SourceFetchError =>
    new SourceFetchError('HTTP_4XX', 'upstream refused', {
      host: 'earthquake.usgs.gov',
      status,
    });

  it('recognises the documented 400', () => {
    expect(isWindowTooLarge(failure(400), readFixtureText('usgs', 'fdsn-over-20k-400.txt'))).toBe(
      true,
    );
  });

  it('recognises the 503 that P0 actually observed', () => {
    // An open-ended query from 2000-01-01 answered "table is full". It means the same thing to a
    // caller holding a splittable window, and retrying it three times would just waste the run.
    expect(isWindowTooLarge(failure(503), 'Error 503: Service Unavailable\n\ntable is full')).toBe(
      true,
    );
  });

  it('does not mistake an ordinary 400 for a window problem', () => {
    // A 400 for a bad parameter is our bug. Splitting the window would hide it forever.
    expect(isWindowTooLarge(failure(400), 'Error 400: unknown parameter [magtype]')).toBe(false);
  });

  it('does not mistake an ordinary outage for a window problem', () => {
    expect(isWindowTooLarge(failure(503), 'Error 503: Service Unavailable')).toBe(false);
    expect(isWindowTooLarge(failure(500), 'table is full')).toBe(false);
  });
});

describe('the deletion sweep', () => {
  it('keeps the deletions it can identify and counts the ones it cannot', () => {
    /*
     * The finding this test exists for: in the real capture, 55 of 98 deleted events have an
     * empty `id` and null `ids`, `net` and `code`. USGS purges the metadata, leaving time and
     * geometry. There is no way to know which record those were.
     *
     * They are counted, not skipped, and not guessed at. Running them past the ordinary 20 %
     * reject threshold would fail every sweep, because 56 % is the normal case here.
     */
    const sweep = parseDeletionSweep(readFixtureBytes('usgs', 'fdsn-includedeleted-only.geojson'));
    expect(sweep.deletions).toHaveLength(43);
    expect(sweep.unidentifiable).toBe(55);
    expect(sweep.deletions.length + sweep.unidentifiable).toBe(98);
  });

  it('carries the alias set, so the right record is tombstoned', () => {
    const sweep = parseDeletionSweep(readFixtureBytes('usgs', 'fdsn-includedeleted-only.geojson'));
    const first = sweep.deletions[0];
    expect(first).toBeDefined();
    expect(first?.aliases).toContain(first?.primaryKey);
    expect(first?.observedAt.getTime()).toBeGreaterThan(0);
  });

  it('calls a sweep that can tombstone nothing drift, not a quiet day', () => {
    // If every deletion lost its identity we would be blind to deletions entirely. That is worth
    // failing over; silently reporting "0 tombstones" would look like there were none.
    const body = new TextEncoder().encode(
      JSON.stringify({
        type: 'FeatureCollection',
        metadata: { count: 2 },
        features: [
          {
            type: 'Feature',
            id: '',
            properties: { time: 1, updated: null, ids: null, status: 'deleted' },
          },
          {
            type: 'Feature',
            id: '',
            properties: { time: 2, updated: null, ids: null, status: 'deleted' },
          },
        ],
      }),
    );
    expect(() => parseDeletionSweep(body)).toThrow(/blind to deletions/);
  });

  it('accepts an empty sweep, because no deletions is a real answer', () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ type: 'FeatureCollection', metadata: { count: 0 }, features: [] }),
    );
    expect(parseDeletionSweep(body)).toStrictEqual({ deletions: [], unidentifiable: 0 });
  });
});

describe('the window planner', () => {
  it('tiles a range exactly, with no gap and no overlap', () => {
    const windows = planWindows(FROM, TO);
    expect(describePlanDefect(windows, FROM, TO)).toBeNull();
    expect(planCoverageMs(windows)).toBe(TO.getTime() - FROM.getTime());
  });

  it('ends on the requested instant rather than overshooting it', () => {
    // Overshooting would make "the same range twice" ingest different rows the second time.
    const to = new Date('2026-02-05T00:00:00.000Z');
    const windows = planWindows(FROM, to);
    expect(windows.at(-1)?.to).toStrictEqual(to);
  });

  it('is deterministic', () => {
    expect(planWindows(FROM, TO)).toStrictEqual(planWindows(FROM, TO));
  });

  it.each([
    ['an inverted range', TO, FROM],
    ['an empty range', FROM, FROM],
  ])('refuses %s rather than returning an empty plan', (_name, from, to) => {
    // An empty plan would let a backfill of a mistyped range report success having done nothing.
    expect(() => planWindows(from, to)).toThrow(WindowPlanError);
  });

  it('splits a window into two halves that tile it', () => {
    const window = { from: FROM, to: TO };
    const [left, right] = splitWindow(window);
    expect(left.from).toStrictEqual(FROM);
    expect(right.to).toStrictEqual(TO);
    expect(left.to).toStrictEqual(right.from);
    expect(describePlanDefect([left, right], FROM, TO)).toBeNull();
  });

  it('splits deterministically, so a resumed backfill recomputes the same boundary', () => {
    const window = { from: FROM, to: new Date(FROM.getTime() + 999_999) };
    expect(splitWindow(window)).toStrictEqual(splitWindow(window));
  });

  it('refuses to split below the floor instead of looping forever', () => {
    const window = { from: FROM, to: new Date(FROM.getTime() + DEFAULT_WINDOW_PLAN.minWindowMs) };
    // An over-limit window that cannot be divided is a real condition, and reporting it is the
    // only honest response: giving up quietly would leave a hole nothing would ever mention.
    expect(() => splitWindow(window)).toThrow(/already at the .* floor/);
  });

  it('terminates when a range is split repeatedly', () => {
    // Guards the recursion the orchestrator performs: halving must reach the floor, not approach
    // it asymptotically.
    let windows = [{ from: FROM, to: new Date(FROM.getTime() + 60 * 60 * 1000) }];
    let rounds = 0;
    while (rounds < 100) {
      const next: typeof windows = [];
      let split = false;
      for (const window of windows) {
        const span = window.to.getTime() - window.from.getTime();
        if (span > DEFAULT_WINDOW_PLAN.minWindowMs) {
          next.push(...splitWindow(window));
          split = true;
        } else next.push(window);
      }
      windows = next;
      rounds += 1;
      if (!split) break;
    }
    expect(rounds).toBeLessThan(100);
    expect(describePlanDefect(windows, FROM, new Date(FROM.getTime() + 60 * 60 * 1000))).toBeNull();
  });

  it.each([
    [
      'a gap',
      [
        { from: 0, to: 10 },
        { from: 11, to: 20 },
      ],
      /do not meet/,
    ],
    [
      'an overlap',
      [
        { from: 0, to: 12 },
        { from: 10, to: 20 },
      ],
      /do not meet/,
    ],
    ['a wrong start', [{ from: 5, to: 20 }], /starts at/],
    ['a wrong end', [{ from: 0, to: 15 }], /ends at/],
    [
      'an inverted window',
      [
        { from: 0, to: 20 },
        { from: 20, to: 20 },
      ],
      /empty or inverted/,
    ],
  ])('describes %s in a plan', (_name, raw, pattern) => {
    const windows = raw.map((w) => ({ from: new Date(w.from), to: new Date(w.to) }));
    const defect = describePlanDefect(windows, new Date(0), new Date(20));
    expect(defect).toMatch(pattern);
  });
});
