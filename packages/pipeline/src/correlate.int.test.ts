/**
 * Correlation against a real database.
 *
 * The unit tests prove the *decision* is right; these prove the decision reaches the database
 * intact and that the loop around it has the properties the read path depends on — a record joins
 * exactly one event, re-running changes nothing, and the answer does not depend on the order the
 * rows happened to be inserted in.
 *
 * Every geometry here is built from a stated offset rather than a copied coordinate, and the
 * misfits the assertions depend on are written out from the published scales in
 * `earthquake.config.ts` so that a threshold change breaks the test that relied on it instead of
 * silently re-labelling what the test is about.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DECISION, HYSTERESIS_MISFIT, MISFIT_SCALES, candidateScore } from '@geonerva/correlation';
import { createDb, derivationsAsOf, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation } from '@geonerva/db/testing/factories';

import { correlateEarthquakes, seedSingleSourceEvents } from './correlate.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
});

const T0 = new Date('2026-09-20T08:00:00.000Z');
const INGEST = new Date('2026-09-20T09:00:00.000Z');
const AS_OF = new Date('2026-09-20T10:00:00.000Z');
/*
 * A later ingest, and the run that sees it. A revision is only *visible as a revision* when it
 * arrives after the link was decided — `linked_at < ingested_at` is what makes a record show up
 * as needing re-evaluation, and correlation stamps links with the knowledge time it ran at.
 */
const LATER_INGEST = new Date('2026-09-20T11:00:00.000Z');
const LATER_AS_OF = new Date('2026-09-20T12:00:00.000Z');
const seconds = (n: number): Date => new Date(T0.getTime() + n * 1000);

/** Marrakech, as a starting point that is nowhere near a real catalogue entry. */
const AT = { lat: 31.6295, lon: -7.9811 };

/**
 * A point `km` north of `AT`.
 *
 * The shortest degree of latitude is 110.574 km (WGS84, at the equator), so dividing by it
 * over-states the separation slightly. Every assertion below is written so that over-stating is
 * the safe direction: a test that asserts a pair still matches is made harder, not easier.
 */
function north(km: number): { lat: number; lon: number } {
  return { lat: AT.lat + km / 110.574, lon: AT.lon };
}

interface SeedOptions {
  readonly sourceId?: string;
  readonly primaryKey: string;
  readonly aliases?: readonly string[];
  readonly at?: { lat: number; lon: number };
  readonly originTime?: Date;
  readonly magnitude?: number | null;
  readonly magnitudeType?: string;
  readonly contributor?: string | null;
  readonly derivedFrom?: unknown;
  readonly ingestedAt?: Date;
  readonly lifecycleStatus?: 'ACTIVE' | 'DELETED';
}

async function seed(options: SeedOptions): Promise<string> {
  const result = await seedObservation(db, {
    sourceId: options.sourceId ?? 'usgs',
    primaryKey: options.primaryKey,
    aliases: options.aliases ?? [options.primaryKey],
    ingestedAt: options.ingestedAt ?? INGEST,
    observedAt: options.originTime ?? T0,
    centroid: options.at ?? AT,
    magnitude: options.magnitude ?? 5.0,
    magnitudeType: options.magnitudeType ?? 'mww',
    depthKm: 10,
    contributor: options.contributor ?? null,
    derivedFrom: options.derivedFrom,
    lifecycleStatus: options.lifecycleStatus ?? 'ACTIVE',
  });
  return result.sourceRecordId;
}

/** Every active link, as `primaryKey -> canonical public id`. */
async function activeLinks(): Promise<Record<string, string>> {
  const result = await sql<{ primary_key: string; public_id: string; relation: string }>`
    SELECT r.primary_key, e.public_id, l.relation
    FROM geonerva.canonical_links l
    JOIN geonerva.source_records r ON r.id = l.source_record_id
    JOIN geonerva.canonical_events e ON e.id = l.canonical_event_id
    WHERE l.unlinked_at IS NULL
    ORDER BY r.primary_key
  `.execute(db);
  const links: Record<string, string> = {};
  for (const row of result.rows) links[row.primary_key] = row.public_id;
  return links;
}

