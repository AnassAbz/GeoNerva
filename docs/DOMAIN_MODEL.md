# GeoNerva — Domain Model & Database Design

> Status: **proposed for architecture freeze** (2026-09-19). Changes after freeze require an ADR in `DECISIONS.md`.
>
> This document defines *what things are*, *how they change over time*, and *how they are stored*. Package boundaries and runtime flows are in `ARCHITECTURE.md`.

## 1. Modelling principles

1. **Append-only facts, derived views.** Everything GeoNerva learns from a provider is stored as an immutable version. "Current state" is a projection. This is what makes replay, auditing and "What Changed?" deterministic.
2. **Bitemporal by construction.** Every fact carries *when it happened in the world* and *when GeoNerva learned it*. Queries are always parameterised by an `as_of` knowledge time (default `now()`).
3. **Identity is separate from content.** A provider record has a stable GeoNerva identity; its content changes through versions. A canonical event is an identity that *links* provider records; its values are computed from the linked versions.
4. **Provider semantics are preserved, not translated.** GDACS `Orange` stays `Orange` with scheme `GDACS_ALERT`. It is never converted to a number or to another provider's scale.
5. **Derived ≠ observed.** Observed facts (provider values), GeoNerva derivations (distances, relevance, baselines, changes) and AI text are different types, never mixed in one field.

## 2. Time semantics (the most important section)

| Field | Meaning | Set by | Examples |
|---|---|---|---|
| `observed_at` | When the physical phenomenon occurred / was measured | provider | EQ origin time; FIRMS `acq_date+acq_time`; GDACS `fromdate`; alert `sent` of the first message |
| `valid_from` / `valid_to` | Interval during which the provider says the record applies | provider | alert `effective`/`expires`; GDACS `fromdate`/`todate`; TC forecast times. Null for instantaneous events |
| `source_updated_at` | When the provider says it last revised this record | provider | USGS `updated`; GDACS `datemodified`; CAP `sent` of an Update. **Null** for FIRMS (no revision time exists) |
| `ingested_at` | When the version became visible in GeoNerva's database | GeoNerva | one timestamp per ingestion batch, taken with `clock_timestamp()` immediately before `COMMIT` |

Rules:

- All four are `timestamptz`, stored in UTC. Display converts to the selected location's IANA timezone (and always offers UTC on hover).
- Provider timestamps without an offset (GDACS) are parsed as UTC **explicitly** in the adapter; the adapter test asserts it.
- `observed_at` may be *later* than `ingested_at` never; if a provider reports a future `observed_at` (> `ingested_at` + 5 min) the record is rejected with `FUTURE_OBSERVATION` (except forecast geometry, which is modelled via `valid_from/valid_to`, not `observed_at`).
- **Replay invariant:** the view of the world "as of T" contains exactly the versions with `ingested_at ≤ T`, and for each record only the latest such version. Nothing else. A property test enforces this across every read path (`TESTING.md` §6).
- `ingested_at` is a batch timestamp, not the fetch start. A version fetched at 12:00 whose batch commits at 12:17 is invisible to a replay at 12:10.
- Derived artifacts (clusters, canonical links, baselines, snapshots) carry `as_of` = the knowledge time they were computed for, and `computed_at` = wall-clock of computation. Only `as_of` participates in replay.

## 3. Enumerations

