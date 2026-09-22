/**
 * Representative latency of the read API on a seeded database (IMPLEMENTATION_PLAN P8.6; G6's
 * "p95 briefing latency < 600 ms on the seeded dataset").
 *
 *   DATABASE_URL_TEST=postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva_bench_test \
 *     pnpm bench:api
 *
 * ### What is measured, and what is not
 *
 * Each route handler is called **in process**, sequentially, exactly as Next.js would call it:
 * parameter parsing, the rate-limit write, the as-of reads, assembly, the Zod-free JSON
 * serialization. What is not included is everything outside the process — TLS, the platform's
 * routing, the CDN (which serves most live traffic from cache, §13.3) — and concurrency: one
 * request at a time, so the figures are service time, not time under load.
 *
 * The database is the local development container. Its data volume sits on a USB-attached SSD
 * (see the G8 report, §8), so read latency here is if anything pessimistic against a hosted
 * PostgreSQL; it is not a production measurement, and nothing in this script claims to be one.
 *
 * ### The dataset
 *
 * Dense on purpose: a region around Marrakech holding ten years of earthquakes down to M2.5 (a
 * Gutenberg–Richter distribution, so many small ones), a week of elevated activity, a second source
 * restating the recent events, 150 active fire clusters with their detections, GDACS floods, and a
 * global background of records and detections elsewhere so the spatial indexes have something to
 * exclude. Seeded through the same repositories the worker uses. Deterministic: a fixed seed.
 */

import { sql, type Kysely } from 'kysely';

import { loadWebConfig } from '@geonerva/config';
import {
  assignDetectionsToCluster,
  bulkInsertDetections,
  createCanonicalEvent,
  createCluster,
  createDb,
  generateFireClusterPublicId,
  insertClusterVersionIfChanged,
  linkRecord,
  upsertPlaces,
  type DB,
} from '@geonerva/db';
import { setupTestDatabase } from '@geonerva/db/testing';
import { contentHash, seedObservation, seedRun, stableUuid } from '@geonerva/db/testing/factories';

import { GET as briefing } from '../apps/web/app/api/v1/briefing/route.ts';
import { GET as evidence } from '../apps/web/app/api/v1/evidence/[id]/route.ts';
import { GET as eventDetail } from '../apps/web/app/api/v1/events/[publicId]/route.ts';
import { GET as events } from '../apps/web/app/api/v1/events/route.ts';
import { GET as fireCluster } from '../apps/web/app/api/v1/fire-clusters/[publicId]/route.ts';
import { GET as history } from '../apps/web/app/api/v1/history/route.ts';
import { GET as suggest } from '../apps/web/app/api/v1/places/suggest/route.ts';
import { GET as horizon } from '../apps/web/app/api/v1/replay/horizon/route.ts';
import { GET as sourcesStatus } from '../apps/web/app/api/v1/sources/status/route.ts';
import { setWebConfigForTesting } from '../apps/web/lib/server/config.ts';
import { setDatabaseForTesting } from '../apps/web/lib/server/db.ts';

const CENTER = { lat: 31.63, lon: -7.98 };
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WARMUP = 5;
const SAMPLES = 60;

/** mulberry32: a small deterministic PRNG, so two runs seed the same world. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const random = prng(20260921);

/** A point `km` away from the centre in a random direction. */
function around(maxKm: number): { lat: number; lon: number } {
  const km = maxKm * Math.sqrt(random());
  const bearing = random() * 2 * Math.PI;
  const lat = CENTER.lat + (km * Math.cos(bearing)) / 110.574;
  const lon =
    CENTER.lon + (km * Math.sin(bearing)) / (111.32 * Math.cos((CENTER.lat * Math.PI) / 180));
  return { lat, lon };
}

/** Anywhere on land-ish latitudes, at least ~10° from the centre. */
function elsewhere(): { lat: number; lon: number } {
  for (;;) {
    const lat = -55 + random() * 115;
    const lon = -180 + random() * 360;
    if (Math.abs(lat - CENTER.lat) > 10 || Math.abs(lon - CENTER.lon) > 10) return { lat, lon };
  }
}

