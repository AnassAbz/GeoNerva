/**
 * The seeded scenario database of docs/TESTING.md §5, for the E2E suite.
 *
 * ### The one instant everything is anchored to
 *
 * **`2026-09-22T13:06:00.000Z`** — `SCENARIO_ANCHOR`, byte-identical to `FIXTURE_NOW` in
 * `apps/web/lib/fixtures/common.ts`, so a page served from this database describes the same world
 * the P9a mocks describe. Every timestamp below is written as an offset from it. Nothing here
 * reads the wall clock, so two seeds of the same scenario produce the same rows, and a Playwright
 * run with `GEONERVA_FAKE_NOW=2026-09-22T13:06:00.000Z` sees a world that is not ageing under it.
 *
 * ### SQL or a seeding script
 *
 * docs/TESTING.md names `test-fixtures/scenarios/*.sql`. This is TypeScript instead, and
 * deliberately: a `.sql` file would have to re-implement `content_sha256` derivation, the
 * head-pointer maintenance of `insertVersionIfChanged`, the alias resolution of
 * `resolveSourceRecord`, the frontier arithmetic of `recordLiveCoverage` (ADR-041) and the
 * `generate_series` shape of `recordIntervalCoverage`. A second implementation of the write path
 * is exactly the thing that lets a seeded database drift from what production can actually
 * produce — a fixture that no run could have created is a fixture that proves nothing. So every
 * row here is written through the repository writers in `@geonerva/db`, the same functions the
 * ingestion pipeline calls, and the only thing this module supplies is a clock.
 *
 * Three stamps cannot come from a writer, because the writer takes them from the database's own
 * `clock_timestamp()` — which is right in production and wrong for a simulated timeline. They are
 * passed explicitly where the writer allows it (`finishRun`'s `committedAt`,
 * `recordLiveCoverage`'s `recordedAt`) and, for the backfill checkpoint, written with the query
 * builder before `recordIntervalCoverage` reads it. `packages/db/src/testing/factories.ts` makes
 * the same compromise for the same reason, and says so.
 *
 * ### Idempotency
 *
 * **Not** idempotent: `createCanonicalEvent` and `createCluster` mint identities, and the second
 * call collides. Run `truncate()` from `@geonerva/db/testing` first, which is what
 * `scripts/seed-scenario.ts` does. The safety guard in that harness is the reason the script
 * refuses a database whose name does not end in `_test`.
 *
 * ### The world
 *
 * Marrakech (GeoNames 2542997), as `apps/web/lib/fixtures/world.ts` depicts it:
 *
 *  - an M4.7 earthquake 142 km east, reported by **two independent sources** (USGS Mww 4.7 after a
 *    revision from mb 4.6, EMSC mb 4.6) and republished by GDACS;
 *  - a smaller M3.4 earthquake five days earlier, single-source;
 *  - a fire activity cluster 39 km south-west: 14 VIIRS detections over three cluster versions;
 *  - a GDACS flood event (modelled area) in Souss-Massa, 171 km away, updated this morning;
 *  - about five years of read catalog behind it, so the earthquake baseline can answer rather
 *    than refuse;
 *  - weather warnings **not covered** (ECCC is Canada-only and seeded disabled), and no cyclone
 *    history, so two cards state a limit rather than a count.
 *
 * `firms-stale` is the same world with the fire feeds down: NASA FIRMS's last successful poll is
 * five hours old and its recent attempts failed, and so is GDACS's wildfire feed — the second
 * source of the same family, without which the card stays `AVAILABLE` (see the fire block below).
 * The fire family is then `UNAVAILABLE` and never renders a count of zero (invariant I11). The cluster rows are still there — I11 is not "hide the data",
 * it is "do not claim emptiness you did not observe" — and the card shows no items because the
 * source that would have to vouch for them has not delivered.
 */

import { createHash } from 'node:crypto';

import type { DatabaseHandle, DB } from '@geonerva/db';
import {
  assignDetectionsToCluster,
  bulkInsertDetections,
  createCanonicalEvent,
  createCluster,
  finishAnalysisRun,
  finishRun,
  insertClusterVersionIfChanged,
  insertVersionIfChanged,
  linkRecord,
  acquireRunLease,
  recordIntervalCoverage,
  recordLiveCoverage,
  resolveSourceRecord,
  startAnalysisRun,
  upsertPlaces,
} from '@geonerva/db';

/**
 * The query builder, reached through `DatabaseHandle` so that this package never imports Kysely
 * itself — `.dependency-cruiser.cjs` keeps the driver inside `packages/db`, and a type-only import
 * would still be an edge.
 */
export type ScenarioDb = DatabaseHandle['db'];