/** The partition of records into events, independent of the public ids that were allocated. */
async function grouping(): Promise<string[][]> {
  const links = await activeLinks();
  const byEvent = new Map<string, string[]>();
  for (const [primaryKey, publicId] of Object.entries(links)) {
    const group = byEvent.get(publicId);
    if (group === undefined) byEvent.set(publicId, [primaryKey]);
    else group.push(primaryKey);
  }
  /*
   * Sorted by code unit, not by `localeCompare`. A locale-aware comparison orders `em1` before
   * `EQ-1` under some collations and after it under others, which would make these assertions
   * depend on the machine rather than on the grouping they are about.
   */
  const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...byEvent.values()]
    .map((group) => [...group].sort(byCodeUnit))
    .sort((a, b) => byCodeUnit(a[0] ?? '', b[0] ?? ''));
}

async function stateOf(primaryKey: string): Promise<{
  n_sources: number;
  n_independent_sources: number;
  agreement: { level: string };
  magnitude: string | null;
  headline: Record<string, unknown>;
}> {
  const result = await sql<{
    n_sources: number;
    n_independent_sources: number;
    agreement: { level: string };
    magnitude: string | null;
    headline: Record<string, unknown>;
  }>`
    SELECT s.n_sources, s.n_independent_sources, s.agreement, s.magnitude, s.headline
    FROM geonerva.canonical_event_state s
    JOIN geonerva.canonical_links l
      ON l.canonical_event_id = s.canonical_event_id AND l.unlinked_at IS NULL
    JOIN geonerva.source_records r ON r.id = l.source_record_id
    WHERE r.primary_key = ${primaryKey}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no projection for ${primaryKey}`);
  return row;
}

describe('two independent solutions of one earthquake', () => {
  it('merges them into one canonical event and reports two independent sources', async () => {
    /*
     * Δt 2 s / 5 km / ΔM 0.1, both Mw. Misfit = 2/16 + 5/100 + 0.1/0.8 = 0.3, well inside the 1.0
     * that `DECISION.matchMisfit` allows, and with no competitor the uniqueness gap is infinite.
     */
    const misfit =
      2 / MISFIT_SCALES.timeSeconds +
      5000 / MISFIT_SCALES.distanceMeters +
      0.1 / MISFIT_SCALES.magnitude;
    expect(misfit).toBeLessThan(DECISION.matchMisfit);

    await seed({ sourceId: 'usgs', primaryKey: 'us1', contributor: 'us' });
    await seed({
      sourceId: 'emsc',
      primaryKey: 'em1',
      contributor: 'EMSC',
      originTime: seconds(2),
      at: north(5),
      magnitude: 5.1,
    });

    const result = await correlateEarthquakes(db, { asOf: AS_OF });
    expect(result.considered).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.created).toBe(1);

    expect(await grouping()).toEqual([['em1', 'us1']]);
    const state = await stateOf('us1');
    expect(state.n_sources).toBe(2);
    expect(state.n_independent_sources).toBe(2);
    expect(state.agreement.level).toBe('AGREE');
  });

  it('never merges two records from the same source', async () => {
    /*
     * Stage 0's invariant. These two USGS records are 2 s and 5 km apart — a misfit that would
     * match across sources — but ComCat has already decided they are different earthquakes, and
     * overriding that collapses an aftershock sequence into a single event.
     */
    await seed({ sourceId: 'usgs', primaryKey: 'us1' });
    await seed({ sourceId: 'usgs', primaryKey: 'us2', originTime: seconds(2), at: north(5) });

    await correlateEarthquakes(db, { asOf: AS_OF });
    expect(await grouping()).toEqual([['us1'], ['us2']]);
  });

  it('opens separate events for solutions outside the candidate window', async () => {
    // 200 km apart: beyond `CANDIDATE_WINDOW.maxDistanceMeters`, so nothing is even scored.
    await seed({ sourceId: 'usgs', primaryKey: 'us1' });
    await seed({ sourceId: 'emsc', primaryKey: 'em1', at: north(200) });

    const result = await correlateEarthquakes(db, { asOf: AS_OF });
    expect(result.created).toBe(2);
    expect(await grouping()).toEqual([['em1'], ['us1']]);
  });
});

