-- 0016 — the evidence endpoint reads a raw payload's metadata, never its body (ADR-038, accepted
-- 2026-09-22).
--
-- Two things, both additive.
--
-- 1. `payload_captured`. `payload_pruned = true` cannot tell "a body was stored and retention
--    removed it" from "no body was ever stored" — a backfill writes the second from the outset
--    (ADR-033), and the two are different answers to a reader asking why a payload is gone. The
--    column says which, and it never changes once true: pruning removes a body, it does not
--    un-capture one.
--
--    Existing rows are classified by what can be established now. A row still holding its body
--    was captured. A pruned row was captured if any version citing it came from a run that was
--    not a backfill (a live body pruned by retention); otherwise it is taken as never captured,
--    which is the conservative answer — it claims less.
--
-- 2. A column-level grant, the pattern 0007 already uses for `agent_outputs`. `payload` stays
--    unreachable from the web role: `SELECT payload` and `SELECT *` both fail at the database.

ALTER TABLE geonerva.raw_source_records ADD COLUMN payload_captured boolean;

UPDATE geonerva.raw_source_records w
SET payload_captured =
  w.payload IS NOT NULL
  OR (w.payload_pruned AND EXISTS (
        SELECT 1
        FROM geonerva.observation_versions v
        JOIN geonerva.ingestion_runs r ON r.id = v.ingestion_run_id
        WHERE v.raw_record_id = w.id
          AND r.trigger <> 'BACKFILL'
      ));

ALTER TABLE geonerva.raw_source_records
  ALTER COLUMN payload_captured SET NOT NULL,
  ALTER COLUMN payload_captured SET DEFAULT true,
  -- A body can only be held by a row that captured one.
  ADD CONSTRAINT raw_source_records_payload_implies_captured
    CHECK (payload IS NULL OR payload_captured);

COMMENT ON COLUMN geonerva.raw_source_records.payload_captured IS
  'Whether a body was ever stored. False for backfilled payloads (ADR-033), which keep only their
   digest from the outset; true for live payloads, including after retention prunes them (ADR-038).';

GRANT SELECT (id, source_id, payload_sha256, payload_pruned, payload_captured, first_seen_at)
  ON geonerva.raw_source_records TO geonerva_web;
