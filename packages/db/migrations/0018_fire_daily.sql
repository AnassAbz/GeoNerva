-- 0018 — the daily fire aggregate an honest trend needs (ADR-040, accepted 2026-09-22).
--
-- `FIRE_TREND` compares the last 7 days of thermal detections with the 28 before them, per covered
-- day (ARCHITECTURE §8.2). Raw detections are kept 72 hours on the lean profile, so the trend must
-- read an aggregate — and the aggregate must be replayable and must never present an unread day as
-- a quiet one. Two append-only tables, both stamped with the knowledge time they became true:
--
--  * `fire_daily_counts` — per grid cell, day and **product**, so a sensor's contribution stays
--    separable and a sensor added or retired mid-window cannot manufacture a trend (ADR-009).
--  * `fire_daily_coverage` — what GeoNerva can say about a whole day for one feed: it was read
--    (`COVERED`), FIRMS reported no satellite data (`MISSING_DATA`), or GeoNerva did not read every
--    hour of it (`NOT_COVERED`, from the ADR-041 ledger). Only a `COVERED` day's absence of counts
--    means zero detections; the other two are excluded from the comparison.
--
-- A day is written once it is **final** — the UTC day is over and no longer inside the FIRMS
-- `DAY_RANGE` window, so no further detection for it can arrive. A correction is a new row with a
-- later `computed_at`; nothing is ever updated.
--
-- `fire_daily_cells` from migration 0005 is superseded: it had no writer, no knowledge time and no
-- product dimension. Nothing ever wrote or read it.

DROP TABLE IF EXISTS geonerva.fire_daily_cells;

CREATE TABLE geonerva.fire_daily_counts (
  -- The 0.25° lat/lon grid of ADR-011: `floor((lat + 90) / 0.25) * 1440 + floor((lon + 180) / 0.25)`.
  cell_id     integer NOT NULL,
  day         date NOT NULL,
  product_id  smallint NOT NULL REFERENCES geonerva.source_products (id),
  computed_at timestamptz NOT NULL,
  n           integer NOT NULL CHECK (n > 0),
  n_high_conf integer NOT NULL DEFAULT 0 CHECK (n_high_conf >= 0),
  frp_sum     real,
  PRIMARY KEY (cell_id, day, product_id, computed_at),
  CHECK (n_high_conf <= n)
);

COMMENT ON TABLE geonerva.fire_daily_counts IS
  'Detections per 0.25° cell, UTC day and product, as computed at a knowledge time. Append-only
   (ADR-040); rows exist only for cells with detections, and only for days recorded COVERED.';

CREATE INDEX fire_daily_counts_day_idx ON geonerva.fire_daily_counts (day, product_id, computed_at);

CREATE TABLE geonerva.fire_daily_coverage (
  product_id  smallint NOT NULL REFERENCES geonerva.source_products (id),
  day         date NOT NULL,
  computed_at timestamptz NOT NULL,
  state       text NOT NULL CHECK (state IN ('COVERED', 'MISSING_DATA', 'NOT_COVERED')),
  PRIMARY KEY (product_id, day, computed_at)
);

COMMENT ON TABLE geonerva.fire_daily_coverage IS
  'What GeoNerva can say about one feed''s whole day: read, no satellite data, or not read. Only a
   COVERED day with no counts means zero detections (ADR-040).';

ALTER TABLE geonerva.fire_daily_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE geonerva.fire_daily_coverage ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON geonerva.fire_daily_counts TO geonerva_worker;
GRANT SELECT, INSERT ON geonerva.fire_daily_coverage TO geonerva_worker;
GRANT SELECT ON geonerva.fire_daily_counts TO geonerva_web;
GRANT SELECT ON geonerva.fire_daily_coverage TO geonerva_web;