describe('a republication is not a second opinion', () => {
  it('links a GDACS copy as DERIVED_COPY and does not count it as independent', async () => {
    /*
     * ADR-030 and ADR-006. GDACS restating the USGS solution adds a row, not a source. Counting it
     * would report "2 sources, they agree" for a copy agreeing with its original — the most
     * expensive lie this system can tell.
     */
    await seed({ sourceId: 'usgs', primaryKey: 'us1', aliases: ['us1', 'usc000abcd'] });
    await correlateEarthquakes(db, { asOf: AS_OF });

    await seed({
      sourceId: 'gdacs',
      primaryKey: 'EQ-1',
      at: north(3),
      originTime: seconds(1),
      derivedFrom: { source: 'usgs', ref: 'usc000abcd' },
      ingestedAt: LATER_INGEST,
    });
    const result = await correlateEarthquakes(db, { asOf: LATER_AS_OF });

    expect(result.identityMatched).toBe(1);
    expect(await grouping()).toEqual([['EQ-1', 'us1']]);

    const state = await stateOf('us1');
    expect(state.n_sources).toBe(2);
    expect(state.n_independent_sources).toBe(1);
    expect(state.agreement.level).toBe('DERIVED_ONLY');
  });

  it('holds a cross-reference it cannot resolve rather than guessing', async () => {
    /*
     * GDACS can arrive before the USGS record it names. Correlating it spatiotemporally in the
     * meantime would create an event that the later USGS ingestion has to merge away, so within
     * the 24-hour horizon the record is left alone and the next run re-reads it.
     */
    await seed({
      sourceId: 'gdacs',
      primaryKey: 'EQ-2',
      derivedFrom: { source: 'usgs', ref: 'us-not-ingested' },
      originTime: new Date(AS_OF.getTime() - 60 * 60 * 1000),
    });

    const result = await correlateEarthquakes(db, { asOf: AS_OF });
    expect(result.pendingIdentityRef).toBe(1);
    expect(await grouping()).toEqual([]);
  });

  it('falls back to spatiotemporal matching once the horizon has passed', async () => {
    await seed({
      sourceId: 'gdacs',
      primaryKey: 'EQ-3',
      derivedFrom: { source: 'usgs', ref: 'us-never-arrives' },
      originTime: new Date(AS_OF.getTime() - 48 * 60 * 60 * 1000),
    });

    const result = await correlateEarthquakes(db, { asOf: AS_OF });
    expect(result.pendingIdentityRef).toBe(0);
    expect(result.created).toBe(1);
    expect(await grouping()).toEqual([['EQ-3']]);
  });
});

