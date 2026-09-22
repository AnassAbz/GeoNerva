/**
 * The seeded E2E scenario database, against real PostGIS (docs/TESTING.md §5).
 *
 * This is the test that has to exist before Playwright can be trusted. An E2E suite asserting on
 * a page built from a database nobody checked will report a seeding mistake as a UI regression,
 * and the two are not remotely the same investigation. So the seed is exercised here through the
 * same three read models the pages call — `buildBriefing`, `buildHistory`, `buildMapFeatures` —
 * and what is asserted is that **they answer rather than refuse**, that the invariants the
 * integration harness cares about hold on the seeded rows, and that the one difference between the
 * two scenarios shows up in the one place it should.
 *
 * The clock is `SCENARIO_ANCHOR`, never `new Date()`. That is the same value a Playwright run
 * passes as `GEONERVA_FAKE_NOW`, so this test and that run describe the same instant.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import {
  MARRAKECH_REF,
  SCENARIO_ANCHOR,
  SCENARIO_IDS,
  seedMarrakechScenario,
  type ScenarioName,
} from '@geonerva/test-fixtures/scenarios';
import {
  historyResponseSchema,
  locationBriefingSchema,
  mapFeaturesResponseSchema,
  type LocationRef,
  type SubjectSummary,
} from '@geonerva/domain';

import { buildBriefing } from './briefing.ts';
import { buildHistory } from './history.ts';
import { buildMapFeatures } from './map-features.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const AS_OF = new Date(SCENARIO_ANCHOR);
const ENGINE = 'scenario-int-1';
const LOCATION: LocationRef = { ...MARRAKECH_REF };

/**
 * Both scenarios, seeded and read once.
 *
 * They cannot coexist: they mint the same public ids, so the database is truncated between them.
 * Seeding writes a few thousand rows through the production writers one transaction at a time,
 * which is slower than a hand-built fixture and is exactly the point — it is the path a real run
 * takes. Re-seeding per test would cost minutes, so each scenario is read while it is loaded and
 * its answers are kept.
 */
const seeds = new Map<ScenarioName, Awaited<ReturnType<typeof seedMarrakechScenario>>>();
const answers = new Map<ScenarioName, Awaited<ReturnType<typeof readAll>>>();

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
  for (const scenario of ['all-fresh', 'firms-stale'] as const) {
    await testDb.truncate();
    seeds.set(scenario, await seedMarrakechScenario(db, scenario));
    answers.set(scenario, await readAll());
  }
}, 900_000);

afterAll(async () => {
  await db.destroy();
});

async function readAll(): Promise<{
  readonly briefing: Awaited<ReturnType<typeof buildBriefing>>;
  readonly eqHistory: Awaited<ReturnType<typeof buildHistory>>;
  readonly fireHistory: Awaited<ReturnType<typeof buildHistory>>;
  readonly map: Awaited<ReturnType<typeof buildMapFeatures>>;
  readonly invariants: Awaited<ReturnType<typeof readInvariants>>;
}> {
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
  const eqHistory = await buildHistory({
    db,
    location: LOCATION,
    family: 'EARTHQUAKES',
    metric: 'EQ_COUNT_7D',
    radiusKm: 150,
    asOf: AS_OF,
    retentionProfile: 'lean',
  });
  const fireHistory = await buildHistory({
    db,
    location: LOCATION,
    family: 'FIRE_ACTIVITY',
    metric: 'FIRE_TREND',
    radiusKm: 100,
    asOf: AS_OF,
    retentionProfile: 'lean',
  });
  const map = await buildMapFeatures({
    db,
    bbox: { west: -10.5, south: 29.5, east: -5.5, north: 33.0 },
    zoom: 7,
    families: ['EARTHQUAKES', 'FIRE_ACTIVITY', 'FLOODS'],
    asOf: AS_OF,
    retentionProfile: 'lean',
  });
  return { briefing, eqHistory, fireHistory, map, invariants: await readInvariants() };
}

