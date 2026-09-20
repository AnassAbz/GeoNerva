# GeoNerva — Data Sources

> Status: **architecture phase, verified 2026-09-19; P0 fixture capture and verification completed 2026-09-19** (see §10 for V1–V9 resolutions and §11 for demo-place coverage). Every fact below was checked against official documentation and/or live responses on that date. Statements changed by P0 are marked **[P0 2026-09-19]**. Fixtures and their manifests live in `packages/test-fixtures/sources/<source>/`; capture scripts in `scripts/capture-fixtures/`.
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
| GeoNames cities (local table) | Type-ahead suggestions (offline) | — | Global | none | static import | — | CC BY 4.0 (verified [P0 2026-09-19], V5) | **P0** |
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
- FDSN query hard limit: **20,000 rows → HTTP 400 if exceeded** (`text/plain`, "101872 matching events exceeds search limit of 20000"). Backfill must call `count` then split time ranges recursively. **[P0 2026-09-19]** `count?format=geojson` answers **HTTP 200** with `{"count","maxAllowed","error"}` when over the limit; one open-ended query (from 2000-01-01, no magnitude filter) returned **HTTP 503** "table is full" instead of 400 — the adapter treats 400 *and* 503-on-large-query as "split the range".
- FDSN `includesuperseded` only works with `eventid`. `includedeleted` only in csv/geojson; a deleted event queried by `eventid` returns **409** (confirmed [P0 2026-09-19], fixture `usgs/fdsn-eventid-deleted-409.txt`). Deleted features in `includedeleted=only` have `status:"deleted"`, `types:null`, often `place:null`, but keep `mag`/geometry.
- **[P0 2026-09-19]** Querying FDSN by a *secondary* id returns the event under its current preferred id (e.g. `eventid=us7000tiar` → `id: pr2026261000`). `mag:null` exists in real data (e.g. `sonic boom` events) but was absent from `all_month`; negative depths (above sea level) are common (308 of 10,823 in `all_month`).
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

**[P4 2026-09-20] Most deleted events carry no identity.** Re-reading the P0 capture
(`fdsn-includedeleted-only.geojson`, 98 deletions over a 7-day window): **55 of 98 have an empty
feature `id` and `null` for `ids`, `net`, `code`, `place` and `types`.** USGS purges an event's
metadata when it deletes it, leaving `time`, `mag` and geometry. Only **43** still carry an alias
set. Consequences, all of them load-bearing:

- The alias-based identity model cannot resolve the stripped 55. GeoNerva **counts them and
  reports the count**; it does not skip them silently and it does not guess which record they were.
- A deletion sweep is therefore **~56 % unidentifiable in normal operation**, so the ordinary 20 %
  reject threshold must not be applied to it — doing so would fail every sweep as schema drift.
- Drift for a sweep is a different signal: a non-empty sweep in which **nothing** is identifiable
  means GeoNerva is blind to deletions, and that does fail.
- The live schema's `id: min(1)` and non-null `ids` are correct for the feed and wrong for this
  endpoint, which is why the sweep uses its own deletion-tolerant shape.

A record whose deletion is only ever visible as a stripped entry will therefore keep its last
live version and never be tombstoned. That is a known, documented gap rather than a silent one; a
tombstone requires the 409-on-`eventid` path or a future websocket feed to identify it.

### 1.5 Completeness — scientifically critical

- NEIC's goal: ~M4.5 global completeness, ~M3.0 US completeness.
- USGS FAQ: the lists "should NOT be considered complete … especially … of all magnitude 4.5 and greater events around the globe"; "might not display earthquakes smaller than 5.0 outside the U.S."; many regional networks do not share data with NEIC.
- Global location uncertainty can be "10s of kilometers in many parts of the world".
- **Live check (Marrakech, 300 km, past 365 d): 1 event.** 100 km around the 2023 Al Haouz M6.8 epicentre, Sep–Dec 2023: only 8 events.
- **[P0 2026-09-19]** Over **5 years** (2021-09-19 → 2026-09-19) USGS has **9** events within 150 km of Marrakech at M ≥ 2.5 (4 at M ≥ 4.5) while EMSC has **187** (6 at M ≥ 4.5) — a 20× difference in the same window (§11).