describe('a pair that might be one event is shown as two', () => {
  it('records the candidate instead of merging on a maybe', async () => {
    /*
     * Δt 20 s and nothing else: misfit 20/16 = 1.25, above `matchMisfit` and below
     * `possibleMisfit`. Merging here would produce an event that reports itself as corroborated by
     * two independent sources when it may be two different earthquakes; two events cost a
     * sentence.
     */
    const misfit = 20 / MISFIT_SCALES.timeSeconds;
    expect(misfit).toBeGreaterThan(DECISION.matchMisfit);
    expect(misfit).toBeLessThanOrEqual(DECISION.possibleMisfit);

    await seed({ sourceId: 'usgs', primaryKey: 'us1' });
    await seed({ sourceId: 'emsc', primaryKey: 'em1', originTime: seconds(20) });

    const result = await correlateEarthquakes(db, { asOf: AS_OF });
    expect(result.possible).toBe(1);
    expect(await grouping()).toEqual([['em1'], ['us1']]);

    const candidates = await sql<{ decision: string; score: string }>`
      SELECT decision, score FROM geonerva.correlation_candidates
    `.execute(db);
    expect(candidates.rows).toHaveLength(1);
    expect(candidates.rows[0]?.decision).toBe('POSSIBLE_MATCH');
    /*
     * The stored score is the bounded restatement of the misfit, not the misfit: the column is
     * constrained to [0, 1] and a misfit is neither bounded nor oriented that way. The misfit
     * itself survives at full precision in `reasons`.
     */
    expect(Number(candidates.rows[0]?.score)).toBeCloseTo(candidateScore(misfit), 3);
    expect(candidateScore(misfit)).toBeLessThan(candidateScore(DECISION.matchMisfit));
  });
});

describe('re-running the derivation', () => {
  it('changes nothing when the facts have not changed', async () => {
    /*
     * Idempotence is what makes the run resumable: a run that dies halfway must be safe to repeat,
     * and a second pass that re-linked everything would churn `linked_at` and fill "What Changed?"
     * with merges no earthquake caused.
     */
    await seed({ sourceId: 'usgs', primaryKey: 'us1' });
    await seed({ sourceId: 'emsc', primaryKey: 'em1', originTime: seconds(2), at: north(5) });

    await correlateEarthquakes(db, { asOf: AS_OF });
    const before = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM geonerva.canonical_links`.execute(db);
    const firstGrouping = await grouping();

    const second = await correlateEarthquakes(db, { asOf: new Date(AS_OF.getTime() + 60_000) });
    const after = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM geonerva.canonical_links`.execute(db);

    expect(second.considered).toBe(0);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect(await grouping()).toEqual(firstGrouping);
  });

  it('produces the same grouping whatever order the records were ingested in', async () => {
    /*
     * A chain, which is the only shape where processing order can change the answer. Three
     * solutions 60 km apart in a line: the ends match the middle and **not each other**, so
     * whichever record is correlated first decides whether the far end joins one event or opens
     * its own. Correlating in origin-time order makes that a property of the earthquakes rather
     * than of the order the rows arrived in.
     *
     * Misfits, from the published scales: middle↔end is 1/16 + 60/100 = 0.66, a match; end↔end is
     * 2/16 + 120/100 = 1.325, which is a POSSIBLE_MATCH and merges nothing.
     */
    const adjacent = 1 / MISFIT_SCALES.timeSeconds + 60_000 / MISFIT_SCALES.distanceMeters;
    const ends = 2 / MISFIT_SCALES.timeSeconds + 120_000 / MISFIT_SCALES.distanceMeters;
    expect(adjacent).toBeLessThanOrEqual(DECISION.matchMisfit);
    expect(ends).toBeGreaterThan(DECISION.matchMisfit);
    expect(ends).toBeLessThanOrEqual(DECISION.possibleMisfit);

    const west = { sourceId: 'usgs', primaryKey: 'us1', at: north(0), originTime: T0 } as const;
    const middle = {
      sourceId: 'emsc',
      primaryKey: 'em1',
      at: north(60),
      originTime: seconds(1),
    } as const;
    const east = {
      sourceId: 'gdacs',
      primaryKey: 'EQ-1',
      at: north(120),
      originTime: seconds(2),
    } as const;

    await seed(west);
    await seed(middle);
    await seed(east);
    await correlateEarthquakes(db, { asOf: AS_OF });
    const first = await grouping();

    await testDb.truncate();

    await seed(east);
    await seed(middle);
    await seed(west);
    await correlateEarthquakes(db, { asOf: AS_OF });

    expect(await grouping()).toEqual(first);
    expect(first).toEqual([['EQ-1'], ['em1', 'us1']]);
  });
});

