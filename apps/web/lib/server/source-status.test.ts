/**
 * `buildSourceStatus` — the `/data-status` assembly.
 *
 * This is the response that makes GeoNerva's central promise checkable, so the tests are written
 * as the ways a status page lies:
 *
 *  - **A false green.** A source with no runs reporting `FRESH`; a success rate of 100 % from one
 *    run with no denominator beside it; a rate of `0` where there was no rate at all.
 *  - **An averaged rollup.** A source whose tsunami feed is dead reading "mostly fine" because its
 *    earthquake feed is healthy.
 *  - **A fabricated check.** Five `status: 'OK'` data-quality rows with nothing computing them.
 *  - **A citation that does not resolve.** An `evidenceId` in the body with no manifest entry
 *    (invariant I9).
 *  - **A replayed heartbeat measured against the wrong clock**, reporting every historical
 *    heartbeat as stale.
 *
 * Every input here is fabricated rather than read, which is the point of the module being pure: the
 * cases below — a source with no products, a product with no health, an unknown enum value — are
 * ones a seeded database cannot easily produce.
 */

import { describe, expect, it } from 'vitest';

import { replayHorizonFor } from '@geonerva/briefing';
import type { FreshnessPolicy, SourceHealthStatus } from '@geonerva/domain';

import type {
  AttributionRow,
  EvidenceRow,
  RunSummaryRow,
  SourceHealthAsOf,
  SourceProductRow,
  SourceRow,
} from './db.ts';
import {
  WORKER_HEARTBEAT_INTERVAL_S,
  WORKER_HEARTBEAT_STALE_AFTER_S,
  buildSourceStatus,
  evidenceIdsFor,
  type SourceStatusInput,
} from './source-status.ts';

const AS_OF = new Date('2026-09-21T12:00:00.000Z');
const GENERATED_AT = new Date('2026-09-21T12:00:01.000Z');
const RUN_UUID = '0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77';
const OTHER_RUN_UUID = '1c7d6a2f-0b3e-4d48-9a22-7f3b0d1e5c88';

const POLICY: FreshnessPolicy = {
  pollIntervalS: 300,
  fetchFreshWithinS: 900,
  fetchStaleAfterS: 3600,
  unavailableAfterS: 86_400,
  dataCurrentWithinS: 3600,
  dataStaleAfterS: 86_400,
  quietIsNormal: true,
};

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    source_id: 'usgs',
    name: 'USGS Earthquake Hazards Program',
    homepage: 'https://earthquake.usgs.gov',
    licence: 'Public domain (U.S. Government work)',
    attribution_text: 'Earthquake data courtesy of the U.S. Geological Survey.',
    terms_url: 'https://www.usgs.gov/laws',
    disclaimer: null,
    coverage_note: 'Complete from about M4.5 outside the United States.',
    coverage_geometry_available: false,
    enabled: true,
    ...overrides,
  };
}

function product(overrides: Partial<SourceProductRow> = {}): SourceProductRow {
  return {
    product_id: 1,
    source_id: 'usgs',
    code: 'comcat_all_day',
    hazard_types: ['EARTHQUAKE'],
    capabilities: ['EVENT_REVISIONS'],
    platform: null,
    instrument: null,
    resolution_m: null,
    status: 'ACTIVE',
    active_from: '2016-01-01',
    active_to: null,
    enabled: true,
    ...overrides,
  };
}

function health(overrides: Partial<SourceHealthAsOf> = {}): SourceHealthAsOf {
  return {
    sourceId: 'usgs',
    productId: 1,
    status: 'FRESH',
    lastAttemptAt: new Date('2026-09-21T11:55:00.000Z'),
    lastSuccessAt: new Date('2026-09-21T11:55:00.000Z'),
    newestObservedAt: new Date('2026-09-21T11:40:00.000Z'),
    consecutiveFailures: 0,
    lastErrorClass: null,
    expected: POLICY,
    evidenceId: `EV:RUN:${RUN_UUID}`,
    reasons: ['OK'],
    asOf: AS_OF,
    productCode: 'comcat_all_day',
    ...overrides,
  };
}

