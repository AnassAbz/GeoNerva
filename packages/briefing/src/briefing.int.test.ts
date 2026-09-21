/**
 * `buildBriefing` against a real database.
 *
 * The snapshot's own properties are tested in `snapshot.int.test.ts`. What is tested here is the
 * assembly: that the two snapshots come from one code path at two knowledge times, that the
 * manifest can resolve every citation the response makes (invariant I9), that the copy is complete
 * without a model, and that `ai` stays absent unless a validated output is handed in.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCanonicalEvent, createDb, linkRecord, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation, seedRun } from '@geonerva/db/testing/factories';
import { parseEvidenceId, type LocationRef } from '@geonerva/domain';

import { EvidenceManifestError, buildBriefing } from './briefing.ts';
import { scanLexicon } from './lexicon.ts';

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

/*
 * The window is 24 hours, so `fromAsOf` is T0. An event observed *inside* the window is new; one
 * observed before it is a late report. Every timestamp below is placed relative to these two.
 */
const T0 = new Date('2026-09-20T00:00:00.000Z');
const AS_OF = new Date('2026-09-21T00:00:00.000Z');
const INSIDE_WINDOW = new Date('2026-09-20T18:00:00.000Z');
const ENGINE = 'briefing-test-1';

const MARRAKECH: LocationRef = {
  key: 'p:2542997',
  label: 'Marrakech',
  lat: 31.6295,
  lon: -7.9811,
  timezone: 'Africa/Casablanca',
  countryCode: 'MA',
  admin1: 'Marrakech-Safi',
};

function north(km: number): { lat: number; lon: number } {
  return { lat: MARRAKECH.lat + km / 110.574, lon: MARRAKECH.lon };
}

async function build(overrides: Partial<Parameters<typeof buildBriefing>[0]> = {}) {
  return buildBriefing({
    db,
    location: MARRAKECH,
    asOf: AS_OF,
    engineVersion: ENGINE,
    window: '24h',
    generatedAt: new Date('2026-09-21T00:00:05.000Z'),
    ...overrides,
  });
}

