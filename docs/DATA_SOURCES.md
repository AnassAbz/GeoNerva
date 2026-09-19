# GeoNerva — Data Sources

> Status: **architecture phase, verified 2026-09-19**. Every fact below was checked against official documentation and/or live responses on that date. Items marked **UNVERIFIED** must be resolved in Phase 0 (fixture capture) before the adapter that depends on them is merged.
>
> This document is the contract between the outside world and GeoNerva. If a provider changes, this file changes first, then the adapter, then the fixtures.

## 0. Source matrix (v1)

| Source | Role in v1 | Hazards | Coverage | Auth | Polling cadence | Expected data latency | Licence | Priority |
|---|---|---|---|---|---|---|---|---|
| USGS ComCat real-time feeds | Primary earthquakes | EARTHQUAKE | Global, but completeness ≈ M4.5 outside US | none | 5 min (`all_day`), hourly reconcile via FDSN `updatedafter` | minutes | US public domain | **P0** |
| USGS FDSN event service | Baseline backfill, deletions reconcile | EARTHQUAKE | same | none | daily + on backfill | n/a | US public domain | **P0** |
| GDACS API + RSS | Impact-based alerts; flood, cyclone, volcano, large wildfire; EQ cross-reference | EARTHQUAKE, FLOOD, CYCLONE, VOLCANO, WILDFIRE_EVENT, DROUGHT | Global | none | 10 min (RSS refreshes every 6 min) | minutes – hours | EU, CC BY 4.0 (see §2.7) | **P0** |
| NASA FIRMS Area API | Satellite thermal detections | THERMAL_ACTIVITY | Global | MAP_KEY (free) | 30 min | **≈ 3 h after overpass** (NRT) | NASA open data | **P0** |
| EMSC SeismicPortal FDSN | **Independent** 2nd earthquake source | EARTHQUAKE | Global; dense Euro-Med & North Africa | none | 5 min | minutes | CC BY 4.0 | **P0** |
| ECCC MSC GeoMet `weather-alerts` | Official weather alerts | WEATHER_ALERT | **Canada only** | none | 5 min | minutes | ECCC Data Servers End-use Licence v2.1.1 | P1 (first post-launch adapter) |
| NWS `api.weather.gov` alerts | Official weather alerts | WEATHER_ALERT | US + territories | User-Agent | 5 min | minutes | US public domain | P1 |
| ECCC Datamart CAP via AMQPS | Full CAP lineage for Canada | WEATHER_ALERT | Canada | anonymous AMQP | push | seconds | ECCC licence | P1 |
| Nominatim (OSMF) | Submit-time geocoding, reverse geocoding | — | Global | UA required | on demand, ≤1 req/s, cached | — | ODbL | **P0** |
| GeoNames cities (local table) | Type-ahead suggestions (offline) | — | Global | none | static import | — | CC BY 4.0 (**verify in Phase 0**) | **P0** |
| OpenFreeMap | Basemap tiles/styles | — | Global | none | client | — | OSM ODbL + OpenMapTiles | **P0** |
| Protomaps PMTiles (self-hosted) | Basemap fallback | — | Global | none | client | — | ODbL | P1 |

"Polling cadence" is how often GeoNerva asks. "Expected data latency" is how late the data typically is relative to the physical event. They are different numbers and GeoNerva tracks them separately (see `DOMAIN_MODEL.md` §SourceHealth).

---

## 1. USGS — Earthquake Hazards Program (ComCat)

**Purpose:** authoritative earthquake events, revisions, and the historical catalog used for baselines.

### 1.1 Interfaces

| Interface | URL | Use in GeoNerva |
|---|---|---|
| Real-time GeoJSON summary | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{all\|1.0\|2.5\|4.5\|significant}_{hour\|day\|week\|month}.geojson` | Primary poll: `all_day.geojson` every 5 min; `all_week` on cold start / gap recovery |
| Detail GeoJSON | `properties.detail` URL per event | Fetched only for events that pass the relevance pre-filter (PAGER, ShakeMap, DYFI products) — P1 |
| FDSN event service | `https://earthquake.usgs.gov/fdsnws/event/1/query` | `updatedafter` reconcile (hourly), `includedeleted=only` (daily), baseline backfill |
| FDSN `count` | `/fdsnws/event/1/count` | Chunk planning under the 20,000-row hard limit |