export const SCENARIO_NAMES = ['all-fresh', 'firms-stale'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

/** The single instant every timestamp in this scenario is expressed relative to. */
export const SCENARIO_ANCHOR = '2026-09-22T13:06:00.000Z';

const ANCHOR_MS = Date.parse(SCENARIO_ANCHOR);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** `minutesBefore(4)` is 13:02, the USGS poll that is four minutes old at the anchor. */
function before(ms: number): Date {
  return new Date(ANCHOR_MS - ms);
}

/** The place `/place/marrakech-ma-2542997` resolves through, verbatim from GeoNames. */
export const MARRAKECH_PLACE = {
  geonameid: 2542997,
  name: 'Marrakesh',
  asciiName: 'Marrakesh',
  /* "Marrakech" is the spelling most users type and exists only as an alternate (ADR-013). */
  altNames: 'Marrakech,Marraquexe,Marrakesch,مراكش,Marakeš,マラケシュ',
  countryCode: 'MA',
  admin1: 'Marrakech-Safi',
  lat: 31.63416,
  lon: -7.99994,
  population: 839296,
  timezone: 'Africa/Casablanca',
} as const;

/**
 * The location the read models are asked about, after the API's own rounding.
 *
 * Two decimals, which is invariant I15 and what `roundUserCoordinate` produces for the row above.
 * Stated here so a test asserts against the same pair the response carries.
 */
export const MARRAKECH_REF = {
  key: 'p:2542997',
  label: 'Marrakesh',
  lat: 31.63,
  lon: -8.0,
  timezone: 'Africa/Casablanca',
  countryCode: 'MA',
  admin1: 'Marrakech-Safi',
} as const;

/** The public ids of the three subjects, stable so a Playwright spec can navigate straight to one. */
export const SCENARIO_IDS = {
  earthquake: 'EQ-26-7K3F9Q',
  olderEarthquake: 'EQ-26-3MZ8QA',
  /** Beyond `world.ts`; see the comment where it is seeded. */
  nearbyEarthquake: 'EQ-26-8TD4XH',
  fireCluster: 'FR-26-4HX2MB',
  flood: 'FL-26-9QW3TD',
  olderFlood: 'FL-24-2PN6VC',
} as const;

/** Geometry, from `world.ts`: the epicentre, the cluster centroid and the modelled flood area. */
export const SCENARIO_GEOMETRY = {
  eqEpicentre: { lat: 31.52, lon: -6.49 },
  fireCentroid: { lat: 31.4, lon: -8.3 },
  floodArea: {
    type: 'Polygon',
    coordinates: [
      [
        [-9.62, 30.18],
        [-8.71, 30.12],
        [-8.52, 30.55],
        [-9.05, 30.84],
        [-9.58, 30.66],
        [-9.62, 30.18],
      ],
    ],
  },
} as const;

/** The timeline, as offsets from the anchor. Mirrors `T` in `apps/web/lib/fixtures/world.ts`. */
const T = {
  eqObserved: before(78 * MINUTE + 48_000), // 11:47:12
  emscIngested: before(70 * MINUTE + 29_000), // 11:55:31
  emscObserved: before(78 * MINUTE + 50_000), // 11:47:10
  usgsV1Ingested: before(67 * MINUTE + 20_000), // 11:58:40
  gdacsEqIngested: before(45 * MINUTE + 50_000), // 12:20:10
  usgsV2Ingested: before(24 * MINUTE + 55_000), // 12:41:05
  usgsV2Updated: before(27 * MINUTE + 9_000), // 12:38:51
  olderEqObserved: before(4 * DAY + 15 * HOUR + 57 * MINUTE + 16_000), // 09-17T21:08:44
  olderEqIngested: before(4 * DAY + 15 * HOUR + 39 * MINUTE + 58_000), // 09-17T21:26:02
  fireFirst: before(1 * DAY + 11 * HOUR + 1 * MINUTE), // 09-21T02:05
  fireLast: before(10 * HOUR + 52 * MINUTE), // 09-22T02:14
  clusterV1: before(1 * DAY + 7 * HOUR + 36 * MINUTE), // 09-21T05:30
  clusterV2: before(22 * HOUR + 56 * MINUTE), // 09-21T14:10
  clusterV3: before(7 * HOUR + 46 * MINUTE), // 09-22T05:20
  floodObserved: before(2 * DAY + 7 * HOUR + 6 * MINUTE), // 09-20T06:00
  floodIngested: before(2 * DAY + 5 * HOUR + 54 * MINUTE), // 09-20T07:12
  floodUpdated: before(6 * HOUR + 26 * MINUTE), // 09-22T06:40
} as const;

/** The engine version the seeded analysis runs claim. Not the web app's; it is a fixture stamp. */
const ENGINE_VERSION = 'scenario-seed-1';

/** How far back the read catalog goes. Five years gives the 7-day baseline ~260 windows. */
const CATALOG_YEARS = 5;
const CATALOG_FROM = new Date(ANCHOR_MS - CATALOG_YEARS * 365.25 * DAY);
/** Where the historical backfill stops and the live polls take over. */
const BACKFILL_TO = before(2 * DAY);

export interface SeedOptions {
  /**
   * Reference earthquakes in the catalog before the current window.
   *
   * `EARTHQUAKE_BASELINE` needs ≥ 52 windows **and** ≥ 20 reference events above the estimated
   * completeness magnitude for `status: OK`, and `estimateCompleteness` needs 50 events above the
   * candidate Mc before it will use a computed one rather than the M4.5 global fallback. 140 is
   * comfortably past both while staying inside a test's patience.
   */
  readonly referenceEvents?: number;
}

export interface SeedResult {
  readonly scenario: ScenarioName;
  readonly anchor: string;
  readonly counts: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------------------------
// Small helpers. Deterministic by construction: no randomness, no wall clock.
// ---------------------------------------------------------------------------------------------

/** A 32-byte content hash over the values that make a version's content what it is. */
function contentHash(...parts: readonly (string | number | boolean | null)[]): Buffer {
  return createHash('sha256').update(parts.map(String).join('\u0000'), 'utf8').digest();
}

/** A UUID that is stable for a label, so a failing assertion names the same row every run. */
function stableUuid(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** A point at a bearing, so the reference catalog is not a line of events due north. */
function around(km: number, bearingDegrees: number): { lat: number; lon: number } {
  const radians = (bearingDegrees * Math.PI) / 180;
  const dLat = (km * Math.cos(radians)) / 110.574;
  const dLon = (km * Math.sin(radians)) / (111.32 * Math.cos((MARRAKECH_REF.lat * Math.PI) / 180));
  return {
    lat: Number((MARRAKECH_REF.lat + dLat).toFixed(4)),
    lon: Number((MARRAKECH_REF.lon + dLon).toFixed(4)),
  };
}

/** The id of one seeded product. Read rather than assumed: migration 0008 owns these rows. */
async function productId(db: ScenarioDb, sourceId: string, code: string): Promise<number> {
  const row = await db
    .withSchema('geonerva')
    .selectFrom('source_products')
    .select('id')
    .where('source_id', '=', sourceId)
    .where('code', '=', code)
    .executeTakeFirst();
  if (row === undefined) throw new Error(`migration 0008 has no product ${sourceId}/${code}`);
  return row.id;
}

// ---------------------------------------------------------------------------------------------
// Feeds: scheduled polls and the coverage they recorded.
// ---------------------------------------------------------------------------------------------

interface Poll {
  readonly at: Date;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly newestObservedAt?: Date | null;
  /** Hours of feed the poll read back over, which is what becomes coverage (ADR-041). */
  readonly lookbackHours?: number;
}

/**
 * One scheduled poll, finished, with its coverage recorded.
 *
 * `committedAt` is passed to `finishRun` rather than left to `clock_timestamp()`, because a
 * replay reads `committed_at` and a run committed at the real wall clock would be invisible at
 * the anchor — the source would read `UNAVAILABLE` at the very knowledge time the scenario is
 * about. Only `SUCCEEDED` polls record coverage: a failed fetch read nothing, and crediting it
 * would be the availability lie the ledger exists to prevent.
 */
async function poll(
  db: ScenarioDb,
  sourceId: string,
  product: number,
  spec: Poll,
): Promise<number> {
  const lease = await acquireRunLease(db, {
    sourceId,
    productId: product,
    trigger: 'SCHEDULE',
    startedAt: spec.at,
  });
  if (!lease.acquired) throw new Error(`could not lease ${sourceId}/${String(product)}`);

  await finishRun(db, {
    runId: lease.runId,
    status: spec.status,
    newestObservedAt: spec.newestObservedAt ?? null,
    errorClass: spec.status === 'FAILED' ? 'HTTP_5XX' : null,
    finishedAt: spec.at,
    committedAt: spec.at,
    httpStatus: spec.status === 'FAILED' ? 503 : 200,
  });

  if (spec.status !== 'SUCCEEDED') return 0;
  const lookback = (spec.lookbackHours ?? 24) * HOUR;
  return db.transaction().execute((trx) =>
    recordLiveCoverage(trx, {
      productId: product,
      window: { from: new Date(spec.at.getTime() - lookback), to: spec.at },
      recordedAt: spec.at,
    }),
  );
}

/**
 * A completed historical backfill of `[from, to)`, checkpointed at `completedAt`.
 *
 * The plan and interval rows are written with the query builder rather than through
 * `openBackfillPlan`/`markIntervalDone`, for one reason: `markIntervalDone` stamps `completed_at`
 * with `clock_timestamp()`, and `recordIntervalCoverage` uses that stamp as the coverage's
 * `recorded_at`. Coverage recorded after the anchor is coverage a replay at the anchor cannot
 * see, so the baseline would refuse for a catalog it had in fact read. The coverage itself is
 * then written by the production function, reading these rows exactly as `markIntervalDone` does.
 */
async function backfilled(
  db: ScenarioDb,
  sourceId: string,
  product: number | null,
  from: Date,
  to: Date,
): Promise<number> {
  const planId = stableUuid(`plan:${sourceId}:${String(product)}:${from.toISOString()}`);
  await db
    .withSchema('geonerva')
    .insertInto('backfill_plans')
    .values({
      id: planId,
      source_id: sourceId,
      product_id: product,
      mode: 'HISTORICAL',
      range_from: from,
      range_to: to,
      min_magnitude: null,
      window_ms: String(DAY),
      min_window_ms: String(DAY),
      status: 'COMPLETED',
      finished_at: to,
    })
    .execute();
  await db
    .withSchema('geonerva')
    .insertInto('backfill_intervals')
    .values({
      plan_id: planId,
      interval_from: from,
      interval_to: to,
      status: 'DONE',
      completed_at: to,
    })
    .execute();
  return db.transaction().execute((trx) => recordIntervalCoverage(trx, { planId, from, to }));
}

/** A finished derivation run, which is the axis that lets a family's items be believed. */
async function derivation(
  db: ScenarioDb,
  kind: 'CORRELATION' | 'SEED' | 'CLUSTERING',
  at: Date,
): Promise<void> {
  const id = stableUuid(`analysis:${kind}:${at.toISOString()}`);
  await startAnalysisRun(db, { id, kind, engineVersion: ENGINE_VERSION, startedAt: at });
  await finishAnalysisRun(db, { id, status: 'SUCCEEDED', finishedAt: at });
}

// ---------------------------------------------------------------------------------------------
// Observations.
// ---------------------------------------------------------------------------------------------

interface ObservationSpec {
  readonly sourceId: string;
  readonly productId?: number | null;
  readonly hazardType: 'EARTHQUAKE' | 'FLOOD';
  readonly primaryKey: string;
  readonly aliases?: readonly string[];
  readonly ingestedAt: Date;
  readonly observedAt: Date;
  readonly sourceUpdatedAt?: Date | null;
  readonly centroid: { readonly lat: number; readonly lon: number };
  readonly geometryKind?: 'EPICENTER' | 'MODEL_AREA';
  readonly magnitude?: number | null;
  readonly magnitudeType?: string | null;
  readonly depthKm?: number | null;
  readonly contributor?: string | null;
  readonly providerStatus?: string | null;
  readonly title?: string | null;
  readonly sourceUrl?: string | null;
  readonly severityScheme?: string | null;
  readonly severityValue?: string | null;
  readonly derivedFrom?: unknown;
  readonly geometries?: readonly {
    readonly role: 'affected_area' | 'global_area';
    readonly seq: number;
    readonly geoJson: unknown;
  }[];
  readonly contentTag?: string;
}

/**
 * Resolves the record identity and inserts a version if the content changed — the same two calls
 * the ingestion pipeline makes, in one transaction, so the head pointer and the version land
 * together.
 */
async function observe(db: ScenarioDb, spec: ObservationSpec): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const identity = await resolveSourceRecord(trx, {
      sourceId: spec.sourceId,
      productId: spec.productId ?? null,
      hazardType: spec.hazardType,
      primaryKey: spec.primaryKey,
      aliases: spec.aliases ?? [spec.primaryKey],
      firstIngestedAt: spec.ingestedAt,
    });
    await insertVersionIfChanged(trx, {
      sourceRecordId: identity.sourceRecordId,
      hazardType: spec.hazardType,
      ingestedAt: spec.ingestedAt,
      observedAt: spec.observedAt,
      sourceUpdatedAt: spec.sourceUpdatedAt ?? null,
      lifecycleStatus: 'ACTIVE',
      severityScheme: spec.severityScheme ?? null,
      severityValue: spec.severityValue ?? null,
      providerStatus: spec.providerStatus ?? null,
      contributor: spec.contributor ?? null,
      magnitude: spec.magnitude ?? null,
      magnitudeType: spec.magnitudeType ?? null,
      depthKm: spec.depthKm ?? null,
      centroid: spec.centroid,
      geometryKind: spec.geometryKind ?? 'EPICENTER',
      attributes: {},
      title: spec.title ?? null,
      sourceUrl: spec.sourceUrl ?? null,
      derivedFrom: spec.derivedFrom,
      contentSha256: contentHash(
        spec.sourceId,
        spec.primaryKey,
        spec.contentTag ?? '',
        spec.magnitude ?? null,
        spec.magnitudeType ?? null,
        spec.depthKm ?? null,
        spec.centroid.lat,
        spec.centroid.lon,
        spec.severityValue ?? null,
      ),
      ...(spec.geometries === undefined ? {} : { geometries: spec.geometries }),
    });
    return identity.sourceRecordId;
  });
}

