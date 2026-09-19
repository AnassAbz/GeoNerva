-- 0009 — partition maintenance hardening (security review P2: S-4, S-5, S-6, S-7).
--
-- Applied migrations are immutable, so these corrections replace the functions defined in
-- 0005 rather than editing it. Four defects, all of them latent until production conditions:
--
--  * **S-4 (timezone).** Partition *names* were derived from the UTC date while partition
--    *bounds* were `day::timestamptz`, which PostgreSQL resolves in the session time zone. On a
--    server running anything other than UTC, the bounds slide by the offset, and detections in
--    that window fail to insert with "no partition of relation found for row" — a hard ingestion
--    failure whose cause is invisible in the data. Bounds are now anchored to UTC explicitly.
--  * **S-5 (RLS).** 0007 enables row-level security on the tables that existed when it ran.
--    Partitions created later are new tables and had RLS off, so a non-owner role denied on the
--    parent could read live detections straight from a partition. RLS is now enabled as part of
--    creating one.
--  * **S-6 (races).** The check-then-create was not concurrency-safe: two ingestion runs crossing
--    midnight both see "no partition" and one fails with 42P07, taking the whole batch with it.
--    The duplicate is now caught and treated as success, which is what it is.
--  * **S-7 (locking).** `DROP TABLE` on a partition needs ACCESS EXCLUSIVE on the parent, and
--    PostgreSQL's lock queue is FIFO: one long-running reader plus one retention run blocks every
--    subsequent query on the fire table. Retention now drops a single partition per call, under a
--    `lock_timeout`, so the worker can commit between partitions and a busy moment defers the
--    work instead of stalling ingestion.

CREATE OR REPLACE FUNCTION geonerva.ensure_fire_detection_partition(day date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  partition_name text := format('fire_detections_%s', to_char(day, 'YYYYMMDD'));
  -- `AT TIME ZONE 'UTC'` turns the date's midnight into an absolute instant, independent of the
  -- session's TimeZone. `acquired_at` is stored in UTC, so these are the right boundaries (S-4).
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
    -- The parent's RLS does not extend to a partition created afterwards (S-5).
    EXECUTE format('ALTER TABLE geonerva.%I ENABLE ROW LEVEL SECURITY', partition_name);
  EXCEPTION
    WHEN duplicate_table THEN
      -- Another session created it between the check and the CREATE. That is the desired state,
      -- so the loser of the race returns normally instead of failing an ingestion batch (S-6).
      NULL;
  END;

  RETURN partition_name;
END
$$;

COMMENT ON FUNCTION geonerva.ensure_fire_detection_partition(date) IS
  'Idempotently creates the daily partition for `day`, with UTC bounds and RLS enabled.
   Concurrency-safe: a lost race returns the existing partition rather than raising.';

-- Retention, one partition at a time.
CREATE FUNCTION geonerva.drop_fire_detection_partition(partition_day date, lock_timeout_ms integer DEFAULT 5000)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  partition_name text := format('fire_detections_%s', to_char(partition_day, 'YYYYMMDD'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE n.nspname = 'geonerva' AND c.relname = partition_name AND parent.relname = 'fire_detections'
  ) THEN
    RETURN false;
  END IF;

  -- Retention is never urgent. Waiting behind a long reader would queue every later query on the
  -- fire table behind this ACCESS EXCLUSIVE request, so give up quickly and retry tonight (S-7).
  EXECUTE format('SET LOCAL lock_timeout = %s', lock_timeout_ms::text);
  EXECUTE format('DROP TABLE geonerva.%I', partition_name);
  RETURN true;
END
$$;

COMMENT ON FUNCTION geonerva.drop_fire_detection_partition(date, integer) IS
  'Drops one daily partition under a lock timeout. Returns false when it does not exist.
   The caller commits between partitions so retention cannot hold the parent lock across days.';

-- The batch function stays for compatibility, but now only *reports* what is due, so no caller
-- can accidentally take the parent lock for every expired day in one transaction.
CREATE OR REPLACE FUNCTION geonerva.fire_detection_partitions_before(cutoff date)
RETURNS SETOF date
LANGUAGE sql
STABLE
AS $$
  SELECT to_date(right(c.relname, 8), 'YYYYMMDD')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_inherits i ON i.inhrelid = c.oid
  JOIN pg_class parent ON parent.oid = i.inhparent
  JOIN pg_namespace pn ON pn.oid = parent.relnamespace
  WHERE pn.nspname = 'geonerva'
    AND parent.relname = 'fire_detections'
    AND n.nspname = 'geonerva'
    AND c.relname ~ '^fire_detections_[0-9]{8}$'
    AND to_date(right(c.relname, 8), 'YYYYMMDD') < cutoff
  ORDER BY 1
$$;

COMMENT ON FUNCTION geonerva.fire_detection_partitions_before(date) IS
  'The days whose partitions are past retention. Dropping them is the caller''s job, one
   transaction each (see drop_fire_detection_partition).';

DROP FUNCTION IF EXISTS geonerva.drop_fire_detection_partitions_before(date);

-- Existing partitions created before this migration also need RLS (S-5).
DO $$
DECLARE
  partition_name text;
BEGIN
  FOR partition_name IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE n.nspname = 'geonerva' AND parent.relname = 'fire_detections'
  LOOP
    EXECUTE format('ALTER TABLE geonerva.%I ENABLE ROW LEVEL SECURITY', partition_name);
  END LOOP;
END
$$;

-- S-14: EXECUTE on functions defaults to PUBLIC. These are SECURITY INVOKER, so this is tidiness
-- rather than a hole, but PUBLIC should not be able to call maintenance functions at all.
REVOKE EXECUTE ON FUNCTION geonerva.ensure_fire_detection_partition(date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION geonerva.ensure_fire_detection_partitions(date, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION geonerva.drop_fire_detection_partition(date, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION geonerva.fire_detection_partitions_before(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geonerva.ensure_fire_detection_partition(date) TO geonerva_worker;
GRANT EXECUTE ON FUNCTION geonerva.ensure_fire_detection_partitions(date, integer) TO geonerva_worker;
GRANT EXECUTE ON FUNCTION geonerva.drop_fire_detection_partition(date, integer) TO geonerva_worker;
GRANT EXECUTE ON FUNCTION geonerva.fire_detection_partitions_before(date) TO geonerva_worker, geonerva_web;

-- S-13: the comment in 0007 says the web role must never reach AI outputs, but the grant that
-- follows it includes `output`, the model's text. Withhold it: the read path renders AI text from
-- the validated briefing, not by reading the raw agent output table.
REVOKE SELECT ON geonerva.agent_outputs FROM geonerva_web;
GRANT SELECT (id, snapshot_id, role, model, prompt_version, validation_status, used, created_at)
  ON geonerva.agent_outputs TO geonerva_web;