function run(overrides: Partial<RunSummaryRow> = {}): RunSummaryRow {
  return {
    id: RUN_UUID,
    source_id: 'usgs',
    product_id: 1,
    trigger: 'SCHEDULE',
    status: 'SUCCEEDED',
    started_at: new Date('2026-09-21T11:55:00.000Z'),
    finished_at: new Date('2026-09-21T11:55:04.000Z'),
    committed_at: new Date('2026-09-21T11:55:05.000Z'),
    n_received: 230,
    n_new_records: 3,
    n_new_versions: 5,
    n_unchanged: 222,
    n_rejected: 0,
    newest_observed_at: new Date('2026-09-21T11:40:00.000Z'),
    error_class: null,
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: `EV:RUN:${RUN_UUID}`,
    kind: 'RUN',
    summary: 'usgs ingestion run, SUCCEEDED',
    source_id: 'usgs',
    product_id: 1,
    observed_at: new Date('2026-09-21T11:40:00.000Z'),
    ingested_at: new Date('2026-09-21T11:55:05.000Z'),
    url: null,
    ...overrides,
  };
}

const ATTRIBUTION: AttributionRow = {
  source_id: 'usgs',
  name: 'USGS Earthquake Hazards Program',
  homepage: 'https://earthquake.usgs.gov',
  licence: 'Public domain (U.S. Government work)',
  attribution_text: 'Earthquake data courtesy of the U.S. Geological Survey.',
  terms_url: 'https://www.usgs.gov/laws',
  disclaimer: null,
};

function input(overrides: Partial<SourceStatusInput> = {}): SourceStatusInput {
  return {
    asOf: AS_OF,
    generatedAt: GENERATED_AT,
    isReplay: false,
    horizon: replayHorizonFor('lean', AS_OF),
    cutoffs: { usgs: new Date('2026-09-21T11:55:05.000Z') },
    sources: [source()],
    products: [product()],
    healthBySource: [health({ productId: null, productCode: null })],
    healthByProduct: [health()],
    runs: [run()],
    tally: [{ source_id: 'usgs', total: 12, succeeded: 12 }],
    worker: { last_seen_at: new Date('2026-09-21T11:59:30.000Z'), version: 'worker-1' },
    attribution: [ATTRIBUTION],
    evidence: [evidence()],
    ...overrides,
  };
}

describe('buildSourceStatus — the shape of the frozen contract', () => {
  it('fills every top-level field', () => {
    const status = buildSourceStatus(input());
    expect(Object.keys(status).sort()).toEqual([
      'asOfContext',
      'attribution',
      'dataQuality',
      'evidenceManifest',
      'generatedAt',
      'schemaVersion',
      'sources',
      'worker',
    ]);
  });

  it('stamps the knowledge time and the generation time separately', () => {
    const status = buildSourceStatus(input());
    expect(status.asOfContext.asOf).toBe(AS_OF.toISOString());
    expect(status.generatedAt).toBe(GENERATED_AT.toISOString());
  });

  it('sorts sourceCutoffs by source id so the bytes do not depend on the servers locale', () => {
    const status = buildSourceStatus(
      input({
        cutoffs: { firms: null, usgs: new Date('2026-09-21T11:55:05.000Z'), emsc: null },
      }),
    );
    expect(Object.keys(status.asOfContext.sourceCutoffs)).toEqual(['emsc', 'firms', 'usgs']);
  });

  it('reports a cutoff of null rather than an epoch when a source has committed nothing', () => {
    const status = buildSourceStatus(input({ cutoffs: { firms: null } }));
    expect(status.asOfContext.sourceCutoffs['firms']).toBeNull();
  });

  it('is deterministic: the same input produces the same bytes', () => {
    expect(JSON.stringify(buildSourceStatus(input()))).toBe(
      JSON.stringify(buildSourceStatus(input())),
    );
  });
});