/** The invariants the integration harness asserts, read straight off the seeded rows. */
async function readInvariants(): Promise<{
  readonly versionsWithoutBitemporalColumns: number;
  readonly versionsObservedTooLate: number;
  readonly coverageProducts: number;
  readonly coverageHoursWithoutRecordedAt: number;
  readonly recordsWithTwoActiveLinks: number;
}> {
  const row = await sql<{
    bitemporal: string;
    too_late: string;
    coverage_products: string;
    coverage_unstamped: string;
    double_linked: string;
  }>`
    SELECT
      -- valid_from is deliberately not here: it is nullable, and only the facts that carry a
      -- validity interval set it. The two stamps every version must have are the bitemporal pair.
      (SELECT count(*) FROM geonerva.observation_versions
        WHERE ingested_at IS NULL OR observed_at IS NULL)::text AS bitemporal,
      (SELECT count(*) FROM geonerva.observation_versions
        WHERE observed_at > ingested_at + interval '5 minutes')::text AS too_late,
      (SELECT count(DISTINCT product_id) FROM geonerva.feed_coverage_hours)::text
        AS coverage_products,
      (SELECT count(*) FROM geonerva.feed_coverage_hours WHERE recorded_at IS NULL)::text
        AS coverage_unstamped,
      (SELECT count(*) FROM (
        SELECT source_record_id FROM geonerva.canonical_links
        WHERE unlinked_at IS NULL GROUP BY source_record_id HAVING count(*) > 1) AS d)::text
        AS double_linked
  `.execute(db);
  const values = row.rows[0];
  if (values === undefined) throw new Error('no invariant row');
  return {
    versionsWithoutBitemporalColumns: Number(values.bitemporal),
    versionsObservedTooLate: Number(values.too_late),
    coverageProducts: Number(values.coverage_products),
    coverageHoursWithoutRecordedAt: Number(values.coverage_unstamped),
    recordsWithTwoActiveLinks: Number(values.double_linked),
  };
}

/** One card item by public id, asserted present so nothing below needs optional chaining. */
function itemOf(items: readonly SubjectSummary[], publicId: string): SubjectSummary {
  const found = items.find((item) => item.publicId === publicId);
  if (found === undefined) throw new Error(`the seeded scenario has no item ${publicId}`);
  return found;
}

function answerFor(scenario: ScenarioName) {
  const answer = answers.get(scenario);
  if (answer === undefined) throw new Error(`no answers for ${scenario}`);
  return answer;
}

describe('the seed itself', () => {
  it('writes rows into every table the read paths depend on', () => {
    const counts = seeds.get('all-fresh')?.counts;
    expect(counts).toBeDefined();
    // Stated individually rather than as one object, so a failure names the table that is empty.
    expect(counts?.['places']).toBe(1);
    expect(counts?.['canonical_events']).toBeGreaterThan(140);
    expect(counts?.['observation_versions']).toBeGreaterThan(140);
    expect(counts?.['observation_geometries']).toBeGreaterThan(0);
    expect(counts?.['canonical_links']).toBeGreaterThan(140);
    expect(counts?.['ingestion_runs']).toBeGreaterThan(20);
    expect(counts?.['analysis_runs']).toBe(5);
    expect(counts?.['fire_clusters']).toBe(1);
    expect(counts?.['fire_cluster_versions']).toBe(3);
    expect(counts?.['fire_detections']).toBe(14);
    // ADR-041: enough ledger hours behind the 7-day baseline to have a reference period at all.
    expect(counts?.['feed_coverage_hours']).toBeGreaterThan(52 * 7 * 24);
  });

  it('is anchored to one instant, stated in the seed and in the anchor constant', () => {
    expect(seeds.get('all-fresh')?.anchor).toBe(SCENARIO_ANCHOR);
    expect(seeds.get('firms-stale')?.anchor).toBe(SCENARIO_ANCHOR);
  });

  it.each(['all-fresh', 'firms-stale'] as const)(
    'satisfies the harness invariants in %s',
    (scenario) => {
      const { invariants } = answerFor(scenario);
      // Bitemporal columns set on every version, and I13: observed_at ≤ ingested_at + 5 min.
      expect(invariants.versionsWithoutBitemporalColumns).toBe(0);
      expect(invariants.versionsObservedTooLate).toBe(0);
      // I6: a source record has at most one active canonical link.
      expect(invariants.recordsWithTwoActiveLinks).toBe(0);
      // ADR-041: coverage is recorded per feed, with the instant it became true.
      expect(invariants.coverageProducts).toBeGreaterThanOrEqual(3);
      expect(invariants.coverageHoursWithoutRecordedAt).toBe(0);
    },
  );

  it('rounds the place to the two decimals invariant I15 requires', () => {
    // The seeded GeoNames row carries full precision; what a response may carry is two decimals.
    for (const value of [MARRAKECH_REF.lat, MARRAKECH_REF.lon]) {
      expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-9);
    }
    const { briefing } = answerFor('all-fresh');
    expect(briefing.briefing.location.lat).toBe(MARRAKECH_REF.lat);
    expect(briefing.briefing.location.lon).toBe(MARRAKECH_REF.lon);
  });
});

