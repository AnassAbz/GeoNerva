-- P6 review finding. `seedSingleSourceEvents` and `correlateEarthquakes` both wrote
-- `analysis_runs.kind = 'CORRELATION'`, and `derivationsAsOf` keys the derivation axis on `kind`
-- alone. A GDACS seed run succeeding hourly therefore vouched for earthquake correlation: with
-- the matcher failing or never scheduled, the earthquake card reported "no earthquakes to report"
-- beside unlinked records, because the one axis that exists to catch GeoNerva's own pipeline
-- failing was being satisfied by a different pipeline.
--
-- Seeding is a distinct derivation — it opens an identity for a single-source hazard and makes no
-- matching decision — so it gets its own kind.

ALTER TABLE geonerva.analysis_runs DROP CONSTRAINT analysis_runs_kind_check;

ALTER TABLE geonerva.analysis_runs ADD CONSTRAINT analysis_runs_kind_check
  CHECK (kind IN
    ('CORRELATION', 'SEED', 'CLUSTERING', 'SNAPSHOT', 'BASELINE', 'AI_BRIEFING', 'RETENTION'));

COMMENT ON COLUMN geonerva.analysis_runs.kind IS
  'The derivation that ran. SEED is distinct from CORRELATION: it opens a canonical event for a
   single-source hazard without deciding a match, and a successful seed must never be read as
   evidence that correlation is current (P6 review).';