describe('buildSourceStatus — the 24-hour success rate', () => {
  it('reports the rate with its denominator', () => {
    const entry = buildSourceStatus(
      input({ tally: [{ source_id: 'usgs', total: 20, succeeded: 15 }] }),
    ).sources[0];
    expect(entry?.successRate24h).toBe(0.75);
    expect(entry?.runCount24h).toBe(20);
  });

  /*
   * The false-negative this page exists to prevent. A `0` reads as "every run failed"; `null`
   * reads as "there is no rate to state", and those are different facts about a source.
   */
  it('reports null, not zero, when no run committed in the window', () => {
    const entry = buildSourceStatus(input({ tally: [] })).sources[0];
    expect(entry?.successRate24h).toBeNull();
    expect(entry?.runCount24h).toBe(0);
  });

  it('reports null when the tally exists but its total is zero', () => {
    const entry = buildSourceStatus(
      input({ tally: [{ source_id: 'usgs', total: 0, succeeded: 0 }] }),
    ).sources[0];
    expect(entry?.successRate24h).toBeNull();
  });

  /**
   * A mutation control for the denominator, not for the rate.
   *
   * A single successful run and two hundred successful runs both give `1`. If `runCount24h` were
   * dropped or hard-coded, every assertion above would still pass while the page lost the one
   * number that makes the rate meaningful.
   */
  it('distinguishes a perfect rate over one run from a perfect rate over many', () => {
    const one = buildSourceStatus(input({ tally: [{ source_id: 'usgs', total: 1, succeeded: 1 }] }))
      .sources[0];
    const many = buildSourceStatus(
      input({ tally: [{ source_id: 'usgs', total: 200, succeeded: 200 }] }),
    ).sources[0];
    expect(one?.successRate24h).toBe(many?.successRate24h);
    expect(one?.runCount24h).not.toBe(many?.runCount24h);
  });

  it('attributes a tally to the right source and does not borrow another source rate', () => {
    const status = buildSourceStatus(
      input({
        sources: [source(), source({ source_id: 'firms', name: 'NASA FIRMS' })],
        products: [product()],
        healthBySource: [
          health({ productId: null, productCode: null }),
          health({ sourceId: 'firms', productId: null, productCode: null, evidenceId: null }),
        ],
        healthByProduct: [health()],
        tally: [{ source_id: 'usgs', total: 4, succeeded: 4 }],
      }),
    );
    expect(status.sources.find((entry) => entry.sourceId === 'usgs')?.successRate24h).toBe(1);
    expect(status.sources.find((entry) => entry.sourceId === 'firms')?.successRate24h).toBeNull();
  });
});

