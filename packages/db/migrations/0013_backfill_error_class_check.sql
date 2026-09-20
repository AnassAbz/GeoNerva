-- 0013 — constrain `backfill_intervals.error_class` to the ADR-032 taxonomy.
--
-- 0012 declared it as a bare `text`, while `ingestion_runs.error_class` has been constrained since
-- 0002 and extended by 0011. An operator reads that column as a *classification*, and nothing
-- stopped it holding free text — a provider message, a driver string, anything a future caller
-- happened to pass. ADR-032's whole argument is that the class must not lie; this makes the
-- database enforce it rather than trusting every caller to.
--
-- Additive and safe: the same value list as 0011, and the column is nullable, so a row with no
-- failure is unaffected. Nothing existing is dropped or rewritten.

ALTER TABLE geonerva.backfill_intervals
  ADD CONSTRAINT backfill_intervals_error_class_check
  CHECK (error_class IS NULL OR error_class IN (
    'HTTP_4XX', 'HTTP_5XX', 'TIMEOUT', 'TOO_LARGE', 'SCHEMA_DRIFT',
    'EMPTY_SUSPICIOUS', 'RATE_LIMITED', 'DB_ERROR', 'LEASE_EXPIRED', 'UNKNOWN',
    'NETWORK', 'CONFIG_ERROR', 'ABORTED'));

COMMENT ON COLUMN geonerva.backfill_intervals.error_class IS
  'Sanitized failure class (ADR-032), same taxonomy as ingestion_runs.error_class.';
