-- 0008 — seed the sources and products (DOMAIN_MODEL §4.1, DATA_SOURCES §0, §9).
--
-- Sources and products are **data, not code**: enabling a source, retiring a satellite or
-- retuning a freshness policy is an UPDATE, never a deployment (ADR-009). Nothing in the code
-- base branches on these ids; it branches on capabilities.
--
-- Licence and attribution are stored next to the data they govern, so that a response can never
-- be rendered without them. Where a provider's terms are inconsistent, GeoNerva adopts the
-- stricter reading (GDACS: CC BY 4.0, not public domain — DATA_SOURCES §2.7).
--
-- Freshness policies mirror `INITIAL_FRESHNESS_POLICIES` in packages/domain; an integration test
-- asserts that the seeded JSON parses against the domain schema and matches those values.

INSERT INTO geonerva.sources
  (id, name, homepage, licence, attribution_text, terms_url, disclaimer, coverage, coverage_note,
   enabled, policy)
VALUES
  ('usgs',
   'U.S. Geological Survey — Earthquake Hazards Program',
   'https://earthquake.usgs.gov/',
   'U.S. Public Domain',
   'U.S. Geological Survey, Earthquake Hazards Program, ANSS Comprehensive Catalog (ComCat), doi:10.5066/F7MS3QZH',
   'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
   'Contributed (non-USGS network) content may be copyrighted; contributing networks are named in the evidence.',
   NULL,
   'Global, but completeness is only assured from about M4.5 outside the United States.',
   true,
   '{"freshness":{"pollIntervalS":300,"fetchFreshWithinS":1200,"fetchStaleAfterS":3600,"unavailableAfterS":86400,"dataCurrentWithinS":null,"dataStaleAfterS":null,"quietIsNormal":true},"polling":{"intervalS":300,"jitterRatio":0.1,"timeoutMs":30000,"maxBodyBytes":20971520}}'::jsonb),

  ('emsc',
   'European-Mediterranean Seismological Centre (EMSC/CSEM)',
   'https://www.emsc-csem.org',
   'CC BY 4.0',
   'Credit: EMSC/CSEM, https://www.emsc-csem.org',
   'https://www.emsc-csem.org/Menu/disclaimer.php',
   'No warranty. Consult national authorities for decisions that matter.',
   NULL,
   'Global, with a much denser network in Europe, the Mediterranean and North Africa than elsewhere.',
   true,
   '{"freshness":{"pollIntervalS":300,"fetchFreshWithinS":1200,"fetchStaleAfterS":3600,"unavailableAfterS":86400,"dataCurrentWithinS":null,"dataStaleAfterS":null,"quietIsNormal":true},"polling":{"intervalS":300,"jitterRatio":0.1,"timeoutMs":30000,"maxBodyBytes":20971520}}'::jsonb),

  ('gdacs',
   'Global Disaster Alert and Coordination System (GDACS)',
   'https://www.gdacs.org',
   'CC BY 4.0 (European Union)',
   'GDACS, European Union (CC BY 4.0)',
   'https://www.gdacs.org/About/termofuse.aspx',
   'GDACS alerts are impact estimates provided "as is", with no guarantee of completeness or timeliness, and should not be used for decision making without prior confirmation. They are not a substitute for national authorities.',
   NULL,
   'Global. Alert levels are modelled impact estimates, not measured hazard intensities.',
   true,
   '{"freshness":{"pollIntervalS":600,"fetchFreshWithinS":2400,"fetchStaleAfterS":7200,"unavailableAfterS":86400,"dataCurrentWithinS":null,"dataStaleAfterS":null,"quietIsNormal":true},"polling":{"intervalS":600,"jitterRatio":0.1,"timeoutMs":30000,"maxBodyBytes":5242880}}'::jsonb),

  ('firms',
   'NASA FIRMS — Fire Information for Resource Management System',
   'https://firms.modaps.eosdis.nasa.gov/',
   'NASA open data',
   'We acknowledge the use of data and/or imagery from NASA''s Fire Information for Resource Management System (FIRMS), part of NASA''s Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA''s Earth Science Data and Information System (ESDIS).',
   'https://www.earthdata.nasa.gov/engage/open-data-services-and-software/data-and-information-policy',
   'Thermal detections are satellite observations of heat, provided "as is". They can include gas flares, industrial sites and volcanoes, and they are not confirmed wildfires.',
   NULL,
   'Global. Near-real-time detections arrive about three hours after the satellite overpass, and a place is only seen a few times per day.',
   true,
   '{"freshness":{"pollIntervalS":1800,"fetchFreshWithinS":5400,"fetchStaleAfterS":10800,"unavailableAfterS":86400,"dataCurrentWithinS":21600,"dataStaleAfterS":43200,"quietIsNormal":false},"polling":{"intervalS":1800,"jitterRatio":0.1,"timeoutMs":120000,"maxBodyBytes":41943040}}'::jsonb),

  ('eccc',
   'Environment and Climate Change Canada — Meteorological Service of Canada',
   'https://eccc-msc.github.io/open-data/',
   'ECCC Data Servers End-use Licence v2.1.1',
   'Data Source: Environment and Climate Change Canada',
   'https://eccc-msc.github.io/open-data/licence/readme_en/',
   'Alerts must be reproduced without alteration of their content or intent. ECCC is not the only Canadian alerting authority; this covers ECCC weather alerts only.',
   NULL,
   'Canada only, and weather alerts only. Other regions are not covered by GeoNerva yet.',
   -- P1 (ADR-019). Seeded disabled so that coverage can already say "not covered yet" honestly,
   -- and so that enabling the adapter later is a data change.
   false,
   '{"freshness":{"pollIntervalS":300,"fetchFreshWithinS":1200,"fetchStaleAfterS":3600,"unavailableAfterS":86400,"dataCurrentWithinS":null,"dataStaleAfterS":null,"quietIsNormal":true},"polling":{"intervalS":300,"jitterRatio":0.1,"timeoutMs":30000,"maxBodyBytes":10485760}}'::jsonb);

