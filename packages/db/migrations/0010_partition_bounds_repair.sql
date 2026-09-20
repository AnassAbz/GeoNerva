-- 0010 — repair partition bounds and make the timezone assumption explicit (re-review R-1).
--
-- 0009 corrected the *function* that creates partitions but left the partitions 0005 had already
-- created. On a server whose `TimeZone` is not UTC — including the per-database form
-- `ALTER DATABASE … SET TimeZone='America/New_York'`, which a migration inherits silently — those
-- partitions carry local-midnight bounds. Two consequences, both bad:
--
--   * the corrected function eventually asks for a UTC-aligned range that overlaps a local-aligned
--     one and raises `42P17 … would overlap …`. `ensurePartitionsForDays` runs before *every*
--     detection batch, so FIRMS ingestion stops permanently and does not self-heal;
--   * a detection at 00:30Z lands in the partition named for the previous day, and retention,
--     which selects by name, deletes it a day early — data loss inside the retention window.
--
-- This migration repairs the bounds, and then removes the cause: every GeoNerva connection pins
-- `TimeZone=UTC`, and the partition function raises an actionable error if a misaligned partition
-- ever reappears.

-- ── 1. Repair ───────────────────────────────────────────────────────────────
-- For each partition: read its declared bounds (the literals carry an offset, so casting them is
-- exact regardless of the session zone) and compare with UTC midnight for the day in its name.
-- Aligned partitions are left alone. A misaligned one is detached, its rows are re-inserted
-- through the parent so that routing puts each row in the partition for its own UTC day, and the
-- detached table is dropped. Empty ones skip straight to the drop.
DO $$
DECLARE
  part record;
  bounds text;
  lower_literal text;
  upper_literal text;
  actual_lower timestamptz;
  expected_lower timestamptz;
  expected_upper timestamptz;
  day date;
  row_count bigint;
BEGIN
  FOR part IN
    SELECT c.oid, c.relname, c.relpartbound
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE n.nspname = 'geonerva'
      AND parent.relname = 'fire_detections'
      AND c.relname ~ '^fire_detections_[0-9]{8}$'
    ORDER BY c.relname
  LOOP
    bounds := pg_get_expr(part.relpartbound, part.oid);
    lower_literal := (regexp_match(bounds, 'FROM \(''([^'']+)''\)'))[1];
    upper_literal := (regexp_match(bounds, 'TO \(''([^'']+)''\)'))[1];
    CONTINUE WHEN lower_literal IS NULL OR upper_literal IS NULL;

    day := to_date(right(part.relname, 8), 'YYYYMMDD');
    actual_lower := lower_literal::timestamptz;
    expected_lower := (day::timestamp AT TIME ZONE 'UTC');
    expected_upper := ((day + 1)::timestamp AT TIME ZONE 'UTC');

    CONTINUE WHEN actual_lower = expected_lower AND upper_literal::timestamptz = expected_upper;

    EXECUTE format('SELECT count(*) FROM geonerva.%I', part.relname) INTO row_count;
    RAISE NOTICE 'repairing % (bounds % , % rows)', part.relname, bounds, row_count;

    EXECUTE format('ALTER TABLE geonerva.fire_detections DETACH PARTITION geonerva.%I', part.relname);

    IF row_count > 0 THEN
      -- Create the partitions the rows will need, then let the parent route them. Detections are
      -- append-only, so re-inserting is lossless; ON CONFLICT DO NOTHING covers a row that also
      -- exists in a correctly-bounded partition.
      PERFORM geonerva.ensure_fire_detection_partition(d::date)
      FROM generate_series(day - 1, day + 1, interval '1 day') AS d;

      EXECUTE format(
        'INSERT INTO geonerva.fire_detections SELECT * FROM geonerva.%I ON CONFLICT DO NOTHING',
        part.relname);
    END IF;

    EXECUTE format('DROP TABLE geonerva.%I', part.relname);
  END LOOP;
END
$$;

-- Repairing may have removed the deployment window 0005 created, so re-create one. Partitions
-- are created on demand before every batch anyway; this only keeps a fresh database ready.
SELECT geonerva.ensure_fire_detection_partitions(current_date - 1, 5);

-- ── 2. Fail loudly if it ever recurs ────────────────────────────────────────
CREATE OR REPLACE FUNCTION geonerva.ensure_fire_detection_partition(day date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  partition_name text := format('fire_detections_%s', to_char(day, 'YYYYMMDD'));
  lower_bound timestamptz := (day::timestamp AT TIME ZONE 'UTC');
  upper_bound timestamptz := ((day + 1)::timestamp AT TIME ZONE 'UTC');
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'geonerva' AND c.relname = partition_name
  ) THEN
    RETURN partition_name;
  END IF;

  BEGIN
    EXECUTE format(
      'CREATE TABLE geonerva.%I PARTITION OF geonerva.fire_detections FOR VALUES FROM (%L) TO (%L)',
      partition_name, lower_bound, upper_bound);
    EXECUTE format('ALTER TABLE geonerva.%I ENABLE ROW LEVEL SECURITY', partition_name);
  EXCEPTION
    WHEN duplicate_table THEN
      -- Lost a race with another session. That is the desired state (S-6).
      NULL;
    WHEN invalid_object_definition THEN
      -- 42P17: an existing partition overlaps the UTC-aligned range we asked for, which means
      -- some partition still has local-midnight bounds. Say so, rather than failing every
      -- ingestion batch with a message about overlap (R-1).
      RAISE EXCEPTION
        'partition % overlaps an existing partition with non-UTC bounds. A partition was created '
        'while the server TimeZone was not UTC; re-run migration 0010 to repair the bounds.',
        partition_name
        USING ERRCODE = 'invalid_object_definition';
  END;

  RETURN partition_name;
END
$$;

COMMENT ON FUNCTION geonerva.ensure_fire_detection_partition(date) IS
  'Idempotently creates the daily partition for `day`, with UTC bounds and RLS enabled.
   Concurrency-safe. Raises an actionable error if an existing partition has non-UTC bounds.';

-- ── 3. Remove the cause ─────────────────────────────────────────────────────
-- Application connections pin TimeZone=UTC (see packages/db/src/client.ts), but a psql session or
-- a future migration run by hand would not. Pinning it on the database itself makes UTC the
-- default for everything that connects, including the migrator.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET TimeZone TO ''UTC''', current_database());
EXCEPTION
  WHEN insufficient_privilege THEN
    -- A managed host may not grant ALTER DATABASE. The per-connection pin still applies.
    RAISE NOTICE 'could not pin TimeZone=UTC on the database; connections pin it individually';
END
$$;

-- R-10: without this, the next function added to the schema is PUBLIC-executable again.
ALTER DEFAULT PRIVILEGES IN SCHEMA geonerva REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