- Feeds say "Updated every minute" and serve `Cache-Control: public, max-age=60` behind CloudFront. Polling faster than 60 s is pointless; 5 min is ample for a near-real-time product.
- FDSN query hard limit: **20,000 rows → HTTP 400 if exceeded**. Backfill must call `count` then split time ranges recursively.
- FDSN `includesuperseded` only works with `eventid`. `includedeleted` only in csv/geojson; a deleted event queried by `eventid` returns **409**.
- No auth. No numeric rate limit documented; official guidance is "automated applications should use Real-time GeoJSON Feeds whenever possible".

### 1.2 Fields preserved

`id, ids, sources, net, code, mag, magType, time, updated, tz, felt, cdi, mmi, alert (PAGER), status (automatic|reviewed|deleted), tsunami, sig, types, nst, dmin, rms, gap, type, title, place, url, detail`, geometry `[lon, lat, depth_km]`.

### 1.3 Identity semantics (critical)

- `id` is "the current preferred id for the event, and **may change over time**".
- `ids` is a comma-delimited list of **all** associated event IDs, e.g. `",pt26261050,us7000tiar,pr2026261000,"`.
- Preferred origin/magnitude are selected by `preferredWeight`, ties by latest `updateTime`. Magnitude, magType, location and the authoritative network can all change after first publication.
- **Consequence:** GeoNerva keys USGS records by an internal `source_record_id` and maintains an **alias set** from `ids`. Any incoming feature whose `ids` intersects an existing alias set is the same source record. `id` is stored but never used as the only key.

### 1.4 Deletions

Summary feeds **silently drop** deleted events. A deletion is only observable via FDSN `includedeleted=only` (daily reconcile, window = retention of live events). A deletion becomes a tombstone *version* of the record — never a hard delete (replay must still show that the event was visible before deletion).

### 1.5 Completeness — scientifically critical

- NEIC's goal: ~M4.5 global completeness, ~M3.0 US completeness.
- USGS FAQ: the lists "should NOT be considered complete … especially … of all magnitude 4.5 and greater events around the globe"; "might not display earthquakes smaller than 5.0 outside the U.S."; many regional networks do not share data with NEIC.
- Global location uncertainty can be "10s of kilometers in many parts of the world".
- **Live check (Marrakech, 300 km, past 365 d): 1 event.** 100 km around the 2023 Al Haouz M6.8 epicentre, Sep–Dec 2023: only 8 events.

**Design consequence:** the brief's Marrakech example ("4 earthquakes within 180 km in 48 h, largest M3.4") is not producible from USGS data. Baselines must use a location-dependent magnitude of completeness (Mc), multi-year windows, and a visible completeness caveat. See `ARCHITECTURE.md` §8.

### 1.6 History

ComCat reaches back to 1900; modern global M4.5 completeness is only stable from roughly the mid-1990s (research consensus, not an official USGS statement). GeoNerva backfills **global M≥4.5 from 2000-01-01** (~7k events/year → ~190k rows) plus **all magnitudes for the most recent 30 days**.

### 1.7 Licence & attribution

- USGS-authored data: **U.S. Public Domain**. Credit requested: "U.S. Geological Survey".
- Contributed (non-USGS network) content may be copyrighted — surface the contributing `sources` in evidence.
- Citation: U.S. Geological Survey, Earthquake Hazards Program, 2017, ANSS Comprehensive Catalog (ComCat), https://doi.org/10.5066/F7MS3QZH.
- Lifecycle: feed v1.0 in production; policy guarantees ≥30 days notice before deprecation. No announced deprecations.

### 1.8 Known limitations

- Magnitude types differ (Mww, mb, ML, Md…) — values are not strictly comparable across types.
- `tsunami=1` "does not indicate if a tsunami actually did or will exist" — only that the event is large/oceanic. GeoNerva must say exactly that and link to official tsunami warning centres.
- PAGER `alert` is null for most M<5.5 events (23 of 25 in a live sample).

---

## 2. GDACS — Global Disaster Alert and Coordination System (EC JRC + UN OCHA)

**Purpose:** impact-based alert levels for large events; the only v1 source for floods, cyclones and volcanoes; a cross-reference for earthquakes.