INSERT INTO geonerva.source_products
  (source_id, code, hazard_types, capabilities, platform, instrument, resolution_m,
   confidence_scale, latency_class, status, active_from, active_to, enabled, policy)
VALUES
  ('usgs', 'comcat', ARRAY['EARTHQUAKE'],
   ARRAY['REALTIME_EVENTS', 'HISTORICAL_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS', 'DELETIONS',
         'IMPACT_ALERT_LEVELS', 'CROSS_REFERENCES'],
   NULL, NULL, NULL, NULL, 'MINUTES', 'ACTIVE', NULL, NULL, true, NULL),

  ('emsc', 'rts', ARRAY['EARTHQUAKE'],
   ARRAY['REALTIME_EVENTS', 'HISTORICAL_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS',
         'CROSS_REFERENCES'],
   NULL, NULL, NULL, NULL, 'MINUTES', 'ACTIVE', NULL, NULL, true, NULL),

  -- GDACS is one feed per event type; episodes are versions of an event.
  ('gdacs', 'EQ', ARRAY['EARTHQUAKE'],
   ARRAY['REALTIME_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS', 'IMPACT_ALERT_LEVELS',
         'CROSS_REFERENCES'],
   NULL, NULL, NULL, NULL, 'MINUTES', 'ACTIVE', NULL, NULL, true, NULL),
  ('gdacs', 'FL', ARRAY['FLOOD'],
   ARRAY['REALTIME_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS', 'POLYGONS', 'IMPACT_ALERT_LEVELS'],
   NULL, NULL, NULL, NULL, 'HOURS', 'ACTIVE', NULL, NULL, true, NULL),
  ('gdacs', 'TC', ARRAY['TROPICAL_CYCLONE'],
   ARRAY['REALTIME_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS', 'POLYGONS', 'TRACKS',
         'FORECAST_GEOMETRY', 'IMPACT_ALERT_LEVELS'],
   NULL, NULL, NULL, NULL, 'HOURS', 'ACTIVE', NULL, NULL, true, NULL),
  ('gdacs', 'WF', ARRAY['WILDFIRE_EVENT'],
   ARRAY['REALTIME_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS', 'POLYGONS', 'IMPACT_ALERT_LEVELS'],
   NULL, NULL, NULL, NULL, 'HOURS', 'ACTIVE', NULL, NULL, true, NULL),
  ('gdacs', 'VO', ARRAY['VOLCANO'],
   ARRAY['REALTIME_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS', 'IMPACT_ALERT_LEVELS'],
   NULL, NULL, NULL, NULL, 'HOURS', 'ACTIVE', NULL, NULL, true, NULL),
  ('gdacs', 'DR', ARRAY['DROUGHT'],
   ARRAY['REALTIME_EVENTS', 'EVENT_DETAILS', 'IMPACT_ALERT_LEVELS'],
   NULL, NULL, NULL, NULL, 'HOURS', 'ACTIVE', NULL, NULL, true, NULL),

  -- FIRMS: NOAA-20 and NOAA-21 only. Suomi-NPP delivery ends 2026-11-01 and MODIS is shutting
  -- down, so neither is ingested; both would also mix confidence scales (ADR-009).
  ('firms', 'VIIRS_NOAA20_NRT', ARRAY['THERMAL_ACTIVITY'],
   ARRAY['POINT_DETECTIONS', 'REALTIME_EVENTS', 'HISTORICAL_EVENTS'],
   'NOAA-20', 'VIIRS', 375, 'CATEGORICAL', 'NRT', 'ACTIVE', DATE '2018-01-01', NULL, true, NULL),
  ('firms', 'VIIRS_NOAA21_NRT', ARRAY['THERMAL_ACTIVITY'],
   ARRAY['POINT_DETECTIONS', 'REALTIME_EVENTS', 'HISTORICAL_EVENTS'],
   'NOAA-21', 'VIIRS', 375, 'CATEGORICAL', 'NRT', 'ACTIVE', DATE '2023-01-01', NULL, true, NULL),

  -- ECCC (P1). Identity key is the GeoMet feature `id`, shaped
  -- `<alert-thread><YYYYMMDDhhmm>_<feature_id>`; `feature_id` alone is not unique within a poll,
  -- and `publication_datetime` maps to source_updated_at (P0 verification V1).
  ('eccc', 'weather-alerts', ARRAY['WEATHER_ALERT'],
   ARRAY['OFFICIAL_WARNINGS', 'REALTIME_EVENTS', 'EVENT_DETAILS', 'EVENT_REVISIONS', 'POLYGONS'],
   NULL, NULL, NULL, NULL, 'MINUTES', 'ACTIVE', NULL, NULL, false, NULL);