/** Gutenberg–Richter with b = 1 above M2.5, capped at M7.5, to one decimal. */
function magnitude(): number {
  const value = 2.5 - Math.log10(1 - random());
  return Math.round(Math.min(value, 7.5) * 10) / 10;
}

async function productId(db: Kysely<DB>, source: string, code: string): Promise<number | null> {
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = ${source} AND code = ${code}
  `.execute(db);
  return result.rows[0]?.id ?? null;
}

async function seedEarthquake(
  db: Kysely<DB>,
  key: string,
  point: { lat: number; lon: number },
  observedAt: Date,
  restatedByEmsc: boolean,
): Promise<string> {
  const ingestedAt = new Date(observedAt.getTime() + 10 * 60_000);
  const mag = magnitude();
  const usgs = await seedObservation(db, {
    sourceId: 'usgs',
    primaryKey: key,
    ingestedAt,
    observedAt,
    centroid: point,
    magnitude: mag,
    depthKm: 5 + Math.round(random() * 30),
    providerStatus: 'reviewed',
    contributor: 'us',
  });
  const event = await createCanonicalEvent(db, { hazardType: 'EARTHQUAKE', createdAt: ingestedAt });
  await db.transaction().execute((trx) =>
    linkRecord(trx, {
      canonicalEventId: event.id,
      sourceRecordId: usgs.sourceRecordId,
      relation: 'PRIMARY',
      matchKind: 'SEED',
      algorithmVersion: 'bench-1',
      linkedAt: ingestedAt,
    }),
  );
  if (restatedByEmsc) {
    const emsc = await seedObservation(db, {
      sourceId: 'emsc',
      primaryKey: `emsc-${key}`,
      ingestedAt,
      observedAt: new Date(observedAt.getTime() + 4_000),
      centroid: { lat: point.lat + 0.02, lon: point.lon - 0.02 },
      magnitude: Math.round((mag - 0.1) * 10) / 10,
      magnitudeType: 'mb',
      depthKm: 10,
    });
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: emsc.sourceRecordId,
        relation: 'SAME_EVENT',
        matchKind: 'SPATIOTEMPORAL',
        algorithmVersion: 'bench-1',
        linkedAt: ingestedAt,
      }),
    );
  }
  return event.publicId;
}

interface Seeded {
  readonly eventPublicId: string;
  readonly clusterPublicId: string;
  readonly evidenceId: string;
}

async function seed(db: Kysely<DB>): Promise<Seeded> {
  const started = Date.now();
  const counts = { quakes: 0, detections: 0, clusters: 0, floods: 0, places: 0 };

  // Sources read and derivations run, recently and a day ago, so both snapshots of a 24 h window
  // see every family as current.
  for (const at of [new Date(NOW.getTime() - 25 * HOUR), new Date(NOW.getTime() - 5 * 60_000)]) {
    for (const [source, code] of [
      ['usgs', 'comcat'],
      ['emsc', 'rts'],
      ['gdacs', 'EQ'],
      ['firms', 'VIIRS_NOAA20_NRT'],
    ] as const) {
      await seedRun(db, {
        sourceId: source,
        productId: await productId(db, source, code),
        status: 'SUCCEEDED',
        startedAt: at,
        newestObservedAt: at,
      });
    }
    for (const kind of ['CORRELATION', 'CLUSTERING']) {
      await sql`
        INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
        VALUES (gen_random_uuid(), ${kind}, 'geonerva-1', ${at}, ${at}, 'SUCCEEDED')
      `.execute(db);
    }
  }

  // Completed historical backfills up to the first live run, so /history reads its full reference
  // rather than refusing: coverage, not the oldest record, is what a baseline trusts.
  for (const [source, years] of [
    ['usgs', 10],
    ['gdacs', 5],
  ] as const) {
    const from = new Date(NOW.getTime() - (years * 365 + 30) * DAY);
    const to = new Date(NOW.getTime() - 25 * HOUR);
    await sql`
      WITH plan AS (
        INSERT INTO geonerva.backfill_plans
          (id, source_id, mode, range_from, range_to, window_ms, min_window_ms, status, finished_at)
        VALUES (gen_random_uuid(), ${source}, 'HISTORICAL', ${from}, ${to}, ${DAY}, ${DAY},
                'COMPLETED', ${to})
        RETURNING id
      )
      INSERT INTO geonerva.backfill_intervals
        (plan_id, interval_from, interval_to, status, completed_at)
      SELECT id, ${from}, ${to}, 'DONE', ${to} FROM plan
    `.execute(db);
  }
  await sql`
    INSERT INTO geonerva.analysis_runs (id, kind, engine_version, started_at, finished_at, status)
    VALUES (gen_random_uuid(), 'SEED', 'geonerva-1', ${NOW}, ${NOW}, 'SUCCEEDED')
  `.execute(db);

  // Earthquakes: ten years within 300 km, a busy last week, and a global background.
  let eventPublicId = '';
  for (let index = 0; index < 3_000; index += 1) {
    const at = new Date(NOW.getTime() - 8 * DAY - random() * 10 * 365 * DAY);
    await seedEarthquake(db, `near${String(index)}`, around(300), at, false);
    counts.quakes += 1;
  }
  for (let index = 0; index < 150; index += 1) {
    const at = new Date(NOW.getTime() - HOUR - random() * 7 * DAY);
    eventPublicId = await seedEarthquake(db, `recent${String(index)}`, around(200), at, true);
    counts.quakes += 1;
  }
  for (let index = 0; index < 3_000; index += 1) {
    const at = new Date(NOW.getTime() - HOUR - random() * 10 * 365 * DAY);
    await seedEarthquake(db, `far${String(index)}`, elsewhere(), at, false);
    counts.quakes += 1;
  }

  // GDACS floods within 300 km over five years.
  for (let index = 0; index < 50; index += 1) {
    const at = new Date(NOW.getTime() - DAY - random() * 5 * 365 * DAY);
    const flood = await seedObservation(db, {
      sourceId: 'gdacs',
      hazardType: 'FLOOD',
      primaryKey: `FL${String(index)}`,
      ingestedAt: new Date(at.getTime() + HOUR),
      observedAt: at,
      centroid: around(300),
      severityScheme: 'GDACS_ALERT',
      severityValue: 'Green',
    });
    const event = await createCanonicalEvent(db, { hazardType: 'FLOOD', createdAt: at });
    await db.transaction().execute((trx) =>
      linkRecord(trx, {
        canonicalEventId: event.id,
        sourceRecordId: flood.sourceRecordId,
        relation: 'PRIMARY',
        matchKind: 'SEED',
        algorithmVersion: 'bench-1',
        linkedAt: at,
      }),
    );
    counts.floods += 1;
  }

  // Fire: 150 active clusters within 100 km, 30 detections each, and a global background.
  const firms = await productId(db, 'firms', 'VIIRS_NOAA20_NRT');
  if (firms === null) throw new Error('the FIRMS product is not seeded');
  let clusterPublicId = '';
  for (let index = 0; index < 150; index += 1) {
    const centre = around(100);
    const detections = Array.from({ length: 30 }, () => ({
      productId: firms,
      acquiredAt: new Date(NOW.getTime() - HOUR - random() * 20 * HOUR),
      lat: centre.lat + (random() - 0.5) * 0.02,
      lon: centre.lon + (random() - 0.5) * 0.02,
      confidenceClass: 'NOMINAL' as const,
      confidenceRaw: 'n',
      frp: 2 + random() * 20,
      brightTi4: 330,
      brightTi5: 290,
      scan: 0.4,
      track: 0.4,
      daynight: 'D' as const,
      providerVersion: '2.0NRT',
      ingestedAt: new Date(NOW.getTime() - 30 * 60_000),
    }));
    await bulkInsertDetections(db, detections);
    const ids = await sql<{ id: string }>`
      SELECT id::text AS id FROM geonerva.fire_detections
      WHERE cluster_id IS NULL
        AND lat BETWEEN ${centre.lat - 0.011} AND ${centre.lat + 0.011}
        AND lon BETWEEN ${centre.lon - 0.011} AND ${centre.lon + 0.011}
    `.execute(db);
    const id = stableUuid(`bench-cluster-${String(index)}`);
    const createdAt = new Date(NOW.getTime() - 21 * HOUR);
    clusterPublicId = generateFireClusterPublicId(createdAt);
    await createCluster(db, { id, publicId: clusterPublicId, createdAt, status: 'ACTIVE' });
    await assignDetectionsToCluster(
      db,
      id,
      ids.rows.map((row) => row.id),
    );
    await insertClusterVersionIfChanged(db, {
      clusterId: id,
      asOf: new Date(NOW.getTime() - 30 * 60_000),
      nTotal: ids.rows.length,
      n24h: ids.rows.length,
      overpasses24h: 2,
      firstDetectedAt: new Date(NOW.getTime() - 21 * HOUR),
      lastDetectedAt: new Date(NOW.getTime() - HOUR),
      frpSum24h: 300,
      frpMax: 22,
      maxConfidence: 'NOMINAL',
      productIds: [firms],
      hullGeoJson: {
        type: 'Polygon',
        coordinates: [
          [
            [centre.lon - 0.012, centre.lat - 0.012],
            [centre.lon + 0.012, centre.lat - 0.012],
            [centre.lon + 0.012, centre.lat + 0.012],
            [centre.lon - 0.012, centre.lat + 0.012],
            [centre.lon - 0.012, centre.lat - 0.012],
          ],
        ],
      },
      centroid: centre,
      status: 'ACTIVE',
      contentSha256: contentHash('bench-cluster', index),
    });
    counts.clusters += 1;
    counts.detections += detections.length;
  }
  const background = Array.from({ length: 20_000 }, () => {
    const point = elsewhere();
    return {
      productId: firms,
      acquiredAt: new Date(NOW.getTime() - HOUR - random() * 20 * HOUR),
      lat: point.lat,
      lon: point.lon,
      confidenceClass: 'NOMINAL' as const,
      confidenceRaw: 'n',
      frp: 5,
      brightTi4: 330,
      brightTi5: 290,
      scan: 0.4,
      track: 0.4,
      daynight: 'N' as const,
      providerVersion: '2.0NRT',
      ingestedAt: new Date(NOW.getTime() - 30 * 60_000),
    };
  });
  await bulkInsertDetections(db, background);
  counts.detections += background.length;

  // Places: Marrakech plus 20,000 synthetic ones, so type-ahead searches a table of real size.
  const places = [
    {
      geonameid: 2542997,
      name: 'Marrakesh',
      asciiName: 'Marrakesh',
      altNames: 'Marrakech,Marrakesch,Marrakech-Safi',
      countryCode: 'MA',
      admin1: '14',
      lat: 31.63,
      lon: -7.98,
      population: 839296,
      timezone: 'Africa/Casablanca',
    },
    ...Array.from({ length: 20_000 }, (_, index) => {
      const point = elsewhere();
      return {
        geonameid: 9_000_000 + index,
        name: `Place ${String(index)}`,
        asciiName: `Place ${String(index)}`,
        altNames: `Mar${String(index)},Alt ${String(index)}`,
        countryCode: 'XX',
        admin1: null,
        lat: Math.round(point.lat * 100) / 100,
        lon: Math.round(point.lon * 100) / 100,
        population: Math.floor(random() * 1_000_000),
        timezone: 'UTC',
      };
    }),
  ];
  counts.places = await upsertPlaces(db, places);

  await sql`ANALYZE`.execute(db);
  const evidenceRow = await sql<{ id: string }>`
    SELECT id::text AS id FROM geonerva.observation_versions ORDER BY id DESC LIMIT 1
  `.execute(db);
  console.log(
    `seeded in ${String(Math.round((Date.now() - started) / 1000))} s: ${JSON.stringify(counts)}`,
  );
  return {
    eventPublicId,
    clusterPublicId,
    evidenceId: `EV:OBS:${evidenceRow.rows[0]?.id ?? '1'}`,
  };
}

let caller = 0;
function request(path: string): Request {
  caller += 1;
  return new Request(`https://geonerva.test${path}`, {
    headers: new Headers({
      // A fresh /24 per request: the limiter keys on the address prefix, not the address, so
      // varying only the last octet measured the 429 path instead of the endpoint.
      'x-forwarded-for': `10.${String(Math.floor(caller / 250) % 250)}.${String(caller % 250)}.7`,
    }),
  });
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