describe('a revised solution', () => {
  it('keeps the link when the revision still fits, without writing a new link row', async () => {
    /*
     * Hysteresis. The revised epicentre is 100 km from the other member: misfit
     * 2/16 + 100/100 + 0.1/0.8 = 1.25, which is beyond the 1.0 that created the link and inside
     * the 1.5 that keeps it. Re-deciding from scratch on every revision would make links flap as
     * solutions are refined.
     */
    const revised =
      2 / MISFIT_SCALES.timeSeconds +
      100_000 / MISFIT_SCALES.distanceMeters +
      0.1 / MISFIT_SCALES.magnitude;
    expect(revised).toBeGreaterThan(DECISION.matchMisfit);
    expect(revised).toBeLessThanOrEqual(HYSTERESIS_MISFIT);

    await seed({ sourceId: 'usgs', primaryKey: 'us1' });
    await seed({
      sourceId: 'emsc',
      primaryKey: 'em1',
      originTime: seconds(2),
      at: north(5),
      magnitude: 5.1,
    });
    await correlateEarthquakes(db, { asOf: AS_OF });
    const linksBefore = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM geonerva.canonical_links`.execute(db);

    // The USGS solution is revised 100 km north of where EMSC puts it, after the link was made.
    await seed({
      sourceId: 'usgs',
      primaryKey: 'us1',
      at: north(105),
      ingestedAt: LATER_INGEST,
    });
    const result = await correlateEarthquakes(db, { asOf: LATER_AS_OF });

    expect(result.revisionsKept).toBe(1);
    expect(await grouping()).toEqual([['em1', 'us1']]);
    const linksAfter = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM geonerva.canonical_links`.execute(db);
    expect(linksAfter.rows[0]?.n).toBe(linksBefore.rows[0]?.n);
  });

  it('breaks the link and re-correlates when the revision no longer fits', async () => {
    /*
     * 140 km from the other member: misfit 2/16 + 140/100 + 0.1/0.8 = 1.65, beyond hysteresis. The
     * old link is closed with a reason rather than edited, so a replay shows the correlation
     * GeoNerva actually believed before the revision.
     */
    const revised =
      2 / MISFIT_SCALES.timeSeconds +
      140_000 / MISFIT_SCALES.distanceMeters +
      0.1 / MISFIT_SCALES.magnitude;
    expect(revised).toBeGreaterThan(HYSTERESIS_MISFIT);

    await seed({ sourceId: 'usgs', primaryKey: 'us1' });
    await seed({
      sourceId: 'emsc',
      primaryKey: 'em1',
      originTime: seconds(2),
      at: north(5),
      magnitude: 5.1,
    });
    await correlateEarthquakes(db, { asOf: AS_OF });

    await seed({
      sourceId: 'usgs',
      primaryKey: 'us1',
      at: north(145),
      ingestedAt: LATER_INGEST,
    });
    const result = await correlateEarthquakes(db, { asOf: LATER_AS_OF });

    expect(result.revisionsBroken).toBe(1);
    expect(await grouping()).toEqual([['em1'], ['us1']]);

    const closed = await sql<{ unlink_reason: string }>`
      SELECT unlink_reason FROM geonerva.canonical_links WHERE unlinked_at IS NOT NULL
    `.execute(db);
    expect(closed.rows.map((row) => row.unlink_reason)).toContain('REVISION_BROKE_MATCH');
  });

  it('breaks a link when the revision has moved away from any one member', async () => {
    /*
     * The worst fit decides, not the best. This event holds three sources: USGS at the origin,
     * EMSC beside it, and GDACS 95 km away — each of which matched the USGS solution when it
     * linked. The USGS solution is then revised 200 km north, which is 2.0 away from EMSC and
     * 1.05 away from GDACS. Taking the *best* fit would keep a link that the members themselves no
     * longer support, and the event would carry a solution 200 km from one of its own sources.
     */
    const toNear = 200_000 / MISFIT_SCALES.distanceMeters;
    const toFar = 105_000 / MISFIT_SCALES.distanceMeters;
    expect(toNear).toBeGreaterThan(HYSTERESIS_MISFIT);
    expect(toFar).toBeLessThanOrEqual(HYSTERESIS_MISFIT);

    await seed({ sourceId: 'usgs', primaryKey: 'us1', at: north(0) });
    await seed({ sourceId: 'emsc', primaryKey: 'em1', at: north(0) });
    await seed({ sourceId: 'gdacs', primaryKey: 'EQ-1', at: north(95) });
    await correlateEarthquakes(db, { asOf: AS_OF });
    expect(await grouping()).toEqual([['EQ-1', 'em1', 'us1']]);

    await seed({ sourceId: 'usgs', primaryKey: 'us1', at: north(200), ingestedAt: LATER_INGEST });
    const result = await correlateEarthquakes(db, { asOf: LATER_AS_OF });

    expect(result.revisionsBroken).toBe(1);
    expect(await grouping()).toEqual([['EQ-1', 'em1'], ['us1']]);
  });

  it('does not let a broken link re-form against the event it just left', async () => {
    /*
     * The flap this prevents. When a revision breaks a link, the event it left is still in the
     * candidate window — and its projection is still anchored on the *pre-revision* solution,
     * because the cache has not been rebuilt yet. Scoring against that stale anchor compares the
     * record with an older version of itself, which fits well by construction, and the record
     * re-joins the event it was just removed from. The link would then break again on the next
     * run, forever.
     *
     * USGS at the origin and EMSC 95 km north match (0.95). The USGS solution is then revised
     * 60 km *south*: 155 km from EMSC, so 1.55 — beyond hysteresis, the link breaks. But it is
     * only 60 km from where USGS used to be, so against the stale anchor it scores 0.6, a clean
     * match. Excluding the event it just left is what stops that.
     */
    const toMember = 155_000 / MISFIT_SCALES.distanceMeters;
    const toStaleAnchor = 60_000 / MISFIT_SCALES.distanceMeters;
    expect(toMember).toBeGreaterThan(HYSTERESIS_MISFIT);
    expect(toStaleAnchor).toBeLessThanOrEqual(DECISION.matchMisfit);

    await seed({ sourceId: 'usgs', primaryKey: 'us1', at: north(0) });
    await seed({ sourceId: 'emsc', primaryKey: 'em1', at: north(95) });
    await correlateEarthquakes(db, { asOf: AS_OF });
    expect(await grouping()).toEqual([['em1', 'us1']]);

    await seed({ sourceId: 'usgs', primaryKey: 'us1', at: north(-60), ingestedAt: LATER_INGEST });
    const result = await correlateEarthquakes(db, { asOf: LATER_AS_OF });

    expect(result.revisionsBroken).toBe(1);
    expect(await grouping()).toEqual([['em1'], ['us1']]);
  });
});

