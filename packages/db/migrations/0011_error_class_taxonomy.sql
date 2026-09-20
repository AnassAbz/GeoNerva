-- 0011 — extend the ingestion error taxonomy with NETWORK, CONFIG_ERROR and ABORTED (ADR-032).
--
-- The taxonomy frozen in 0002 describes what a provider *answered*. P3's outbound client produces
-- three failures where there is no answer, and none of them had a truthful class:
--
--   * NETWORK      — DNS failure, connection refused, TLS failure. Nothing was ever waited on, so
--                    it is not a TIMEOUT.
--   * CONFIG_ERROR — the host allowlist, the private-address (SSRF) check, or a refused redirect.
--                    Raised before or instead of a request; never self-heals; security-relevant.
--                    It means GeoNerva is blind to the source, NOT that the source is down.
--   * ABORTED      — the caller cancelled, e.g. the worker handling SIGTERM. Says nothing at all
--                    about the provider and must not count against its health.
--
-- Additive only: every value 0002 allowed is still allowed and keeps its meaning, so no row is
-- rewritten and no existing reader changes behaviour. The table is empty today, which is the
-- cheapest moment this change will ever happen.

ALTER TABLE geonerva.ingestion_runs
  DROP CONSTRAINT ingestion_runs_error_class_check;

ALTER TABLE geonerva.ingestion_runs
  ADD CONSTRAINT ingestion_runs_error_class_check
  CHECK (error_class IN (
    'HTTP_4XX', 'HTTP_5XX', 'TIMEOUT', 'TOO_LARGE', 'SCHEMA_DRIFT',
    'EMPTY_SUSPICIOUS', 'RATE_LIMITED', 'DB_ERROR', 'LEASE_EXPIRED', 'UNKNOWN',
    'NETWORK', 'CONFIG_ERROR', 'ABORTED'));

COMMENT ON COLUMN geonerva.ingestion_runs.error_class IS
  'Sanitized failure class (ADR-032). CONFIG_ERROR and ABORTED are statements about GeoNerva, '
  'not about the provider, and source-health derivation must treat them as such.';