```text
HazardType
  EARTHQUAKE
  THERMAL_ACTIVITY      # FIRMS detections / clusters — never called "wildfire"
  WILDFIRE_EVENT        # GDACS WF: official burnt-area event (≥ 5,000 ha)
  FLOOD
  TROPICAL_CYCLONE
  VOLCANO
  DROUGHT
  WEATHER_ALERT
  TSUNAMI               # reserved; no v1 source
  OTHER

HazardFamily (UI cards)
  EARTHQUAKES      = {EARTHQUAKE}
  FIRE_ACTIVITY    = {THERMAL_ACTIVITY, WILDFIRE_EVENT}
  FLOODS           = {FLOOD}
  CYCLONES         = {TROPICAL_CYCLONE}
  WEATHER_ALERTS   = {WEATHER_ALERT}
  OTHER            = {VOLCANO, DROUGHT, OTHER}

SourceCapability
  REALTIME_EVENTS  HISTORICAL_EVENTS  EVENT_DETAILS  EVENT_REVISIONS
  DELETIONS  POLYGONS  TRACKS  FORECAST_GEOMETRY  POINT_DETECTIONS
  OFFICIAL_WARNINGS  IMPACT_ALERT_LEVELS  CROSS_REFERENCES

GeometryKind
  EPICENTER  DETECTION_PIXEL_CENTER  REGION_POLYGON  MODEL_AREA
  TRACK_OBSERVED  TRACK_FORECAST  WIND_BUFFER  UNCERTAINTY_CONE
  CENTROID_ONLY  THREAT_AREA

LifecycleStatus (per observation version)
  ACTIVE  UPDATED  ENDED  CANCELLED  EXPIRED  DELETED

SourceHealthStatus
  FRESH        # polls succeed and data is as current as this source normally is
  DEGRADED     # polls succeed but data is older than normal, or a product/sensor is failing, or last poll failed within grace
  STALE        # no successful poll within the stale threshold
  UNAVAILABLE  # never succeeded, disabled, or no success for > 24 h
  # "CONFLICTING" from the brief is NOT a source-health state; conflicts are event properties (§6.4)

Coverage (per location × hazard family)
  COVERED      # at least one enabled source covers this place for this hazard
  PARTIAL      # covered with a known limitation (e.g. earthquakes complete only ≥ M4.5 here)
  NOT_COVERED  # no source; UI says so explicitly

RelevanceLevel
  LOW  MODERATE  HIGH  CRITICAL      # CRITICAL requires an authoritative basis (see ARCHITECTURE §9)
  # absence of a relevance result ≠ "safe"; events outside the analysis radius simply aren't assessed

AgreementLevel
  SINGLE_SOURCE  DERIVED_ONLY  AGREE  MINOR_DIFFERENCES  CONFLICT
```

## 4. Entities, lifecycles and update behaviour

### 4.1 Source & SourceProduct

- **Source**: a provider (`usgs`, `gdacs`, `firms`, `eccc`). Static metadata: licence, attribution text, terms URL, coverage geometry (null = global), coverage note, freshness policy, polling policy.
- **SourceProduct**: a specific feed/sensor within a source (`firms:VIIRS_NOAA20_NRT`, `gdacs:FL`, `usgs:comcat`). Carries capabilities, hazard types, and for sensors: platform, instrument, `resolution_m`, `confidence_scale` (`CATEGORICAL|NUMERIC`), `latency_class`, `status (ACTIVE|RETIRING|RETIRED)`, `active_from`, `active_to`.
- Lifecycle: rows are seeded by migration; enabling/disabling and sensor retirement are data changes recorded with `updated_at`. Code never branches on source names; it branches on capabilities.

### 4.2 FreshnessPolicy (value object on Source/Product)

```text
poll_interval        how often we ask                          e.g. FIRMS 30 min
fetch_fresh_within   last successful poll younger than this   e.g. FIRMS 90 min
fetch_stale_after    last successful poll older than this     e.g. FIRMS 3 h
data_current_within  newest observed_at younger than this     e.g. FIRMS 6 h  (NRT latency ≈ 3 h)
data_stale_after                                              e.g. FIRMS 12 h
quiet_is_normal      true for USGS/GDACS (no new events ≠ problem), false for FIRMS (always detections globally)
```

Initial values (to be tuned from production run history):

| Product | poll | fetch fresh / stale | data current / stale | quiet normal |
|---|---|---|---|---|
| usgs:comcat | 5 min | 20 min / 60 min | n/a | yes |
| emsc:rts | 5 min | 20 min / 60 min | n/a | yes |
| gdacs:* | 10 min | 40 min / 2 h | n/a | yes |
| firms:VIIRS_* | 30 min | 90 min / 3 h | 6 h / 12 h | no |
| eccc:weather-alerts | 5 min | 20 min / 60 min | n/a | yes |

### 4.3 SourceHealth (derived, not stored)

`SourceHealth(source, as_of)` is a **pure function** of `ingestion_runs` with `committed_at ≤ as_of` plus the policy. Nothing is written except the runs. This makes health replayable ("what did GeoNerva know about FIRMS health at 12:10?") for free.

```text
SourceHealth {
  source_id, product_id?
  status: SourceHealthStatus
  last_attempt_at, last_success_at
  newest_observed_at            # data currency
  consecutive_failures
  last_error_class              # sanitized, e.g. HTTP_5XX, TIMEOUT, SCHEMA_DRIFT, EMPTY_SUSPICIOUS
  expected: FreshnessPolicy
  evidence_id                   # EV:RUN:<last run id>
}
```

### 4.4 IngestionRun

