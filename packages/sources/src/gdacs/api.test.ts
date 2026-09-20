/**
 * The GDACS fetch layer.
 *
 * A G5 reviewer noted that this whole module had **no tests at all** — not page termination, not
 * the `TOO_LARGE` refusals, not the cross-page dedupe, not the geometry cap, not `isAreaFeature` —
 * and that three of the phase's HIGH findings lived in exactly that gap. They are pure functions
 * over an injected `fetch`, so the gap was cost-free to close and expensive to leave.
 *
 * Every test here drives a counting responder, so what is asserted is the *sequence of requests*
 * as well as the answer: how many pages were walked, and whether a second one was asked for at all.
 */

import { describe, expect, it } from 'vitest';

import type { SourceFetchError } from '@geonerva/http';

import { createSourceClient } from '../contract.ts';
import { gdacsDescriptor } from './adapter.ts';
import {
  GDACS_MAX_PAGES,
  GDACS_PAGE_SIZE,
  gdacsFetchEventData,
  gdacsFetchGeometry,
  gdacsFetchList,
  isAreaFeature,
} from './api.ts';

const WINDOW = {
  from: new Date('2026-09-19T00:00:00Z'),
  to: new Date('2026-09-20T00:00:00Z'),
};

/** One list row, unique by event id so the dedupe has something to work on. */
function row(eventId: number): unknown {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [10, 20] },
    properties: { eventtype: 'WF', eventid: eventId, fromdate: '2026-09-19T00:00:00' },
  };
}

function page(ids: readonly number[]): Response {
  return new Response(JSON.stringify({ type: 'FeatureCollection', features: ids.map(row) }), {
    headers: { 'content-type': 'application/json' },
  });
}

