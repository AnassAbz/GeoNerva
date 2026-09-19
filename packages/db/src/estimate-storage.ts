/**
 * `pnpm --filter @geonerva/db estimate-storage` — measures what GeoNerva actually costs on disk.
 *
 * ARCHITECTURE §12 decides the retention profiles from a storage budget (500 MB on the free
 * tier). Those figures started as estimates, and estimates about row widths, index overhead and
 * TOAST are usually wrong, so this script loads a representative volume into a throwaway database
 * and reports `pg_total_relation_size` per table, split into heap, indexes and TOAST.
 *
 * Volumes come from measurement, not assumption (docs/DATA_SOURCES.md §3.5):
 *   - FIRMS NOAA-20 + NOAA-21 ≈ **146k detections/day** (the keyless "24 h" files span ≈ 42 h,
 *     so the row counts in those files overstate a day by roughly 75 %).
 *   - USGS M ≥ 4.5 since 2000 ≈ 190k events, plus the EMSC backfill and recent all-magnitude
 *     history: ~250k earthquake versions is a fair lean-profile figure.
 *
 * Rows are generated in SQL rather than through the repositories: this measures storage, and
 * `generate_series` fills the same tables, indexes and partitions far faster than round-trips.
 */
import { sql, type Kysely } from 'kysely';

// Output goes through process.stdout/stderr rather than `console`, matching migrator/cli.ts:
// `no-console` is an error outside operational scripts, and these are the two CLIs in this package.
const out = (line = ''): void =>
  void process.stdout.write(`${line}
`);
const err = (line: string): void =>
  void process.stderr.write(`${line}
`);

import { createDb } from './client.ts';
import type { DB } from './generated/database.ts';
import { ensurePartitionsForDays } from './repositories/fire.ts';
import { setupTestDatabase, type TestDatabase } from './testing/test-database.ts';

/** Lean profile: 72 h of detections at the measured rate. */
const DETECTIONS_PER_DAY = 146_000;
const DETECTION_DAYS = 3;
const EARTHQUAKE_VERSIONS = 250_000;
const GDACS_VERSIONS = 5_000;

export interface TableSize {
  readonly table: string;
  readonly rows: number;
  readonly totalBytes: number;
  readonly heapBytes: number;
  readonly indexBytes: number;
  readonly toastBytes: number;
}

/** Sizes of every table in the `geonerva` schema, including partitions, largest first. */
export async function measureTableSizes(db: Kysely<DB>): Promise<TableSize[]> {
  const result = await sql<{
    table_name: string;
    rows: string;
    total_bytes: string;
    heap_bytes: string;
    index_bytes: string;
    toast_bytes: string;
  }>`
    SELECT c.relname AS table_name,
           COALESCE(s.n_live_tup, 0)::text AS rows,
           pg_total_relation_size(c.oid)::text AS total_bytes,
           pg_table_size(c.oid)::text AS heap_bytes,
           pg_indexes_size(c.oid)::text AS index_bytes,
           COALESCE(pg_total_relation_size(c.reltoastrelid), 0)::text AS toast_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'geonerva' AND c.relkind IN ('r', 'p')
    ORDER BY pg_total_relation_size(c.oid) DESC
  `.execute(db);

  return result.rows.map((row) => ({
    table: row.table_name,
    rows: Number(row.rows),
    totalBytes: Number(row.total_bytes),
    heapBytes: Number(row.heap_bytes),
    indexBytes: Number(row.index_bytes),
    toastBytes: Number(row.toast_bytes),
  }));
}

async function loadDetections(db: Kysely<DB>, days: number, perDay: number): Promise<void> {
  const today = new Date();
  const dayDates = Array.from(
    { length: days },
    (_, index) => new Date(today.getTime() - index * 24 * 60 * 60 * 1000),
  );
  await ensurePartitionsForDays(db, dayDates);

  for (const day of dayDates) {
    const dayStart = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0, 0),
    );
    // Coordinates are spread over land-ish latitudes so the GiST index sees realistic spread.
    await sql`
      INSERT INTO geonerva.fire_detections (
        product_id, acquired_at, lat, lon, geog, confidence_class, confidence_raw,
        frp, bright_ti4, bright_ti5, scan, track, daynight, provider_version,
        ingestion_run_id, ingested_at
      )
      SELECT (CASE WHEN i % 2 = 0 THEN p20.id ELSE p21.id END),
             t.acquired_at,
             lat, lon,
             ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography,
             (ARRAY['LOW','NOMINAL','HIGH'])[1 + (i % 3)],
             (ARRAY['l','n','h'])[1 + (i % 3)],
             (i % 400)::real, 300.5, 290.5, 0.4, 0.36,
             CASE WHEN i % 2 = 0 THEN 'D' ELSE 'N' END,
             '2.0NRT', NULL,
             -- NRT arrives about three hours after the overpass (docs/DATA_SOURCES.md §3.3).
             t.acquired_at + interval '3 hours'
      FROM generate_series(1, ${perDay}) AS i,
           LATERAL (SELECT ${dayStart}::timestamptz + make_interval(secs => (i % 86400))
                      AS acquired_at) AS t,
           -- Correlated with i on purpose: an uncorrelated subquery is evaluated once, which
           -- would put every detection at one point and make both the unique key and the GiST
           -- index unrealistic.
           LATERAL (SELECT (abs(hashint4(i)) % 1400000)::double precision / 10000 - 70 AS lat,
                           (abs(hashint4(i * 7 + 13)) % 3599999)::double precision / 10000 - 180 AS lon) AS coords,
           LATERAL (SELECT id FROM geonerva.source_products
                    WHERE code = 'VIIRS_NOAA20_NRT' LIMIT 1) AS p20,
           LATERAL (SELECT id FROM geonerva.source_products
                    WHERE code = 'VIIRS_NOAA21_NRT' LIMIT 1) AS p21
      ON CONFLICT DO NOTHING
    `.execute(db);
  }
}

