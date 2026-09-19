/**
 * Schema constants, kept in their own module so that the migrator can use them without pulling in
 * the Kysely client (and therefore the generated types, which only exist after a migration run).
 */

/** The schema every GeoNerva object lives in. Never `public` (ADR-008). */
export const GEONERVA_SCHEMA = 'geonerva';

/**
 * The `search_path` used by every connection and by every migration.
 *
 * It contains only the schemas PostGIS might live in — `public` on a plain PostgreSQL,
 * `extensions` on Supabase — and deliberately **not** `geonerva`. GeoNerva's own tables are
 * always written schema-qualified, so nothing can shadow them, and the same SQL runs unchanged on
 * both hosts.
 */
export const SEARCH_PATH = 'public, extensions';