**Design consequence:** the brief's Marrakech example ("4 earthquakes within 180 km in 48 h, largest M3.4") is not producible from USGS data. Baselines must use a location-dependent magnitude of completeness (Mc), multi-year windows, and a visible completeness caveat. See `ARCHITECTURE.md` §8.

### 1.6 History

ComCat reaches back to 1900; modern global M4.5 completeness is only stable from roughly the mid-1990s (research consensus, not an official USGS statement). GeoNerva backfills **global M≥4.5 from 2016-01-01** (79,929 events, measured via the FDSN `count` endpoint on 2026-09-20) plus **all magnitudes for the most recent 30 days** (11,015).

> **Narrowed from 2000-01-01 by ADR-034 [P4 2026-09-20].** The original scope is 187,173 events, and at the measured 1,865 B/event that is 333 MB of a 500 MB lean budget for a single source. The window was narrowed rather than the magnitude floor raised, because the M4.5–5.0 band is where a location's baseline lives in moderately active regions. The `standard` profile keeps 2000 → now.

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
| Event list (incremental) | `/gdacsapi/api/events/geteventlist/latest?datemodified=…` | **Not used [P0 2026-09-19]** — works only with explicit `eventlist`+`alertlevel`, is ordered by `todate` not `datemodified`, and its paging overlaps (see V2) |
| Event data | `/gdacsapi/api/events/geteventdata?eventtype=&eventid=` | Required for EQ `sourceid` (empty in list/RSS) |
| Episode data | `/gdacsapi/api/events/getepisodedata?eventtype=&eventid=&episodeid=` | Episode versions |
| Geometry | `/gdacsapi/api/polygons/getgeometry?eventtype=&eventid=&episodeid=` | Flood areas, cyclone tracks/buffers/cones, wildfire area |
| Swagger | `https://www.gdacs.org/gdacsapi/swagger/v1/swagger.json` | Contract tests pin against this |

- No auth. **No documented rate limits, SLA, versioning or deprecation policy.** It's an internal ASP.NET API exposed through Swagger.
- Observed today: one timeout and one **unexpected HTTP 204** (EQ search without `alertlevel`). Adapter must treat 204 as "empty but suspicious" → health DEGRADED, not "no events".
- Dates (`fromdate`, `todate`, `datemodified`) have **no timezone suffix** → parse as UTC explicitly.
- **[P0 2026-09-19] Paging is unreliable.** Page 1 and page 2 of the same `SEARCH` query shared 67 of 100 events (WF, many identical `todate`s); `latest` pages shared 78 of 100. The adapter must (a) choose date windows small enough that each returns < 100 events and split recursively otherwise, (b) never rely on `pageNumber` > 1 for completeness, (c) dedupe by `(eventtype, eventid)`.
- **[P0 2026-09-19]** The HTTP 204 is reproducible: `SEARCH?eventlist=EQ` **without** `alertlevel` → 204 (fixture). Always send `alertlevel=green;orange;red`. `country=` is a case-insensitive substring match on the country text (e.g. "Japan" matches "Southeast Of Honshu, Japan"); ISO3 codes return 204. `eventsbyarea` (WKT) caps `days` at 30.
- **[P0 2026-09-19]** `datemodified` is bumped in bulk by GDACS jobs (dozens of old events, e.g. a 2026-09-04 volcano, all re-stamped within the same minute) — it is not a content-change signal. Change detection = content hash of the normalized episode.

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

**[P0 2026-09-19]** `getepisodedata` for historical episodes returns the *event's current* `datemodified`, `severitydata` and overall `alertlevel`; only `episodeid`/`episodealertlevel`/`episodealertscore` differ (SAUDEL-26 episodes 20 → 21: Green → Orange, fixtures `getepisodedata-tc-ep20/21.json`). Historical episode content therefore cannot be reconstructed from the API — GeoNerva only versions episodes it observed live. EQ `episodeid`s are global counters (e.g. 1734905), TC/FL/WF episode ids are per-event counters.

### 2.4 Earthquakes vs USGS — not independent

