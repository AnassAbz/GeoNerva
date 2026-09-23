/**
 * Code and database must agree about which feeds are live, and a disagreement must be said out
 * loud.
 *
 * This is the invariant activating EMSC taught us: enabling a source is two changes, the adapter
 * list and the `enabled` flag, and each direction of drift fails in its own quiet way. A
 * scheduled-but-disabled product is the worse one — `runIngestion` skips it before the run lease,
 * so there is no run row, no health evidence and no coverage, and the job does nothing for ever.
 */

import { describe, expect, it } from 'vitest';

import {
  describeSourceStateMismatch,
  findSourceStateMismatch,
  type ProductState,
} from './scheduled-sources.ts';
import { SCHEDULED_FEEDS } from './start.ts';

function product(
  over: Partial<ProductState> & Pick<ProductState, 'sourceId' | 'code'>,
): ProductState {
  return { enabled: true, status: 'ACTIVE', ...over };
}

const LIVE = new Set(['usgs', 'emsc', 'gdacs']);

describe('findSourceStateMismatch', () => {
  it('says nothing when the job list and the database agree', () => {
    const mismatch = findSourceStateMismatch(
      [
        { sourceId: 'usgs', productCode: 'comcat' },
        { sourceId: 'emsc', productCode: 'rts' },
      ],
      [product({ sourceId: 'usgs', code: 'comcat' }), product({ sourceId: 'emsc', code: 'rts' })],
      new Set(['usgs', 'emsc']),
    );

    expect(mismatch.scheduledButOff).toEqual([]);
    expect(mismatch.enabledButUnscheduled).toEqual([]);
    expect(describeSourceStateMismatch(mismatch)).toEqual([]);
  });

  it('names a product the build polls but the database has switched off', () => {
    const mismatch = findSourceStateMismatch(
      [{ sourceId: 'gdacs', productCode: 'FL' }],
      [product({ sourceId: 'gdacs', code: 'FL', enabled: false })],
      LIVE,
    );

    expect(mismatch.scheduledButOff).toEqual(['gdacs:FL (product disabled)']);
    expect(describeSourceStateMismatch(mismatch)[0]).toContain('will do nothing');
  });

  it('distinguishes a disabled source from a disabled product, because the fix differs', () => {
    const mismatch = findSourceStateMismatch(
      [{ sourceId: 'gdacs', productCode: 'FL' }],
      [product({ sourceId: 'gdacs', code: 'FL' })],
      new Set(['usgs']),
    );

    expect(mismatch.scheduledButOff).toEqual(['gdacs:FL (source disabled)']);
  });

  it('names a retired product, which is enabled and still must not be polled', () => {
    const mismatch = findSourceStateMismatch(
      [{ sourceId: 'firms', productCode: 'MODIS_SNPP' }],
      [product({ sourceId: 'firms', code: 'MODIS_SNPP', status: 'RETIRED' })],
      new Set(['firms']),
    );

    expect(mismatch.scheduledButOff).toEqual(['firms:MODIS_SNPP (retired)']);
  });

  it('names a product the build does not know about at all', () => {
    const mismatch = findSourceStateMismatch(
      [{ sourceId: 'gdacs', productCode: 'XX' }],
      [product({ sourceId: 'gdacs', code: 'FL' })],
      LIVE,
    );

    expect(mismatch.scheduledButOff).toEqual(['gdacs:XX (no such product)']);
  });

  /*
   * The other direction, and the one that made GDACS read UNAVAILABLE for six feeds: enabled in
   * the database, polled by nothing. Smoke check 2 catches this from outside; this is the inside
   * view, available before a single request is served.
   */
  it('names every product enabled in the database that nothing polls', () => {
    const mismatch = findSourceStateMismatch(
      [{ sourceId: 'gdacs', productCode: 'FL' }],
      [
        product({ sourceId: 'gdacs', code: 'FL' }),
        product({ sourceId: 'gdacs', code: 'TC' }),
        product({ sourceId: 'gdacs', code: 'VO' }),
      ],
      LIVE,
    );

    expect(mismatch.enabledButUnscheduled).toEqual(['gdacs:TC', 'gdacs:VO']);
    expect(describeSourceStateMismatch(mismatch)[0]).toContain('read UNAVAILABLE');
  });

  /*
   * Activating one GDACS family is exactly this shape: the source stays on, five products go off,
   * one is scheduled. It must read as agreement, or the warning would cry wolf on every
   * deliberate single-family activation and be ignored when it mattered.
   */
  it('treats one-family activation as agreement, not as drift', () => {
    const codes = ['EQ', 'FL', 'TC', 'WF', 'VO', 'DR'];
    const mismatch = findSourceStateMismatch(
      [{ sourceId: 'gdacs', productCode: 'FL' }],
      codes.map((code) => product({ sourceId: 'gdacs', code, enabled: code === 'FL' })),
      LIVE,
    );

    expect(mismatch.scheduledButOff).toEqual([]);
    expect(mismatch.enabledButUnscheduled).toEqual([]);
  });

  it('ignores a product whose source is switched off, in either direction', () => {
    const mismatch = findSourceStateMismatch(
      [],
      [product({ sourceId: 'firms', code: 'VIIRS_NOAA20_NRT' })],
      new Set(['usgs']),
    );

    /* The source is off; its products advertising themselves is not a drift to shout about. */
    expect(mismatch.enabledButUnscheduled).toEqual([]);
  });
});

/*
 * The check is only as good as the list it judges, and that list is where it went wrong.
 *
 * FIRMS is not a `SourceAdapter`, so it cannot live in `SCHEDULED_ADAPTERS`; the first version of
 * its scheduled job therefore never reached the drift check at all. The result was the exact
 * failure the check exists to prevent: FIRMS ingested 92,616 detections and produced 34,087
 * clusters while `sources.firms.enabled` was false, and start-up said nothing. A feed this worker
 * polls but does not declare here is invisible to the invariant.
 */
describe('SCHEDULED_FEEDS', () => {
  it('declares every feed the worker polls, including the ones that are not adapters', () => {
    const labels = SCHEDULED_FEEDS.map((feed) => `${feed.sourceId}:${feed.productCode}`);
    expect(labels).toContain('usgs:comcat');
    expect(labels).toContain('emsc:rts');
    expect(labels).toContain('gdacs:WF');
    /* The two that have no adapter, and that the first version of this list omitted. */
    expect(labels).toContain('firms:VIIRS_NOAA20_NRT');
    expect(labels).toContain('firms:VIIRS_NOAA21_NRT');
  });

  it('lists each feed once, so a duplicate cannot mask a missing one', () => {
    const labels = SCHEDULED_FEEDS.map((feed) => `${feed.sourceId}:${feed.productCode}`);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