describe('/briefing on the seeded scenario', () => {
  it.each(['all-fresh', 'firms-stale'] as const)('answers without refusing in %s', (scenario) => {
    const { briefing } = answerFor(scenario);
    // The contract, in full: a response that does not parse is a refusal with extra steps.
    const parsed = locationBriefingSchema.parse(briefing.briefing);
    expect(parsed.copy.headline.length).toBeGreaterThan(0);
    expect(parsed.copy.summary.length).toBeGreaterThan(0);
    // I9: every citation the response makes is in its own manifest. `strictManifest: true`
    // would already have thrown, so this is the assertion that it was on.
    expect(briefing.unresolvedEvidenceIds).toEqual([]);
    expect(parsed.evidenceManifest.length).toBeGreaterThan(0);
    expect(parsed.attribution.map((entry) => entry.sourceId)).toContain('usgs');
  });

  it('shows the earthquake, corroborated by two independent sources', () => {
    const { briefing } = answerFor('all-fresh');
    const card = briefing.briefing.snapshot.families.EARTHQUAKES;
    expect(card.availability).toBe('AVAILABLE');
    const ids = card.items.map((item) => item.publicId);
    expect(ids).toContain(SCENARIO_IDS.earthquake);

    const quake = itemOf(card.items, SCENARIO_IDS.earthquake);
    /*
     * Three sources reported it; GDACS republished USGS, so two of them are independent
     * (ADR-030). This is what the "per-source values and agreement" E2E flow reads.
     *
     * `LOW`, not the `MODERATE` the P9a mock claims: `assessSubject` reads the distance–magnitude
     * table, and an M4.7 at 144 km is in the low band. Pinned here because the mock's overstated
     * level is what makes its `chgEqNew` a HEADLINE change, which is why this scenario also
     * carries a nearer earthquake — see the seed's comment on `nearbyEarthquake`.
     */
    expect(quake.agreement?.nSources).toBe(3);
    expect(quake.agreement?.nIndependentSources).toBe(2);
    expect(quake.relevance.level).toBe('LOW');

    // And the nearer M5.4, also two independent sources, which is the card's first item.
    const nearby = itemOf(card.items, SCENARIO_IDS.nearbyEarthquake);
    expect(nearby.agreement?.nIndependentSources).toBe(2);
    expect(nearby.relevance.level).toBe('HIGH');
    // I10: only an authoritative alert can make a relevance CRITICAL, and GeoNerva holds none.
    expect(card.items.every((item) => item.relevance.level !== 'CRITICAL')).toBe(true);
  });

  it('has a change the "What Changed" region can list and link to', () => {
    /*
     * Not a decoration: two of §5's flows read this region ("dashboard loads with headline, What
     * Changed, cards" and "Open event from What Changed"), and a section whose every signal is
     * DETAIL or SUPPRESSED cannot support either. `EQ-26-8TD4XH` is in the scenario for exactly
     * this reason; the comment where it is seeded explains why the M4.7 does not qualify.
     */
    const { briefing } = answerFor('all-fresh');
    const prominent = [...briefing.briefing.changes.headline, ...briefing.briefing.changes.listed];
    expect(prominent.length).toBeGreaterThan(0);
    expect(prominent.map((signal) => signal.subjectRef)).toContain(
      `CE:${SCENARIO_IDS.nearbyEarthquake}`,
    );
    for (const signal of prominent) {
      expect(signal.title.length).toBeGreaterThan(0);
      expect(signal.evidenceIds.length).toBeGreaterThan(0);
    }
  });

  it('shows the flood event and says weather warnings are not covered here', () => {
    const { briefing } = answerFor('all-fresh');
    const floods = briefing.briefing.snapshot.families.FLOODS;
    expect(floods.availability).toBe('AVAILABLE');
    expect(floods.items.map((item) => item.publicId)).toContain(SCENARIO_IDS.flood);
    // ECCC is Canada-only and seeded disabled, so this card states a limit, not a count of zero.
    expect(briefing.briefing.snapshot.families.WEATHER_ALERTS.availability).toBe('NOT_COVERED');
  });
});