describe('buildSourceStatus — health', () => {
  it('carries the derivations rollup rather than recomputing one', () => {
    const rollup = health({ productId: null, productCode: null, status: 'STALE' });
    const status = buildSourceStatus(
      input({ healthBySource: [rollup], healthByProduct: [health({ status: 'FRESH' })] }),
    );
    expect(status.sources[0]?.health.status).toBe('STALE');
    expect(status.sources[0]?.products[0]?.health.status).toBe('FRESH');
  });

  /*
   * "Worst wins" is `aggregateSourceHealth`'s rule and the entry must not soften it. The test
   * feeds a rollup that is already UNAVAILABLE beside a healthy product, which is the shape a
   * source with one dead feed produces.
   */
  it.each<SourceHealthStatus>(['FRESH', 'DEGRADED', 'STALE', 'UNAVAILABLE'])(
    'reports the rollup status %s verbatim',
    (status) => {
      const built = buildSourceStatus(
        input({ healthBySource: [health({ productId: null, productCode: null, status })] }),
      );
      expect(built.sources[0]?.health.status).toBe(status);
    },
  );

  /**
   * A missing health entry is refused, not described.
   *
   * It used to be described with a fabricated policy of zeros — "expected poll interval: 0 s",
   * `reasons: ['DISABLED']` for a source that may not be disabled — which is precisely the kind of
   * invented number this page exists not to publish. `healthAsOf` returns an entry per source and
   * per product, so a gap is an internal inconsistency between two reads of one database, and
   * `INTERNAL_ERROR` with a trace id is the honest rendering of that.
   */
  it('refuses to describe a source the derivation did not report on', () => {
    expect(() => buildSourceStatus(input({ healthBySource: [], healthByProduct: [] }))).toThrow(
      /health derivation returned no entry for source usgs/u,
    );
  });

  it('names the product when it is the product that is missing', () => {
    expect(() => buildSourceStatus(input({ healthByProduct: [] }))).toThrow(
      /product usgs\/comcat_all_day/u,
    );
  });

  it('reports a missing timestamp as null rather than as an epoch', () => {
    const status = buildSourceStatus(
      input({
        healthBySource: [
          health({
            productId: null,
            productCode: null,
            lastAttemptAt: null,
            lastSuccessAt: null,
            newestObservedAt: null,
            evidenceId: null,
          }),
        ],
      }),
    );
    expect(status.sources[0]?.health.lastSuccessAt).toBeNull();
    expect(status.sources[0]?.health.newestObservedAt).toBeNull();
    expect(JSON.stringify(status)).not.toContain('1970-01-01');
  });

  it('publishes the policy the judgement was made against', () => {
    const expected = buildSourceStatus(input()).sources[0]?.health.expected;
    expect(expected).toEqual({
      pollIntervalS: 300,
      fetchFreshWithinS: 900,
      fetchStaleAfterS: 3600,
      unavailableAfterS: 86_400,
      dataCurrentWithinS: 3600,
      dataStaleAfterS: 86_400,
      quietIsNormal: true,
    });
  });

  /** `asOf` belongs to the response, once. Repeating it per entry invites two that disagree. */
  it('does not repeat the knowledge time inside each health entry', () => {
    const view = buildSourceStatus(input()).sources[0]?.health;
    expect(Object.keys(view ?? {})).not.toContain('asOf');
  });
});