One execution of one adapter for one product. Created `RUNNING` at start; ends `SUCCEEDED | PARTIAL | FAILED | SKIPPED` (skipped = upstream `Last-Modified`/hash unchanged). Counts: received, new records, new versions, unchanged, rejected. `payload_sha256` of the full response. `committed_at` is the batch `ingested_at`. Failed runs are committed too (with zero versions) because failure is health evidence.

### 4.5 RawSourceRecord

The exact provider payload for one record (event-scale sources only: USGS, GDACS, ECCC), content-addressed by `sha256`. Deduplicated: identical payloads are stored once and referenced by each version. **Not used for FIRMS**: a FIRMS CSV row is already flat and is stored losslessly in `fire_detections` (all original columns kept); the batch hash lives on the run. Raw payload bodies are pruned after the retention window; the hash stays on the version forever.

### 4.6 SourceRecord & aliases

The GeoNerva identity of "one thing a provider talks about":

- USGS: one ComCat event. Keyed internally; **aliases** = every member of `ids` ever seen. Upsert rule: if an incoming feature's `ids` intersect exactly one record's aliases → same record; add new aliases. If they intersect **two** records → ComCat has associated two events we had as separate → **record merge**: the younger record is marked `merged_into`, its versions stay, and correlation is re-run for the survivor.
- EMSC: `unid`. `lastupdate` changes create versions; websocket/FDSN deletions create tombstones.
- GDACS: `(eventtype, eventid)`. Episodes are versions.
- ECCC GeoMet: key determined in Phase 0 (V1 in `DATA_SOURCES.md`).
- FIRMS: not a SourceRecord (see FireDetection).

### 4.7 HazardObservation (= ObservationVersion)

One immutable version of a SourceRecord's content, in canonical shape:

```text
ObservationVersion {
  id                          # bigint, internal
  source_record_id, version_seq
  hazard_type
  observed_at, valid_from?, valid_to?, source_updated_at?, ingested_at
  lifecycle_status
  provider_severity?          # { scheme: "GDACS_ALERT"|"PAGER"|"ECCC_RISK_COLOUR"|"CAP_SEVERITY", value: "Orange" }
  provider_status?            # verbatim, e.g. "reviewed"
  magnitude?, magnitude_type?, depth_km?          # EQ only; typed columns because they are queried
  centroid: Point(4326)       # always present — the representative point
  geometry_kind
  geometries[]                # role-tagged: affected_area, track_forecast, wind_120, cone, region …
  attributes                  # hazard-specific normalized JSON, validated by a Zod schema per hazard
  title?, source_url
  content_sha256              # hash of the normalized content (not raw) — change detector
  raw_record_id?
  derived_from?               # e.g. GDACS EQ: { source: "usgs", ref: "us7000tikb" }
}
```

**Update behaviour:** the adapter normalizes an incoming record, computes `content_sha256`, and compares it with the record's **latest** version. Equal → no new version (counted as `unchanged`). Different → new version with `version_seq + 1`. Content may legitimately return to an earlier state (A→B→A); that is three versions. A USGS deletion creates a version with `lifecycle_status = DELETED` and the previous content copied (tombstone).

Normalization excludes volatile fields that don't change meaning (e.g. USGS feed `metadata.generated`) from the hash; which fields are excluded is part of each adapter's contract test.

### 4.8 CanonicalEvent & CanonicalEventObservation (links)

