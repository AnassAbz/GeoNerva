/**
 * QA round 2 — data integrity (docs/reviews/qa-round-2.md, gate G7).
 *
 * `docs/SECURITY.md` H5 points this round at **misleading scientific output**, and the product's
 * central promise — `PRODUCT.md` §2, §7 — is that GeoNerva never presents an absence of data as
 * an absence of hazard. Every `it` below is a finding from that report, written as an assertion
 * about what the read models actually say, at one fixed instant, on the seeded PostGIS scenario.
 *
 * **These specs are expected to fail.** Each assertion states what the documents require; the
 * value on the other side is what the code produces today. Run with:
 *
 * ```
 * DATABASE_URL_TEST=postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva_qa2_test \
 *   pnpm exec vitest run --config tests/adversarial/vitest.config.ts
 * ```
 *
 * ### Why the read models and not HTTP
 *
 * Every finding here is a disagreement between two surfaces at one knowledge time, and the three
 * builders below are what all four surfaces — briefing card, map, history chart, cluster page —
 * are built from. Asserting on them names the layer the fix belongs in, and does not need a
 * `next start` on a fixed port. The two findings that live in the React layer instead
 * (`hazard-card.tsx`) are in `apps/web/components/hazard-card.qa2.spec.tsx`, beside the suite
 * they belong to.
 *
 * The clock is `SCENARIO_ANCHOR` and never `new Date()` — the same instant a Playwright run
 * passes as `GEONERVA_FAKE_NOW`, so this file and that run describe one world.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Relative imports, not `@geonerva/*`.
 *
 * `tests/` is not matched by `pnpm-workspace.yaml`'s `apps/*` / `packages/*` globs, so pnpm links
 * no `node_modules` here. `@geonerva/db` and `@geonerva/test-fixtures` happen to resolve anyway —
 * they are root `devDependencies` and are found by walking up — but `@geonerva/briefing` and
 * `@geonerva/domain` are not, and `pnpm typecheck` fails on them. Adding `tests/*` to the
 * workspace file, or the two packages to the root manifest, would both be edits to foundational
 * files this role may not make.
 *
 * So all four are reached by path, straight to the entry each package's own `exports` map names.
 * The packages resolve their *own* bare specifiers through their own links, which is why nothing
 * further is needed and why the vitest config carries no aliases.
 */
import { createDb, type DB } from '../../packages/db/src/index.ts';
import {
  setupTestDatabase,
  type TestDatabase,
} from '../../packages/db/src/testing/test-database.ts';
import {
  MARRAKECH_REF,
  SCENARIO_ANCHOR,
  SCENARIO_IDS,
  seedMarrakechScenario,
  type ScenarioName,
} from '../../packages/test-fixtures/scenarios/index.ts';
import {
  buildBriefing,
  buildFireClusterDetail,
  buildHistory,
  buildMapFeatures,
} from '../../packages/briefing/src/index.ts';
import type { LocationRef } from '../../packages/domain/src/index.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const AS_OF = new Date(SCENARIO_ANCHOR);
const ENGINE = 'qa2-adversarial-1';
const LOCATION: LocationRef = { ...MARRAKECH_REF };
const DAY_MS = 24 * 60 * 60 * 1000;

/** The viewport the `/place` page's map panel covers for Marrakech, tile-snapped as the API is. */
const VIEWPORT = { west: -10.1953125, south: 29.8828125, east: -5.9765625, north: 33.046875 };

type Answers = Awaited<ReturnType<typeof readAll>>;
const answers = new Map<ScenarioName, Answers>();

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
  for (const scenario of ['all-fresh', 'firms-stale'] as const) {
    await testDb.truncate();
    await seedMarrakechScenario(db, scenario);
    answers.set(scenario, await readAll());
  }
}, 900_000);

afterAll(async () => {
  await db.destroy();
});