describe('buildSourceStatus — products and enum narrowing', () => {
  it('lists a product with its sensor lifecycle', () => {
    const view = buildSourceStatus(
      input({
        products: [
          product({
            product_id: 7,
            code: 'viirs_noaa21',
            platform: 'NOAA-21',
            instrument: 'VIIRS',
            resolution_m: 375,
            status: 'RETIRING',
            active_from: '2023-01-01',
            active_to: '2027-01-01',
          }),
        ],
        healthByProduct: [health({ productId: 7, productCode: 'viirs_noaa21' })],
      }),
    ).sources[0]?.products[0];

    expect(view).toMatchObject({
      id: 7,
      code: 'viirs_noaa21',
      platform: 'NOAA-21',
      instrument: 'VIIRS',
      resolutionM: 375,
      status: 'RETIRING',
      activeFrom: '2023-01-01',
      activeTo: '2027-01-01',
    });
  });

  /*
   * An unrecognised product status must not present as ACTIVE. `ACTIVE` is the one value a reader
   * takes as a promise that the feed is being polled, so the conservative direction is RETIRED.
   */
  it('maps an unrecognised product status to RETIRED, never ACTIVE', () => {
    const view = buildSourceStatus(input({ products: [product({ status: 'SOMETHING_NEW' })] }))
      .sources[0]?.products[0];
    expect(view?.status).toBe('RETIRED');
  });

  it('drops a hazard type the domain does not declare instead of passing it through', () => {
    const view = buildSourceStatus(
      input({ products: [product({ hazard_types: ['EARTHQUAKE', 'ASTEROID_IMPACT'] })] }),
    ).sources[0];
    expect(view?.products[0]?.hazardTypes).toEqual(['EARTHQUAKE']);
    expect(view?.hazardTypes).toEqual(['EARTHQUAKE']);
  });

  /*
   * Asserted on **both** lists on purpose. The source-level union is computed by filtering over
   * `SOURCE_CAPABILITIES`, which drops an unknown value as a side effect of how it is built — so
   * a narrowing function that stopped narrowing would still produce a clean union while the
   * product's own list carried the unknown string into the frozen contract. The product list is
   * the one that can actually go wrong.
   */
  it('drops an unknown capability from the product and from the union', () => {
    const view = buildSourceStatus(
      input({ products: [product({ capabilities: ['EVENT_REVISIONS', 'TELEPATHY'] })] }),
    ).sources[0];
    expect(view?.products[0]?.capabilities).toEqual(['EVENT_REVISIONS']);
    expect(view?.capabilities).toEqual(['EVENT_REVISIONS']);
  });

  it('drops an unknown hazard type from the product list, not only from the union', () => {
    const view = buildSourceStatus(
      input({ products: [product({ hazard_types: ['EARTHQUAKE', 'ASTEROID_IMPACT'] })] }),
    ).sources[0];
    expect(view?.products[0]?.hazardTypes).toEqual(['EARTHQUAKE']);
  });

  /** The source-level lists are the union over products, in the domains own order. */
  it('unions hazard types across products in a canonical order', () => {
    const view = buildSourceStatus(
      input({
        products: [
          product({ product_id: 1, hazard_types: ['FLOOD'] }),
          product({ product_id: 2, code: 'b', hazard_types: ['EARTHQUAKE', 'FLOOD'] }),
        ],
        healthByProduct: [health({ productId: 1 }), health({ productId: 2, productCode: 'b' })],
      }),
    ).sources[0];
    expect(view?.hazardTypes).toEqual(['EARTHQUAKE', 'FLOOD']);
  });

  it('reports a source with no products as having no hazard types rather than guessing', () => {
    const view = buildSourceStatus(input({ products: [], healthByProduct: [] })).sources[0];
    expect(view?.products).toEqual([]);
    expect(view?.hazardTypes).toEqual([]);
    expect(view?.capabilities).toEqual([]);
  });

  /*
   * Each product must get **its own** health, not a sibling's.
   *
   * The lookup key is `(sourceId, productId)`. A key of `sourceId` alone type-checks, passes every
   * single-product test, and gives two products of one source the same status — which on this page
   * would report a dead feed as healthy because a sibling feed is fine. Two products with
   * different statuses is the only arrangement that can see it.
   */
  it('gives each product of a source its own health', () => {
    const status = buildSourceStatus(
      input({
        products: [
          product({ product_id: 1, code: 'comcat_all_day' }),
          product({ product_id: 2, code: 'comcat_reviewed' }),
        ],
        healthByProduct: [
          health({ productId: 1, productCode: 'comcat_all_day', status: 'FRESH' }),
          health({
            productId: 2,
            productCode: 'comcat_reviewed',
            status: 'UNAVAILABLE',
            reasons: ['NO_SUCCESS_BEYOND_LIMIT'],
            lastSuccessAt: null,
          }),
        ],
      }),
    );
    const byId = new Map(status.sources[0]?.products.map((entry) => [entry.id, entry]));
    expect(byId.get(1)?.health.status).toBe('FRESH');
    expect(byId.get(2)?.health.status).toBe('UNAVAILABLE');
    expect(byId.get(2)?.health.productId).toBe(2);
  });

  it('does not attach one sources products to another', () => {
    const status = buildSourceStatus(
      input({
        sources: [source(), source({ source_id: 'firms', name: 'NASA FIRMS' })],
        products: [product({ product_id: 1, source_id: 'usgs' })],
        healthBySource: [
          health({ productId: null, productCode: null }),
          health({ sourceId: 'firms', productId: null, productCode: null, evidenceId: null }),
        ],
      }),
    );
    expect(status.sources.find((entry) => entry.sourceId === 'firms')?.products).toEqual([]);
  });
});

