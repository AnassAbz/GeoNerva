-- 0001 — the GeoNerva schema and the extensions it needs.
--
-- Portability contract (ADR-008, ADR-031):
--   * Every GeoNerva object lives in the schema `geonerva`, never in `public`. On Supabase the
--     `public` schema is exposed through the Data API; `geonerva` is not, and every table
--     additionally has RLS enabled with no policies (migration 0007) = deny-all.
--   * PostGIS lives in `extensions` on Supabase and in `public` on a plain PostgreSQL. Migrations
--     therefore never write `public.ST_DWithin(...)` or `extensions.geography`: PostGIS types and
--     functions are resolved through `search_path`, which the migrator sets to
--     `public, extensions` before every file, and which the runtime client sets per connection.
--   * `CREATE EXTENSION` is guarded by an existence check rather than `IF NOT EXISTS ... SCHEMA`,
--     because on a managed host the extension already exists in a schema we must not move, while
--     on a bare PostgreSQL it has to be created somewhere. The guard makes both cases a no-op or
--     a plain create.
--   * SQL stays within **PostGIS 3.3** features: Supabase ships 3.3.7, local and CI run 3.4
--     (there is no 17-3.3 image). `packages/db/src/postgis-requirements.ts` lists every PostGIS
--     function GeoNerva uses with the version that introduced it, and an integration test fails
--     if any of them needs more than 3.3.

CREATE SCHEMA IF NOT EXISTS geonerva;

COMMENT ON SCHEMA geonerva IS
  'GeoNerva application schema. Not exposed through any data API; RLS enabled with no policies.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    CREATE EXTENSION postgis SCHEMA public;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE EXTENSION pg_trgm SCHEMA public;
  END IF;
END
$$;

-- Minimum platform versions, asserted here so that a migration against an unsupported server
-- fails immediately and transactionally rather than halfway through the schema.
DO $$
DECLARE
  postgis_version text;
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'GeoNerva requires PostgreSQL 15 or newer (found %)',
      current_setting('server_version');
  END IF;

  SELECT extversion INTO postgis_version FROM pg_extension WHERE extname = 'postgis';
  IF postgis_version IS NULL THEN
    RAISE EXCEPTION 'PostGIS is not installed';
  END IF;

  IF string_to_array(postgis_version, '.')::int[] < ARRAY[3, 3] THEN
    RAISE EXCEPTION 'GeoNerva requires PostGIS 3.3 or newer (found %)', postgis_version;
  END IF;
END
$$;
