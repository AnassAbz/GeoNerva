-- 0019 — the append-only tables are append-only at the grant level too (security review F-23).
--
-- 0017 and 0018 each granted `SELECT, INSERT` on their new tables, which reads as least privilege
-- for a table whose comment says "append-only". It was not: 0007's
-- `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO geonerva_worker`
-- had already applied at `CREATE TABLE` time, and a narrower `GRANT` does not revoke a wider one.
-- The live privileges were `DELETE, INSERT, SELECT, UPDATE` on all three, so the claim the
-- migrations made was decoration.
--
-- No escalation was possible — the worker is the trusted writer and writes only inserts — but the
-- point of these tables is that history is not rewritten. `fire_daily_counts` and
-- `fire_daily_coverage` are what a replay reads to say what a day held at a knowledge time
-- (ADR-040), and `feed_coverage_hours` is what says a period was observed at all (ADR-041). An
-- UPDATE against any of them is a silent edit to the past, so the role that writes them should
-- not be able to make one by accident.
--
-- `feed_coverage_frontier` is deliberately not included: it is operational state, one row per
-- feed, and `recordLiveCoverage` maintains it with `ON CONFLICT … DO UPDATE`. It carries no
-- history and nothing replays through it.

REVOKE UPDATE, DELETE ON geonerva.feed_coverage_hours FROM geonerva_worker;
REVOKE UPDATE, DELETE ON geonerva.fire_daily_counts FROM geonerva_worker;
REVOKE UPDATE, DELETE ON geonerva.fire_daily_coverage FROM geonerva_worker;

COMMENT ON TABLE geonerva.feed_coverage_hours IS
  'Hours of observation time a feed was read for, with the first moment GeoNerva knew it.
   Append-only (ADR-041) and now enforced by grant, not only by convention: coverage that outlives
   ingestion-run retention, per feed.';

COMMENT ON TABLE geonerva.fire_daily_counts IS
  'Detections per 0.25 degree cell, UTC day and product, as computed at a knowledge time.
   Append-only (ADR-040) and enforced by grant; rows exist only for cells with detections, and
   only for days recorded COVERED.';

COMMENT ON TABLE geonerva.fire_daily_coverage IS
  'What GeoNerva can say about one feed''s whole day: read, no satellite data, or not read. Only a
   COVERED day with no counts means zero detections (ADR-040). Append-only, enforced by grant.';