### 2.1 Interfaces

| Interface | URL | Use |
|---|---|---|
| RSS (refreshed every 6 min) | `https://www.gdacs.org/xml/rss.xml`, `rss_24h.xml`, `rss_7d.xml`, per-hazard variants | Change detection trigger (cheap, has `datemodified`, `episodeid`) |
| Event list | `/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=green;orange;red&fromDate&toDate&pageSize&pageNumber` | Backfill / reconcile; **max 100 per page** |
| Event list (incremental) | `/gdacsapi/api/events/geteventlist/latest?datemodified=…` | Incremental sync candidate — **UNVERIFIED, test in Phase 0** |
| Event data | `/gdacsapi/api/events/geteventdata?eventtype=&eventid=` | Required for EQ `sourceid` (empty in list/RSS) |
| Episode data | `/gdacsapi/api/events/getepisodedata?eventtype=&eventid=&episodeid=` | Episode versions |
| Geometry | `/gdacsapi/api/polygons/getgeometry?eventtype=&eventid=&episodeid=` | Flood areas, cyclone tracks/buffers/cones, wildfire area |
| Swagger | `https://www.gdacs.org/gdacsapi/swagger/v1/swagger.json` | Contract tests pin against this |

- No auth. **No documented rate limits, SLA, versioning or deprecation policy.** It's an internal ASP.NET API exposed through Swagger.
- Observed today: one timeout and one **unexpected HTTP 204** (EQ search without `alertlevel`). Adapter must treat 204 as "empty but suspicious" → health DEGRADED, not "no events".
- Dates (`fromdate`, `todate`, `datemodified`) have **no timezone suffix** → parse as UTC explicitly.

### 2.2 Alert semantics — impact estimates, not hazard intensity

| Hazard | Model | Level meaning |
|---|---|---|
| EQ | ShakeMap model (population at MMI ≥ VII × vulnerability × INFORM coping capacity); fallback "EQ parameters" model (Mw, depth, population within 20–100 km) usually for M < 5.5 | Green 0–1, Orange 1–2, Red ≥ 2. Green with score 0 when max MMI ≤ VI |
| TC | Saffir-Simpson category × exposed population × vulnerability; wind only (surge computed, not scored) | Red > 3 days ahead **capped at Orange** |
| WF | GWIS NRT burnt area (from MODIS/VIIRS) ≥ 5,000 ha | Green automatic; Orange/Red **expert-assigned** |
| FL | Documented method (deaths/displacement thresholds) is **outdated**; live events are `source: GLOFAS`, severity 0, all Green | Treat as "GDACS flood event", do not explain via the old method |

- EQ/TC notifications are "automatic … not reviewed by human experts".
- `alertscore` vs `episodealertscore` are **inconsistent between RSS and API** → GeoNerva stores both verbatim but **derives nothing from scores**; only the level string (`Green|Orange|Red`) is used.
- GDACS levels are **never** mapped onto USGS PAGER colours (PAGER has Yellow; different model).

### 2.3 Episodes

`eventid` is stable; `episodeid` increments per update. Store `alertlevel` (event overall) and `episodealertlevel` (this update) separately, plus `iscurrent`, `istemporary`, `fromdate`, `todate`, `datemodified`, `severitydata`. Each episode is a new observation version.

### 2.4 Earthquakes vs USGS — not independent

- 99/100 recent GDACS EQs had `source: NEIC`; 1 `PRICO RS`.
- `geteventdata.properties.sourceid` = the USGS event ID (e.g. `us7000tikb`). All 25 sampled resolved against USGS — one only via the USGS **`ids` alias list**, not the current `id`.
- Values identical to USGS at copy time (0.0 km, same magnitude, time truncated to whole seconds).
- Minimum magnitude observed: exactly **M4.5**. GDACS `datemodified` lags the event by hours.

**Design consequence:** GDACS EQ ↔ USGS matching is an **identity match on `sourceid` ∈ USGS alias set**, not a fuzzy match, and GDACS EQ is a **derived** observation. Agreement between them is not independent confirmation (see `ARCHITECTURE.md` §6).

### 2.5 Floods