async function loadObservationVersions(
  db: Kysely<DB>,
  sourceId: string,
  hazardType: string,
  count: number,
): Promise<void> {
  await sql`
    INSERT INTO geonerva.source_records
      (source_id, product_id, hazard_type, primary_key, first_ingested_at)
    SELECT ${sourceId}, NULL, ${hazardType},
           ${sourceId} || '-' || i::text,
           now() - make_interval(secs => i)
    FROM generate_series(1, ${count}) AS i
    ON CONFLICT DO NOTHING
  `.execute(db);

  await sql`
    INSERT INTO geonerva.observation_versions (
      source_record_id, version_seq, hazard_type, ingestion_run_id, ingested_at, observed_at,
      lifecycle_status, contributor, magnitude, magnitude_type, depth_km, centroid,
      geometry_kind, attributes, title, source_url, content_sha256
    )
    SELECT r.id, 1, ${hazardType}, NULL,
           now() - make_interval(secs => (r.id % 1000000)),
           now() - make_interval(secs => (r.id % 1000000) + 60),
           'ACTIVE', 'NEIC',
           (4 + (r.id % 30) / 10.0)::numeric(4,2), 'mww', (r.id % 600)::numeric(6,2),
           ST_SetSRID(ST_MakePoint((random() * 360 - 180), (random() * 140 - 70)), 4326)::geography,
           'EPICENTER',
           jsonb_build_object('net', 'us', 'sig', r.id % 1000, 'felt', r.id % 50),
           'M' || (4 + (r.id % 30) / 10.0)::text || ' - somewhere in the world',
           'https://earthquake.usgs.gov/earthquakes/eventpage/us' || r.id::text,
           -- A deterministic 32-byte stand-in for the content hash; pgcrypto is not guaranteed.
           decode(lpad(to_hex(r.id), 64, '0'), 'hex')
    FROM geonerva.source_records r
    WHERE r.source_id = ${sourceId}
    ON CONFLICT DO NOTHING
  `.execute(db);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<number> {
  let testDb: TestDatabase | undefined;
  try {
    testDb = await setupTestDatabase();
    const db = createDb(testDb.pool);
    await testDb.truncate();

    out(
      `Loading ${DETECTION_DAYS} × ${DETECTIONS_PER_DAY.toLocaleString()} detections, ` +
        `${EARTHQUAKE_VERSIONS.toLocaleString()} earthquake versions, ` +
        `${GDACS_VERSIONS.toLocaleString()} GDACS versions…`,
    );
    const started = Date.now();
    await loadDetections(db, DETECTION_DAYS, DETECTIONS_PER_DAY);
    await loadObservationVersions(db, 'usgs', 'EARTHQUAKE', EARTHQUAKE_VERSIONS);
    await loadObservationVersions(db, 'gdacs', 'FLOOD', GDACS_VERSIONS);
    await sql`ANALYZE`.execute(db);
    out(`Loaded in ${((Date.now() - started) / 1000).toFixed(0)} s\n`);

    const sizes = await measureTableSizes(db);
    const total = sizes.reduce((sum, size) => sum + size.totalBytes, 0);

    out('table                              rows        total      heap     index     toast');
    out('─'.repeat(88));
    for (const size of sizes) {
      if (size.totalBytes < 16 * 1024) continue;
      out(
        `${size.table.padEnd(33)} ${size.rows.toLocaleString().padStart(10)} ` +
          `${mb(size.totalBytes).padStart(10)} ${mb(size.heapBytes).padStart(9)} ` +
          `${mb(size.indexBytes).padStart(9)} ${mb(size.toastBytes).padStart(9)}`,
      );
    }
    out('─'.repeat(88));
    out(`${'TOTAL'.padEnd(33)} ${''.padStart(10)} ${mb(total).padStart(10)}`);
    out(
      `\nLean profile budget is 500 MB (ADR-018). Measured: ${mb(total)} ` +
        `(${((total / (500 * 1024 * 1024)) * 100).toFixed(0)} % of budget).`,
    );

    await db.destroy();
    return 0;
  } catch (error) {
    err(`✗ ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
