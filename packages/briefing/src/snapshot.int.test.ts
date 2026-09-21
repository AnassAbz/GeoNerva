/**
 * `buildSnapshot` against a real database.
 *
 * Three properties are being tested, and every one of them is invisible from the outside when it
 * breaks:
 *
 *  - **Determinism (I14).** The same database state, `asOf` and `engineVersion` produce the same
 *    `contentSha256`. The hash is the AI cache key, the change engine's identity for a snapshot,
 *    and the unique key of `location_snapshots`, so a hash that wobbles defeats all three quietly.
 *  - **Provenance (I9).** Every evidence ID the snapshot references is one the manifest can
 *    resolve, and every claim carries one.
 *  - **Availability (I11).** A card reports zero only when a usable source looked and a derivation
 *    ran. "Nothing is happening here" and "we cannot tell you" must never be the same output.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCanonicalEvent, createDb, linkRecord, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation, seedRun } from '@geonerva/db/testing/factories';
import { parseEvidenceId, type LocationRef } from '@geonerva/domain';

import { contentSha256 } from './content-hash.ts';
import { buildSnapshot } from './snapshot.ts';

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
const ENGINE = 'snapshot-test-1';

/** Marrakech. Chosen because ECCC does not cover it, which is the `NOT_COVERED` case. */
const MARRAKECH: LocationRef = {
  key: 'p:2542997',
  label: 'Marrakech',
  lat: 31.6295,
  lon: -7.9811,
  timezone: 'Africa/Casablanca',
  countryCode: 'MA',
  admin1: 'Marrakech-Safi',
};

/** A point `km` north of the location. 110.574 km is the shortest degree of latitude (WGS84). */
function north(km: number): { lat: number; lon: number } {
  return { lat: MARRAKECH.lat + km / 110.574, lon: MARRAKECH.lon };
}

async function build(asOf = AS_OF) {
  return buildSnapshot({
    db,
    location: MARRAKECH,
    asOf,
    engineVersion: ENGINE,
    generatedAt: new Date('2026-09-20T10:00:05.000Z'),
  });
}