describe('what the derivation records about itself', () => {
  it('writes an analysis run that the availability model can see', async () => {
    /*
     * Without this row, a location with no canonical events is indistinguishable from a location
     * whose correlation has never run, and the product reports the second as "nothing to report".
     */
    await seed({ sourceId: 'usgs', primaryKey: 'us1' });
    const result = await correlateEarthquakes(db, { asOf: AS_OF });

    const [state] = await derivationsAsOf(db, {
      asOf: new Date(Date.now() + 60_000),
      kinds: ['CORRELATION'],
    });
    expect(state?.lastSucceededAt).not.toBeNull();
    expect(state?.latestStatus).toBe('SUCCEEDED');

    const runs = await sql<{ id: string; stats: { created: number } }>`
      SELECT id::text AS id, stats FROM geonerva.analysis_runs WHERE kind = 'CORRELATION'
    `.execute(db);
    expect(runs.rows[0]?.id).toBe(result.runId);
    expect(runs.rows[0]?.stats.created).toBe(1);
  });

  it('does not correlate a tombstoned record', async () => {
    // A deleted record is not evidence of an earthquake, and linking it would keep it on the map.
    await seed({ sourceId: 'usgs', primaryKey: 'us1', lifecycleStatus: 'DELETED' });
    const result = await correlateEarthquakes(db, { asOf: AS_OF });
    expect(result.considered).toBe(0);
    expect(await grouping()).toEqual([]);
  });

  it('does not see facts ingested after the knowledge time it was given', async () => {
    await seed({ sourceId: 'usgs', primaryKey: 'us1', ingestedAt: INGEST });
    await seed({
      sourceId: 'emsc',
      primaryKey: 'em1',
      originTime: seconds(2),
      at: north(5),
      ingestedAt: new Date(AS_OF.getTime() + 60_000),
    });

    const result = await correlateEarthquakes(db, { asOf: AS_OF });
    expect(result.considered).toBe(1);
    expect(await grouping()).toEqual([['us1']]);
  });
});