async function readAll() {
  const briefing = await buildBriefing({
    db,
    location: LOCATION,
    asOf: AS_OF,
    engineVersion: ENGINE,
    window: '24h',
    generatedAt: AS_OF,
    retentionProfile: 'lean',
    strictManifest: true,
  });
  const history = {
    eq7: await buildHistory({
      db,
      location: LOCATION,
      family: 'EARTHQUAKES',
      metric: 'EQ_COUNT_7D',
      radiusKm: 150,
      asOf: AS_OF,
      retentionProfile: 'lean',
    }),
    eq30: await buildHistory({
      db,
      location: LOCATION,
      family: 'EARTHQUAKES',
      metric: 'EQ_COUNT_30D',
      radiusKm: 150,
      asOf: AS_OF,
      retentionProfile: 'lean',
    }),
    fire: await buildHistory({
      db,
      location: LOCATION,
      family: 'FIRE_ACTIVITY',
      metric: 'FIRE_TREND',
      radiusKm: 100,
      asOf: AS_OF,
      retentionProfile: 'lean',
    }),
  };
  const map = {
    fire: await buildMapFeatures({
      db,
      bbox: VIEWPORT,
      zoom: 8,
      families: ['FIRE_ACTIVITY'],
      asOf: AS_OF,
      retentionProfile: 'lean',
    }),
    weather: await buildMapFeatures({
      db,
      bbox: VIEWPORT,
      zoom: 8,
      families: ['WEATHER_ALERTS'],
      asOf: AS_OF,
      retentionProfile: 'lean',
    }),
  };
  const cluster = await buildFireClusterDetail({
    db,
    publicId: SCENARIO_IDS.fireCluster,
    asOf: AS_OF,
    location: LOCATION,
    retentionProfile: 'lean',
  });
  return { briefing, history, map, cluster, truth: await readTruth() };
}

/**
 * The facts the database itself holds, so a rendered number can be checked against the rows
 * rather than against another derivation of the same rows.
 */
async function readTruth(): Promise<{
  readonly detections24h: number;
  readonly overpasses24h: number;
}> {
  const since = new Date(AS_OF.getTime() - DAY_MS);
  const row = await sql<{ detections: string; overpasses: string }>`
    SELECT count(*)::text AS detections,
           count(DISTINCT date_trunc('hour', acquired_at))::text AS overpasses
      FROM geonerva.fire_detections
     WHERE acquired_at > ${since} AND acquired_at <= ${AS_OF}
  `.execute(db);
  const values = row.rows[0];
  if (values === undefined) throw new Error('no detection-count row');
  return { detections24h: Number(values.detections), overpasses24h: Number(values.overpasses) };
}

function answerFor(scenario: ScenarioName): Answers {
  const answer = answers.get(scenario);
  if (answer === undefined) throw new Error(`no answers for ${scenario}`);
  return answer;
}

// -------------------------------------------------------------------------------------------
// F-1 — every hazard card says "not enough history" while /history answers from 259 windows.
// -------------------------------------------------------------------------------------------

describe('F-1 · a card must not deny the history the same page reports', () => {
  /*
   * `snapshot.ts` returns `metrics: []` for every family unconditionally, and
   * `hazard-card.tsx` renders `COPY.card.insufficientHistory` when `card.metrics[0]` is
   * undefined. So the earthquake card prints "Not enough history to establish a baseline." on a
   * page whose own Historical context section prints "…compared with 259 7-day periods since
   * 2021" — PRODUCT §7's sanctioned copy for thin data, used where the data is not thin.
   *
   * `DOMAIN_MODEL.md` §4.14 puts `metrics[]: BaselineMetric` on the family, and §4.11 says
   * `EV:BAS:<sha>` is "embedded in the briefing manifest".
   */
  it('carries the earthquake baseline on the card that reports earthquakes', () => {
    const { briefing, history } = answerFor('all-fresh');
    expect(history.eq7.metric.status).toBe('OK');

    const card = briefing.briefing.snapshot.families.EARTHQUAKES;
    expect(card.availability).toBe('AVAILABLE');
    expect(card.metrics.map((metric) => metric.metricCode)).toContain('EQ_COUNT_7D');
  });

  it('never leaves an AVAILABLE card with no metric at all', () => {
    const { briefing } = answerFor('all-fresh');
    const silent = Object.values(briefing.briefing.snapshot.families)
      .filter((card) => card.availability === 'AVAILABLE' && card.metrics.length === 0)
      .map((card) => card.family);
    expect(silent).toEqual([]);
  });

  it('puts the baseline evidence in the briefing manifest (DOMAIN_MODEL §4.11)', () => {
    const { briefing } = answerFor('all-fresh');
    const kinds = briefing.briefing.evidenceManifest.map((entry) => entry.kind);
    expect(kinds).toContain('BAS');
  });
});

// -------------------------------------------------------------------------------------------
// F-2 — the map cannot say "unavailable" or "not covered", only "total: 0".
// -------------------------------------------------------------------------------------------