describe('buildSourceStatus — recent runs', () => {
  it('summarizes a run with its counts and its evidence id', () => {
    const view = buildSourceStatus(input()).sources[0]?.recentRuns[0];
    expect(view).toEqual({
      id: RUN_UUID,
      productId: 1,
      trigger: 'SCHEDULE',
      status: 'SUCCEEDED',
      startedAt: '2026-09-21T11:55:00.000Z',
      committedAt: '2026-09-21T11:55:05.000Z',
      durationMs: 4000,
      counts: { received: 230, newRecords: 3, newVersions: 5, unchanged: 222, rejected: 0 },
      newestObservedAt: '2026-09-21T11:40:00.000Z',
      errorClass: null,
      evidenceId: `EV:RUN:${RUN_UUID}`,
    });
  });

  /*
   * From `finished_at`, not `committed_at`: they differ by the commit, and the number a reader
   * wants is how long the provider took. A run with no finish reports `null`, never a duration
   * measured against the present.
   */
  it('reports a duration of null when the run never recorded a finish', () => {
    const view = buildSourceStatus(input({ runs: [run({ finished_at: null })] })).sources[0]
      ?.recentRuns[0];
    expect(view?.durationMs).toBeNull();
  });

  it('does not measure duration from committed_at', () => {
    const view = buildSourceStatus(input()).sources[0]?.recentRuns[0];
    expect(view?.durationMs).not.toBe(5000);
  });

  /*
   * A status the domain does not recognise must not be rendered or counted as a success. `FAILED`
   * is the conservative direction, matching the SQL tally, which filters *for* SUCCEEDED rather
   * than filtering out known failures.
   */
  it('maps an unrecognised run status to FAILED, never SUCCEEDED', () => {
    const view = buildSourceStatus(input({ runs: [run({ status: 'MYSTERY' })] })).sources[0]
      ?.recentRuns[0];
    expect(view?.status).toBe('FAILED');
  });

  it('drops an unrecognised error class rather than inventing one', () => {
    const view = buildSourceStatus(
      input({ runs: [run({ status: 'FAILED', error_class: 'WEIRD' })] }),
    ).sources[0]?.recentRuns[0];
    expect(view?.errorClass).toBeNull();
  });

  it('never carries an error message, which RunSummaryView has no field for', () => {
    expect(JSON.stringify(buildSourceStatus(input()))).not.toContain('errorMessage');
  });
});