- **CanonicalEvent**: identity only — `id`, `public_id` (e.g. `EQ-26-7K3F9Q`), `hazard_type`, `created_at`, `merged_into?`.
- **CanonicalLink** (the brief's `CanonicalEventObservation`): links a *SourceRecord* (not a version) to a canonical event, with `relation (PRIMARY | SAME_EVENT | DERIVED_COPY)`, `match_kind (IDENTITY_REF | SPATIOTEMPORAL)`, `confidence`, `reasons[]`, `algorithm_version`, `linked_at`, `unlinked_at?`. Links are bitemporal: a replay at T uses links with `linked_at ≤ T < coalesce(unlinked_at, ∞)`.
- **Invariant:** a SourceRecord has at most one active `SAME_EVENT|PRIMARY|DERIVED_COPY` link. Enforced by partial unique index.
- **Invariant:** all records linked to a canonical event share its hazard type.
- **Lifecycle:** created when a record matches nothing → the record becomes `PRIMARY`. Linked records are added by correlation. When a revision breaks a match, the link is closed (`unlinked_at`) and the orphaned record gets a new canonical event (split). When two canonical events are found to be the same (e.g. USGS alias merge), the younger is `merged_into` the older and its links are re-pointed (closed + reopened, preserving history). Public IDs of merged events redirect.
- **Values are projected**, never stored as truth: `CanonicalEventView(as_of)` = f(latest versions of linked records as of T). A `canonical_event_state` cache holds the "now" projection for fast map/radius queries and is rebuilt whenever a linked record gets a version.
- **Possible matches** are stored as `correlation_candidates` (pairwise, with score and reasons) and shown as "possibly the same event" — never merged.

### 4.9 FireDetection

Immutable. Key `(product_id, acquired_at, lat_e4, lon_e4)` (coordinates rounded to 1e-4° ≈ 11 m for the key; full precision kept). Columns preserve every FIRMS attribute. `confidence_class` normalized to `LOW|NOMINAL|HIGH` for VIIRS; the raw value is kept in `confidence_raw`. No revisions (NRT → SP would be a separate product). Retention: rolling window (profile-dependent, §8).

### 4.10 FireActivityCluster

A group of detections that GeoNerva treats as one area of thermal activity. **Not** called a wildfire.

- Identity: `fire_clusters(id, public_id, created_at, status ACTIVE|COOLING|INACTIVE|MERGED, merged_into?)`.
- Versions: `fire_cluster_versions` written by each clustering run *only if the summary changed*: `as_of`, `detection_count_total`, `detection_count_24h`, `distinct_overpasses_24h`, `first_detected_at`, `last_detected_at`, `frp_sum_24h`, `frp_max`, `max_confidence`, `sensors[]`, `hull` (Polygon, buffered by half pixel size), `centroid`.
- Membership: `fire_detections.cluster_id` (assigned once; a detection never changes cluster except via cluster merge, which is recorded on the cluster).
- Lifecycle: `ACTIVE` (detection within 24 h) → `COOLING` (24–72 h) → `INACTIVE` (> 72 h). Two active clusters that become connected are merged (older survives). A cluster never splits in v1 (documented simplification; splitting creates identity churn with little user value).
- Clustering algorithm: see `ARCHITECTURE.md` §7.4.

### 4.11 EvidenceItem

Evidence is a **typed reference** to something immutable, not a separately authored table. IDs are stable strings:

| Prefix | Refers to | Persisted? |
|---|---|---|
| `EV:OBS:<version_id>` | one ObservationVersion (provider fact) | yes |
| `EV:FCV:<cluster_version_id>` | one FireActivityCluster version | yes |
| `EV:FDS:<cluster_version_id>:<count>` | the detection set behind a cluster version | yes (via membership) |
| `EV:RUN:<run_id>` | an ingestion run (health evidence) | yes |
| `EV:BAS:<sha>` | a baseline computation (method, params, as_of, result) | content-addressed; embedded in the briefing manifest; persisted for materialized locations |
| `EV:REL:<sha>` | a relevance assessment | same |
| `EV:CHG:<sha>` | a change signal | same |
| `EV:COR:<link_id>` | a correlation decision | yes |

Every briefing response includes an **evidence manifest**: `{ id, kind, summary, source_id?, observed_at?, ingested_at, url? }` for every evidence ID referenced anywhere in it. The UI resolves primary evidence (`OBS`, `FCV`, `RUN`, `COR`) through `/api/evidence/:id`; derived evidence is self-contained in the manifest. AI validation checks references against this manifest (`ARCHITECTURE.md` §11).

### 4.12 Location

```text
Location {
  key            # "p:<geonameid>" for GeoNames, "n:<osm_type><osm_id>" for Nominatim, "c:<lat2>,<lon2>" for raw coordinates
  label, country_code?, admin1?
  lat, lon       # rounded to 0.01° (~1.1 km) at the API boundary — ALWAYS
  timezone       # IANA
  coverage: { [family]: Coverage + note }
}
```

Privacy rule: raw-coordinate locations (`c:` keys, including "Use my location") are **never persisted** server-side. They are computed on demand and cached only in HTTP caches keyed by the rounded URL. Named places may be persisted in `analysis_locations` (they are public places, not personal data). Watch places live in browser storage (P1).

### 4.13 BaselineMetric

```text
BaselineMetric {
  id (EV:BAS:<sha>)
  location_key, hazard_family, metric_code        # e.g. EQ_COUNT_M_GE_MC_WITHIN_R
  params { radius_km, mc, window_days, reference_years, sensor_group? }
  as_of
  status: OK | INSUFFICIENT_HISTORY | INSUFFICIENT_COVERAGE | NOT_APPLICABLE
  observed_value
  reference: { n_windows, n_events, median, p25, p75, p90, p95, mean, rate_per_window }
  percentile?                                     # mid-rank empirical percentile of observed_value
  band: BELOW_TYPICAL | TYPICAL | ABOVE_TYPICAL | WELL_ABOVE_TYPICAL | null
  method_version
}
```

Computation and thresholds: `ARCHITECTURE.md` §8. Computed on demand, content-addressed, cached; persisted for materialized locations.

### 4.14 LocationSnapshot

The deterministic output of `buildSnapshot(location, as_of, engine_version)`:

```text
LocationSnapshot {
  location, as_of, engine_version, generated_at
  source_cutoffs { [source]: last committed run ≤ as_of }
  source_health[]                    # SourceHealth(as_of) for every source relevant here
  families {
    [family]: {
      availability: AVAILABLE | UNAVAILABLE | NOT_COVERED   # UNAVAILABLE = relevant source STALE/UNAVAILABLE
      coverage, coverage_note
      items[]: { subject_ref, hazard_type, headline_facts, distance_km, relevance, agreement?, evidence_ids }
      metrics[]: BaselineMetric
      data_confidence: { level HIGH|MEDIUM|LOW, reasons[] }
    }
  }
  overall: { headline_relevance, headline_code }   # e.g. NO_HIGH_RELEVANCE_ITEMS | HIGH_RELEVANCE_PRESENT | DATA_UNAVAILABLE
  evidence_manifest[]
  content_sha256
}
```

- **Snapshots are reproducible, so persistence is a cache, not the source of truth.** Given the append-only store, `buildSnapshot(L, T)` returns the same content for the same `engine_version`. They are persisted for materialized locations (curated, demo, popular named places) to power change history, shareable reports and AI caching.
- `engine_version` changes whenever relevance/baseline/change logic changes. Snapshots of different engine versions are never diffed against each other; the previous snapshot is recomputed under the current engine instead.

### 4.15 ChangeSignal

```text
ChangeSignal {
  id (EV:CHG:<sha>)
  type: NEW_EVENT | EVENT_UPDATED | EVENT_ESCALATED | EVENT_DEESCALATED | EVENT_RESOLVED
      | ACTIVITY_INCREASE | ACTIVITY_DECREASE | ABNORMAL_ACTIVITY
      | SOURCE_STALE | SOURCE_RECOVERED | SOURCE_CONFLICT
      | RELEVANCE_INCREASE | RELEVANCE_DECREASE
      | ENTERED_AREA | LEFT_AREA
  family, subject_ref?, metric_code?
  before, after                       # typed values, e.g. { magnitude: 5.1 } → { magnitude: 5.3 }
  from_as_of, to_as_of
  importance: 0..100                  # deterministic score (ARCHITECTURE §10)
  prominence: HEADLINE | LISTED | DETAIL | SUPPRESSED
  suppression_reason?
  reason_codes[], evidence_ids[]
  engine_version
}
```

### 4.16 AnalysisRun & AgentOutput

- **AnalysisRun**: one execution of a derivation (`CORRELATION | CLUSTERING | SNAPSHOT | BASELINE | AI_BRIEFING`), with `as_of`, `engine_version`, inputs hash, timing, status, error class. Operational audit + metrics (correlation rate, ambiguous rate, failures).
- **AgentOutput** (P1): one model call's structured output for a snapshot: `role`, `model`, `prompt_version`, `input_sha256`, `output` (JSON), `validation_status (PASSED | REPAIRED | REJECTED)`, `validation_errors[]`, `used`, token counts, cost. Cached by `(snapshot content_sha256, role, prompt_version, model)`. A REJECTED output is kept for evaluation but never shown.

## 5. Entity relationship overview

```text
sources 1─* source_products 1─* ingestion_runs 1─* observation_versions *─1 source_records 1─* source_record_aliases
                                     │                    │  └─* observation_geometries
                                     │                    └─? raw_source_records
                                     └─* fire_detections *─? fire_clusters 1─* fire_cluster_versions

source_records *─1 canonical_links *─1 canonical_events 1─1 canonical_event_state (cache)
source_records *─* correlation_candidates

analysis_locations 1─* location_snapshots 1─* change_signals
location_snapshots 1─* agent_outputs (P1)
baseline_metrics (cache) ; analysis_runs ; places (GeoNames) ; geocode_cache ; rate_limit_buckets
fire_daily_cells (long-term aggregate)
```

## 6. Database design (PostgreSQL 15+ / PostGIS 3.3+)

Schema `geonerva` (**not** `public`: on Supabase, `public` is exposed through the Data API; our schema is not exposed and every table additionally has RLS enabled with no policies = deny-all for `anon`/`authenticated`). PostGIS lives in schema `extensions` on Supabase, `public` locally — migrations reference types via `search_path`, never schema-qualified PostGIS names.

**Geometry type choice:** `geography` (SRID 4326) for everything used in distance/radius math (`ST_DWithin`/`ST_Distance` in metres on the spheroid, correct across the antimeridian and at high latitude). `geometry(…, 4326)` is used only for viewport bounding-box filtering and vector-tile output, via an expression index `(geog::geometry)`. See `ARCHITECTURE.md` §7.

### 6.1 Reference & operations

```sql
sources(
  id text PK, name text, homepage text, licence text, attribution_text text, terms_url text,
  coverage geography(MultiPolygon) NULL,  -- NULL = global
  coverage_note text, enabled bool, policy jsonb, updated_at timestamptz)

source_products(
  id smallserial PK, source_id text FK, code text, hazard_types text[], capabilities text[],
  platform text, instrument text, resolution_m int, confidence_scale text, latency_class text,
  status text CHECK (status IN ('ACTIVE','RETIRING','RETIRED')), active_from date, active_to date,
  policy jsonb, UNIQUE(source_id, code))

ingestion_runs(
  id uuid PK, source_id text FK, product_id smallint FK NULL,
  trigger text CHECK (trigger IN ('SCHEDULE','MANUAL','BACKFILL','RECONCILE')),
  started_at timestamptz NOT NULL, finished_at timestamptz, committed_at timestamptz,
  status text CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED','SKIPPED')),
  http_status int, bytes_received bigint, payload_sha256 bytea,
  n_received int, n_new_records int, n_new_versions int, n_unchanged int, n_rejected int,
  newest_observed_at timestamptz, error_class text, error_message text,  -- sanitized, ≤ 1 KB
  worker_version text)
  INDEX (source_id, committed_at DESC)            -- health(as_of)
  INDEX (source_id, product_id, started_at DESC)
  -- a run lease: UNIQUE (source_id, product_id) WHERE status = 'RUNNING'  → prevents overlapping runs

ingestion_rejects(id bigserial PK, run_id uuid FK, reason_code text, excerpt jsonb, created_at timestamptz)
  -- retention 30 d
```

### 6.2 Provider facts

```sql
raw_source_records(
  id bigserial PK, source_id text, payload_sha256 bytea NOT NULL, payload jsonb NULL,  -- NULL after prune
  first_seen_at timestamptz, UNIQUE(source_id, payload_sha256))

source_records(
  id bigserial PK, source_id text FK, product_id smallint FK, hazard_type text,
  primary_key text NOT NULL, first_ingested_at timestamptz,
  merged_into bigint FK NULL, merged_at timestamptz NULL,
  UNIQUE(source_id, primary_key))

source_record_aliases(
  source_id text, alias text, source_record_id bigint FK, first_seen_at timestamptz,
  PRIMARY KEY (source_id, alias))                 -- idempotency for USGS ids

observation_versions(
  id bigserial PK, source_record_id bigint FK, version_seq int NOT NULL,
  hazard_type text NOT NULL,                      -- denormalized for filtered spatial scans
  ingestion_run_id uuid FK, ingested_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL, valid_from timestamptz, valid_to timestamptz,
  source_updated_at timestamptz,
  lifecycle_status text NOT NULL,
  severity_scheme text, severity_value text, provider_status text,
  magnitude numeric(4,2), magnitude_type text, depth_km numeric(6,2),
  centroid geography(Point,4326) NOT NULL,
  geometry_kind text NOT NULL,
  attributes jsonb NOT NULL, title text, source_url text,
  derived_from jsonb, content_sha256 bytea NOT NULL, raw_record_id bigint FK NULL,
  UNIQUE (source_record_id, version_seq),
  CHECK (observed_at <= ingested_at + interval '5 minutes'),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from))
  INDEX GIST (centroid)
  INDEX (source_record_id, ingested_at DESC)      -- as-of lookup: latest version ≤ T
  INDEX (hazard_type, observed_at DESC)
  INDEX BRIN (ingested_at)
  INDEX (hazard_type, magnitude) WHERE hazard_type = 'EARTHQUAKE'   -- baseline scans

observation_geometries(
  observation_version_id bigint FK, role text, seq smallint, valid_at timestamptz NULL,
  geog geography(Geometry,4326) NOT NULL,
  PRIMARY KEY (observation_version_id, role, seq))
  INDEX GIST (geog)
  INDEX GIST ((geog::geometry))                   -- viewport bbox

source_record_heads(
  source_record_id bigint PK FK, latest_version_id bigint FK, latest_ingested_at timestamptz)
  -- maintained in the same transaction as version inserts; fast "now" path
```

### 6.3 Canonical events & correlation

```sql
canonical_events(
  id uuid PK, public_id text UNIQUE, hazard_type text, created_at timestamptz,
  created_by_run uuid, merged_into uuid FK NULL, merged_at timestamptz)

canonical_links(
  id bigserial PK, canonical_event_id uuid FK, source_record_id bigint FK,
  relation text CHECK (relation IN ('PRIMARY','SAME_EVENT','DERIVED_COPY')),
  match_kind text CHECK (match_kind IN ('IDENTITY_REF','SPATIOTEMPORAL','SEED')),
  confidence numeric(4,3), reasons jsonb, algorithm_version text,
  linked_at timestamptz NOT NULL, unlinked_at timestamptz NULL, unlink_reason text)
  UNIQUE (source_record_id) WHERE unlinked_at IS NULL      -- one active canonical per record
  INDEX (canonical_event_id) WHERE unlinked_at IS NULL
  INDEX (source_record_id, linked_at)

correlation_candidates(
  id bigserial PK, record_a bigint FK, record_b bigint FK,   -- record_a < record_b
  decision text CHECK (decision IN ('POSSIBLE_MATCH','NO_MATCH_CLOSE')),
  score numeric(4,3), reasons jsonb, algorithm_version text, evaluated_at timestamptz,
  superseded_at timestamptz NULL,
  UNIQUE (record_a, record_b, algorithm_version, evaluated_at))

canonical_event_state(                                        -- "now" projection cache
  canonical_event_id uuid PK FK, hazard_type text, as_of timestamptz, engine_version text,
  observed_at timestamptz, centroid geography(Point,4326), footprint geography(Geometry,4326) NULL,
  is_active bool, headline jsonb, agreement jsonb, n_sources int, n_independent_sources int)
  INDEX GIST (centroid), INDEX GIST (footprint), INDEX GIST ((centroid::geometry))
  INDEX (hazard_type, is_active, observed_at DESC)

event_relations(                                              -- RELATED, never SAME (P1: WF↔fire cluster, warnings↔events)
  id bigserial PK, from_ref text, to_ref text, relation text, reasons jsonb,
  established_at timestamptz, ended_at timestamptz NULL)
```

### 6.4 Fire activity

```sql
fire_detections(
  id bigserial, product_id smallint FK, acquired_at timestamptz NOT NULL,
  lat double precision, lon double precision,
  lat_e4 int GENERATED ALWAYS AS (round(lat*1e4)) STORED,
  lon_e4 int GENERATED ALWAYS AS (round(lon*1e4)) STORED,
  geog geography(Point,4326) NOT NULL,
  confidence_class text, confidence_raw text, frp real, bright_ti4 real, bright_ti5 real,
  scan real, track real, daynight char(1), provider_version text,
  ingestion_run_id uuid, ingested_at timestamptz NOT NULL, cluster_id uuid NULL,
  PRIMARY KEY (acquired_at, id),
  UNIQUE (product_id, acquired_at, lat_e4, lon_e4))
  PARTITION BY RANGE (acquired_at)                -- daily partitions; retention = DROP PARTITION
  INDEX GIST (geog) (per partition)
  INDEX (cluster_id)

fire_clusters(
  id uuid PK, public_id text UNIQUE, created_at timestamptz, status text,
  merged_into uuid NULL, merged_at timestamptz NULL, persistent_source bool DEFAULT false)  -- P1 flag

fire_cluster_versions(
  id bigserial PK, cluster_id uuid FK, analysis_run_id uuid, as_of timestamptz NOT NULL,
  n_total int, n_24h int, overpasses_24h int, first_detected_at timestamptz, last_detected_at timestamptz,
  frp_sum_24h real, frp_max real, max_confidence text, product_ids smallint[],
  hull geography(Polygon,4326), centroid geography(Point,4326), content_sha256 bytea)
  INDEX GIST (hull), INDEX GIST (centroid), INDEX (cluster_id, as_of DESC)

fire_cluster_heads(cluster_id uuid PK, latest_version_id bigint, status text, last_detected_at timestamptz)
  INDEX (status)

fire_daily_cells(                                 -- long-term compact aggregate for fire trends/baselines
  cell_id int, day date, product_group text, n int, frp_sum real, n_high_conf int,
  PRIMARY KEY (cell_id, day, product_group))
  -- cell_id = regular 0.25° lat/lon grid index; see ARCHITECTURE §7.6 for why not H3
```

### 6.5 Locations, analysis, AI

```sql
places(                                           -- GeoNames cities15000 import
  geonameid int PK, name text, ascii_name text, alt_names text, country_code text, admin1 text,
  lat double precision, lon double precision, population int, timezone text)
  INDEX GIN (ascii_name gin_trgm_ops), INDEX (population DESC)

geocode_cache(query_sha256 bytea PK, provider text, response jsonb, created_at timestamptz, expires_at timestamptz)

analysis_locations(                               -- named/curated places only; never raw user coordinates
  key text PK, label text, lat numeric(5,2), lon numeric(5,2), geog geography(Point,4326),
  country_code text, timezone text, materialize bool DEFAULT false, is_demo bool DEFAULT false,
  created_at timestamptz)

location_snapshots(
  id uuid PK, location_key text FK, as_of timestamptz, engine_version text,
  content_sha256 bytea, snapshot jsonb, generated_at timestamptz, analysis_run_id uuid,
  UNIQUE (location_key, as_of, engine_version))
  INDEX (location_key, as_of DESC)

change_signals(
  id text PK,                                     -- EV:CHG:<sha>
  location_key text FK, from_snapshot uuid, to_snapshot uuid, type text, family text,
  subject_ref text, importance smallint, prominence text, payload jsonb, engine_version text)
  INDEX (location_key, to_snapshot)

baseline_metrics(id text PK, location_key text, family text, metric_code text, as_of timestamptz,
  method_version text, payload jsonb, computed_at timestamptz)
  INDEX (location_key, family, metric_code, as_of DESC)

analysis_runs(id uuid PK, kind text, location_key text NULL, as_of timestamptz, engine_version text,
  started_at timestamptz, finished_at timestamptz, status text, inputs_sha256 bytea, stats jsonb, error_class text)

agent_outputs(                                    -- P1
  id uuid PK, snapshot_id uuid FK, role text, model text, prompt_version text, input_sha256 bytea,
  output jsonb, validation_status text, validation_errors jsonb, used bool,
  tokens_in int, tokens_out int, cost_micros bigint, created_at timestamptz,
  UNIQUE (snapshot_id, role, prompt_version, model))

rate_limit_buckets(bucket_key bytea, window_start timestamptz, n int, PRIMARY KEY (bucket_key, window_start))
  -- bucket_key = HMAC(ip /24 or /48, daily secret) — raw IPs never stored
```

### 6.6 Idempotency guarantees

| Scenario | Mechanism |
|---|---|
| Same poll run twice | `raw_source_records UNIQUE(source_id, payload_sha256)`; version inserted only if `content_sha256` ≠ latest; FIRMS `UNIQUE(product_id, acquired_at, lat_e4, lon_e4)` with `ON CONFLICT DO NOTHING` |
| Overlapping runs for one product | partial unique index on `ingestion_runs (source_id, product_id) WHERE status='RUNNING'` = lease; stale leases (> 3× timeout) are expired by the next run |
| USGS preferred id changes | alias table; lookup by any alias |
| Correlation re-run | links carry `algorithm_version`; re-evaluation closes and reopens links rather than duplicating; one active link per record |
| Clustering re-run for the same `as_of` | version inserted only if `content_sha256` changed |
| Snapshot recomputation | `UNIQUE(location_key, as_of, engine_version)` |

### 6.7 Retention (see `ARCHITECTURE.md` §12 for profiles)

| Data | Lean profile (Supabase free, 500 MB) | Standard profile (≥ 8 GB) |
|---|---|---|
| `fire_detections` | 72 h (drop daily partitions) | 30 d |
| `fire_cluster_versions` | 30 d | 1 y |
| `fire_daily_cells` | 400 d at 0.5° | 5 y at 0.25° |
| `observation_versions` (EQ M ≥ 4.5 catalog) | forever (~190k rows since 2000) | forever |
| `observation_versions` (EQ < M4.5) | 90 d | 2 y |
| `observation_versions` (GDACS, ECCC) | forever (small) | forever |
| `raw_source_records.payload` | 14 d (hash kept) | 180 d |
| `ingestion_runs` | 90 d | 2 y |
| `location_snapshots` / `change_signals` | 30 d | 1 y |
| `agent_outputs` | 30 d | 1 y |

**Replay horizon** = the shortest retention among the data a replay needs. It is exposed by the API (`/api/replay/horizon`) and the UI refuses to replay beyond it, per hazard family ("thermal detections are retained for 72 h in this deployment").