describe('F-2 · the map must not present an outage or a gap as a quiet region', () => {
  /*
   * `MapFeaturesResponse` (packages/domain/src/read-models/map-and-places.ts) has no
   * availability, coverage or source-health field. `total` is the only answer it can give, so
   * "no source reads this place" and "GeoNerva looked and found nothing" are byte-identical
   * responses — the one confusion ARCHITECTURE §9.8 exists to prevent, on the surface a reader
   * looks at first.
   */
  it('says something other than "total: 0" for a family it has no source for', () => {
    const { briefing, map } = answerFor('all-fresh');
    expect(briefing.briefing.snapshot.families.WEATHER_ALERTS.availability).toBe('NOT_COVERED');
    expect(map.weather.total).toBe(0);

    /*
     * Any field at all in which the response could distinguish "no source reads this place" from
     * "GeoNerva looked and found nothing". The contract has none of them, which is the finding —
     * the names are candidates, not a prescription.
     */
    const keys = Object.keys(map.weather as unknown as Record<string, unknown>);
    const disclosure = keys.filter((key) =>
      /availability|coverage|notCovered|unavailable|sourceHealth/iu.test(key),
    );
    expect(disclosure).not.toEqual([]);
  });

  it('does not draw an active fire cluster the briefing refuses to vouch for', () => {
    /*
     * `firms-stale`: all three fire sources are STALE with three consecutive 5xx, the card is
     * UNAVAILABLE, and the headline is "GeoNerva cannot currently report on fire activity here."
     * The map, asked for the same family at the same instant, returns the cluster with
     * `isActive: true` and `clusterStatus: 'ACTIVE'` and no way to say the feed is down.
     */
    const { briefing, map } = answerFor('firms-stale');
    const card = briefing.briefing.snapshot.families.FIRE_ACTIVITY;
    expect(card.availability).toBe('UNAVAILABLE');

    const drawn = map.fire.features.map((feature) => feature.publicId);
    expect({ cardAvailability: card.availability, drawn }).toEqual({
      cardAvailability: 'UNAVAILABLE',
      drawn: [],
    });
  });
});

// -------------------------------------------------------------------------------------------
// F-3 — "in the last 24 hours" is a figure from a run 7 h 46 min before the knowledge time.
// -------------------------------------------------------------------------------------------

describe('F-3 · a "last 24 hours" count must mean the last 24 hours', () => {
  /*
   * The cluster summary is the newest `fire_cluster_versions` row at or before `asOf`, and its
   * `n_24h` / `overpasses_24h` were computed at *that row's* `as_of`. The seeded run is at
   * 05:20 and the knowledge time is 13:06, so the page reads "8 detections in the last 24
   * hours · seen on 2 satellite overpasses" when the rows hold 5 detections on 1 overpass: the
   * three detections of 21 Sep 12:48 fell out of the window 18 minutes before the anchor.
   *
   * It is not only a displayed number. ARCHITECTURE §9.2 makes `HIGH` conditional on
   * `n_24h >= 5 or overpasses_24h >= 2`, so a summary that ages without being recomputed can
   * hold a relevance level up after the evidence for it has expired.
   */
  it('reports the detections the rows actually hold at the knowledge time', () => {
    /*
     * Only the detection count is asserted. "Distinct overpasses" has no definition this suite
     * owns — the seed supplies the figure rather than deriving it — so asserting a count of
     * distinct acquisition hours would be testing my definition, not the product's. The overpass
     * figure is stale by the same 7 h 46 min (2 where the rows support 1) and is reported as
     * argument in §3, M-2.
     */
    const { cluster, truth } = answerFor('all-fresh');
    expect(cluster.kind).toBe('found');
    if (cluster.kind !== 'found') return;

    expect(cluster.detail.summary.detectionCount24h).toBe(truth.detections24h);
  });

  it('states the same 24-hour count on the card as on the cluster page', () => {
    const { briefing, cluster } = answerFor('all-fresh');
    if (cluster.kind !== 'found') throw new Error('no cluster');
    const item = briefing.briefing.snapshot.families.FIRE_ACTIVITY.items.find(
      (entry) => entry.publicId === SCENARIO_IDS.fireCluster,
    );
    if (item === undefined) throw new Error('no fire item on the card');

    /* The card's reason sentence quotes the count in `params`, which is what it must agree with. */
    const quoted = item.relevance.reasons
      .map((reason) => reason.params['detections24h'] ?? reason.params['n24h'])
      .find((value) => typeof value === 'number');
    expect(quoted).toBe(cluster.detail.summary.detectionCount24h);
  });
});

// -------------------------------------------------------------------------------------------
// F-4 — "in the top 1 % of comparable periods", from 59 comparable periods.
// -------------------------------------------------------------------------------------------