/** A client whose answers are a function of which request number this is. */
function clientServing(responder: (url: URL, call: number) => Response): {
  client: ReturnType<typeof createSourceClient>;
  calls: URL[];
} {
  const calls: URL[] = [];
  const client = createSourceClient(gdacsDescriptor('WF'), {
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    jitter: () => 1,
    fetchImpl: ((input: string | URL) => {
      const url = new URL(input);
      calls.push(url);
      return Promise.resolve(responder(url, calls.length));
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

const range = (from: number, count: number): number[] =>
  Array.from({ length: count }, (_, index) => from + index);

describe('paging', () => {
  it('stops on a short page, and asks for no more', async () => {
    const { client, calls } = clientServing((_url, call) =>
      call === 1 ? page(range(1, GDACS_PAGE_SIZE)) : page(range(101, 58)),
    );
    const list = await gdacsFetchList(client, 'WF', WINDOW);

    expect(list.kind).toBe('LIST');
    if (list.kind !== 'LIST') return;
    expect(list.features).toHaveLength(158);
    expect(list.pagesRead).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('stops on a 204 and reports it as the status, without calling it malformed', async () => {
    // A 204 after a full page is the clean end of the walk.
    const { client } = clientServing((_url, call) =>
      call === 1 ? page(range(1, GDACS_PAGE_SIZE)) : new Response(null, { status: 204 }),
    );
    const list = await gdacsFetchList(client, 'WF', WINDOW);

    expect(list.kind).toBe('LIST');
    if (list.kind !== 'LIST') return;
    expect(list.features).toHaveLength(GDACS_PAGE_SIZE);
    expect(list.httpStatus).toBe(204);
  });

  it('treats a 200 with no body as malformed, not as "there is nothing"', async () => {
    /*
     * These were handled alike, so an empty or truncated 200 from a proxy read as "this product
     * has nothing" — and for FL, TC, VO and DR, whose `emptyBatchIsSuspicious` is false by
     * design, that commits SUCCEEDED with zero received. "Unavailable" rendered as "empty", for
     * four of six products.
     */
    const { client } = clientServing(
      () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const list = await gdacsFetchList(client, 'WF', WINDOW);
    expect(list.kind).toBe('MALFORMED');
  });

  it('deduplicates the same event across pages', async () => {
    // P0 saw page 1 and page 2 share 67 of 100 rows. Overlap is survivable; counting it twice
    // is not, because the identity would then produce two versions in one batch.
    const { client } = clientServing((_url, call) =>
      call === 1 ? page(range(1, GDACS_PAGE_SIZE)) : page([...range(50, 51), 999]),
    );
    const list = await gdacsFetchList(client, 'WF', WINDOW);

    if (list.kind !== 'LIST') throw new Error('expected a list');
    expect(list.features).toHaveLength(GDACS_PAGE_SIZE + 1);
    // `rows` keeps the pre-dedupe total, which is the only overlap evidence this API yields.
    expect(list.rows).toBe(GDACS_PAGE_SIZE + 52);
  });

  it('refuses when a full page adds nothing new, rather than calling it complete', async () => {
    /*
     * The HIGH finding. This returned the list as if it were whole, reasoning that "the sort has
     * looped, so more pages cannot help" — which is backwards. A page that is 100/100 duplicates
     * is the strongest evidence that the unstable sort is overlapping *and skipping*, so it is
     * the moment to be least confident. On such a day it committed 100 wildfires as a complete
     * catalogue when there were 258, with nothing reporting the 158 that were missing.
     */
    const { client } = clientServing(() => page(range(1, GDACS_PAGE_SIZE)));
    await expect(gdacsFetchList(client, 'WF', WINDOW)).rejects.toThrow(/looped/);

    let thrown: unknown;
    try {
      await gdacsFetchList(client, 'WF', WINDOW);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as SourceFetchError).errorClass).toBe('TOO_LARGE');
  });

  it('refuses when pages are still full at the cap', async () => {
    let id = 1;
    const { client, calls } = clientServing(() => {
      const ids = range(id, GDACS_PAGE_SIZE);
      id += GDACS_PAGE_SIZE;
      return page(ids);
    });
    await expect(gdacsFetchList(client, 'WF', WINDOW)).rejects.toThrow(/still full/);
    expect(calls).toHaveLength(GDACS_MAX_PAGES);
  });

  it('hands a page that is not a feature collection back untouched', async () => {
    // So `parse` fails it as SCHEMA_DRIFT with the provider's own bytes as the evidence — which
    // is where the captured HTML-with-200 maintenance page belongs.
    const html = '<html><body>maintenance</body></html>';
    const { client } = clientServing(
      () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    );
    const list = await gdacsFetchList(client, 'WF', WINDOW);

    expect(list.kind).toBe('MALFORMED');
    if (list.kind !== 'MALFORMED') return;
    expect(new TextDecoder().decode(list.body)).toBe(html);
    expect(list.page).toBe(1);
  });

  it('keeps a feature with no usable identity rather than dropping it', async () => {
    /*
     * It cannot be deduplicated, and it will fail validation in `parse` and become a counted
     * reject with a reason. Dropping it here would make it vanish between the provider and the
     * reject count, and "nothing is skipped silently" is the rule the whole contract rests on.
     */
    const { client } = clientServing(
      () =>
        new Response(
          JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature' }, row(1)] }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const list = await gdacsFetchList(client, 'WF', WINDOW);
    if (list.kind !== 'LIST') throw new Error('expected a list');
    expect(list.features).toHaveLength(2);
  });
});

describe('the detail and geometry passes', () => {
  it('returns null for a detail the provider will not give, rather than throwing', async () => {
    // The list row is a complete record on its own; the detail only ever *adds* the upstream id.
    // Failing an earthquake because its optional enrichment 500ed would lose a real event.
    const { client } = clientServing(() => new Response('nope', { status: 500 }));
    expect(await gdacsFetchEventData(client, 'EQ', 1)).toBeNull();
  });

  it('separates "no area" from "an area too large to keep"', async () => {
    /*
     * The honesty case. P0 measured one flood episode's geometry at 1.8 MB, so a cap is
     * necessary — but dropping the *flag* with the shape would turn a decision about our storage
     * into a statement about the provider's data, and the flood would be described as having no
     * modelled area at all.
     */
    const polygon = {
      type: 'Feature',
      properties: { Class: 'Poly_Affected' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 20],
            [11, 20],
            [11, 21],
            [10, 20],
          ],
        ],
      },
    };
    const centroidOnly = {
      type: 'Feature',
      properties: { Class: 'Point_Centroid' },
      geometry: { type: 'Point', coordinates: [10, 20] },
    };

    const small = clientServing(
      () =>
        new Response(
          JSON.stringify({ type: 'FeatureCollection', features: [centroidOnly, polygon] }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    expect(await gdacsFetchGeometry(small.client, 'FL', 1, 2)).toStrictEqual({
      hasArea: true,
      features: [polygon],
      oversized: false,
    });

    const none = clientServing(
      () =>
        new Response(JSON.stringify({ type: 'FeatureCollection', features: [centroidOnly] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await gdacsFetchGeometry(none.client, 'FL', 1, 2)).toStrictEqual({
      hasArea: false,
      features: [],
      oversized: false,
    });

    // Padded past the 512 KB cap with a member nothing reads, so only the size differs.
    const big = clientServing(
      () =>
        new Response(
          JSON.stringify({
            type: 'FeatureCollection',
            features: [polygon],
            note: 'x'.repeat(600 * 1024),
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(await gdacsFetchGeometry(big.client, 'FL', 1, 2)).toStrictEqual({
      hasArea: true,
      features: [],
      oversized: true,
    });
  });

  it('returns null when the question could not be asked at all', async () => {
    // Which is a different fact from `hasArea: false`, and `normalize` turns it into a reject.
    const { client } = clientServing(() => new Response(null, { status: 204 }));
    expect(await gdacsFetchGeometry(client, 'FL', 1, 2)).toBeNull();
  });
});

describe('isAreaFeature', () => {
  const polygonOf = (cls: string | undefined): unknown => ({
    type: 'Feature',
    ...(cls === undefined ? {} : { properties: { Class: cls } }),
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [10, 20],
          [11, 20],
          [11, 21],
          [10, 20],
        ],
      ],
    },
  });

  it('admits any Poly_ class, because an unseen polygon is still an area', () => {
    expect(isAreaFeature(polygonOf('Poly_Affected'))).toBe(true);
    expect(isAreaFeature(polygonOf('Poly_Global'))).toBe(true);
    expect(isAreaFeature(polygonOf('Poly_area'))).toBe(true);
    // A class this code has never seen. Treating an unknown polygon as "no area" would be the
    // wrong default for a flood; *what role to store it under* is a separate, closed decision.
    expect(isAreaFeature(polygonOf('Poly_Something_New'))).toBe(true);
  });

  it('refuses a point and a non-geometry', () => {
    expect(
      isAreaFeature({
        type: 'Feature',
        properties: { Class: 'Point_Centroid' },
        geometry: { type: 'Point', coordinates: [10, 20] },
      }),
    ).toBe(false);
    expect(isAreaFeature({ type: 'Feature', geometry: null })).toBe(false);
    expect(isAreaFeature(null)).toBe(false);
    expect(isAreaFeature('nope')).toBe(false);
  });
});
