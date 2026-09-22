-- 0015 — type-ahead over alternate names (P8, ADR-013).
--
-- The plan is explicit: type-ahead "must index `alternatenames`: the primary name is 'Marrakesh'
-- and 'Marrakech' exists only as an alternate" (IMPLEMENTATION_PLAN P8 task 2). Migration 0006
-- indexed `ascii_name` alone, so the spelling most French- and Arabic-speaking users type for the
-- city would have been answered with a sequential scan at best — and, once a query planner stops
-- choosing that scan, with nothing.
--
-- GeoNames stores the alternates as one comma-separated string. A trigram index on it serves the
-- `ILIKE` patterns the suggestion read uses for "an alternate that starts with the query".

CREATE INDEX places_alt_names_trgm_idx ON geonerva.places USING gin (alt_names gin_trgm_ops);
CREATE INDEX places_name_trgm_idx ON geonerva.places USING gin (name gin_trgm_ops);

COMMENT ON COLUMN geonerva.places.alt_names IS
  'GeoNames alternatenames, comma-separated and verbatim. Searched for type-ahead: many places are
   typed by an alternate (Marrakech for Marrakesh), so the primary name alone is not enough.';