/** A committed, successful run, so the source is healthy at `asOf`. */
async function healthySource(sourceId: string, productCode: string): Promise<void> {
  const product = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = ${sourceId} AND code = ${productCode}
  `.execute(db);
  await seedRun(db, {
    sourceId,
    productId: product.rows[0]?.id ?? null,
    status: 'SUCCEEDED',
    startedAt: INGEST,
    newestObservedAt: T0,
  });
}

/** A finished derivation, so the derivation axis does not report the family as un-run. */
async function derivationRan(kind: 'CORRELATION' | 'CLUSTERING', finishedAt: Date): Promise<void> {
  await sql`
    INSERT INTO geonerva.analysis_runs
      (id, kind, engine_version, started_at, finished_at, status)
    VALUES (gen_random_uuid(), ${kind}, ${ENGINE}, ${finishedAt}, ${finishedAt}, 'SUCCEEDED')
  `.execute(db);
}

/** One earthquake, linked to its own canonical event. */
async function seedLinkedEarthquake(options: {
  readonly primaryKey: string;
  readonly sourceId?: string;
  readonly magnitude?: number;
  readonly at?: { lat: number; lon: number };
  readonly canonicalEventId?: string;
  readonly publicId?: string;
  readonly relation?: 'PRIMARY' | 'SAME_EVENT' | 'DERIVED_COPY';
  readonly ingestedAt?: Date;
  readonly severityScheme?: string;
  readonly severityValue?: string;
  readonly observedAt?: Date;
}): Promise<{ canonicalEventId: string; publicId: string }> {
  const seeded = await seedObservation(db, {
    sourceId: options.sourceId ?? 'usgs',
    primaryKey: options.primaryKey,
    aliases: [options.primaryKey],
    ingestedAt: options.ingestedAt ?? INGEST,
    observedAt: options.observedAt ?? T0,
    centroid: options.at ?? north(20),
    magnitude: options.magnitude ?? 5.4,
    magnitudeType: 'mww',
    depthKm: 10,
    providerStatus: 'reviewed',
    contributor: 'us',
    severityScheme: options.severityScheme ?? null,
    severityValue: options.severityValue ?? null,
  });

  /*
   * The event is created through the repository rather than by raw SQL, so the public id is the
   * one `generatePublicId` produces. A hand-written id would not survive `isPublicId`, and a test
   * that invented its own identifier format would stop testing the one the product uses.
   */
  let canonicalEventId = options.canonicalEventId;
  let publicId = options.publicId ?? '';
  if (canonicalEventId === undefined) {
    const created = await createCanonicalEvent(db, {
      hazardType: 'EARTHQUAKE',
      createdAt: INGEST,
      ...(options.publicId === undefined ? {} : { publicId: options.publicId }),
    });
    canonicalEventId = created.id;
    publicId = created.publicId;
  }

  await db.transaction().execute(async (trx) => {
    await linkRecord(trx, {
      canonicalEventId,
      sourceRecordId: seeded.sourceRecordId,
      relation: options.relation ?? 'PRIMARY',
      matchKind: 'SPATIOTEMPORAL',
      algorithmVersion: 'eq-corr-1',
      linkedAt: INGEST,
    });
  });

  if (publicId === '') {
    const row = await sql<{ public_id: string }>`
      SELECT public_id FROM geonerva.canonical_events WHERE id = ${canonicalEventId}::uuid
    `.execute(db);
    publicId = row.rows[0]?.public_id ?? '';
  }
  return { canonicalEventId, publicId };
}

describe('the shape of a snapshot', () => {
  it('always returns every family, because "not covered" is a result', async () => {
    const { snapshot } = await build();
    expect(Object.keys(snapshot.families).sort()).toEqual([
      'CYCLONES',
      'EARTHQUAKES',
      'FIRE_ACTIVITY',
      'FLOODS',
      'OTHER',
      'WEATHER_ALERTS',
    ]);
  });

  it('reports weather warnings as NOT_COVERED here, with the reason', async () => {
    /*
     * ECCC is Canada-only and disabled, so no source covers weather warnings in Marrakech. This
     * must never render as "no warnings": one is a statement about the world and the other is a
     * statement about GeoNerva.
     */
    const { snapshot } = await build();
    const card = snapshot.families.WEATHER_ALERTS;
    expect(card.availability).toBe('NOT_COVERED');
    expect(card.items).toEqual([]);
    expect(card.coverage.note).not.toBeNull();
  });

  it('names the coverage gap in the overall statement', async () => {
    const { snapshot } = await build();
    expect(snapshot.overall.notCoveredFamilies).toContain('WEATHER_ALERTS');
    expect(snapshot.overall.coverageStatement).toContain('weather warnings');
  });
});

describe('an empty result is never an answer on its own', () => {
  it('reports UNAVAILABLE when correlation has never run over data that exists', async () => {
    /*
     * The defect this whole axis exists for. The earthquake is ingested, USGS is healthy, and the
     * as-of read returns it — but nothing has correlated it, so there is no canonical event to
     * point at. Without the derivation axis the card would say "no earthquakes to report" to a
     * place with an M5.4 twenty kilometres away.
     */
    await healthySource('usgs', 'comcat');
    await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'us-unlinked',
      aliases: ['us-unlinked'],
      ingestedAt: INGEST,
      observedAt: T0,
      centroid: north(20),
      magnitude: 5.4,
      depthKm: 10,
    });

    const { snapshot } = await build();
    const card = snapshot.families.EARTHQUAKES;
    expect(card.availability).toBe('UNAVAILABLE');
    expect(card.items).toEqual([]);
    expect(card.itemsTotal).toBe(0);
    expect(card.dataConfidence.reasons[0]?.code).toBe('AVAILABILITY_DERIVATION_NOT_RUN');
  });

  it('reports AVAILABLE with nothing to report when a healthy source genuinely saw nothing', async () => {
    /*
     * All three earthquake sources, not two: GDACS's EQ feed also carries `EARTHQUAKE`, and with
     * it silent the card is correctly `SOME_SOURCES_UNUSABLE` rather than a clean zero. Which is
     * the model working — a count of zero that omits a source that never answered is not the same
     * observation.
     */
    await healthySource('usgs', 'comcat');
    await healthySource('emsc', 'rts');
    await healthySource('gdacs', 'EQ');
    const { snapshot } = await build();

    const card = snapshot.families.EARTHQUAKES;
    expect(card.availability).toBe('AVAILABLE');
    expect(card.items).toEqual([]);
    /*
     * `PARTIAL_COVERAGE` rather than `NOTHING_TO_REPORT`, and that is the right answer: USGS and
     * EMSC both publish a completeness caveat, so an empty earthquake card here means "nothing
     * above the threshold these catalogues are complete to", not "nothing happened". The zero is
     * still renderable — a usable source did look — but the caveat travels with it.
     */
    expect(card.availability).toBe('AVAILABLE');
    expect(card.dataConfidence.reasons[0]?.code).toBe('AVAILABILITY_PARTIAL_COVERAGE');
    expect(card.coverage.level).toBe('PARTIAL');
    expect(card.caveats.length).toBeGreaterThan(0);
  });

  it('reports UNAVAILABLE when every source for a family has never succeeded', async () => {
    const { snapshot } = await build();
    expect(snapshot.families.EARTHQUAKES.availability).toBe('UNAVAILABLE');
    expect(snapshot.overall.headlineCode).toBe('DATA_UNAVAILABLE');
  });

  it('leads with unavailability rather than with quiet', async () => {
    /*
     * A place whose earthquake feed is down must not lead with "nothing needs your attention".
     * The two sentences look alike on a screen and mean opposite things, and the calm one is the
     * dangerous mistake.
     */
    const { snapshot } = await build();
    expect(snapshot.overall.headlineCode).toBe('DATA_UNAVAILABLE');
    expect(snapshot.overall.headlineText).toContain('cannot');
  });
});

describe('subjects', () => {
  beforeEach(async () => {
    await healthySource('usgs', 'comcat');
    await healthySource('emsc', 'rts');
    await healthySource('gdacs', 'EQ');
    await derivationRan('CORRELATION', new Date(INGEST.getTime() + 60_000));
  });

  it('describes a linked earthquake as one subject with its evidence', async () => {
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { snapshot, evidenceIds } = await build();

    const card = snapshot.families.EARTHQUAKES;
    expect(card.availability).toBe('AVAILABLE');
    expect(card.items).toHaveLength(1);

    const item = card.items[0];
    expect(item?.subjectRef).toMatch(/^CE:/);
    expect(item?.hazardType).toBe('EARTHQUAKE');
    expect(item?.title).toBe('M5.4 earthquake');
    // 20 km north, over-stated slightly by the flat-degree conversion the helper documents.
    expect(item?.distanceKm).toBeGreaterThan(19);
    expect(item?.distanceKm).toBeLessThan(21);
    // M5.4 at 20 km: inside the HIGH band, which is M ≥ 5.0 within 50 km (EARTHQUAKE_BANDS).
    expect(item?.relevance.level).toBe('HIGH');
    expect(item?.evidenceIds.length).toBeGreaterThan(0);
    for (const id of item?.evidenceIds ?? []) expect(evidenceIds).toContain(id);
  });

  it('counts a derived copy as a second record and not as a second source', async () => {
    /*
     * ADR-030 reaching the read model. A GDACS copy of the USGS solution adds a row, not a source
     * — and `nIndependentSources` is the number a card is allowed to describe as corroboration.
     */
    const { canonicalEventId } = await seedLinkedEarthquake({ primaryKey: 'us1' });
    await seedLinkedEarthquake({
      primaryKey: 'em1',
      sourceId: 'emsc',
      canonicalEventId,
      relation: 'DERIVED_COPY',
    });

    const { snapshot } = await build();
    const item = snapshot.families.EARTHQUAKES.items[0];
    expect(item?.agreement?.nSources).toBe(2);
    expect(item?.agreement?.nIndependentSources).toBe(1);
    expect(item?.agreement?.level).toBe('DERIVED_ONLY');
  });

  it('reports two independent solutions as agreeing', async () => {
    const { canonicalEventId } = await seedLinkedEarthquake({ primaryKey: 'us1' });
    await seedLinkedEarthquake({
      primaryKey: 'em1',
      sourceId: 'emsc',
      canonicalEventId,
      relation: 'SAME_EVENT',
      magnitude: 5.5,
    });

    const { snapshot } = await build();
    const item = snapshot.families.EARTHQUAKES.items[0];
    expect(item?.agreement?.nIndependentSources).toBe(2);
    expect(item?.agreement?.level).toBe('AGREE');
  });

  it('never returns CRITICAL without an authoritative basis', async () => {
    /*
     * Invariant I10. GeoNerva's own heuristics top out at HIGH whatever the magnitude: "critical"
     * is a claim only an authority can make, and the basis is the citation that proves one did.
     */
    await seedLinkedEarthquake({ primaryKey: 'us1', magnitude: 7.9, at: north(15) });
    const { snapshot } = await build();

    for (const item of snapshot.families.EARTHQUAKES.items) {
      if (item.relevance.level === 'CRITICAL')
        expect(item.relevance.authoritativeBasis).not.toBeNull();
    }
    expect(snapshot.families.EARTHQUAKES.items[0]?.relevance.level).toBe('HIGH');
  });

  it('orders by relevance before distance, so the nearest is not automatically first', async () => {
    /*
     * The two keys have to disagree for the order to mean anything. An M4.6 twenty kilometres away
     * is `MODERATE`; an M6.8 sixty kilometres away is `HIGH`. Sorting by distance would put the
     * smaller one at the top of a card whose job is to say what deserves attention.
     */
    await seedLinkedEarthquake({ primaryKey: 'small-near', magnitude: 4.6, at: north(20) });
    await seedLinkedEarthquake({ primaryKey: 'big-far', magnitude: 6.8, at: north(60) });

    const { snapshot } = await build();
    const items = snapshot.families.EARTHQUAKES.items;
    expect(items.map((item) => item.relevance.level)).toEqual(['HIGH', 'MODERATE']);
    expect(items[0]?.distanceKm).toBeGreaterThan(items[1]?.distanceKm ?? 0);
  });

  it('orders equally relevant items by distance', async () => {
    await seedLinkedEarthquake({ primaryKey: 'far', magnitude: 5.4, at: north(40) });
    await seedLinkedEarthquake({ primaryKey: 'near', magnitude: 5.4, at: north(20) });

    const { snapshot } = await build();
    const distances = snapshot.families.EARTHQUAKES.items.map((item) => item.distanceKm);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('demotes a CRITICAL it cannot cite, rather than claiming one (invariant I10)', async () => {
    /*
     * A PAGER red alert within 100 km makes the model *eligible* for `CRITICAL` — and eligibility
     * is not the claim. `CRITICAL` says an authority called this critical, so without the
     * authority's statement the level is `HIGH` and the card says why. Returning `CRITICAL` with a
     * null basis is the one thing invariant I10 forbids outright.
     */
    await seedLinkedEarthquake({
      primaryKey: 'pager-red',
      magnitude: 6.2,
      at: north(30),
      severityScheme: 'PAGER',
      severityValue: 'red',
    });

    const { snapshot } = await build();
    const item = snapshot.families.EARTHQUAKES.items[0];
    expect(item?.relevance.level).toBe('HIGH');
    expect(item?.relevance.authoritativeBasis).toBeNull();
    expect(item?.relevance.reasons.map((reason) => reason.code)).toContain(
      'NO_AUTHORITATIVE_BASIS',
    );
    // The provider's own alert is still shown as a fact, on its own scale.
    expect(item?.providerSeverity).toEqual({ scheme: 'PAGER', value: 'red' });
  });

  it('shows no items at all when the family cannot support a claim', async () => {
    /*
     * Invariant I11's other half. The event exists and is linked, but no source has ever produced
     * a successful run — so GeoNerva cannot say what is happening here, and a card that listed the
     * one event it happens to hold would be making exactly the claim it just disclaimed. The total
     * goes with it: a count behind an unavailable card is the same zero wearing a different name.
     */
    await testDb.truncate();
    await derivationRan('CORRELATION', new Date(INGEST.getTime() + 60_000));
    await seedLinkedEarthquake({ primaryKey: 'us1' });

    const { snapshot } = await build();
    const card = snapshot.families.EARTHQUAKES;
    expect(card.availability).toBe('UNAVAILABLE');
    expect(card.items).toEqual([]);
    expect(card.itemsTotal).toBe(0);
  });
});

describe('determinism', () => {
  beforeEach(async () => {
    await healthySource('usgs', 'comcat');
    await healthySource('emsc', 'rts');
    await healthySource('gdacs', 'EQ');
    await derivationRan('CORRELATION', new Date(INGEST.getTime() + 60_000));
  });

  it('produces the same hash for two builds of the same knowledge time', async () => {
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const first = await build();
    const second = await build();
    expect(second.snapshot.contentSha256).toBe(first.snapshot.contentSha256);
  });

  it('excludes generatedAt from the hash', async () => {
    /*
     * Wall-clock time is not knowledge time. Two builds a minute apart describe the same world, so
     * including it would change the cache key on every request and fill `location_snapshots` with
     * duplicates of one snapshot.
     */
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const first = await buildSnapshot({
      db,
      location: MARRAKECH,
      asOf: AS_OF,
      engineVersion: ENGINE,
      generatedAt: new Date('2026-09-20T10:00:00.000Z'),
    });
    const second = await buildSnapshot({
      db,
      location: MARRAKECH,
      asOf: AS_OF,
      engineVersion: ENGINE,
      generatedAt: new Date('2026-09-20T11:30:00.000Z'),
    });

    expect(second.snapshot.generatedAt).not.toBe(first.snapshot.generatedAt);
    expect(second.snapshot.contentSha256).toBe(first.snapshot.contentSha256);
  });

  it('changes the hash when the engine version changes', async () => {
    // Snapshots of different engine versions are never diffed against each other (§4.14).
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const first = await build();
    const second = await buildSnapshot({
      db,
      location: MARRAKECH,
      asOf: AS_OF,
      engineVersion: `${ENGINE}-next`,
      generatedAt: new Date('2026-09-20T10:00:05.000Z'),
    });
    expect(second.snapshot.contentSha256).not.toBe(first.snapshot.contentSha256);
  });

  it('changes the hash when a fact changes', async () => {
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const before = await build();

    await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'us1',
      aliases: ['us1'],
      ingestedAt: new Date(INGEST.getTime() + 120_000),
      observedAt: T0,
      centroid: north(20),
      magnitude: 5.9,
      magnitudeType: 'mww',
      depthKm: 10,
      providerStatus: 'reviewed',
      contributor: 'us',
    });
    const after = await build();

    expect(after.snapshot.contentSha256).not.toBe(before.snapshot.contentSha256);
  });

  it('does not see a fact ingested after the knowledge time', async () => {
    /*
     * Invariant I2 at the snapshot level. A version ingested after `asOf` must not appear, and the
     * hash must not move — a replay that drifted as new data arrived would not be a replay.
     */
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const before = await build();

    await seedLinkedEarthquake({
      primaryKey: 'us2',
      at: north(30),
      ingestedAt: new Date(AS_OF.getTime() + 60_000),
    });
    const after = await build();

    expect(after.snapshot.families.EARTHQUAKES.items).toHaveLength(1);
    expect(after.snapshot.contentSha256).toBe(before.snapshot.contentSha256);
  });

  it('does not depend on the order rows were inserted in', async () => {
    /*
     * Row-order independence. The same three earthquakes inserted in a different order must
     * produce a byte-identical snapshot, or the hash is a property of the planner rather than of
     * the data.
     *
     * Two things are deliberate here.
     *
     * The public ids are carried across, because they are part of the database *state* rather
     * than of the facts — a fresh event gets a fresh random id — so regenerating them would move
     * the subject references for a reason that has nothing to do with ordering.
     *
     * The comparison is over what ordering could actually disturb — the sequence of subjects and
     * the values attached to them — rather than over the snapshot hash. Re-seeding mints new run
     * uuids and new version ids, and those reach the snapshot as `EV:RUN:` and `EV:OBS:` evidence:
     * a different hash there is a *correct* report of different state, and asserting on it would
     * make this test fail for a reason it is not about. Repeated-build hash equality is covered by
     * its own test above, where the state genuinely is identical.
     */
    const events = [
      { primaryKey: 'aaa', km: 20 },
      { primaryKey: 'bbb', km: 21 },
      { primaryKey: 'ccc', km: 22 },
    ];
    const publicIds = new Map<string, string>();
    for (const event of events) {
      const created = await seedLinkedEarthquake({
        primaryKey: event.primaryKey,
        magnitude: 5.4,
        at: north(event.km),
      });
      publicIds.set(event.primaryKey, created.publicId);
    }
    const first = await build();

    await testDb.truncate();
    await healthySource('usgs', 'comcat');
    await healthySource('emsc', 'rts');
    await healthySource('gdacs', 'EQ');
    await derivationRan('CORRELATION', new Date(INGEST.getTime() + 60_000));
    for (const event of [...events].reverse()) {
      await seedLinkedEarthquake({
        primaryKey: event.primaryKey,
        magnitude: 5.4,
        at: north(event.km),
        publicId: publicIds.get(event.primaryKey),
      });
    }
    const second = await build();

    const shape = (build: Awaited<ReturnType<typeof buildSnapshot>>) =>
      build.snapshot.families.EARTHQUAKES.items.map((item) => ({
        publicId: item.publicId,
        title: item.title,
        level: item.relevance.level,
        distanceKm: item.distanceKm,
        agreement: item.agreement?.level ?? null,
      }));

    expect(shape(second)).toEqual(shape(first));
    expect(contentSha256(shape(second))).toBe(contentSha256(shape(first)));
  });

  it('breaks ties on the subject reference, so equal items have one order', async () => {
    /*
     * Identical magnitude at an identical epicentre: nothing but the subject reference can decide.
     *
     * The rows are arranged so that the database's own order is the *wrong* one.
     * `observationsAsOf` returns `observed_at DESC`, and `observed_at` is not one of the snapshot's
     * sort keys — so giving `ZZZZZZ` the later origin time puts it first in the query result while
     * leaving it last by subject reference. Without the tiebreak the card follows the rows; with
     * it, the card has one order. A test where the two happen to agree proves nothing.
     */
    const first = await createCanonicalEvent(db, {
      hazardType: 'EARTHQUAKE',
      createdAt: INGEST,
      publicId: 'EQ-26-ZZZZZZ',
    });
    const second = await createCanonicalEvent(db, {
      hazardType: 'EARTHQUAKE',
      createdAt: INGEST,
      publicId: 'EQ-26-AAAAAA',
    });
    await seedLinkedEarthquake({
      primaryKey: 'zzz',
      magnitude: 5.4,
      at: north(20),
      canonicalEventId: first.id,
      observedAt: new Date(T0.getTime() + 60_000),
    });
    await seedLinkedEarthquake({
      primaryKey: 'aaa',
      magnitude: 5.4,
      at: north(20),
      canonicalEventId: second.id,
    });

    const { snapshot } = await build();
    expect(snapshot.families.EARTHQUAKES.items.map((item) => item.subjectRef)).toEqual([
      'CE:EQ-26-AAAAAA',
      'CE:EQ-26-ZZZZZZ',
    ]);
  });
});

describe('provenance', () => {
  beforeEach(async () => {
    await healthySource('usgs', 'comcat');
    await healthySource('emsc', 'rts');
    await healthySource('gdacs', 'EQ');
    await derivationRan('CORRELATION', new Date(INGEST.getTime() + 60_000));
  });

  it('gives every evidence ID a canonical, parseable form', async () => {
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { evidenceIds } = await build();
    expect(evidenceIds.length).toBeGreaterThan(0);
    for (const id of evidenceIds) expect(() => parseEvidenceId(id)).not.toThrow();
  });

  it('references every ID a claim carries (invariant I9)', async () => {
    /*
     * The manifest rule. An evidence ID on a fact that the manifest cannot resolve is a citation
     * to nothing, which is worse than no citation at all: it looks like proof.
     */
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { snapshot, evidenceIds } = await build();
    const manifest = new Set(evidenceIds);

    for (const card of Object.values(snapshot.families)) {
      for (const item of card.items) {
        for (const id of item.evidenceIds) expect(manifest.has(id)).toBe(true);
        for (const fact of item.facts) {
          for (const id of fact.evidenceIds) expect(manifest.has(id)).toBe(true);
        }
        for (const reason of item.relevance.reasons) {
          for (const id of reason.evidenceIds) expect(manifest.has(id)).toBe(true);
        }
      }
      for (const health of card.sourceHealth) {
        if (health.evidenceId !== null) expect(manifest.has(health.evidenceId)).toBe(true);
      }
    }
    for (const id of snapshot.overall.evidenceIds) expect(manifest.has(id)).toBe(true);
  });

  it('cites the observation version and the correlation link behind an item', async () => {
    /*
     * Structured identifiers, not copied payloads. `EV:OBS:<version_id>` points at the immutable
     * row, and `EV:COR:<link_id>` at the decision that made the subject — which is what lets the
     * event page show the reasoning without the snapshot carrying the provider's bytes.
     */
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { snapshot } = await build();
    const kinds = (snapshot.families.EARTHQUAKES.items[0]?.evidenceIds ?? []).map(
      (id) => parseEvidenceId(id).kind,
    );
    expect(kinds).toContain('OBS');
    expect(kinds).toContain('COR');
  });

  it('carries no provider payload into the snapshot', async () => {
    /*
     * Provenance by reference. The snapshot must not become a copy of the feed: a raw payload
     * inside it would bloat every cache entry and would put provider strings — which may carry
     * markup — into a document the UI renders.
     */
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { snapshot } = await build();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('"attributes"');
    expect(serialized).not.toContain('"rawPayload"');
    expect(serialized.length).toBeLessThan(200_000);
  });

  it('states the data cutoff per source', async () => {
    const { asOfContext } = await build();
    expect(asOfContext.sourceCutoffs['usgs']).toBe(INGEST.toISOString());
    // A source that has never committed a run has a null cutoff, not a missing key: a reader must
    // be able to see that FIRMS has no cutoff, rather than find no entry and guess why.
    expect(Object.keys(asOfContext.sourceCutoffs)).toContain('firms');
    expect(asOfContext.sourceCutoffs['firms']).toBeNull();
  });

  it('states a replay horizon for every family', async () => {
    const { asOfContext } = await build();
    expect(asOfContext.replayHorizon.profile).toBe('lean');
    for (const family of Object.keys(asOfContext.replayHorizon.byFamily)) {
      const horizon = asOfContext.replayHorizon.byFamily[family as 'EARTHQUAKES'];
      expect(new Date(horizon.earliestAsOf).getTime()).toBeLessThan(AS_OF.getTime());
      expect(horizon.note.length).toBeGreaterThan(0);
    }
  });
});