describe('buildSourceStatus — the worker heartbeat', () => {
  it('reports a recent heartbeat as live', () => {
    const worker = buildSourceStatus(input()).worker;
    expect(worker).toEqual({
      lastSeenAt: '2026-09-21T11:59:30.000Z',
      version: 'worker-1',
      isStale: false,
    });
  });

  /**
   * The threshold, written as the requirement rather than as the constant.
   *
   * `WorkerStatusView.isStale` is defined as "older than twice its interval" and ARCHITECTURE §14
   * fixes the interval at one minute, so the answer is **120 seconds** — a literal, not something
   * to be read back out of the module. Deriving these expectations from
   * `WORKER_HEARTBEAT_STALE_AFTER_S` made the earlier version of this test survive an edit that
   * widened the window to an hour: the constant moved and the expectation moved with it, which is
   * a test that confirms the implementation instead of the rule.
   */
  it('derives its threshold from a one-minute interval, per ARCHITECTURE §14', () => {
    expect(WORKER_HEARTBEAT_INTERVAL_S).toBe(60);
    expect(WORKER_HEARTBEAT_STALE_AFTER_S).toBe(120);
  });

  it.each([
    [0, false],
    [60, false],
    [119, false],
    [120, false],
    [121, true],
    [3600, true],
  ])('a heartbeat %i seconds old reports isStale=%s', (ageS, expected) => {
    const seenAt = new Date(AS_OF.getTime() - ageS * 1000);
    expect(
      buildSourceStatus(input({ worker: { last_seen_at: seenAt, version: null } })).worker?.isStale,
    ).toBe(expected);
  });

  it('reports a null version without treating it as a missing heartbeat', () => {
    const seenAt = new Date(AS_OF.getTime() - 10_000);
    expect(
      buildSourceStatus(input({ worker: { last_seen_at: seenAt, version: null } })).worker,
    ).toEqual({ lastSeenAt: seenAt.toISOString(), version: null, isStale: false });
  });

  /**
   * Staleness is measured against the **knowledge time**, not the wall clock.
   *
   * Comparing a heartbeat from a replayed hour to `Date.now()` would report every historical
   * heartbeat as stale — a statement about how long ago the request is asking about, not about the
   * worker. This is the mutation control for that: a heartbeat 30 seconds before a knowledge time
   * two days in the past is live.
   */
  it('judges a replayed heartbeat against the replayed clock', () => {
    const pastAsOf = new Date('2026-09-19T12:00:00.000Z');
    const worker = buildSourceStatus(
      input({
        asOf: pastAsOf,
        isReplay: true,
        horizon: replayHorizonFor('lean', pastAsOf),
        worker: { last_seen_at: new Date('2026-09-19T11:59:30.000Z'), version: 'worker-1' },
      }),
    ).worker;
    expect(worker?.isStale).toBe(false);
  });

  it('reports null when there is no heartbeat GeoNerva can state', () => {
    expect(buildSourceStatus(input({ worker: null })).worker).toBeNull();
  });
});

describe('buildSourceStatus — data quality', () => {
  /*
   * Empty means "no checks reported", not "all checks pass". TESTING.md §7 puts those five
   * invariants in the worker, which does not compute them; five fabricated OK rows would invert
   * the purpose of this page.
   */
  it('reports no data-quality checks rather than fabricating passing ones', () => {
    expect(buildSourceStatus(input()).dataQuality).toEqual([]);
  });

  /**
   * The previous version searched the serialized response for `"status":"OK"`, which no enum in
   * the response can produce — health is FRESH/DEGRADED/STALE/UNAVAILABLE and a run is
   * SUCCEEDED/PARTIAL/… — so it passed against any implementation, including one that fabricated
   * `status: 'WARN'` rows from nothing. The check that means something is that the array is empty
   * and therefore carries no check object at all.
   */
  it('emits no data-quality check object of any status', () => {
    const status = buildSourceStatus(input());
    expect(status.dataQuality).toHaveLength(0);
    for (const check of status.dataQuality) {
      expect(['OK', 'WARN', 'ALARM']).not.toContain(check.status);
    }
  });
});

