-- 0006 — locations, derived analysis artifacts, caches and AI outputs
-- (DOMAIN_MODEL §6.5, ADR-004, ADR-012, ADR-013, ADR-015).
--
-- Privacy rule (ADR-015): raw user coordinates are **never** persisted. `analysis_locations`
-- holds named, public places only, and the CHECK constraint below enforces it at the storage
-- layer rather than trusting every caller. Everything keyed by a location inherits that rule
-- through its foreign key.

CREATE TABLE geonerva.places (
  geonameid    integer PRIMARY KEY,
  name         text NOT NULL,
  ascii_name   text NOT NULL,
  alt_names    text,
  country_code text,
  admin1       text,
  lat          double precision NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lon          double precision NOT NULL CHECK (lon >= -180 AND lon < 180),
  population   integer,
  timezone     text NOT NULL
);

COMMENT ON TABLE geonerva.places IS
  'GeoNames cities15000 import, used for offline type-ahead so that keystrokes never leave the
   server (ADR-013).';

CREATE INDEX places_ascii_name_trgm_idx ON geonerva.places USING gin (ascii_name gin_trgm_ops);
CREATE INDEX places_population_idx ON geonerva.places (population DESC NULLS LAST);

CREATE TABLE geonerva.geocode_cache (
  query_sha256 bytea PRIMARY KEY CHECK (octet_length(query_sha256) = 32),
  provider     text NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

COMMENT ON TABLE geonerva.geocode_cache IS
  'Nominatim responses, keyed by a hash of the normalized query so the raw query is not stored.
   Protects GeoNerva''s standing under the OSMF usage policy (≤ 1 req/s, 30-day cache).';

CREATE INDEX geocode_cache_expires_idx ON geonerva.geocode_cache (expires_at);

CREATE TABLE geonerva.analysis_locations (
  key          text PRIMARY KEY,
  label        text NOT NULL,
  -- numeric(5,2)/(6,2) makes the two-decimal rounding a storage guarantee, not a convention.
  lat          numeric(5, 2) NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lon          numeric(6, 2) NOT NULL CHECK (lon >= -180 AND lon < 180),
  geog         geography(Point, 4326) NOT NULL,
  country_code text,
  admin1       text,
  timezone     text NOT NULL,
  -- Materialized locations get snapshots, change history and (P1) AI caching.
  materialize  boolean NOT NULL DEFAULT false,
  is_demo      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- ADR-015 enforced in the schema: only `p:` (GeoNames) and `n:` (Nominatim) keys may be
  -- persisted. A `c:` raw-coordinate key is rejected by the database itself.
  CONSTRAINT analysis_locations_named_place_only
    CHECK (key ~ '^p:[1-9][0-9]{0,9}$' OR key ~ '^n:[NWR][1-9][0-9]{0,18}$')
);

COMMENT ON TABLE geonerva.analysis_locations IS
  'Named, public places only. Raw user coordinates are never persisted server-side (ADR-015).';

CREATE INDEX analysis_locations_geog_gix ON geonerva.analysis_locations USING gist (geog);
CREATE INDEX analysis_locations_materialize_idx
  ON geonerva.analysis_locations (materialize) WHERE materialize;

CREATE TABLE geonerva.analysis_runs (
  id             uuid PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN
                   ('CORRELATION', 'CLUSTERING', 'SNAPSHOT', 'BASELINE', 'AI_BRIEFING', 'RETENTION')),
  location_key   text REFERENCES geonerva.analysis_locations (key),
  as_of          timestamptz,
  engine_version text NOT NULL,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  status         text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
  inputs_sha256  bytea CHECK (inputs_sha256 IS NULL OR octet_length(inputs_sha256) = 32),
  stats          jsonb,
  error_class    text,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

COMMENT ON TABLE geonerva.analysis_runs IS
  'Audit and metrics for derivations. A post-commit failure here never rolls back facts:
   projections are rebuildable (ARCHITECTURE §4.2 step 6).';

CREATE INDEX analysis_runs_kind_started_idx ON geonerva.analysis_runs (kind, started_at DESC);

CREATE TABLE geonerva.location_snapshots (
  id              uuid PRIMARY KEY,
  location_key    text NOT NULL REFERENCES geonerva.analysis_locations (key),
  as_of           timestamptz NOT NULL,
  engine_version  text NOT NULL,
  content_sha256  bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  snapshot        jsonb NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  analysis_run_id uuid REFERENCES geonerva.analysis_runs (id),
  -- Recomputing the same snapshot must not create a second row (DOMAIN_MODEL §6.6).
  UNIQUE (location_key, as_of, engine_version)
);

COMMENT ON TABLE geonerva.location_snapshots IS
  'A cache, not a source of truth: buildSnapshot(L, T) is reproducible from the append-only store
   for a given engine_version (invariant I14).';

CREATE INDEX location_snapshots_location_asof_idx
  ON geonerva.location_snapshots (location_key, as_of DESC);

CREATE TABLE geonerva.change_signals (
  -- EV:CHG:<sha> — content-addressed by the change itself.
  id             text PRIMARY KEY,
  location_key   text NOT NULL REFERENCES geonerva.analysis_locations (key),
  from_snapshot  uuid REFERENCES geonerva.location_snapshots (id),
  to_snapshot    uuid NOT NULL REFERENCES geonerva.location_snapshots (id),
  type           text NOT NULL,
  family         text NOT NULL,
  subject_ref    text,
  metric_code    text,
  importance     smallint NOT NULL CHECK (importance >= 0 AND importance <= 100),
  prominence     text NOT NULL CHECK (prominence IN ('HEADLINE', 'LISTED', 'DETAIL', 'SUPPRESSED')),
  payload        jsonb NOT NULL,
  engine_version text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE geonerva.change_signals IS
  'Diff output between two knowledge states. Suppressed signals are stored too, so that
   "show N minor changes" is honest rather than a silent filter (ARCHITECTURE §10.3).';

CREATE INDEX change_signals_location_to_idx ON geonerva.change_signals (location_key, to_snapshot);
CREATE INDEX change_signals_subject_idx ON geonerva.change_signals (subject_ref)
  WHERE subject_ref IS NOT NULL;

CREATE TABLE geonerva.baseline_metrics (
  -- EV:BAS:<sha> — content-addressed by method, params and as_of.
  id             text PRIMARY KEY,
  location_key   text NOT NULL REFERENCES geonerva.analysis_locations (key),
  family         text NOT NULL,
  metric_code    text NOT NULL,
  as_of          timestamptz NOT NULL,
  method_version text NOT NULL,
  payload        jsonb NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE geonerva.baseline_metrics IS
  'Cache of computed baselines for materialized locations. Recomputable at any time.';

CREATE INDEX baseline_metrics_lookup_idx
  ON geonerva.baseline_metrics (location_key, family, metric_code, as_of DESC);

CREATE TABLE geonerva.agent_outputs (
  id                uuid PRIMARY KEY,
  snapshot_id       uuid NOT NULL REFERENCES geonerva.location_snapshots (id) ON DELETE CASCADE,
  role              text NOT NULL,
  model             text NOT NULL,
  prompt_version    text NOT NULL,
  input_sha256      bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
  output            jsonb NOT NULL,
  validation_status text NOT NULL CHECK (validation_status IN ('PASSED', 'REPAIRED', 'REJECTED')),
  validation_errors jsonb,
  -- A REJECTED output is kept for evaluation but never shown (ADR-012).
  used              boolean NOT NULL DEFAULT false,
  tokens_in         integer CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out        integer CHECK (tokens_out IS NULL OR tokens_out >= 0),
  cost_micros       bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, role, prompt_version, model),
  CHECK (NOT used OR validation_status <> 'REJECTED')
);

COMMENT ON TABLE geonerva.agent_outputs IS
  'P1 runtime AI. Cached by (snapshot content hash, role, prompt version, model). AI_MODE is
   disabled in production for v1 (owner decision Q4).';

CREATE TABLE geonerva.rate_limit_buckets (
  -- HMAC of the IP prefix (/24 or /48) with a daily-rotated secret. Raw IPs are never stored.
  bucket_key   bytea NOT NULL CHECK (octet_length(bucket_key) = 32),
  window_start timestamptz NOT NULL,
  n            integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (bucket_key, window_start)
);

COMMENT ON TABLE geonerva.rate_limit_buckets IS
  'Fixed-window counters. The only table the web role may write, besides the geocode cache.';

CREATE INDEX rate_limit_buckets_window_idx ON geonerva.rate_limit_buckets (window_start);