`getgeometry` returns a centroid plus `Poly_Affected` ("Affected area", MultiPolygon) and `Poly_Global` (much larger), with `polygondate`. Their derivation is **undocumented** and they look like modelled/impact areas (GloFAS), **not observed inundation extents**. Copernicus GFM observed flood extent is exposed only as WMS (not ingestible as vectors).

**Design consequence:** UI language is "within the GDACS flood-event area (modelled)", never "flooded". Events with centroid-only geometry are handled explicitly.

### 2.6 Tropical cyclones & wildfires

- TC sources: NOAA, JTWC. Geometry: advisory positions, track LineStrings (observed vs forecast flagged), wind buffers `Poly_Green` (60 km/h), `Poly_Orange` (90 km/h), `Poly_Red` (120 km/h) per forecast time and cumulative, `Poly_Cones` (uncertainty cone). Cadence follows advisories (~6 h).
- WF: GWIS via JRC, daily; `Poly_area` affected area + centroid. Homepage only shows fires > 10,000 ha with > 10,000 people within 5 km; smaller ones via search.

### 2.7 Terms & licence

- Terms: https://www.gdacs.org/About/termofuse.aspx — "as is", "should not be used for decision making without prior confirmation", "no guarantee … completeness or timeliness", "subject to unspecified downtime", "changes … without prior notice", not a substitute for national authorities.
- Licence is inconsistent: RSS says `public domain`; per-event resources say **"European Union (CC BY 4.0), reuse allowed with appropriate credit to GDACS"**. GeoNerva adopts the stricter reading: **CC BY 4.0, attribute "GDACS, European Union"**, and shows the GDACS disclaimer on event detail and methodology pages.

---

## 3. NASA FIRMS — Fire Information for Resource Management System

**Purpose:** satellite **thermal detections** ("active fire / thermal anomaly" pixels). Not confirmed wildfires.

### 3.1 Interfaces (API v4.1.16)

| Interface | URL | Use |
|---|---|---|
| Area API | `/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north \| world}/{DAY_RANGE}[/{YYYY-MM-DD}]` | Primary: `world`, `DAY_RANGE=2` every 30 min per active sensor |
| Data availability | `/api/data_availability/csv/{MAP_KEY}/{SENSOR\|ALL}` | Sensor capability discovery at worker start |
| Missing data | `/api/missing_data/...` | Distinguish "no detections" from "no satellite data" |
| MAP_KEY status | `/mapserver/mapkey_status/?MAP_KEY=` | Health check (response schema **UNVERIFIED**) |
| Keyless 24 h CSVs | `https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv` (J2 = NOAA-21) | **Zero-config dev mode** and fallback when the key is exhausted |
| Country API | — | **Currently unavailable** ("Feature currently not available") — do not use |

