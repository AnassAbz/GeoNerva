-- 0012 — resumable backfill plans and their interval checkpoints (P4.2).
--
-- Additive: two new tables, nothing existing is altered. No frozen contract is touched.
--
-- A backfill must survive the process that started it. P4.2 forbids a cursor in process memory
-- and a hidden mutable cursor, so the plan and the state of every interval in it live here, and a
-- resumed backfill reads them rather than recomputing from something it remembers.
--
-- Two design points worth stating, because both are load-bearing:
--
--   * **An interval is identified by its bounds, not by a sequence number.** The primary key is
--     `(plan_id, interval_from, interval_to)`, so re-planning or re-splitting a window produces
--     exactly the same rows and `ON CONFLICT DO NOTHING` makes it idempotent. Processing order is
--     `interval_from`, which means a window split mid-run sorts into place with no renumbering.
--   * **Requesting the same range twice resumes the same plan.** The unique index on the range
--     makes a repeat request find the existing plan instead of creating a second one that would
--     re-walk work already done. Overlapping-but-different ranges are separate plans, and it is
--     the content hash that keeps their facts from duplicating.

CREATE TABLE geonerva.backfill_plans (
  id               uuid PRIMARY KEY,
  source_id        text NOT NULL REFERENCES geonerva.sources (id),
  product_id       smallint REFERENCES geonerva.source_products (id),
  -- What kind of question this plan asks. A deletion sweep is planned the same way but parsed
  -- differently, so the mode has to be part of the plan's identity.
  mode             text NOT NULL CHECK (mode IN ('HISTORICAL', 'DELETION_SWEEP')),
  range_from       timestamptz NOT NULL,
  range_to         timestamptz NOT NULL,
  min_magnitude    numeric(4, 2),
  window_ms        bigint NOT NULL CHECK (window_ms > 0),
  min_window_ms    bigint NOT NULL CHECK (min_window_ms > 0),
  status           text NOT NULL
                     CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'ABANDONED')),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at      timestamptz,
  -- Sanitized and bounded, exactly as ingestion_runs.error_message is: never a provider body.
  error_message    text CHECK (error_message IS NULL OR octet_length(error_message) <= 1024),
  CHECK (range_from < range_to),
  CHECK (min_window_ms <= window_ms),
  CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);

COMMENT ON TABLE geonerva.backfill_plans IS
  'One historical backfill request and its parameters. The plan a resumed backfill trusts.';

-- Requesting the same range for the same product resumes rather than duplicating. COALESCE
-- because a null product or magnitude must still compare equal to itself.
CREATE UNIQUE INDEX backfill_plans_request_idx
  ON geonerva.backfill_plans (
    source_id,
    COALESCE(product_id, -1),
    mode,
    range_from,
    range_to,
    COALESCE(min_magnitude, -99)
  );

CREATE INDEX backfill_plans_status_idx ON geonerva.backfill_plans (status, created_at DESC);

CREATE TABLE geonerva.backfill_intervals (
  plan_id          uuid NOT NULL REFERENCES geonerva.backfill_plans (id) ON DELETE CASCADE,
  interval_from    timestamptz NOT NULL,
  interval_to      timestamptz NOT NULL,
  status           text NOT NULL
                     CHECK (status IN ('PENDING', 'DONE', 'SPLIT', 'FAILED')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The run that ingested this interval, so an interval's facts are traceable to a batch.
  ingestion_run_id uuid REFERENCES geonerva.ingestion_runs (id),
  n_received       integer NOT NULL DEFAULT 0 CHECK (n_received >= 0),
  error_class      text,
  error_message    text CHECK (error_message IS NULL OR octet_length(error_message) <= 1024),
  completed_at     timestamptz,
  PRIMARY KEY (plan_id, interval_from, interval_to),
  CHECK (interval_from < interval_to),
  -- A finished interval says when. A SPLIT one is finished in the sense that it will never be
  -- fetched: its children carry the work.
  CHECK ((status IN ('DONE', 'SPLIT')) = (completed_at IS NOT NULL))
);

COMMENT ON TABLE geonerva.backfill_intervals IS
  'Checkpoint per window. Marked DONE inside the same transaction that commits the window''s
   facts, so there is no instant at which the facts exist and the checkpoint does not.';

-- The resumption query: the next PENDING interval of a plan, in time order.
CREATE INDEX backfill_intervals_pending_idx
  ON geonerva.backfill_intervals (plan_id, interval_from)
  WHERE status = 'PENDING';

-- Both tables hold operational state, not provider facts, but they are in the same schema behind
-- the same deny-all RLS as everything else (0007). Enabling it here keeps that uniform: a table
-- without RLS in a schema where every other table has it is the kind of gap nobody notices.
ALTER TABLE geonerva.backfill_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE geonerva.backfill_intervals ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON geonerva.backfill_plans TO geonerva_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON geonerva.backfill_intervals TO geonerva_worker;
GRANT SELECT ON geonerva.backfill_plans TO geonerva_web;
GRANT SELECT ON geonerva.backfill_intervals TO geonerva_web;