/** Opens a canonical event with a fixed public id and links its members. */
async function canonical(
  db: ScenarioDb,
  input: {
    readonly publicId: string;
    readonly hazardType: 'EARTHQUAKE' | 'FLOOD';
    readonly createdAt: Date;
    readonly members: readonly {
      readonly sourceRecordId: string;
      readonly relation: 'PRIMARY' | 'SAME_EVENT' | 'DERIVED_COPY';
      readonly matchKind: 'SEED' | 'SPATIOTEMPORAL' | 'IDENTITY_REF';
      readonly linkedAt: Date;
    }[];
  },
): Promise<string> {
  const event = await createCanonicalEvent(db, {
    id: stableUuid(`event:${input.publicId}`),
    publicId: input.publicId,
    hazardType: input.hazardType,
    createdAt: input.createdAt,
  });
  for (const member of input.members) {
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: member.sourceRecordId,
        relation: member.relation,
        matchKind: member.matchKind,
        algorithmVersion: 'eq-corr-1',
        linkedAt: member.linkedAt,
      }),
    );
  }
  return event.id;
}

// ---------------------------------------------------------------------------------------------
// The scenario.
// ---------------------------------------------------------------------------------------------

/**
 * Writes one scenario. The caller has already truncated; see the module comment.
 *
 * Returns the row counts, which is what a seeding script prints and what an integration test
 * asserts against — a seed that silently wrote nothing is the failure mode worth catching.
 */