- `DAY_RANGE` is **1–5** (not 1–10). Output is **CSV only**.
- MAP_KEY limit: **5,000 transactions / 10 min**. Weight (from the page's own `computeWeight` JS): `ceil(ceil(ΔLon/60)·ceil(ΔLat/60)·(VIIRS?2:0.5)·dayRange)`. `world` VIIRS 1-day = 36; 2-day = 72. Two sensors every 30 min ≈ 144 per poll — ~3 % of budget.

### 3.2 Sensors — model as data, with lifecycle

| SOURCE | Satellite / instrument | Resolution | Confidence scale | Status (2026-09-19) | v1 |
|---|---|---|---|---|---|
| `VIIRS_NOAA20_NRT` | NOAA-20 / VIIRS | 375 m | categorical low/nominal/high | active | **ingest** |
| `VIIRS_NOAA21_NRT` | NOAA-21 / VIIRS | 375 m | categorical | active | **ingest** |
| `VIIRS_SNPP_NRT` | Suomi-NPP / VIIRS | 375 m | categorical | **all product delivery ceases 2026-11-01 13:00 UTC** (NESDIS/NASA; "subject to change") | **do not ingest** |
| `MODIS_NRT` | Terra, Aqua / MODIS | 1 km | numeric 0–100 | platforms drifting; shut-down "late 2026 / early 2027" | **do not ingest** |
| `LANDSAT_NRT` | Landsat | 30 m | — | US/Canada only | P1 candidate |
| `*_SP` | standard processing | — | — | 2–3 month lag; NOAA-20 SP availability contradictory, no NOAA-21 SP | not ingested (P2 historical) |

Sensors live in the `sensors` table with `active_from`, `active_to`, `status`, `resolution_m`, `confidence_scale`, `latency_class`. Adding/removing a sensor is a data change, not a code change.

### 3.3 Latency (drives freshness policy)

- URT ≈ 5 min, RT ≈ 30 min — **CONUS, southern Canada, northern Mexico only**; NRT "within 3 hours of satellite observation" globally; SP 2–3 months.
- Live global/US/Canada 24 h files contained **only `2.0NRT`** rows. Whether the API returns URT/RT is **UNVERIFIED**.
- Polar orbiters pass a given point only a few times per day → physical fire start to first detection is often 3–12 h.

**Design consequence:** the brief's "FIRMS expected < 30 min" is wrong. GeoNerva uses two thresholds: *poll freshness* (last successful poll ≤ 90 min → FRESH) and *data currency* (newest detection `observed_at` ≤ 6 h → CURRENT; > 12 h → STALE). See `DOMAIN_MODEL.md` §SourceHealth.

### 3.4 Records

- VIIRS columns: `latitude, longitude, bright_ti4, scan, track, acq_date, acq_time (HHMM UTC), satellite (N|N20|N21), confidence (low|nominal|high), version (e.g. 2.0NRT), bright_ti5, frp (MW), daynight`.
- A detection is "the center of a pixel flagged as containing one or more fires" — **not a perimeter, not a fire count**. Pixel grows off-nadir (`scan`, `track`).
- **No stable detection ID.** Idempotency key: `(sensor_id, acquired_at, round(lat,4), round(lon,4))`.
- **No `type` field in NRT** (vegetation / volcano / static industrial / offshore is only in MODIS SP). Gas flares, volcanoes, industrial roofs appear as detections. GeoNerva builds its own persistent-source flag (P1).
- NRT rows are later superseded by SP rows with different values — SP would be a separate stream, never an in-place update.

### 3.5 Volume

Live global 24 h: NOAA-20 ≈ 115k rows (9.6 MB), NOAA-21 ≈ 113k, SNPP ≈ 109k, MODIS ≈ 21k. With only NOAA-20/21: **≈ 230k detections/day**, ≈ 40–50 MB/day in Postgres with indexes. This single fact drives the retention design (`ARCHITECTURE.md` §12).

### 3.6 Licence & attribution

NASA open data, "as is". Required acknowledgement:

> We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA's Earth Science Data and Information System (ESDIS).

Redistribution must follow the Earthdata data-use policy and replicate/link the disclaimer.

---

## 4. Environment and Climate Change Canada — MSC weather alerts

**Purpose:** official Canadian weather alerts. Demonstrates that GeoNerva represents coverage gaps honestly.

### 4.1 Channels

| Channel | URL | Polling allowed? | Lineage | v1 |
|---|---|---|---|---|
| **MSC GeoMet OGC API** | `https://api.weather.gc.ca/collections/weather-alerts/items?f=json` | yes (≤ ~1 req/s overall) | per-region features, **no CAP identifier/references** | **P1 (first)** |
| Datamart CAP | `https://dd.weather.gc.ca/today/alerts/cap/{YYYYMMDD}/{OFFICE}/{hh}/…cap` | **No** — policy: "Do not request directory listings to assess the availability of new data, the AMQPS notification service must be used" | full CAP `references` chain | P1 via AMQPS |
| AMQPS (Sarracenia) | broker `dd.weather.gc.ca`, anonymous, subtopic `*.alerts.cap.#` | push | full | P1 (needs persistent worker) |
| NAAD (Pelmorex) | TCP stream | — | all Canadian alerting authorities | out of scope |

- GeoMet feature properties: `alert_code, alert_type (warning|watch|advisory|statement), alert_name_en/fr, alert_text_en/fr, publication_datetime, expiration_datetime, validity_datetime, event_end_datetime, risk_colour_en, confidence_en, impact_en, feature_id, feature_name_en/fr, province, status_en`. Geometry = **forecast-region polygon**.
- **Stable identity key for GeoMet features is UNVERIFIED** — Phase 0 must capture two consecutive polls of the same alert to determine it.
- Current CAP polygons are forecast regions; free-form "true threat area" polygons were planned for June 2026 and are **delayed**. When they ship, geometry semantics change → geometry kind is versioned in the observation.
- Datamart: date directories by UTC transmission date, 30-day retention.

### 4.2 Terms

- No auth. Usage policy: contact MSC above 86,400 requests/day.
- Licence: **ECCC Data Servers End-use Licence v2.1.1** (not OGL-Canada). Worldwide, royalty-free, commercial use allowed.
- Attribution: **"Data Source: Environment and Climate Change Canada"** + licence link.
- **Alert-specific clause: alerts "shall be reproduced in such a way that there is no alteration of the content or intent of the alert."** → GeoNerva shows alert text verbatim with attribution, and runtime AI is **forbidden** from paraphrasing ECCC alert content (it may only reference it).

### 4.3 Coverage statement (UI)

"Weather warnings: Canada (ECCC, weather alerts only). Other regions: not covered by GeoNerva yet." ECCC is not the only Canadian alerting authority (NAAD aggregates all) — the coverage statement says "ECCC weather alerts", not "all Canadian emergency alerts".

---

## 5. NWS — api.weather.gov (P1)

- `/alerts/active`, `Accept: application/geo+json`, **User-Agent with contact required**. No published rate limit.
- Live: 456 active alerts, **only ~18 % carry geometry**; the rest reference UGC/SAME zones → requires a cached zone-geometry table (~4k zones, count **UNVERIFIED**).
- Public domain. Same CAP model as ECCC; cheap second adapter once the weather-alert model exists.

## 6. EMSC — European-Mediterranean Seismological Centre (P0)

**Purpose:** an **independent** earthquake catalogue. GDACS earthquakes are copies of USGS/NEIC solutions, so without EMSC GeoNerva would have no genuine cross-source earthquake agreement to show. EMSC also closes most of the completeness gap in the brief's own flagship example.

### 6.1 Interfaces

| Interface | URL | Use |
|---|---|---|
| FDSN event (EMSC-RTS catalogue) | `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&updatedafter=…&limit=…` | Poll every 5 min with `updatedafter`; backfill |
| Realtime websocket | `wss://www.seismicportal.eu/standing_order/websocket` (`action` includes `delete`) | P1 (needs a persistent worker) |
| EventID conversion | `https://www.seismicportal.eu/eventid/api/convert?source_id=&source_catalog=&out_catalog=` | Optional corroborating evidence for correlation (P1). **Not** used as the match decision |

- `format=json` returns GeoJSON (an EMSC extension). **`format=geojson` returns HTTP 400.**
- Radius parameters are in **degrees**, not km.
- Per-request maximum is effectively **20,000** rows. No published rate limit; "it is not expected that the entire dataset be downloaded".
- Feature properties: `source_id, source_catalog, lastupdate, time, flynn_region, lat, lon, depth, evtype, auth, mag, magtype, unid`. The `unid` (e.g. `20260803_0000324`) is the stable key; `lastupdate` → `source_updated_at`; `auth` = contributing agency (e.g. IPMA).
- The event JSON contains **no USGS ID**. The EventID API matches by misfit (`dloc/105 + dt/13 + dmag/0.8`, defaults "tested for events with a magnitude above 4.5"). It is a fuzzy match computed by EMSC, so GeoNerva records it only as an extra correlation reason.

### 6.2 Coverage (live check, Marrakech, ~300 km, 12 months)

| Catalogue | Events | Magnitudes |
|---|---|---|
| USGS ComCat | 1 | M4.7 |
| EMSC | 10 | M2.4 – M4.7 (EMSC ×5, IPMA ×5; ml, mb, mw) |

The shared M4.7 (USGS `us6000thv7` = EMSC `20260803_0000324`) is a real cross-source match. This is one region and one sample; completeness elsewhere must be measured, not assumed (see `ARCHITECTURE.md` §8).

### 6.3 Licence & attribution

- Web-service data (FDSN, websocket, EventID): **CC BY 4.0**, commercial use allowed with attribution. Website *content* is "All rights reserved" and must not be scraped.
- Credit line: **"Credit: EMSC/CSEM, https://www.emsc-csem.org"**. Show the EMSC disclaimer (no warranty; consult authorities for critical decisions) on the methodology page.

## 7. Global aggregators (not in v1)

- WMO Alert Hub / SWIC CAP feeds: explicitly **demo**, terms unverified.
- MeteoAlarm (EUMETNET): OGC EDR API + Atom (legacy RSS retired 2026-01-14), CC BY 4.0; redistribution rules unverified. Candidate for Europe in P2.

---

## 8. Supporting services

### 8.1 Geocoding

| Provider | Autocomplete allowed | Cache/store | Display on MapLibre | Verdict |
|---|---|---|---|---|
| Nominatim (OSMF public) | **No** (explicitly forbidden) | must cache | yes | **P0 for submit + reverse only**, ≤ 1 req/s server-side, identifying UA, cache 30 d |
| Local GeoNames `cities15000` table | yes (our own data) | yes | yes | **P0 type-ahead**, zero external calls |
| Photon (komoot public) | yes | not addressed | yes | optional adapter; "extensive usage will be throttled or banned" |
| OpenCage free | autosuggest not free | permanent storage allowed | yes | free tier is testing-only; paid upgrade path |
| Mapbox / Google | yes | restricted | **No** (must display on their maps) | **excluded** |

Coordinates typed by the user (`31.63, -8.0`, DMS) are parsed locally — no provider call. Postal codes are "where supported" = where Nominatim resolves them.

Timezone: `geo-tz` (MIT code, ODbL data) server-side, computed once per resolved place and stored.

### 8.2 Basemap

- **Primary: OpenFreeMap** "dark" or "fiord" style — no key, no request limits, commercial use allowed, **no SLA**, may be discontinued without notice. Attribution: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors.
- **Fallback (P1): self-hosted Protomaps PMTiles** (dark flavor, reduced max zoom) on object storage; style switch on tile error.
- Excluded for the public demo: MapTiler, Stadia, Protomaps-hosted, CARTO free tiers (non-commercial or key-gated).
- MapLibre GL JS **v6** (6.10.0, 2026-09-15): BSD-3, **ESM-only, WebGL2 required**. React wrapper `@vis.gl/react-maplibre` 8.1.x — v6 compatibility must be confirmed in Phase 1; fallback is a thin in-house wrapper.

### 8.3 Runtime AI (P1)

Anthropic Messages API with structured outputs (`output_config.format` JSON schema). Model configurable; default `claude-opus-5`. See `ARCHITECTURE.md` §11.

---

## 9. Attribution block (rendered in footer + /methodology)

```
Earthquakes: U.S. Geological Survey (public domain), ANSS ComCat doi:10.5066/F7MS3QZH
Earthquakes: Credit: EMSC/CSEM, https://www.emsc-csem.org (CC BY 4.0)
Disaster alerts: GDACS, European Union (CC BY 4.0) — see GDACS disclaimer
Thermal detections: NASA FIRMS (LANCE / ESDIS) — acknowledgement text
Weather alerts: Data Source: Environment and Climate Change Canada (ECCC licence)
Place search: © OpenStreetMap contributors (ODbL) via Nominatim; GeoNames (CC BY 4.0)
Basemap: OpenFreeMap © OpenMapTiles © OpenStreetMap contributors
```

## 10. Open verification items for Phase 0

| # | Item | Blocks |
|---|---|---|
| V1 | GeoMet `weather-alerts` stable feature identity across polls | ECCC adapter |
| V2 | GDACS `geteventlist/latest?datemodified=` behaviour | GDACS incremental sync |
| V3 | FIRMS `mapkey_status` response schema; `data_availability` ranges for NOAA-20/21 NRT | FIRMS health, backfill |
| V4 | Whether FIRMS `*_NRT` API ever returns URT/RT rows | FIRMS versioning |
| V5 | GeoNames licence and `cities15000` row count | search |
| V6 | EMSC fair-use expectations (no published limit) — contact EMSC if polling every 5 min is a concern; `updatedafter` semantics for deletions | EMSC adapter |
| V9 | USGS ComCat production association thresholds (PDL `DefaultAssociator` code defaults are ±16 s / 100 km; production config unverified) | correlation calibration |
| V7 | `@vis.gl/react-maplibre` compatibility with MapLibre v6 | frontend |
| V8 | Supabase PostGIS version on the chosen project | db |