describe('hazards with only one source', () => {
  /*
   * GDACS is the only source for floods, cyclones and volcanoes, so there is nothing to correlate
   * them against. They still need a canonical event — the read model points at subjects, not at
   * source records — but the event must not be dressed up as a match that was made.
   */
  async function seedGdacs(
    primaryKey: string,
    hazardType: 'FLOOD' | 'TROPICAL_CYCLONE' | 'VOLCANO',
  ): Promise<void> {
    await seedObservation(db, {
      sourceId: 'gdacs',
      hazardType,
      primaryKey,
      aliases: [primaryKey],
      ingestedAt: INGEST,
      observedAt: T0,
      centroid: AT,
      magnitude: null,
      severityScheme: 'GDACS_ALERT',
      severityValue: 'Orange',
    });
  }

  it('gives each record its own event, marked SEED rather than matched', async () => {
    await seedGdacs('FL-1', 'FLOOD');
    await seedGdacs('TC-1', 'TROPICAL_CYCLONE');

    const result = await seedSingleSourceEvents(db, { asOf: AS_OF });
    expect(result.created).toBe(2);
    expect(await grouping()).toEqual([['FL-1'], ['TC-1']]);

    const links = await sql<{ match_kind: string; relation: string; confidence: string | null }>`
      SELECT match_kind, relation, confidence FROM geonerva.canonical_links
    `.execute(db);
    expect(links.rows.map((row) => row.match_kind)).toEqual(['SEED', 'SEED']);
    expect(links.rows.map((row) => row.relation)).toEqual(['PRIMARY', 'PRIMARY']);
    // No confidence, because no decision was made. A number here would imply one was.
    expect(links.rows.map((row) => row.confidence)).toEqual([null, null]);
  });

  it('reports a lone record as SINGLE_SOURCE, never as agreement', async () => {
    await seedGdacs('VO-1', 'VOLCANO');
    await seedSingleSourceEvents(db, { asOf: AS_OF });

    const state = await stateOf('VO-1');
    expect(state.agreement.level).toBe('SINGLE_SOURCE');
    expect(state.n_sources).toBe(1);
    expect(state.n_independent_sources).toBe(1);
  });

  it('does not seed a second event for a record that already has one', async () => {
    await seedGdacs('FL-2', 'FLOOD');
    await seedSingleSourceEvents(db, { asOf: AS_OF });
    const second = await seedSingleSourceEvents(db, { asOf: LATER_AS_OF });

    expect(second.considered).toBe(0);
    expect(await grouping()).toEqual([['FL-2']]);
  });

  it('leaves earthquakes to the matcher', async () => {
    // Seeding an earthquake would open an event that correlation then has to merge away.
    await seed({ sourceId: 'usgs', primaryKey: 'us1' });
    const result = await seedSingleSourceEvents(db, { asOf: AS_OF });
    expect(result.considered).toBe(0);
    expect(await grouping()).toEqual([]);
  });
});