export async function seedMarrakechScenario(
  db: ScenarioDb,
  scenario: ScenarioName,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const firmsDelivered = scenario === 'all-fresh';
  const referenceEvents = options.referenceEvents ?? 140;

  const products = {
    usgs: await productId(db, 'usgs', 'comcat'),
    emsc: await productId(db, 'emsc', 'rts'),
    gdacsEq: await productId(db, 'gdacs', 'EQ'),
    gdacsFl: await productId(db, 'gdacs', 'FL'),
    gdacsTc: await productId(db, 'gdacs', 'TC'),
    gdacsWf: await productId(db, 'gdacs', 'WF'),
    gdacsVo: await productId(db, 'gdacs', 'VO'),
    gdacsDr: await productId(db, 'gdacs', 'DR'),
    firms20: await productId(db, 'firms', 'VIIRS_NOAA20_NRT'),
    firms21: await productId(db, 'firms', 'VIIRS_NOAA21_NRT'),
  };

  // ---- The place ------------------------------------------------------------------------------
  await upsertPlaces(db, [MARRAKECH_PLACE]);

  // ---- What GeoNerva had read ----------------------------------------------------------------
  // Five years of catalog for the feeds whose history a baseline reads, then live polls from
  // there to the anchor. The gap between them is why the live windows look 24 h back: a window
  // that did not meet the frontier would start a new run and leave a hole (ADR-041).
  let coverageHours = 0;
  coverageHours += await backfilled(db, 'usgs', products.usgs, CATALOG_FROM, BACKFILL_TO);
  coverageHours += await backfilled(db, 'emsc', products.emsc, CATALOG_FROM, BACKFILL_TO);
  coverageHours += await backfilled(db, 'gdacs', products.gdacsFl, CATALOG_FROM, BACKFILL_TO);

  /*
   * The poll history, each reading 24 h back so the ledger's frontier stays contiguous from the
   * backfill's end to the last success.
   *
   * The offsets are not an even cadence: there is a poll a few minutes before each **change-window
   * boundary** (7 d, 24 h, 6 h). A window's diff compares source health at its two ends, and a feed
   * whose last success at the earlier end was hours old reads STALE there and FRESH now — so the
   * diff reports `SOURCE_RECOVERED` for every feed, in a scenario where nothing failed. That is
   * noise in the one section an E2E spec reads most closely, and it is an artefact of the fixture
   * rather than anything the product did.
   */
  const cadence = [
    7 * DAY + 4 * MINUTE,
    7 * DAY,
    4 * DAY,
    2 * DAY,
    24 * HOUR + 4 * MINUTE,
    24 * HOUR,
    12 * HOUR,
    6 * HOUR + 4 * MINUTE,
    6 * HOUR,
    3 * HOUR,
    1 * HOUR,
  ];
  const feeds: readonly {
    readonly sourceId: string;
    readonly productId: number;
    readonly lastSuccess: Date;
    readonly newestObservedAt: Date;
  }[] = [
    {
      sourceId: 'usgs',
      productId: products.usgs,
      lastSuccess: before(4 * MINUTE),
      newestObservedAt: before(79 * MINUTE),
    },
    {
      sourceId: 'emsc',
      productId: products.emsc,
      lastSuccess: before(5 * MINUTE),
      newestObservedAt: before(41 * MINUTE),
    },
    {
      sourceId: 'gdacs',
      productId: products.gdacsEq,
      lastSuccess: before(9 * MINUTE),
      newestObservedAt: before(46 * MINUTE),
    },
    {
      sourceId: 'gdacs',
      productId: products.gdacsFl,
      lastSuccess: before(9 * MINUTE),
      newestObservedAt: T.floodUpdated,
    },
    /*
     * The quiet GDACS feeds, polled and empty.
     *
     * Without them the cyclone and "other" cards read UNAVAILABLE — `SOURCE_NEVER_SUCCEEDED` —
     * and the briefing's headline becomes an outage report about volcanoes rather than the
     * earthquake the scenario is about. A feed that has been polled successfully and returned
     * nothing is `NOTHING_TO_REPORT`, which is the honest state for a quiet region and the one
     * the "not-covered vs nothing-to-report" distinction needs both halves of to be visible.
     */
    {
      sourceId: 'gdacs',
      productId: products.gdacsTc,
      lastSuccess: before(9 * MINUTE),
      newestObservedAt: before(6 * HOUR),
    },
    {
      sourceId: 'gdacs',
      productId: products.gdacsVo,
      lastSuccess: before(9 * MINUTE),
      newestObservedAt: before(6 * HOUR),
    },
    {
      sourceId: 'gdacs',
      productId: products.gdacsDr,
      lastSuccess: before(9 * MINUTE),
      newestObservedAt: before(6 * HOUR),
    },
  ];

  for (const feed of feeds) {
    for (const ago of cadence) {
      coverageHours += await poll(db, feed.sourceId, feed.productId, {
        at: before(ago),
        status: 'SUCCEEDED',
        newestObservedAt: before(ago + 30 * MINUTE),
      });
    }
    coverageHours += await poll(db, feed.sourceId, feed.productId, {
      at: feed.lastSuccess,
      status: 'SUCCEEDED',
      newestObservedAt: feed.newestObservedAt,
    });
  }

  /*
   * The fire feeds, which are the whole difference between the two scenarios.
   *
   * `all-fresh`: the last successful poll is 22 minutes old, inside the 90-minute freshness
   * window of FIRMS's seeded policy, so the family is AVAILABLE.
   *
   * `firms-stale`: the last success is five hours old — past FIRMS's `fetchStaleAfterS` of three
   * hours and GDACS's of two — and the three attempts since then returned 5xx. The card must read
   * UNAVAILABLE and must not render "0 detections" (invariant I11, docs/TESTING.md §5).
   *
   * **GDACS's wildfire feed is in this loop, and it has to be.** `FIRE_ACTIVITY` covers two hazard
   * types, `THERMAL_ACTIVITY` and `WILDFIRE_EVENT`, and `resolveAvailability` reports
   * `ALL_SOURCES_UNUSABLE` only when **every** source of a family is unusable — correctly, because
   * a fresh GDACS WF feed means GeoNerva really can still say something about fire here. So a
   * scenario in which only FIRMS is stale leaves the card `AVAILABLE`, and the outage flow §5
   * describes cannot be exercised by it. The scenario keeps its name because `parseScenario` in
   * `apps/web/lib/view/data.ts` uses it, and it is reported as a finding: §5 and the P9a mock both
   * describe a card that the rules produce only when the wildfire feed is down too.
   */
  for (const fireProduct of [products.firms20, products.firms21, products.gdacsWf]) {
    const fireSource = fireProduct === products.gdacsWf ? 'gdacs' : 'firms';
    for (const ago of [7 * DAY, 4 * DAY, 2 * DAY, 24 * HOUR, 12 * HOUR, 6 * HOUR]) {
      coverageHours += await poll(db, fireSource, fireProduct, {
        at: before(ago),
        status: 'SUCCEEDED',
        newestObservedAt: before(ago + 3 * HOUR),
      });
    }
    if (firmsDelivered) {
      coverageHours += await poll(db, fireSource, fireProduct, {
        at: before(22 * MINUTE),
        status: 'SUCCEEDED',
        newestObservedAt: before(220 * MINUTE),
      });
    } else {
      coverageHours += await poll(db, fireSource, fireProduct, {
        at: before(5 * HOUR),
        status: 'SUCCEEDED',
        newestObservedAt: before(11 * HOUR + 10 * MINUTE),
      });
      for (const ago of [2 * HOUR, 62 * MINUTE, 22 * MINUTE]) {
        await poll(db, fireSource, fireProduct, { at: before(ago), status: 'FAILED' });
      }
    }
  }

  // ---- The derivations ------------------------------------------------------------------------
  // One before the change window opens and one just before the anchor, so both knowledge times a
  // "what changed" diff reads have a completed run vouching for them.
  for (const at of [before(7 * DAY + HOUR), before(10 * MINUTE)]) {
    await derivation(db, 'CORRELATION', at);
    await derivation(db, 'SEED', at);
  }
  await derivation(db, 'CLUSTERING', firmsDelivered ? before(20 * MINUTE) : before(5 * HOUR));

  // ---- The earthquake, as three sources told it ----------------------------------------------
  const usgsRecord = await observe(db, {
    sourceId: 'usgs',
    productId: products.usgs,
    hazardType: 'EARTHQUAKE',
    primaryKey: 'us7000tikb',
    aliases: ['us7000tikb'],
    ingestedAt: T.usgsV1Ingested,
    observedAt: T.eqObserved,
    centroid: SCENARIO_GEOMETRY.eqEpicentre,
    magnitude: 4.6,
    magnitudeType: 'mb',
    depthKm: 10,
    contributor: 'us',
    providerStatus: 'automatic',
    title: 'M 4.6 - 49 km S of Azilal, Morocco',
    sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb',
    contentTag: 'v1',
  });
  // The revision: mb 4.6 automatic becomes Mww 4.7 reviewed. A second version of the same record,
  // which is what makes the event's timeline and the EVENT_UPDATED change signal real.
  await observe(db, {
    sourceId: 'usgs',
    productId: products.usgs,
    hazardType: 'EARTHQUAKE',
    primaryKey: 'us7000tikb',
    aliases: ['us7000tikb'],
    ingestedAt: T.usgsV2Ingested,
    observedAt: T.eqObserved,
    sourceUpdatedAt: T.usgsV2Updated,
    centroid: SCENARIO_GEOMETRY.eqEpicentre,
    magnitude: 4.7,
    magnitudeType: 'mww',
    depthKm: 10,
    contributor: 'us',
    providerStatus: 'reviewed',
    title: 'M 4.7 - 49 km S of Azilal, Morocco',
    sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb',
    contentTag: 'v2',
  });

  const emscRecord = await observe(db, {
    sourceId: 'emsc',
    productId: products.emsc,
    hazardType: 'EARTHQUAKE',
    primaryKey: '20260922_0000187',
    ingestedAt: T.emscIngested,
    observedAt: T.emscObserved,
    centroid: { lat: 31.55, lon: -6.44 },
    magnitude: 4.6,
    magnitudeType: 'mb',
    depthKm: 12,
    contributor: 'EMSC',
    title: 'MOROCCO',
    sourceUrl: 'https://www.seismicportal.eu/eventdetails.html?unid=20260922_0000187',
  });

  // GDACS restates the USGS solution and names it, which is what keeps the independent-source
  // count at two rather than three (ADR-030).
  const gdacsEqRecord = await observe(db, {
    sourceId: 'gdacs',
    productId: products.gdacsEq,
    hazardType: 'EARTHQUAKE',
    primaryKey: '1498833',
    ingestedAt: T.gdacsEqIngested,
    observedAt: T.eqObserved,
    centroid: SCENARIO_GEOMETRY.eqEpicentre,
    magnitude: 4.7,
    depthKm: 10,
    severityScheme: 'GDACS_ALERT',
    severityValue: 'Green',
    title: 'Earthquake in Morocco',
    sourceUrl: 'https://www.gdacs.org/report.aspx?eventid=1498833&eventtype=EQ',
    derivedFrom: { source: 'usgs', id: 'us7000tikb' },
  });

  await canonical(db, {
    publicId: SCENARIO_IDS.earthquake,
    hazardType: 'EARTHQUAKE',
    createdAt: T.usgsV1Ingested,
    members: [
      {
        sourceRecordId: usgsRecord,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        linkedAt: T.usgsV1Ingested,
      },
      {
        sourceRecordId: emscRecord,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        linkedAt: T.usgsV1Ingested,
      },
      {
        sourceRecordId: gdacsEqRecord,
        /* Not SAME_EVENT: `assessAgreement` counts independence by excluding DERIVED_COPY, so
         * linking a republication as an equal member would credit GDACS as a third independent
         * source for a solution it copied from USGS (ADR-030). */
        relation: 'DERIVED_COPY',
        matchKind: 'IDENTITY_REF',
        linkedAt: T.gdacsEqIngested,
      },
    ],
  });

  // The smaller, single-source earthquake five days ago: the second item on the card, and the
  // second event inside the 7-day baseline window.
  const olderRecord = await observe(db, {
    sourceId: 'usgs',
    productId: products.usgs,
    hazardType: 'EARTHQUAKE',
    primaryKey: 'us7000tia2',
    ingestedAt: T.olderEqIngested,
    observedAt: T.olderEqObserved,
    centroid: around(96, 190),
    magnitude: 3.4,
    magnitudeType: 'mb',
    depthKm: 14,
    contributor: 'us',
    providerStatus: 'reviewed',
    title: 'M 3.4 - 12 km NE of Taroudant, Morocco',
    sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tia2',
  });
  await canonical(db, {
    publicId: SCENARIO_IDS.olderEarthquake,
    hazardType: 'EARTHQUAKE',
    createdAt: T.olderEqIngested,
    members: [
      {
        sourceRecordId: olderRecord,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        linkedAt: T.olderEqIngested,
      },
    ],
  });

  /*
   * One event beyond `world.ts`: an M5.4 45 km away, six hours old, reported by USGS and EMSC.
   *
   * It is here because the P9a mock and the real engine disagree, and the engine is right. The
   * mock gives the M4.7 at 142 km `importance: 78` and `prominence: 'HEADLINE'`; `assessSubject`
   * rates that event **LOW** (the distance–magnitude table), so `NEW_EVENT` scores
   * base 25 + level 0 + recency ≈ 34 and lands in `detail`. A briefing whose "What Changed"
   * section has nothing listed cannot support the two E2E flows that read it
   * (docs/TESTING.md §5: "dashboard loads with headline, What Changed, cards" and "Open event
   * from What Changed"), so the scenario carries an event the engine itself ranks that way rather
   * than a fixture that asserts a prominence the rules do not produce.
   *
   * Reported to the owner as a discrepancy in the mock, not silently patched around: if the
   * intended product behaviour is that an M4.7 at 142 km *is* headline news, that is a change to
   * the relevance table or to §10.4's weights, and it belongs in an ADR rather than in a seed.
   */
  const nearbyAt = before(6 * HOUR);
  const nearbyIngested = before(6 * HOUR - 3 * MINUTE);
  const nearbyUsgs = await observe(db, {
    sourceId: 'usgs',
    productId: products.usgs,
    hazardType: 'EARTHQUAKE',
    primaryKey: 'us7000tijz',
    ingestedAt: nearbyIngested,
    observedAt: nearbyAt,
    centroid: around(45, 135),
    magnitude: 5.4,
    magnitudeType: 'mww',
    depthKm: 9,
    contributor: 'us',
    providerStatus: 'reviewed',
    title: 'M 5.4 - 33 km SE of Marrakesh, Morocco',
    sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tijz',
  });
  const nearbyEmsc = await observe(db, {
    sourceId: 'emsc',
    productId: products.emsc,
    hazardType: 'EARTHQUAKE',
    primaryKey: '20260922_0000151',
    ingestedAt: before(6 * HOUR - 5 * MINUTE),
    observedAt: new Date(nearbyAt.getTime() + 2_000),
    centroid: around(45, 137),
    magnitude: 5.3,
    magnitudeType: 'mb',
    depthKm: 11,
    contributor: 'EMSC',
    title: 'MOROCCO',
    sourceUrl: 'https://www.seismicportal.eu/eventdetails.html?unid=20260922_0000151',
  });
  await canonical(db, {
    publicId: SCENARIO_IDS.nearbyEarthquake,
    hazardType: 'EARTHQUAKE',
    createdAt: nearbyIngested,
    members: [
      {
        sourceRecordId: nearbyUsgs,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        linkedAt: nearbyIngested,
      },
      {
        sourceRecordId: nearbyEmsc,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        linkedAt: nearbyIngested,
      },
    ],
  });

  // ---- The floods ------------------------------------------------------------------------------
  const floodRecord = await observe(db, {
    sourceId: 'gdacs',
    productId: products.gdacsFl,
    hazardType: 'FLOOD',
    primaryKey: '1103921',
    ingestedAt: T.floodIngested,
    observedAt: T.floodObserved,
    centroid: { lat: 30.45, lon: -9.05 },
    geometryKind: 'MODEL_AREA',
    severityScheme: 'GDACS_ALERT',
    severityValue: 'Green',
    title: 'Flood in Morocco',
    sourceUrl: 'https://www.gdacs.org/report.aspx?eventid=1103921&eventtype=FL',
    geometries: [{ role: 'affected_area', seq: 1, geoJson: SCENARIO_GEOMETRY.floodArea }],
    contentTag: 'episode-1',
  });
  // Episode 3, this morning: the same record updated, which is the flood card's UPDATED status.
  await observe(db, {
    sourceId: 'gdacs',
    productId: products.gdacsFl,
    hazardType: 'FLOOD',
    primaryKey: '1103921',
    ingestedAt: T.floodUpdated,
    observedAt: T.floodObserved,
    sourceUpdatedAt: T.floodUpdated,
    centroid: { lat: 30.45, lon: -9.05 },
    geometryKind: 'MODEL_AREA',
    severityScheme: 'GDACS_ALERT',
    severityValue: 'Green',
    title: 'Flood in Morocco',
    sourceUrl: 'https://www.gdacs.org/report.aspx?eventid=1103921&eventtype=FL',
    geometries: [{ role: 'affected_area', seq: 1, geoJson: SCENARIO_GEOMETRY.floodArea }],
    contentTag: 'episode-3',
  });
  await canonical(db, {
    publicId: SCENARIO_IDS.flood,
    hazardType: 'FLOOD',
    createdAt: T.floodIngested,
    members: [
      {
        sourceRecordId: floodRecord,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        linkedAt: T.floodIngested,
      },
    ],
  });

  // One older flood in the record, so the GDACS flood context has a history to call this rare
  // against rather than refusing for want of one.
  const olderFloodAt = new Date(ANCHOR_MS - 2 * 365 * DAY);
  const olderFloodRecord = await observe(db, {
    sourceId: 'gdacs',
    productId: products.gdacsFl,
    hazardType: 'FLOOD',
    primaryKey: '1081204',
    ingestedAt: new Date(olderFloodAt.getTime() + HOUR),
    observedAt: olderFloodAt,
    centroid: { lat: 32.24, lon: -8.51 },
    geometryKind: 'MODEL_AREA',
    severityScheme: 'GDACS_ALERT',
    severityValue: 'Green',
    title: 'Flood in Morocco',
    sourceUrl: 'https://www.gdacs.org/report.aspx?eventid=1081204&eventtype=FL',
  });
  await canonical(db, {
    publicId: SCENARIO_IDS.olderFlood,
    hazardType: 'FLOOD',
    createdAt: new Date(olderFloodAt.getTime() + HOUR),
    members: [
      {
        sourceRecordId: olderFloodRecord,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        linkedAt: new Date(olderFloodAt.getTime() + HOUR),
      },
    ],
  });

  // ---- The reference catalog ------------------------------------------------------------------
  /*
   * Earthquakes spread evenly over the read catalog, on a fixed magnitude ladder.
   *
   * Evenly rather than randomly: the distribution the baseline computes has to be the same on
   * every run, or a percentile assertion is a coin toss. The ladder is weighted towards small
   * magnitudes so that `estimateCompleteness` has the 50 events above a low candidate Mc it needs
   * to compute one, instead of falling back to M4.5 and discarding almost the whole catalog.
   */
  /*
   * Two populations, and the split is not decoration.
   *
   * `estimateCompleteness` raises the counting threshold to `RETENTION_FLOOR_MAGNITUDE` (M4.5)
   * whenever the reference period reaches past the 30 days small earthquakes are kept for — which
   * a five-year reference always does. A catalog of M3s is therefore *invisible* to the 7-day
   * baseline no matter how large it is, and a seed built from one produces `RARE_ACTIVITY`: 260
   * windows and no events. So the countable half is at or above the floor, and the smaller half is
   * there because a real catalog has one — it gives the maximum-curvature estimate something to
   * chew on and the map something to draw.
   */
  const strongLadder = [4.5, 4.8, 5.1, 4.6, 5.4, 4.7, 4.9, 5.2, 4.5, 4.6, 5.0, 4.8];
  const weakLadder = [3.0, 3.2, 3.1, 3.4, 3.0, 3.6, 3.3, 3.8, 3.1, 4.1, 3.2, 3.5];
  const referenceWindowMs = ANCHOR_MS - WEEK - CATALOG_FROM.getTime();
  for (let index = 0; index < referenceEvents; index += 1) {
    const observedAt = new Date(
      CATALOG_FROM.getTime() + Math.round(((index + 0.5) * referenceWindowMs) / referenceEvents),
    );
    const ingestedAt = new Date(observedAt.getTime() + 4 * MINUTE);
    /* Every third event clears the floor: 47 of 140, comfortably past the 20 the rule needs. */
    const strong = index % 3 === 0;
    const magnitude = strong
      ? (strongLadder[Math.floor(index / 3) % strongLadder.length] ?? 4.7)
      : (weakLadder[index % weakLadder.length] ?? 3.2);
    const record = await observe(db, {
      sourceId: 'usgs',
      productId: products.usgs,
      hazardType: 'EARTHQUAKE',
      primaryKey: `usref${String(index).padStart(4, '0')}`,
      ingestedAt,
      observedAt,
      centroid: around(12 + ((index * 17) % 128), (index * 61) % 360),
      magnitude,
      magnitudeType: strong ? 'mww' : 'mb',
      depthKm: 8 + ((index * 3) % 25),
      contributor: 'us',
      providerStatus: 'reviewed',
      title: `M ${magnitude.toFixed(1)} - Morocco`,
    });
    await canonical(db, {
      publicId: `EQ-${String(observedAt.getUTCFullYear()).slice(2)}-R${String(index).padStart(5, '0')}`,
      hazardType: 'EARTHQUAKE',
      createdAt: ingestedAt,
      members: [
        { sourceRecordId: record, relation: 'PRIMARY', matchKind: 'SEED', linkedAt: ingestedAt },
      ],
    });
  }

  // ---- The fire activity cluster ---------------------------------------------------------------
  /*
   * Fourteen VIIRS detections over three overpasses, and the three cluster summaries the
   * clustering run wrote as they arrived — 6, then 9, then 14. The summary's `n_total` and the
   * number of reconstructible detections must agree or the detail page withholds the set
   * (ADR-039), so the detections are assigned before the last version is written.
   */
  const clusterId = stableUuid(`cluster:${SCENARIO_IDS.fireCluster}`);
  await createCluster(db, {
    id: clusterId,
    publicId: SCENARIO_IDS.fireCluster,
    createdAt: T.clusterV1,
    status: 'ACTIVE',
  });

  const overpasses = [
    { count: 6, acquiredAt: T.fireFirst, ingestedAt: T.clusterV1, product: products.firms20 },
    {
      count: 3,
      acquiredAt: new Date(T.clusterV2.getTime() - 82 * MINUTE),
      ingestedAt: T.clusterV2,
      product: products.firms21,
    },
    { count: 5, acquiredAt: T.fireLast, ingestedAt: T.clusterV3, product: products.firms20 },
  ] as const;

  let detections = 0;
  const versions = [
    { asOf: T.clusterV1, nTotal: 6, n24h: 6, overpasses: 1, frpSum: 12.4, frpMax: 4.1 },
    { asOf: T.clusterV2, nTotal: 9, n24h: 9, overpasses: 2, frpSum: 27.9, frpMax: 6.8 },
    { asOf: T.clusterV3, nTotal: 14, n24h: 8, overpasses: 2, frpSum: 41.7, frpMax: 9.3 },
  ] as const;

  for (const [index, overpass] of overpasses.entries()) {
    await bulkInsertDetections(
      db,
      Array.from({ length: overpass.count }, (_, offset) => ({
        productId: overpass.product,
        acquiredAt: new Date(overpass.acquiredAt.getTime() + offset * 12_000),
        lat: Number((SCENARIO_GEOMETRY.fireCentroid.lat + (offset - 2) * 0.006).toFixed(5)),
        lon: Number(
          (SCENARIO_GEOMETRY.fireCentroid.lon + (index - 1) * 0.008 + offset * 0.004).toFixed(5),
        ),
        confidenceClass: 'NOMINAL' as const,
        confidenceRaw: 'n',
        frp: 2.1 + offset * 0.4,
        brightTi4: 328 + offset,
        brightTi5: 291 + offset,
        scan: 0.42,
        track: 0.38,
        daynight: offset % 2 === 0 ? ('D' as const) : ('N' as const),
        providerVersion: '2.0NRT',
        ingestedAt: overpass.ingestedAt,
      })),
    );
    detections += overpass.count;

    // Membership, then the summary: a version whose count the detections cannot support is a
    // summary of a set nobody can see.
    const unassigned = await db
      .withSchema('geonerva')
      .selectFrom('fire_detections')
      .select('id')
      .where('cluster_id', 'is', null)
      .execute();
    await assignDetectionsToCluster(
      db,
      clusterId,
      unassigned.map((row) => row.id),
    );

    const version = versions[index];
    if (version === undefined) continue;
    await insertClusterVersionIfChanged(db, {
      clusterId,
      asOf: version.asOf,
      nTotal: version.nTotal,
      n24h: version.n24h,
      overpasses24h: version.overpasses,
      firstDetectedAt: T.fireFirst,
      lastDetectedAt: new Date(overpass.acquiredAt.getTime() + (overpass.count - 1) * 12_000),
      frpSum24h: version.frpSum,
      frpMax: version.frpMax,
      maxConfidence: 'NOMINAL',
      productIds: [overpass.product],
      hullGeoJson: null,
      centroid: SCENARIO_GEOMETRY.fireCentroid,
      status: 'ACTIVE',
      contentSha256: contentHash('fire-cluster', SCENARIO_IDS.fireCluster, version.nTotal),
    });
  }

  const counts = await rowCounts(db);
  return {
    scenario,
    anchor: SCENARIO_ANCHOR,
    counts: { ...counts, feed_coverage_hours: coverageHours, fire_detections_seeded: detections },
  };
}