- 99/100 recent GDACS EQs had `source: NEIC`; 1 `PRICO RS`.
- `geteventdata.properties.sourceid` = the USGS event ID (e.g. `us7000tikb`). All 25 sampled resolved against USGS — one only via the USGS **`ids` alias list**, not the current `id`.
- **[P0 2026-09-19]** A second sample of 70 GDACS EQs (2026-09-05…19) resolved 70/70 against the *current* USGS id. `sourceid` follows the USGS preferred id including regional networks: `PRICO RS` → `pr2026261000`, `ALASKA EC` → `aka2026rcluqc`, `NCAL SS` → `nc75426637`. The alias-only case is therefore rare but real; its fixture (`gdacs/geteventdata-eq-alias-only.json`) is synthetic, derived from a real record.
- Values identical to USGS at copy time (0.0 km, same magnitude, time truncated to whole seconds).
- Minimum magnitude observed: exactly **M4.5**. GDACS `datemodified` lags the event by hours.

**Design consequence:** GDACS EQ ↔ USGS matching is an **identity match on `sourceid` ∈ USGS alias set**, not a fuzzy match, and GDACS EQ is a **derived** observation. Agreement between them is not independent confirmation (see `ARCHITECTURE.md` §6).

### 2.5 Floods

`getgeometry` returns a centroid plus `Poly_Affected` ("Affected area", MultiPolygon) and `Poly_Global` (much larger), with `polygondate`. Their derivation is **undocumented** and they look like modelled/impact areas (GloFAS), **not observed inundation extents**. Copernicus GFM observed flood extent is exposed only as WMS (not ingestible as vectors).

**Design consequence:** UI language is "within the GDACS flood-event area (modelled)", never "flooded". Events with centroid-only geometry are handled explicitly.

**[P0 2026-09-19]** All 16 live flood events inspected had `Point_Centroid` + `Poly_Affected` + `Poly_Global` (Polygon *or* MultiPolygon). Sizes vary from 9 KB to 1.8 MB per `getgeometry` call (US flood episode 91) — the adapter must cap/simplify geometry. The centroid-only fixture is synthetic. Other observed geometry classes: WF `Poly_area` ("Affected Area"); VO `Poly_Circle` (30 km) + ash `Poly_Cones_{0,6,12,18}` (OBS/FCST); TC `Point_Polygon_Point_N` (advisory positions as small polygons), `Poly_{Green,Orange,Red}` per forecast time *and* cumulative (label "60 km/h"/"90 km/h"/"120 km/h"), `Line_Line_N` labelled TD/TS/HU, `Poly_Cones`.

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
| MAP_KEY status | `/mapserver/mapkey_status/?MAP_KEY=` | Health check. **[P0]** Invalid key → HTTP 403 `text/html` one-liner "MAP_KEY is invalid or your have exceeded your transaction/time limit…" (same text for both causes). Success schema still unobserved (no key) — see V3 |
| Keyless 24 h CSVs | `https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv` (J2 = NOAA-21) | **Zero-config dev mode** and fallback when the key is exhausted |
| Country API | — | **Currently unavailable** ("Feature currently not available") — do not use |

