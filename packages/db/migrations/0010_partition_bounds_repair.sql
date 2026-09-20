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
-- Two phases, because one is not enough. A single pass that repairs one partition while its
-- neighbours are still attached and misaligned hits a routing gap: a row spilling out of the
-- partition being repaired belongs to a day whose *name* already exists (still misaligned), so
-- `ensure_fire_detection_partition` takes its "already there" branch and the aligned range is
-- never created. West of UTC the spill runs forward, east of UTC backward, so no ordering saves it.
--
--   Phase A: detach every misaligned partition and stage its rows, so nothing is attached that
--            could shadow a day that still needs an aligned partition.
--   Phase B: create the aligned partitions for the whole staged span, re-insert through the
--            parent (routing each row into the partition for its own UTC day), and assert that
--            the count came back.
--
-- The column list is built from the catalog, excluding `GENERATED ALWAYS` columns: `INSERT …
-- SELECT *` fails with 428C9 because a generated column cannot be given a value.
DO $$
DECLARE
  part record;
  bounds text;
  lower_literal text;
  upper_literal text;
  day date;
  detached text[] := '{}';
  column_list text;
  staged_rows bigint := 0;
  restored_rows bigint := 0;
  min_day date;
  max_day date;
BEGIN
  SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum)
  INTO column_list
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'geonerva' AND c.relname = 'fire_detections'
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';

  -- Phase A: detach the misaligned partitions into a staging table.
  CREATE TEMP TABLE geonerva_partition_repair (LIKE geonerva.fire_detections) ON COMMIT DROP;

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
    -- The parentheses are escaped: unescaped they are capture groups, the pattern then fails to
    -- match `FROM ('…')`, `regexp_match` returns NULL, and every partition is silently skipped.
    lower_literal := (regexp_match(bounds, 'FROM \(''([^'']+)''\)'))[1];
    upper_literal := (regexp_match(bounds, 'TO \(''([^'']+)''\)'))[1];

    IF lower_literal IS NULL OR upper_literal IS NULL THEN
      RAISE EXCEPTION 'could not read the bounds of partition % (%)', part.relname, bounds;
    END IF;

    day := to_date(right(part.relname, 8), 'YYYYMMDD');
    CONTINUE WHEN lower_literal::timestamptz = (day::timestamp AT TIME ZONE 'UTC')
             AND upper_literal::timestamptz = ((day + 1)::timestamp AT TIME ZONE 'UTC');

    RAISE NOTICE 'repairing partition % (bounds %)', part.relname, bounds;
    EXECUTE format('ALTER TABLE geonerva.fire_detections DETACH PARTITION geonerva.%I', part.relname);
    EXECUTE format(
      'INSERT INTO geonerva_partition_repair (%s) SELECT %s FROM geonerva.%I',
      column_list, column_list, part.relname);
    EXECUTE format('DROP TABLE geonerva.%I', part.relname);
    detached := detached || part.relname;
  END LOOP;

  IF array_length(detached, 1) IS NULL THEN
    RETURN; -- every partition was already UTC-aligned
  END IF;

  -- Phase B: create the aligned partitions for the staged span, then let the parent route.
  SELECT count(*), min((acquired_at AT TIME ZONE 'UTC')::date), max((acquired_at AT TIME ZONE 'UTC')::date)
  INTO staged_rows, min_day, max_day
  FROM geonerva_partition_repair;

  IF staged_rows > 0 THEN
    PERFORM geonerva.ensure_fire_detection_partition(d::date)
    FROM generate_series(min_day, max_day, interval '1 day') AS d;

    EXECUTE format(
      'INSERT INTO geonerva.fire_detections (%s) SELECT %s FROM geonerva_partition_repair
       ON CONFLICT DO NOTHING',
      column_list, column_list);

    GET DIAGNOSTICS restored_rows = ROW_COUNT;
    IF restored_rows <> staged_rows THEN
      RAISE EXCEPTION
        'partition repair would lose rows: staged %, restored % (the migration is transactional, '
        'so nothing has been lost; report this with the partition names %)',
        staged_rows, restored_rows, detached;
    END IF;
  END IF;

  RAISE NOTICE 'repaired % partition(s), % row(s) re-routed',
    array_length(detached, 1), restored_rows;
END
$$;

-- Repairing may have removed the deployment window 0005 created, so re-create one. Partitions
-- are created on demand before every batch anyway; this only keeps a fresh database ready.
SELECT geonerva.ensure_fire_detection_partitions(((now() AT TIME ZONE 'UTC')::date - 1), 5);

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
  WHEN OTHERS THEN
    -- A managed host may refuse ALTER DATABASE, and refuse it in its own way. Nothing is lost by
    -- tolerating that: every GeoNerva connection pins TimeZone itself (client.ts, migrator/cli.ts),
    -- so this statement is belt to that braces and must never fail a migration.
    RAISE NOTICE 'could not pin TimeZone=UTC on the database (%); connections pin it individually',
      SQLERRM;
END
$$;

-- V-4: `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC` runs without error and does
-- nothing — EXECUTE-to-PUBLIC is a built-in default, not a granted default privilege, so there is
-- nothing to revoke in advance. Revoke from what exists, and let a test assert the property for
-- functions added later (the durable form; a DDL statement here would only look like protection).
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'geonerva'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO geonerva_worker', fn.signature);
  END LOOP;
END
$$;