/**
 * Row counts of the tables the read paths depend on, so a seed can prove it wrote something.
 *
 * `feed_coverage_hours` is not in this list, and not because it does not matter — it is the
 * biggest table the seed writes. Its size is reported instead from what `recordLiveCoverage` and
 * `recordIntervalCoverage` *return*: the production writers' own count of the hours they inserted,
 * which is the number worth asserting on, and which does not cost a scan of 130,000 rows.
 */
export async function rowCounts(db: ScenarioDb): Promise<Readonly<Record<string, number>>> {
  const tables = [
    'places',
    'ingestion_runs',
    'analysis_runs',
    'source_records',
    'observation_versions',
    'observation_geometries',
    'canonical_events',
    'canonical_links',
    'fire_clusters',
    'fire_cluster_versions',
    'fire_detections',
    'backfill_plans',
  ] as const;

  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = await countOf(db, table);
  }
  return counts;
}

/**
 * Rows in one seeded table.
 *
 * `selectAll` and `length` rather than `count(*)`: every table above holds a few hundred rows at
 * most, and a generic `count` expression does not type against Kysely's union of table names.
 */
async function countOf(db: ScenarioDb, table: keyof DB): Promise<number> {
  const rows = await db.withSchema('geonerva').selectFrom(table).selectAll().execute();
  return rows.length;
}