describe('F-4 · a percentile must be resolvable by its own sample', () => {
  /*
   * ARCHITECTURE §8 principle 3: "Refuse to report a statistic that the data cannot support."
   * The 30-day metric has `reference.nWindows: 59`, and its interpretation reads "well above
   * typical (in the top 1 % of comparable periods)". The finest quantile 59 observations can
   * resolve is 1/59 ≈ 1.7 %; a 1-in-100 rarity is not in the sample. The documented minimum
   * (§8.1) is 52 windows, which gates `status: OK` and says nothing about the 99th percentile
   * the `WELL_ABOVE_TYPICAL` band and its copy both name.
   */
  it('does not claim a 1 % rarity from fewer than 100 reference windows', () => {
    const { metric } = answerFor('all-fresh').history.eq30;
    if (metric.status !== 'OK') return;

    const claimsOnePercent =
      metric.band === 'WELL_ABOVE_TYPICAL' || /top 1\s*%/u.test(metric.interpretation);
    expect({
      claimsOnePercent,
      nWindows: metric.reference?.nWindows ?? 0,
      supportable: (metric.reference?.nWindows ?? 0) >= 100,
    }).toEqual({ claimsOnePercent, nWindows: metric.reference?.nWindows ?? 0, supportable: true });
  });
});

// -------------------------------------------------------------------------------------------
// F-5 — an Mww and an mb compared as a 0.1 discrepancy, with neither type stated.
// -------------------------------------------------------------------------------------------

describe('F-5 · a magnitude must carry its type wherever two of them are compared', () => {
  /*
   * The seeded M5.4 is USGS **Mww** 5.4 and EMSC **mb** 5.3. The agreement block reports
   * `spread: 0.1`, `isConflict: true` and the sentence "Magnitudes differ by 0.1 across 2
   * independent sources", and `magnitude_type` appears nowhere in the response — although
   * `snapshot.ts` reads the column and `hazard-card.tsx` already looks for a `magnitude_type`
   * comparison to render.
   *
   * `/methodology` states the rule this contradicts in its own words: "a moment magnitude and a
   * body-wave magnitude measure different things", which is why correlation discounts the
   * magnitude term by half across types. Presenting the difference between two scales as a 0.1
   * measurement spread — and as evidence that the sources agree — is the misleading scientific
   * output H5 names.
   */
  it('exposes each source magnitude type alongside the compared magnitudes', () => {
    const item = answerFor('all-fresh').briefing.briefing.snapshot.families.EARTHQUAKES.items.find(
      (entry) => entry.publicId === SCENARIO_IDS.nearbyEarthquake,
    );
    if (item === undefined) throw new Error('no M5.4 item on the card');

    const codes = (item.agreement?.comparisons ?? []).map((comparison) =>
      comparison.code.toUpperCase(),
    );
    expect(codes).toContain('MAGNITUDE');
    expect(codes).toContain('MAGNITUDE_TYPE');
  });
});

// -------------------------------------------------------------------------------------------
// F-6 — two surfaces describe the same satellite days in incompatible terms.
// -------------------------------------------------------------------------------------------

describe('F-6 · the two fire surfaces must not contradict each other about coverage', () => {
  /*
   * `/history?family=FIRE_ACTIVITY` refuses with `INSUFFICIENT_COVERAGE` and marks all 35 days
   * `NOT_COVERED` — read from `fire_daily_counts` / `fire_daily_coverage`, which the scenario
   * leaves empty (ADR-040's honest refusal). The cluster page, reading `fire_detections` for the
   * same place, prints "Thermal detections per day · 2026-09-21: 9 · 2026-09-22: 5".
   *
   * One of the two is wrong about whether the satellites saw this place on those days, and a
   * reader has no way to tell which. Either the daily aggregate must be written wherever
   * detections are (so the refusal is real), or a day with detections may not be reported as
   * `NOT_COVERED`. This is partly a seeding gap — the seed writes detections and no aggregate —
   * and it is filed because nothing in the read path notices the contradiction.
   */
  it('does not call a day NOT_COVERED when it holds detections', () => {
    const { history, cluster } = answerFor('all-fresh');
    if (cluster.kind !== 'found') throw new Error('no cluster');

    const daysWithDetections = new Set(
      cluster.detail.detections.byDay
        .filter((day) => day.count > 0)
        .map((day) => day.day.slice(0, 10)),
    );
    const series = history.fire.series[0];
    const contradictions = (series?.points ?? [])
      .filter(
        (point) =>
          point.value === null &&
          point.missingReason === 'NOT_COVERED' &&
          daysWithDetections.has(point.t.slice(0, 10)),
      )
      .map((point) => point.t.slice(0, 10));

    expect(contradictions).toEqual([]);
  });
});
