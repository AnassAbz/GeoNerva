-- 0017 — durable per-feed coverage (ADR-041, accepted 2026-09-22).
--
-- A baseline counts a reference window only if GeoNerva *read* it, and until now that was derived
-- from `ingestion_runs`, which ADR-033 keeps for 90 days on the lean profile. This ledger records
-- coverage itself, per feed (`source_products`), so it outlives the runs it was derived from and so
-- one GDACS feed is never evidence that another was read.
--
-- Two tables, with different natures:
--
--  * `feed_coverage_hours` is a **fact**, append-only: an hour of observation time a feed was read
--    for, and the first moment GeoNerva knew it (`recorded_at`). It is never updated, so a replay
--    at T reads exactly the hours recorded by T. An hour is written only when a read window GeoNerva
--    completed contains all of it — a partial hour is not coverage.
--  * `feed_coverage_frontier` is **operational state**, updated in place, never read as fact: the
--    contiguous run of read windows a feed's recent successful polls have joined into, so each new
--    poll knows which full hours it has just completed. A window that does not meet the frontier
--    starts a new run; a gap is never bridged by assumption.

CREATE TABLE geonerva.feed_coverage_hours (
  product_id    smallint NOT NULL REFERENCES geonerva.source_products (id),
  hour          timestamptz NOT NULL CHECK (date_trunc('hour', hour) = hour),
  -- The magnitude floor the read applied, or NULL for a feed read without one. A backfill plan for
  -- M5.5+ does not cover M4.5 counts, so the floor is part of what an hour's coverage means.
  min_magnitude numeric(4, 2),
  recorded_at   timestamptz NOT NULL
);

-- One row per (feed, hour, floor); the first writer's `recorded_at` stands forever.
CREATE UNIQUE INDEX feed_coverage_hours_key
  ON geonerva.feed_coverage_hours (product_id, hour, COALESCE(min_magnitude, -99));

COMMENT ON TABLE geonerva.feed_coverage_hours IS
  'Hours of observation time a feed was read for, with the first moment GeoNerva knew it. Append-only
   (ADR-041): coverage that outlives ingestion-run retention, per feed.';

-- Coverage as of T is read per product in hour order.
CREATE INDEX feed_coverage_hours_known_idx
  ON geonerva.feed_coverage_hours (product_id, recorded_at, hour);

CREATE TABLE geonerva.feed_coverage_frontier (
  product_id   smallint PRIMARY KEY REFERENCES geonerva.source_products (id),
  covered_from timestamptz NOT NULL,
  covered_to   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (covered_from < covered_to)
);

COMMENT ON TABLE geonerva.feed_coverage_frontier IS
  'Operational: the contiguous run of read windows a feed''s successful polls have joined into, so a
   poll knows which full hours it completed. Never read as a fact about the past (ADR-041).';

-- Hours already vouched for by completed historical backfill intervals. A plan with no product
-- is source-level and covers each of that source's products. `LEAST(interval_to, completed_at)`:
-- a window cannot have been read past the moment its read finished.
INSERT INTO geonerva.feed_coverage_hours (product_id, hour, min_magnitude, recorded_at)
SELECT p.id, h.hour, pl.min_magnitude, min(i.completed_at)
FROM geonerva.backfill_intervals i
JOIN geonerva.backfill_plans pl ON pl.id = i.plan_id
JOIN geonerva.source_products p
  ON p.source_id = pl.source_id AND (pl.product_id IS NULL OR pl.product_id = p.id)
CROSS JOIN LATERAL generate_series(
  date_trunc('hour', i.interval_from) + CASE WHEN date_trunc('hour', i.interval_from) = i.interval_from
                                              THEN interval '0' ELSE interval '1 hour' END,
  date_trunc('hour', LEAST(i.interval_to, i.completed_at)) - interval '1 hour',
  interval '1 hour'
) AS h(hour)
WHERE pl.mode = 'HISTORICAL'
  AND i.status = 'DONE'
GROUP BY p.id, h.hour, pl.min_magnitude
ON CONFLICT DO NOTHING;

ALTER TABLE geonerva.feed_coverage_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE geonerva.feed_coverage_frontier ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON geonerva.feed_coverage_hours TO geonerva_worker;
GRANT SELECT, INSERT, UPDATE ON geonerva.feed_coverage_frontier TO geonerva_worker;
GRANT SELECT ON geonerva.feed_coverage_hours TO geonerva_web;