async function measure(
  label: string,
  handler: (request: Request) => Promise<Response>,
  path: string,
): Promise<{ label: string; p50: number; p95: number; max: number; status: number }> {
  let status = 0;
  for (let index = 0; index < WARMUP; index += 1) {
    const response = await handler(request(path));
    await response.arrayBuffer();
  }
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    const response = await handler(request(path));
    await response.arrayBuffer();
    samples.push(performance.now() - started);
    // The worst status seen, so one refused sample invalidates the row rather than hiding in it.
    status = Math.max(status, response.status);
  }
  samples.sort((left, right) => left - right);
  return {
    label,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: samples.at(-1) ?? Number.NaN,
    status,
  };
}

async function main(): Promise<void> {
  const testDb = await setupTestDatabase();
  const db = createDb(testDb.pool);
  setDatabaseForTesting({ db, pool: testDb.pool, target: 'test', close: () => Promise.resolve() });
  setWebConfigForTesting(
    loadWebConfig({
      DATABASE_URL: 'postgresql://web:pw@127.0.0.1:54320/geonerva_bench_test',
      RATE_LIMIT_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // gitleaks:allow
      NOMINATIM_CONTACT: 'https://example.org/geonerva-contact',
    }),
  );

  try {
    await testDb.truncate();
    const seeded = await seed(db);
    const at = `lat=${String(CENTER.lat)}&lon=${String(CENTER.lon)}`;
    const replayAt = new Date(NOW.getTime() - 3 * HOUR).toISOString();
    // A history row that refuses is a fast path, not the measurement; say so rather than time it.
    const probe = (await (
      await history(request(`/api/v1/history?${at}&family=EARTHQUAKES`))
    ).json()) as { metric: { status: string } };
    console.log(`history EQ status on the bench dataset: ${probe.metric.status}`);
    const results = [
      await measure('briefing, live, 24h', briefing, `/api/v1/briefing?${at}&window=24h`),
      await measure('briefing, live, 7d', briefing, `/api/v1/briefing?${at}&window=7d`),
      await measure(
        'briefing, replay',
        briefing,
        `/api/v1/briefing?${at}&window=24h&as_of=${replayAt}`,
      ),
      await measure('briefing, by place', briefing, '/api/v1/briefing?place=p:2542997&window=24h'),
      await measure(
        'events, zoom 6',
        events,
        '/api/v1/events?bbox=-11.25,28.125,-5.625,33.75&zoom=6',
      ),
      await measure('event detail', eventDetail, `/api/v1/events/${seeded.eventPublicId}`),
      await measure(
        'fire-cluster detail',
        fireCluster,
        `/api/v1/fire-clusters/${seeded.clusterPublicId}`,
      ),
      await measure('history, EQ 7d, 150 km', history, `/api/v1/history?${at}&family=EARTHQUAKES`),
      await measure(
        'history, EQ 30d, 300 km',
        history,
        `/api/v1/history?${at}&family=EARTHQUAKES&metric=EQ_COUNT_30D&radius_km=300`,
      ),
      await measure('history, GDACS floods', history, `/api/v1/history?${at}&family=FLOODS`),
      await measure('sources/status', sourcesStatus, '/api/v1/sources/status'),
      await measure('places/suggest', suggest, '/api/v1/places/suggest?q=Marr'),
      await measure('evidence', evidence, `/api/v1/evidence/${seeded.evidenceId}`),
      await measure('replay/horizon', horizon, '/api/v1/replay/horizon'),
    ];

    console.log(
      `\n${String(SAMPLES)} sequential samples after ${String(WARMUP)} warm-up requests\n`,
    );
    console.log('endpoint                     status   p50 ms   p95 ms   max ms');
    for (const row of results) {
      console.log(
        `${row.label.padEnd(28)} ${String(row.status).padStart(6)} ${row.p50.toFixed(1).padStart(8)} ${row.p95.toFixed(1).padStart(8)} ${row.max.toFixed(1).padStart(8)}`,
      );
    }
    const failed = results.filter((row) => row.status !== 200);
    if (failed.length > 0) {
      console.error(`\nnot 200: ${failed.map((row) => row.label).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    setDatabaseForTesting(null);
    setWebConfigForTesting(null);
    await db.destroy();
  }
}

await main();