- `DAY_RANGE` is **1–5** (not 1–10). Output is **CSV only**.
- **[P0 2026-09-19] Invalid-key responses differ per endpoint** (fixtures in `firms/`): Area API → HTTP **400** `text/plain` `Invalid MAP_KEY.`; `data_availability` → HTTP **401** `text/plain` `Invalid MAP_KEY.`; `mapkey_status` → HTTP **403** `text/html`. A MAP_KEY is 32 lowercase alphanumerics (the site's own validator). `/api/missing_data/` is an HTML page whose table is loaded keylessly from `/api/missing_data/?action=fetch_data` (JSON `{success, html, rowCount}`, `html` = `<tr>` rows of date + satellite for SP and NRT; 163 rows on 2026-09-19, all Suomi NPP) — undocumented, parse defensively.
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
- Live global/US/Canada 24 h files contained **only `2.0NRT`** rows. **[P0 2026-09-19]** Re-checked: NOAA-20 global 128,046 rows, NOAA-21 global 119,443 rows and NOAA-20 CONUS+Hawaii 2,167 rows — 100 % `2.0NRT`. Whether the MAP_KEY Area API returns URT/RT rows remains unobservable without a key (V4): the adapter stores `version` verbatim and must accept unknown suffixes.
- **[P0 2026-09-19]** The keyless "24h" files are not a strict 24 h window: the file modified 2026-09-19 20:40 UTC contained acquisitions from 2026-09-18 00:01 to 2026-09-19 18:34 UTC (≈ 42 h, two `acq_date`s), with the newest detection ≈ 2 h before the file time. Keyless 7 d files are ≈ 49 MB (NOAA-20) and ≈ 48 MB (NOAA-21).
- Polar orbiters pass a given point only a few times per day → physical fire start to first detection is often 3–12 h.

**Design consequence:** the brief's "FIRMS expected < 30 min" is wrong. GeoNerva uses two thresholds: *poll freshness* (last successful poll ≤ 90 min → FRESH) and *data currency* (newest detection `observed_at` ≤ 6 h → CURRENT; > 12 h → STALE). See `DOMAIN_MODEL.md` §SourceHealth.

### 3.4 Records

- VIIRS columns: `latitude, longitude, bright_ti4, scan, track, acq_date, acq_time (HHMM UTC), satellite (N|N20|N21), confidence (low|nominal|high), version (e.g. 2.0NRT), bright_ti5, frp (MW), daynight`.
- A detection is "the center of a pixel flagged as containing one or more fires" — **not a perimeter, not a fire count**. Pixel grows off-nadir (`scan`, `track`).
- **No stable detection ID.** Idempotency key: `(sensor_id, acquired_at, round(lat,4), round(lon,4))`.
- **No `type` field in NRT** (vegetation / volcano / static industrial / offshore is only in MODIS SP). Gas flares, volcanoes, industrial roofs appear as detections. GeoNerva builds its own persistent-source flag (P1).
- NRT rows are later superseded by SP rows with different values — SP would be a separate stream, never an in-place update.

### 3.5 Volume

Live global 24 h: NOAA-20 ≈ 115k rows (9.6 MB), NOAA-21 ≈ 113k, SNPP ≈ 109k, MODIS ≈ 21k. (**[P0 2026-09-19]** second sample: NOAA-20 128k rows / 10.7 MB, NOAA-21 119k / 10.0 MB — but these files span ≈ 42 h, see §3.3, so per-day volume is lower than the row count suggests.) With only NOAA-20/21: **≈ 230k detections/day**, ≈ 40–50 MB/day in Postgres with indexes. This single fact drives the retention design (`ARCHITECTURE.md` §12).

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
- **[P0 2026-09-19] Identity resolved (V1): the feature `id` is the stable key.** Three polls (20:51, 20:54, 21:43 UTC, 65 features each, fixtures `eccc/weather-alerts-{a,b,c}.json` + `identity-analysis-*.json`):
  - `id` has the shape `<alert-thread digits><YYYYMMDDhhmm>_<feature_id>`, e.g. `123156145655712029202609180517_fea1-3598`; the part after `_` is exactly `properties.feature_id` (all 65 features).
  - all 65 `id`s were unchanged across 52 minutes; one feature kept its `id` while `publication_datetime`, `expiration_datetime`, `validity_datetime`, `alert_text_en` and `alert_text_fr` changed → **same record, new version**.
  - `properties.feature_id` alone is **not** unique within a poll (region `fea1-876` appeared twice: an ended wind warning and a continued frost advisory), so the key is `id`, not `feature_id`.
  - the thread prefix is shared by all regions of one alert message and survives status changes (`issued` → `continued` → `ended` observed under one prefix), so `(thread prefix, feature_id)` = one GeoNerva SourceRecord, `publication_datetime` = `source_updated_at`, `status_en` ∈ {issued, continued, ended} is part of the version.
  - **Caveat:** no *new* alert appeared during the observation window, so the behaviour when a region's alert ends and a new one is issued (expected: new thread prefix → new record) is inferred, not observed. Alerts that disappear from the collection are handled as "no longer active", not deletions.
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
- **[P0 2026-09-19]** `geometry.coordinates[2]` is **negative depth** (e.g. `-267.0` for `properties.depth: 267`) — use `properties.depth`. Responses are pretty-printed. `eventid=<unid>` returns a **single Feature**, not a FeatureCollection. Empty results → **HTTP 204** with empty body (default `nodata=204`). `updatedafter` returns old events revised recently (e.g. a 2025-09-13 event with `lastupdate` 2026-09-19) — ordering is not by `lastupdate`. The FDSN documentation exposes **no deleted-event query** (no `includedeleted`); deletions are only visible on the websocket (`action: delete`), see V6.
- **[P0 2026-09-19]** EventID service: `out_catalog=UNID` returns the EMSC `unid` directly (`out_catalog=EMSC` returns the EMSC-RTS `source_id`, e.g. `2037122`, not the unid; `out_catalog=all` lists INGV, GFZ, USGS … ids with misfits). No match → **HTTP 404** JSON `{"detail": "... failed : no data"}`. Querying with a USGS *secondary* id (`us7000tiar`) returns the same match as the preferred id (`pr2026261000`).
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
- MapLibre GL JS **v6** (6.10.0, 2026-09-15): BSD-3, **ESM-only, WebGL2 required**. React wrapper `@vis.gl/react-maplibre` 8.1.x — **[P0 2026-09-19] v6 compatible from 8.1.2** (V7): v6 broke ≤ 8.1.1 (issue visgl/react-map-gl#2597: `map.transform` removed → runtime `TypeError … reading 'center'`, `transformCameraUpdate` became `setTransformCameraUpdate()`); fixed by PR #2598 (merged 2026-07-29, published as 8.1.2 the same day; 8.1.3 = latest, 2026-09-02). Pin `@vis.gl/react-maplibre@^8.1.3`. The peer range is `maplibre-gl >=4.0.0`, so npm will *not* warn about an older wrapper — the minimum version must be pinned explicitly. Fallback remains a thin in-house wrapper.

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

## 10. Verification items (P0, closed 2026-09-19)

| # | Item | Blocks | Resolution | Evidence |
|---|---|---|---|---|
| V1 | GeoMet `weather-alerts` stable feature identity across polls | ECCC adapter | **RESOLVED.** Key = feature `id` (`<alert-thread><YYYYMMDDhhmm>_<feature_id>`); stable across 52 min while alert text and timestamps changed; `feature_id` alone is not unique. `publication_datetime` = `source_updated_at`. Behaviour at alert end → re-issue is inferred, not observed | §4.1; `eccc/weather-alerts-{a,b,c}.json`, `eccc/identity-analysis-a-b.json`, `identity-analysis-a-c.json` |
| V2 | GDACS `geteventlist/latest?datemodified=` behaviour | GDACS incremental sync | **RESOLVED — do not use for incremental sync.** It needs explicit `eventlist`+`alertlevel` (otherwise only a handful of non-Green events), is ordered by `todate desc` (not `datemodified`), caps at 100 per page, and **paging overlaps** (page 1 ∩ page 2 = 78/100; the same defect exists in `SEARCH`, 67/100). Also `datemodified` is bulk-bumped, so it is not a change signal. **Decision:** poll RSS (`rss_24h.xml`) as the cheap trigger + `SEARCH` over date windows narrow enough to return < 100 events, split recursively, dedupe by `(eventtype,eventid)`, and detect change by content hash | §2.1; `gdacs/geteventlist-latest-{no-alertlevel,p1,p2}.json`, `geteventlist-search-eq*.json`, `swagger.json` |
| V3 | FIRMS `mapkey_status` response schema; `data_availability` ranges for NOAA-20/21 NRT | FIRMS health, backfill | **PARTIALLY RESOLVED (no MAP_KEY exists in P0).** Observable: invalid key → Area API 400 `text/plain "Invalid MAP_KEY."`, `data_availability` 401 same body, `mapkey_status` 403 `text/html` one-liner that **cannot distinguish "invalid" from "quota exceeded"**. Success schemas remain unobserved → the health check must treat 403 as DEGRADED-unknown and fall back to the keyless CSVs. Keyless `/api/missing_data/?action=fetch_data` gives the missing-data table without a key. **Deferred to the first phase that has a MAP_KEY (P4c).** | §3.1; `firms/area-invalid-mapkey.txt`, `data-availability-invalid-mapkey.txt`, `mapkey-status-invalid.html`, `missing-data.json` |
| V4 | Whether FIRMS `*_NRT` API ever returns URT/RT rows | FIRMS versioning | **PARTIALLY RESOLVED.** 249,656 keyless rows (NOAA-20 global, NOAA-21 global, NOAA-20 CONUS+Hawaii) were **100 % `2.0NRT`**, including the US file where URT/RT would appear. Unverifiable for the keyed Area API. **Decision:** `version` is stored verbatim, unknown suffixes accepted, and `latency_class` is derived from it — no enum constraint | §3.3; `firms/stats-24h.json`, `j1-usa-24h-slice.csv` |
| V5 | GeoNames licence and `cities15000` row count | search | **RESOLVED.** `readme.txt`: "This work is licensed under a Creative Commons Attribution 4.0 License". `cities15000.zip` of 2026-09-19 (3.36 MB zip): **34,146 rows**, 19 tab-separated columns, 7.18 MB unpacked (the readme's "ca 25.000" is stale). Note: the primary name is "Marrakesh"; "Marrakech" only exists in `alternatenames`, so type-ahead must index alternate names | download.geonames.org readme + the file itself (not committed as a fixture: 3.4 MB, imported in P2) |
| V6 | EMSC fair-use expectations; `updatedafter` semantics for deletions | EMSC adapter | **RESOLVED (with a caveat).** No rate limit is published (the FDSN page states only "the maximum number of events per request has increased to 20000"); polling `updatedafter` every 5 min = 288 requests/day, far below any plausible limit — no prior contact needed, but the UA identifies GeoNerva and the health check backs off on 429/503. `updatedafter` returns re-revised old events (a 2025-09-13 event resurfaced on 2026-09-19) and is **not ordered by `lastupdate`**. There is **no deleted-event query**: deletions exist only as websocket `action:"delete"`. **Decision:** v1 (no websocket worker) reconciles by re-querying the last 7 days daily; a unid that disappears is tombstoned as `MISSING_FROM_SOURCE` after two consecutive reconciles | §6.1; `emsc/updatedafter-t0.json`, `eventid-late-update.json`, `websocket-frames.json` (14 frames in 25 min: create/update only — no delete observed; `websocket-delete-frame.json` is synthetic) |
| V7 | `@vis.gl/react-maplibre` compatibility with MapLibre v6 | frontend | **RESOLVED.** Broken ≤ 8.1.1, fixed in **8.1.2** (2026-07-29) by visgl/react-map-gl PR #2598 (issue #2597); 8.1.3 (2026-09-02) is latest. Verified without installing: the published 8.1.2/8.1.3 tarballs contain `setTransformCameraUpdate`/`getCenterElevation` handling and no `map.transform` access, 8.1.1 has the reverse. Peer range is `maplibre-gl >=4.0.0`, so pin `^8.1.3` explicitly | npm registry metadata + published tarball contents; GitHub PR #2598 / issue #2597 |
| V8 | Supabase PostGIS version on the chosen project | db | **RESOLVED.** `supabase/postgres` `nix/ext/versions.json`: PostGIS **3.3.7 for Postgres 17**, 3.3.2 for Postgres 15; `ansible/vars.yml` ships `postgres17: 17.6.1.173`, `postgres15: 15.14.1.173` (new projects = PG 17). **Consequence:** target **PostGIS 3.3** features only. No `postgis/postgis:17-3.3` Docker tag exists (published: 17-3.4, 17-3.5, 17-3.6-alpine…), so local dev must use `postgis/postgis:17-3.4` and CI must fail on functions introduced after 3.3 (checked by a migration lint + `postgis_full_version()` assertion against the live project once it exists) | supabase/postgres repo (develop) |
| V9 | USGS ComCat production association thresholds | correlation calibration | **PARTIALLY RESOLVED.** PDL javadoc constant values confirm `DefaultAssociator.TIME_DIFF_MILLISECONDS = 16000` (±16 s); the location constant is documented but its value is not published, and NEIC's **production** indexer config is not public. Empirical check on 9 multi-network ComCat events (2 or more contributed origins): max spread **11.0 s / 62.9 km** (median ≈ 4 s / 29 km). **Decision:** GeoNerva's own candidate window stays ±90 s / 150 km with a uniqueness gap, and cross-catalogue calibration uses `sources/correlation/eq-pairs.json` rather than assumed ComCat internals | usgs.github.io/pdl constant-values; measured by `scripts/capture-fixtures/check-comcat-association.mjs` (9 events, median 4.4 s / 29.9 km, max 11.0 s / 62.9 km on 2026-09-19) |

Deferred items after P0: V3 and V4 need a FIRMS MAP_KEY (P4c); V8's live assertion needs the Supabase project (P10); V1's alert-lifecycle edge case needs a longer observation (P1 ECCC adapter, first 24 h in dev).

## 11. Demo location coverage (P0)

Measured 2026-09-19 by `scripts/capture-fixtures/demo-coverage.mjs` (280 requests); raw output in `packages/test-fixtures/sources/coverage/demo-coverage.json`. Period for earthquakes and GDACS: **2021-09-19 → 2026-09-19 (5 years)**. Coordinates from GeoNames `cities15000`.

**Earthquakes — event counts (5 years).** USGS = FDSN `count` with `maxradiuskm`; EMSC = FDSN `count` with `maxradius` in degrees (150 km → 1.349°, 300 km → 2.698°, mean km/degree), so EMSC radii are circles on a sphere of mean radius — within ~0.5 % of the USGS radii.

| Place | USGS 150 km M≥2.5 | USGS 150 km M≥4.5 | USGS 300 km M≥2.5 | USGS 300 km M≥4.5 | EMSC 150 km M≥2.5 | EMSC 150 km M≥4.5 | EMSC 300 km M≥2.5 | EMSC 300 km M≥4.5 |
|---|---|---|---|---|---|---|---|---|
| Marrakech | 9 | 4 | 13 | 5 | **187** | 6 | 218 | 8 |
| Vancouver | 57 | 2 | 171 | 4 | 71 | 2 | 276 | 4 |
| Los Angeles | 723 | 5 | 1,832 | 15 | 741 | 5 | 1,885 | 16 |
| Tokyo | 414 | 172 | 1,076 | 471 | 669 | 189 | 1,850 | 484 |
| Reykjavík | 109 | 54 | 164 | 78 | **1,742** | 47 | 2,027 | 71 |

**Thermal detections and GDACS.** FIRMS = keyless NOAA-20 (J1) + NOAA-21 (J2) **Global 7 d** files fetched 2026-09-19 (49.5 MB / 593,019 rows and 48.0 MB / 575,730 rows, `acq_date` 2026-09-12…19), detections within 150 km. GDACS = `SEARCH` by country name over 5 years, de-duplicated, event point within 300 km.

| Place | FIRMS 7 d ≤150 km (N20 + N21) | GDACS ≤300 km, 5 y (by type) | GDACS levels |
|---|---|---|---|
| Marrakech | 13 (9 + 4) | 15 — EQ 6, FL 8, DR 1 | 14 Green, **1 Red** (Al Haouz M6.8, 2023) |
| Vancouver | 77 (44 + 33) | 56 — WF 41, FL 11, EQ 4 | 56 Green |
| Los Angeles | 193 (96 + 97) | 46 — EQ 17, WF 16, FL 13 | 43 Green, 3 Orange |
| Tokyo | 40 (19 + 21) | 473 — EQ 454, FL 11, TC 8 | 470 Green, 3 Orange |
| Reykjavík | 7 (5 + 2) | 71 — EQ 60, **VO 7**, FL 2, WF 2 | 71 Green |

Caveats: GDACS counts are lower bounds — the country filter is a substring match on the event's country text, so ocean events with no country text are missed, and 8 one-day windows for Canada returned a full page of 100 (wildfire season) and were not split further, so Vancouver's WF count is truncated. FIRMS counts are a single 7-day snapshot in the northern-hemisphere late-fire season and will differ by season.

**Recommendation: keep all five places (Q5 confirmed). No substitutions proposed.** Each one exercises a different part of the product:

| Place | Verdict | Why |
|---|---|---|
| Marrakech | **keep** | The flagship honesty case: USGS 9 vs EMSC 187 events in the same 150 km / 5 y window proves why a second earthquake source and a location-dependent Mc exist. Has one Red GDACS event (Al Haouz) for the high-relevance path, floods, and low but non-zero fire activity. |
| Vancouver | **keep** | Only **ECCC-covered** place (P1 weather alerts), moderate seismicity (57/5 y within 150 km), strong wildfire signal (41 GDACS WF events, 77 detections/7 d). |
| Los Angeles | **keep** | Densest USGS catalogue (723 events at M≥2.5) → best baseline/percentile behaviour; heavy FIRMS activity (193/7 d) including persistent industrial sources; NWS alerts in P1. |
| Tokyo | **keep** | Only place where M≥4.5 is routine (172 within 150 km), 454 GDACS earthquakes and 8 cyclones → cyclone geometry and EQ-agreement paths. |
| Reykjavík | **keep** | Volcano hazard (7 GDACS VO events) and swarm behaviour (EMSC 1,742 vs USGS 109 within 150 km — swarms are the extreme case for change detection), and a genuine near-zero fire baseline (7 detections/7 d) that exercises "no activity" vs "not covered". |

Two product notes from the §11 numbers: (1) at M≥2.5 the **EMSC/USGS ratio is 21× for Marrakech and 16× for Reykjavík but ≈ 1.0× for Los Angeles**, so per-source completeness must be stated per place, not globally; (2) Marrakech and Vancouver have < 5 events at M≥4.5 in 5 years, so M≥4.5 baselines there will hit the minimum-sample gate (`DOMAIN_MODEL.md` §4.13) and must render the "insufficient history" state rather than a percentile.

## 12. Fixture inventory (P0)

`packages/test-fixtures/sources/**` — 92 fixtures, **4.14 MiB** total (budget 6 MiB), each listed in its source's `MANIFEST.json` with URL (keys redacted), capture time, sha256, size, HTTP status, content type, notes, and `synthetic`/`derived_from`. `node scripts/capture-fixtures/verify-manifests.mjs` re-hashes everything, checks the manifest fields, parses JSON/CSV/XML/NDJSON, scans for secrets and enforces the size budget.

| Source | Fixtures (real / synthetic) | Size | Highlights |
|---|---|---|---|
| `usgs` | 19 (12 / 7) | 1,104 KiB | `all_day`; alias query (`us7000tiar` → `pr2026261000`); `includesuperseded` detail; `includedeleted=only`; deleted-by-id 409; `mag:null`; tsunami; PAGER; 20k 400 + `count`; **real revision pair** (2 events `automatic`→`reviewed` with magnitude changes); 7 drift fixtures |
| `emsc` | 18 (10 / 8) | 630 KiB | JSON page; `updatedafter` poll; Morocco event + 12-month Marrakech window; late-revision event; `format=geojson` 400; 204; **real revision pair** (2 unids, `lastupdate`/mag/location changed in 50 min); 14 websocket frames; synthetic delete frame; 7 drift fixtures |
| `gdacs` | 28 (18 / 10) | 1,140 KiB | RSS (trimmed per type); EQ data (NEIC + PRICO); FL with `Poly_Affected`+`Poly_Global`; TC geometry (tracks/buffers/cones) + event data; WF; VO; **episode pair Green→Orange**; 204; `latest` (V2, 3 variants); swagger; synthetic alias-only EQ, centroid-only flood, timeout descriptor, 7 drift fixtures |
| `firms` | 17 (9 / 8) | 241 KiB | NOAA-20/21 24 h slices; midnight-spanning slices; CONUS slice; invalid-key responses (400/401/403); keyless missing-data table; volume/version stats; 7 CSV drift fixtures incl. header-only (EMPTY_SUSPICIOUS) |
| `nominatim` | 3 (2 / 1) | 4.5 KiB | search result, empty result, synthetic 429 |
| `eccc` | 5 (3 / 2) | 881 KiB | three `weather-alerts` polls (2.5 min and 52 min apart) + two identity analyses (V1) |
| `correlation` | 1 | 228 KiB | `eq-pairs.json`: 250 labelled USGS↔EMSC pairs (186 MATCH / 64 NO_MATCH; 38 hand-checked; 4 flagged ambiguous) |
| `coverage` | 1 | 11 KiB | `demo-coverage.json` (§11) |