describe('the FIRMS outage variant', () => {
  it('shows the fire cluster when FIRMS is fresh', () => {
    const fire = answerFor('all-fresh').briefing.briefing.snapshot.families.FIRE_ACTIVITY;
    expect(fire.availability).toBe('AVAILABLE');
    expect(fire.items.map((item) => item.publicId)).toContain(SCENARIO_IDS.fireCluster);
  });

  it('is UNAVAILABLE and never says "0" when FIRMS has not delivered (invariant I11)', () => {
    const fire = answerFor('firms-stale').briefing.briefing.snapshot.families.FIRE_ACTIVITY;
    expect(fire.availability).toBe('UNAVAILABLE');
    // The two ways a card can claim emptiness, both forbidden here.
    expect(fire.items).toEqual([]);
    expect(fire.itemsTotal).toBe(0);
    expect(fire.availability).not.toBe('AVAILABLE');
    // And the card must say which source is missing, or "unavailable" is unexplained.
    const firms = fire.sourceHealth.filter((entry) => entry.sourceId === 'firms');
    expect(firms.length).toBeGreaterThan(0);
    expect(firms.every((entry) => entry.status === 'STALE' || entry.status === 'UNAVAILABLE')).toBe(
      true,
    );
  });

  it('leaves every other family alone', () => {
    const stale = answerFor('firms-stale').briefing.briefing.snapshot.families;
    const fresh = answerFor('all-fresh').briefing.briefing.snapshot.families;
    for (const family of ['EARTHQUAKES', 'FLOODS', 'WEATHER_ALERTS', 'CYCLONES'] as const) {
      expect(stale[family].availability).toBe(fresh[family].availability);
    }
  });
});

describe('/history on the seeded scenario', () => {
  it('answers the 7-day earthquake baseline from the read catalog rather than refusing', () => {
    const response = historyResponseSchema.parse(answerFor('all-fresh').eqHistory);
    // The point of five years of coverage ledger: a reference period exists, so the metric is
    // computed rather than reported as INSUFFICIENT_COVERAGE.
    expect(response.metric.status).toBe('OK');
    expect(response.metric.reference?.nWindows).toBeGreaterThanOrEqual(52);
    expect(response.metric.reference?.nEvents).toBeGreaterThanOrEqual(20);
    expect(response.metric.interpretation.length).toBeGreaterThan(0);
    expect(response.series.length).toBeGreaterThan(0);
    /*
     * The counting threshold is M4.5, not the M3.1 the P9a mock shows.
     * `estimateCompleteness` raises it to `RETENTION_FLOOR_MAGNITUDE` for any reference period
     * reaching past the 30 days small earthquakes are kept for, so a claim about M3s five years
     * back is one GeoNerva is not entitled to make. Asserted here because the first version of
     * this seed had a catalog of M3s and produced 259 windows with zero countable events.
     */
    expect(response.metric.observedValue).toStrictEqual({ kind: 'count', value: 2 });
    expect(response.metric.band).toBe('ABOVE_TYPICAL');
  });

  it('refuses the fire trend honestly, with a reason rather than a zero', () => {
    // FIRMS has no historical backfill in either scenario — five weeks of daily aggregate is not
    // something a seed can invent, and ADR-040 is explicit that an uncovered day is excluded, not
    // counted as quiet. So the metric states that limit, which is itself an E2E flow.
    const response = historyResponseSchema.parse(answerFor('all-fresh').fireHistory);
    expect(response.metric.status).not.toBe('OK');
    expect(response.metric.observedValue.kind).toBe('unavailable');
    expect(response.metric.interpretation.length).toBeGreaterThan(0);
  });
});

describe('/map-features on the seeded scenario', () => {
  it('draws the three subjects in the viewport', () => {
    const response = mapFeaturesResponseSchema.parse(answerFor('all-fresh').map);
    const ids = response.features.map((feature) => feature.publicId);
    expect(ids).toContain(SCENARIO_IDS.earthquake);
    expect(ids).toContain(SCENARIO_IDS.flood);
    expect(ids).toContain(SCENARIO_IDS.fireCluster);
  });

  it('answers at the same knowledge time the briefing did', () => {
    const { map, briefing } = answerFor('all-fresh');
    expect(map.asOfContext.asOf).toBe(briefing.briefing.asOfContext.asOf);
  });
});
