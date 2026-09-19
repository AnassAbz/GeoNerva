-- 0007 — row-level security and the two database roles (ADR-008, DOMAIN_MODEL §6).
--
-- Defence in depth, in three layers:
--
--  1. **Schema.** Nothing lives in `public`, which on Supabase is the only schema the Data API
--     exposes. `geonerva` is not reachable through PostgREST at all.
--  2. **RLS with no policies.** Every table has RLS enabled and **zero** policies, which means
--     deny-all for any non-superuser without `BYPASSRLS` — including Supabase's `anon` and
--     `authenticated` roles if they were ever granted access by mistake. This is the belt for the
--     braces above: a future misconfiguration exposes an empty result set, not the database.
--  3. **Least privilege.** Two roles with genuinely different rights:
--       * `geonerva_worker` — the only writer of provider facts;
--       * `geonerva_web`    — SELECT on facts, plus INSERT/UPDATE on exactly two tables
--                             (`rate_limit_buckets`, `geocode_cache`) that the read path must
--                             write to do its job. It cannot write a single fact.
--
-- The roles are `NOLOGIN` group roles: a deployment grants them to the actual login role, which
-- keeps credentials out of migrations. They are created only if absent, because a managed host
-- may already own them.

DO $$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'geonerva'
      AND c.relkind IN ('r', 'p')
  LOOP
    -- ENABLE, deliberately **not** FORCE. RLS with no policies denies every role except the
    -- table owner and roles with BYPASSRLS, which is exactly the intent: Supabase's `anon` and
    -- `authenticated` get nothing, while the application — which owns these tables, because it
    -- is the role that ran this migration — keeps working. FORCE would also lock out the owner
    -- and would therefore break the application it is meant to protect.
    EXECUTE format('ALTER TABLE geonerva.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geonerva_worker') THEN
    CREATE ROLE geonerva_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geonerva_web') THEN
    CREATE ROLE geonerva_web NOLOGIN;
  END IF;
END
$$;

COMMENT ON ROLE geonerva_worker IS 'Ingestion worker: read/write on the geonerva schema.';
COMMENT ON ROLE geonerva_web IS 'Read-only web app, plus its two operational counters.';

GRANT USAGE ON SCHEMA geonerva TO geonerva_worker, geonerva_web;

-- ── worker: full read/write on facts and derivations ────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA geonerva TO geonerva_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA geonerva TO geonerva_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA geonerva TO geonerva_worker;

-- ── web: SELECT on everything, write on exactly two tables ──────────────────
GRANT SELECT ON ALL TABLES IN SCHEMA geonerva TO geonerva_web;
GRANT INSERT, UPDATE ON geonerva.rate_limit_buckets TO geonerva_web;
GRANT INSERT, UPDATE ON geonerva.geocode_cache TO geonerva_web;

-- The web role must never be able to reach the raw provider payloads it has no use for, nor the
-- AI outputs, which may contain rejected model text that is kept only for evaluation.
REVOKE SELECT ON geonerva.raw_source_records FROM geonerva_web;
REVOKE SELECT ON geonerva.agent_outputs FROM geonerva_web;
GRANT SELECT (id, snapshot_id, role, model, prompt_version, output, validation_status, used, created_at)
  ON geonerva.agent_outputs TO geonerva_web;

-- Future tables created by later migrations inherit these grants, so that adding a table cannot
-- silently leave the web role without read access or, worse, with write access.
ALTER DEFAULT PRIVILEGES IN SCHEMA geonerva
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO geonerva_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA geonerva
  GRANT USAGE, SELECT ON SEQUENCES TO geonerva_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA geonerva
  GRANT SELECT ON TABLES TO geonerva_web;

-- Nothing is granted to PUBLIC, and the schema is not searchable by default.
REVOKE ALL ON SCHEMA geonerva FROM PUBLIC;

-- Deployment note (also in docs/DOMAIN_MODEL.md §6): `geonerva_worker` and `geonerva_web` are
-- NOLOGIN group roles. A deployment that uses them as *separate login roles* rather than as
-- grants to the owning role must also give them BYPASSRLS, or add explicit policies, because RLS
-- with no policies denies non-owner roles regardless of the GRANTs above. The default
-- deployment (Supabase, or a single owning role locally) needs neither.