describe('buildSourceStatus — the evidence manifest (invariant I9)', () => {
  it('resolves every evidence id the response references', () => {
    const status = buildSourceStatus(input());
    const referenced = new Set<string>();
    for (const entry of status.sources) {
      if (entry.health.evidenceId !== null) referenced.add(entry.health.evidenceId);
      for (const item of entry.products) {
        if (item.health.evidenceId !== null) referenced.add(item.health.evidenceId);
      }
      for (const item of entry.recentRuns) referenced.add(item.evidenceId);
    }
    const manifest = new Set(status.evidenceManifest.map((item) => item.id));
    expect([...referenced].filter((id) => !manifest.has(id))).toEqual([]);
    expect(manifest.size).toBeGreaterThan(0);
  });

  it('marks a run citation as resolvable, because the evidence endpoint can serve it', () => {
    expect(buildSourceStatus(input()).evidenceManifest[0]?.resolvable).toBe(true);
  });

  /**
   * A run whose evidence cannot be resolved is **not reported at all**.
   *
   * The earlier version of this test asserted the opposite — an empty manifest beside a
   * `recentRuns[0].evidenceId` — and that is an invariant I9 violation shipped to a caller: the
   * response cites an id its own manifest does not contain. `RunSummaryView.evidenceId` is
   * non-nullable, so there is no I9-compliant way to report the run; the honest answer is that
   * GeoNerva can no longer evidence it. Reachable once retention prunes `ingestion_runs` while
   * health still refers to the run.
   */
  it('omits a run whose evidence it cannot resolve, rather than citing it', () => {
    const status = buildSourceStatus(input({ evidence: [] }));
    expect(status.evidenceManifest).toEqual([]);
    expect(status.sources[0]?.recentRuns).toEqual([]);
  });

  it('keeps the runs it can evidence and drops only the others', () => {
    const status = buildSourceStatus(
      input({
        runs: [run(), run({ id: OTHER_RUN_UUID })],
        /* Only the first run's evidence resolves. */
        evidence: [evidence()],
      }),
    );
    expect(status.sources[0]?.recentRuns.map((entry) => entry.id)).toEqual([RUN_UUID]);
    expect(status.evidenceManifest.map((item) => item.id)).toEqual([`EV:RUN:${RUN_UUID}`]);
  });

  /**
   * A mutation control for the *walk*, not for the filter.
   *
   * The manifest is built by walking the assembled response. If it were built from the input rows
   * instead, a resolved row that nothing cites would still appear — so this feeds an extra
   * evidence row for a run that is not in `recentRuns` and requires it to be excluded.
   */
  it('excludes a resolved row that the response does not cite', () => {
    const status = buildSourceStatus(
      input({
        evidence: [evidence(), evidence({ id: `EV:RUN:${OTHER_RUN_UUID}`, summary: 'unused' })],
      }),
    );
    expect(status.evidenceManifest.map((item) => item.id)).toEqual([`EV:RUN:${RUN_UUID}`]);
  });

  it('sorts the manifest, so the response bytes are stable', () => {
    const ids = buildSourceStatus(
      input({
        runs: [run({ id: OTHER_RUN_UUID }), run()],
        evidence: [evidence({ id: `EV:RUN:${OTHER_RUN_UUID}` }), evidence()],
      }),
    ).evidenceManifest.map((item) => item.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('carries the attribution its licences require, verbatim', () => {
    expect(buildSourceStatus(input()).attribution).toEqual([
      {
        sourceId: 'usgs',
        name: 'USGS Earthquake Hazards Program',
        homepage: 'https://earthquake.usgs.gov',
        licence: 'Public domain (U.S. Government work)',
        attributionText: 'Earthquake data courtesy of the U.S. Geological Survey.',
        termsUrl: 'https://www.usgs.gov/laws',
        disclaimer: null,
      },
    ]);
  });
});

describe('evidenceIdsFor', () => {
  it('collects the ids from health and from runs, deduplicated and sorted', () => {
    expect(
      evidenceIdsFor({
        healthBySource: [health({ productId: null, productCode: null })],
        healthByProduct: [health()],
        runs: [run({ id: OTHER_RUN_UUID }), run()],
      }),
    ).toEqual([`EV:RUN:${RUN_UUID}`, `EV:RUN:${OTHER_RUN_UUID}`]);
  });

  it('skips a health entry with no evidence, which is a source that has never run', () => {
    expect(
      evidenceIdsFor({
        healthBySource: [health({ productId: null, productCode: null, evidenceId: null })],
        healthByProduct: [],
        runs: [],
      }),
    ).toEqual([]);
  });

  /** Built through the codec, so the id here and the id in the manifest cannot drift. */
  it('mints a run id in the canonical evidence form', () => {
    expect(evidenceIdsFor({ healthBySource: [], healthByProduct: [], runs: [run()] })[0]).toBe(
      `EV:RUN:${RUN_UUID}`,
    );
  });
});