/** A healthy, committed run so the source is usable at both knowledge times. */
async function healthySource(sourceId: string, productCode: string, at: Date): Promise<void> {
  const product = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = ${sourceId} AND code = ${productCode}
  `.execute(db);
  await seedRun(db, {
    sourceId,
    productId: product.rows[0]?.id ?? null,
    status: 'SUCCEEDED',
    startedAt: at,
    newestObservedAt: at,
  });
}

/**
 * Both knowledge times need a healthy source and a completed correlation run.
 *
 * A run is committed shortly before **each** `asOf`, not once in the middle. USGS's freshness
 * policy calls a source `STALE` an hour after its last success, so a single run at 18:00 leaves
 * the source stale at the 00:00 knowledge time — the family goes `UNAVAILABLE`, its items are
 * empty by invariant I11, and every assertion about items fails for a reason that has nothing to
 * do with what is being tested.
 */
async function earthquakesUsable(): Promise<void> {
  const beforeWindow = new Date(T0.getTime() - 5 * 60 * 1000);
  const nearAsOf = new Date(AS_OF.getTime() - 5 * 60 * 1000);
  for (const [source, product] of [
    ['usgs', 'comcat'],
    ['emsc', 'rts'],
    ['gdacs', 'EQ'],
  ] as const) {
    await healthySource(source, product, beforeWindow);
    await healthySource(source, product, nearAsOf);
  }
  for (const finishedAt of [beforeWindow, nearAsOf]) {
    await sql`
      INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
      VALUES (gen_random_uuid(), 'CORRELATION', ${ENGINE}, ${finishedAt}, ${finishedAt}, 'SUCCEEDED')
    `.execute(db);
  }
}

async function seedLinkedEarthquake(options: {
  readonly primaryKey: string;
  readonly magnitude?: number;
  readonly km?: number;
  readonly observedAt?: Date;
  readonly ingestedAt?: Date;
}): Promise<{ publicId: string }> {
  const seeded = await seedObservation(db, {
    sourceId: 'usgs',
    primaryKey: options.primaryKey,
    aliases: [options.primaryKey],
    ingestedAt: options.ingestedAt ?? INSIDE_WINDOW,
    observedAt: options.observedAt ?? INSIDE_WINDOW,
    centroid: north(options.km ?? 20),
    magnitude: options.magnitude ?? 5.4,
    magnitudeType: 'mww',
    depthKm: 10,
    providerStatus: 'reviewed',
    contributor: 'us',
  });
  const event = await createCanonicalEvent(db, {
    hazardType: 'EARTHQUAKE',
    createdAt: options.ingestedAt ?? INSIDE_WINDOW,
  });
  await db.transaction().execute(async (trx) => {
    await linkRecord(trx, {
      canonicalEventId: event.id,
      sourceRecordId: seeded.sourceRecordId,
      relation: 'PRIMARY',
      matchKind: 'SPATIOTEMPORAL',
      algorithmVersion: 'eq-corr-1',
      linkedAt: options.ingestedAt ?? INSIDE_WINDOW,
    });
  });
  return { publicId: event.publicId };
}

describe('the assembled response', () => {
  it('is complete with no model configured', async () => {
    /*
     * `AI_MODE=disabled` is the default, so a briefing with `ai: null` is not a degraded response
     * — it is the product. Every field a caller renders has to be populated.
     */
    await earthquakesUsable();
    await seedLinkedEarthquake({ primaryKey: 'us1' });

    const { briefing } = await build();
    expect(briefing.ai).toBeNull();
    expect(briefing.copy.headline.length).toBeGreaterThan(0);
    expect(briefing.copy.summary.length).toBeGreaterThan(0);
    expect(briefing.copy.templateVersion).toBe('tpl-1');
    expect(briefing.snapshot.families.EARTHQUAKES.items).toHaveLength(1);
    expect(briefing.attribution.map((entry) => entry.sourceId)).toContain('usgs');
    expect(briefing.schemaVersion).toBe(1);
  });

  it('reports the snapshot hash as the response hash', async () => {
    // Documented as "hash of the snapshot content, which is also the AI cache key".
    await earthquakesUsable();
    const { briefing } = await build();
    expect(briefing.contentSha256).toBe(briefing.snapshot.contentSha256);
  });

  it('places the window boundaries on the change section', async () => {
    await earthquakesUsable();
    const { briefing } = await build();
    expect(briefing.changes.window).toBe('24h');
    expect(briefing.changes.toAsOf).toBe(AS_OF.toISOString());
    expect(briefing.changes.fromAsOf).toBe(T0.toISOString());
  });

  it('carries the attribution of the providers it actually cited, verbatim', async () => {
    /*
     * Several providers' terms require the attribution text and the disclaimer word for word, so
     * they are columns rather than something the UI composes — and the list is derived from the
     * manifest, so the footer names exactly the sources this response used.
     */
    await earthquakesUsable();
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { briefing } = await build();

    const usgs = briefing.attribution.find((entry) => entry.sourceId === 'usgs');
    expect(usgs?.attributionText).toContain('U.S. Geological Survey');
    expect(usgs?.licence).toBe('U.S. Public Domain');
  });
});

describe('the evidence manifest (invariant I9)', () => {
  it('resolves every id the response references', async () => {
    /*
     * The invariant, checked by traversal rather than by spot check. An unresolvable citation is
     * worse than no citation: it looks like proof.
     */
    await earthquakesUsable();
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { briefing, unresolvedEvidenceIds } = await build();

    expect(unresolvedEvidenceIds).toEqual([]);
    const manifest = new Set(briefing.evidenceManifest.map((item) => item.id));
    expect(manifest.size).toBeGreaterThan(0);

    for (const card of Object.values(briefing.snapshot.families)) {
      for (const item of card.items) {
        for (const id of item.evidenceIds) expect(manifest.has(id)).toBe(true);
        for (const fact of item.facts) {
          for (const id of fact.evidenceIds) expect(manifest.has(id)).toBe(true);
        }
      }
      for (const health of card.sourceHealth) {
        if (health.evidenceId !== null) expect(manifest.has(health.evidenceId)).toBe(true);
      }
    }
    for (const signal of [
      ...briefing.changes.headline,
      ...briefing.changes.listed,
      ...briefing.changes.detail,
      ...briefing.changes.suppressed,
    ]) {
      for (const id of signal.evidenceIds) expect(manifest.has(id)).toBe(true);
    }
  });

  it('describes each manifest entry and says whether it resolves', async () => {
    await earthquakesUsable();
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { briefing } = await build();

    for (const item of briefing.evidenceManifest) {
      expect(() => parseEvidenceId(item.id)).not.toThrow();
      expect(item.summary.length).toBeGreaterThan(0);
      // `OBS`/`COR`/`RUN`/`FCV` resolve through the evidence endpoint; derived kinds do not.
      const derived = item.kind === 'BAS' || item.kind === 'REL' || item.kind === 'CHG';
      expect(item.resolvable).toBe(!derived);
    }
  });

  it('cites the observation behind an item and the correlation that made it a subject', async () => {
    await earthquakesUsable();
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { briefing } = await build();

    const kinds = briefing.evidenceManifest.map((item) => item.kind);
    expect(kinds).toContain('OBS');
    expect(kinds).toContain('COR');
    expect(kinds).toContain('RUN');
  });

  it('throws rather than shipping a citation it cannot resolve', async () => {
    /*
     * The strict default. A caller that supplies an AI output referencing an unknown id must not
     * get a response containing that id — so the assembly fails loudly instead of producing a
     * document whose footnotes point nowhere.
     */
    await earthquakesUsable();
    await seedLinkedEarthquake({ primaryKey: 'us1' });

    const ai = {
      model: 'test',
      promptVersion: 'v1',
      validationStatus: 'PASSED' as const,
      sections: [],
      evidenceIds: ['EV:OBS:999999'],
      disclaimer: 'Generated text.',
      generatedAt: AS_OF.toISOString(),
    };

    await expect(build({ ai })).rejects.toThrow(EvidenceManifestError);
  });

  it('reports the unresolved ids instead of throwing when asked to degrade', async () => {
    await earthquakesUsable();
    const ai = {
      model: 'test',
      promptVersion: 'v1',
      validationStatus: 'PASSED' as const,
      sections: [],
      evidenceIds: ['EV:OBS:999999'],
      disclaimer: 'Generated text.',
      generatedAt: AS_OF.toISOString(),
    };

    const { unresolvedEvidenceIds } = await build({ ai, strictManifest: false });
    expect(unresolvedEvidenceIds).toEqual(['EV:OBS:999999']);
  });

  it('does not resolve an id to a version ingested after the knowledge time', async () => {
    /*
     * A manifest built for a replay must not be able to cite something that did not exist yet. The
     * id is well-formed and the row exists — it was simply ingested later — so the honest outcome
     * is a manifest gap, not a time-travelling citation.
     */
    const later = await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'us-future',
      aliases: ['us-future'],
      ingestedAt: new Date(AS_OF.getTime() + 60 * 60 * 1000),
      observedAt: INSIDE_WINDOW,
      centroid: north(20),
      magnitude: 5.4,
      depthKm: 10,
    });
    await earthquakesUsable();

    const ai = {
      model: 'test',
      promptVersion: 'v1',
      validationStatus: 'PASSED' as const,
      sections: [],
      evidenceIds: [`EV:OBS:${later.versionId}`],
      disclaimer: 'Generated text.',
      generatedAt: AS_OF.toISOString(),
    };

    const { unresolvedEvidenceIds } = await build({ ai, strictManifest: false });
    expect(unresolvedEvidenceIds).toEqual([`EV:OBS:${later.versionId}`]);
  });
});

describe('the change section', () => {
  it('reports an event that arrived inside the window as new', async () => {
    /*
     * The event is ingested inside the window, so the earlier snapshot cannot see it and the later
     * one can. That difference is the change — which is why both snapshots come from one builder.
     */
    await earthquakesUsable();
    await seedLinkedEarthquake({ primaryKey: 'us1' });
    const { briefing } = await build();

    const signals = [...briefing.changes.headline, ...briefing.changes.listed];
    expect(signals.map((signal) => signal.type)).toContain('NEW_EVENT');
    expect(briefing.changes.emptyStatement).toBeNull();
  });

  it('states plainly that nothing changed when nothing did', async () => {
    /*
     * Ingested before the window, so both snapshots hold it and there is no difference. The event
     * is still on the card; it simply is not news.
     */
    await earthquakesUsable();
    const before = new Date(T0.getTime() - 2 * 60 * 60 * 1000);
    await seedLinkedEarthquake({ primaryKey: 'us1', observedAt: before, ingestedAt: before });
    const { briefing } = await build();

    expect(briefing.changes.headline).toEqual([]);
    expect(briefing.changes.listed).toEqual([]);
    expect(briefing.changes.emptyStatement).toBe('No meaningful changes in the last 24 hours.');
    expect(briefing.snapshot.families.EARTHQUAKES.items).toHaveLength(1);
    expect(briefing.copy.summary.at(-1)).toContain('Nothing meaningful changed');
  });

  it('gives each change a content-addressed id that is stable across builds', async () => {
    /*
     * `EV:CHG:<sha>` is the change's own content address, so the same difference between the same
     * two snapshots always has the same identity — which is what lets it be referenced later, and
     * what stops a re-render inventing a new id for an old fact.
     */
    await earthquakesUsable();
    await seedLinkedEarthquake({ primaryKey: 'us1' });

    const first = await build();
    const second = await build();
    const ids = (build_: typeof first) =>
      [...build_.briefing.changes.headline, ...build_.briefing.changes.listed].map(
        (signal) => signal.id,
      );

    expect(ids(second)).toEqual(ids(first));
    for (const id of ids(first)) expect(parseEvidenceId(id).kind).toBe('CHG');
  });

  it('returns suppressed signals with their reason, so the count is honest', async () => {
    await earthquakesUsable();
    const before = new Date(T0.getTime() - 2 * 60 * 60 * 1000);
    await seedLinkedEarthquake({ primaryKey: 'us1', observedAt: before, ingestedAt: before });
    /*
     * A revision below the materiality threshold: the magnitude moves by 0.1, which §10.2 calls
     * immaterial. It is filtered, and the filtering is visible.
     */
    await seedObservation(db, {
      sourceId: 'usgs',
      primaryKey: 'us1',
      aliases: ['us1'],
      ingestedAt: INSIDE_WINDOW,
      observedAt: before,
      centroid: north(20),
      magnitude: 5.5,
      magnitudeType: 'mww',
      depthKm: 10,
      providerStatus: 'reviewed',
      contributor: 'us',
    });

    const { briefing } = await build();
    expect(briefing.changes.suppressedCount).toBe(briefing.changes.suppressed.length);
    for (const signal of briefing.changes.suppressed) {
      expect(signal.suppressionReason).not.toBeNull();
    }
  });
});

describe('language', () => {
  it('produces no prohibited language for a quiet location', async () => {
    /*
     * Scanned with the same scanner that gates model output. A quiet briefing is the one most
     * likely to drift into "you are safe", which is the claim GeoNerva is not entitled to make.
     */
    await earthquakesUsable();
    const { briefing } = await build();
    const text = [
      briefing.copy.headline,
      ...briefing.copy.summary,
      ...Object.values(briefing.copy.byFamily).flat(),
      ...briefing.copy.caveats,
    ].join(' ');

    /*
     * The caveats are provider text relayed verbatim — FIRMS's coverage note contains
     * "near-real-time", which denies rather than promises real-time — so they are passed as
     * verbatim quotes. Everything GeoNerva composed is scanned without exemption.
     */
    expect(scanLexicon(text, { verbatimQuotes: briefing.copy.caveats })).toEqual([]);

    /*
     * Only the earthquake sources are healthy here, so the *location* is not quiet — the other
     * families are unavailable and the headline correctly says so. The quiet family is
     * earthquakes, and its own sentence is the one that must describe an absence rather than
     * assert safety.
     */
    expect(briefing.copy.byFamily.EARTHQUAKES).toContain('No earthquakes to report here.');
  });

  it('names the families it cannot describe rather than reassuring', async () => {
    // No healthy source at all: every family is unavailable, and the copy has to say so.
    const { briefing } = await build();
    expect(briefing.snapshot.overall.headlineCode).toBe('DATA_UNAVAILABLE');
    expect(briefing.copy.headline).toContain('cannot currently report on');
    expect(briefing.copy.summary[0]).toContain('unknown rather than as quiet');
  });
});
