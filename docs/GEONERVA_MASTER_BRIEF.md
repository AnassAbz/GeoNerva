# GeoNerva — Master Engineering & Agent-Orchestration Brief

> **GeoNerva — Understand what’s changing around you.**

GeoNerva is an open-source web application for **explainable, location-specific natural-hazard intelligence**.

It is not another disaster map.

Public agencies already publish large amounts of earthquake, wildfire, flood, cyclone, volcano, severe-weather, and other hazard data. The problem is that the information is fragmented across providers, represented using different schemas, updated at different frequencies, duplicated between systems, and difficult for an ordinary person to interpret relative to a specific location.

GeoNerva should answer:

> **What is changing around a place I care about, how unusual is it, how relevant is it to that location, and what evidence supports that conclusion?**

The application should continuously ingest public hazard information, normalize and correlate it, compare current activity to historical context, detect meaningful changes, and produce transparent location briefings.

---

# 1. Product principles

These principles are non-negotiable.

## 1.1 Not another hazard map

Showing earthquake dots, wildfire points, and cyclone polygons on a map is insufficient.

GeoNerva's differentiators are:

1. **What Changed?**
2. **Location-specific relevance**
3. **Historical abnormality**
4. **Multi-source correlation**
5. **Source agreement/disagreement**
6. **Explainability**
7. **Data provenance**
8. **Freshness awareness**
9. **Historical replay**
10. **Optional agentic interpretation over deterministic data**

Every major feature should reinforce at least one of these.

---

# 2. What GeoNerva must NOT become

Do not turn this into:

- a generic weather app
- a collection of API cards
- a map with colored markers
- an earthquake prediction application
- an LLM wrapper
- a chatbot over raw APIs
- a single opaque "AI risk score"
- an application that invents probabilities
- an emergency-warning replacement
- a microservice architecture merely to appear sophisticated

The engineering should be sophisticated because the problem requires it, not because complexity looks impressive.

---

# 3. Scientific and safety boundaries

GeoNerva must never claim that it can predict earthquakes.

Do not generate statements such as:

> "There is a 72% probability of a major earthquake tomorrow."

Do not imply that increased minor seismic activity predicts a major earthquake unless an authoritative scientific source explicitly supports such a conclusion.

Allowed:

> "Seven earthquakes above M2 occurred within 150 km during the last 24 hours, compared with a recent baseline of 1.4 per 24 hours."

Allowed:

> "Current seismic activity is elevated relative to the selected historical baseline."

Then explicitly state:

> "Elevated recent activity does not by itself predict a larger earthquake."

Likewise, never say:

> "This location is safe."

Say:

> "No high-relevance hazards were detected in the currently indexed sources."

GeoNerva is a **decision-support and situational-awareness tool**, not an official emergency-alert system.

When authoritative emergency guidance exists, link users to it.

---

# 4. Core user story

A user searches:

> Marrakech, Morocco

GeoNerva produces something similar to:

```text
MARRAKECH, MOROCCO
Updated 4 minutes ago

CURRENT SITUATION

No high-relevance hazard changes detected.

WHAT CHANGED
────────────────────────────────

SEISMIC ACTIVITY ↑

4 earthquakes detected within 180 km
during the previous 48 hours.

Recent activity:
Above the 30-day regional baseline.

Largest:
M3.4 · 124 km away · 18 km depth

Interpretation:
Activity is elevated relative to recent history.
This does not imply that a larger earthquake
will occur.

────────────────────────────────

WILDFIRE ACTIVITY

2 new satellite thermal detections
96 km southeast.

Change:
+2 since previous analysis.

Relevance:
LOW

Why:
• relatively distant
• limited number of detections
• no matching major disaster alert

────────────────────────────────

FLOOD / CYCLONE / OTHER

No currently indexed high-relevance events.

────────────────────────────────

DATA CONFIDENCE

USGS       Fresh
NASA FIRMS Fresh
GDACS      Fresh

Sources independently preserved.
```

Every derived statement must be traceable back to data.

---

# 5. Primary features

## P0 — required for v1

### 5.1 Location search

User can search globally for:

- city
- region
- postal code where supported
- coordinates

Also provide:

**Use my location**

Browser geolocation must:

- happen only after explicit user action
- not automatically persist coordinates
- not log precise coordinates unnecessarily

Location search must be behind a provider abstraction so the geocoder can be replaced later.

---

### 5.2 Location Intelligence Dashboard

Every selected location gets a dashboard containing:

- location identity
- coordinates
- local timezone
- last analysis time
- data freshness
- current situation
- What Changed?
- nearby/relevant events
- historical context
- map
- source health
- evidence/provenance

The dashboard should answer the important questions before showing raw detail.

---

### 5.3 What Changed?

This is the flagship feature.

Compare the newest location snapshot with the previous snapshot.

Examples:

```text
2 new wildfire detections within 100 km.
```

```text
Seismic activity increased from 2 events/day
to 8 events/day.
```

```text
A GDACS flood event entered the selected
location's regional relevance area.
```

```text
An existing cyclone alert changed
from Green to Orange.
```

```text
Earthquake magnitude was revised
from M5.1 to M5.3 by the source.
```

Do not produce noise for meaningless changes.

A meaningful-change engine should classify changes into:

- new
- escalated
- de-escalated
- updated
- resolved
- unusual
- source disagreement
- freshness degradation

---

### 5.4 Multi-hazard map

Use:

**MapLibre GL JS**

Prefer:

**OpenFreeMap**

or another explicitly suitable open/free provider selected after verifying current terms.

Map layers should support:

- earthquakes
- wildfire detections/clusters
- flood polygons
- cyclone tracks/polygons
- volcano events where available
- severe-weather alert polygons when available
- selected location
- relevance radius/region

Layers must be individually toggleable.

Do not hard-code the basemap provider deep into the application.

---

### 5.5 Hazard cards

Each hazard family has its own card.

Examples:

- Earthquakes
- Wildfires
- Floods
- Tropical cyclones
- Volcanoes
- Weather alerts

Each card displays:

```text
STATUS
Current activity

CHANGE
How it differs from previous snapshot

CONTEXT
How unusual it is

RELEVANCE
How relevant it is to the selected place

CONFIDENCE
How strong the underlying evidence is

SOURCES
Where the information came from
```

---

### 5.6 Event Detail

Clicking an event opens a detailed analysis.

Include:

- event type
- canonical event ID
- start time
- latest update
- source observations
- event geometry
- selected-location distance
- source-specific severity
- relevance assessment
- historical context
- changes/revisions
- source agreement
- conflicting fields
- evidence
- original source links
- ingestion timestamps

The UI must clearly distinguish:

**Observed facts**

from:

**GeoNerva-derived interpretation**

from:

**AI-generated explanation**

if AI is enabled.

---

### 5.7 Source consensus

If several sources describe the same real-world event:

```text
USGS:
M5.3

GDACS:
M5.2

Regional provider:
M5.3
```

GeoNerva should not render three unrelated earthquakes.

Build a canonical event:

```text
Canonical Earthquake EQ-...

Sources: 3

Magnitude observations:
5.2 – 5.3

Location variance:
3.7 km

Source agreement:
HIGH
```

Never silently discard source disagreement.

---

### 5.8 Historical abnormality

Current activity needs context.

Example:

```text
EARTHQUAKES WITHIN 150 KM

Past 24 hours:
7

30-day daily median:
1

Activity ratio:
7×

Historical percentile:
96th percentile
```

Then communicate carefully:

> "Recent seismic activity is unusually elevated relative to the selected baseline."

Not:

> "Earthquake danger increased 7×."

Those are not equivalent.

All historical computations must be deterministic.

---

### 5.9 Data freshness

Every provider receives a health state:

```text
FRESH
STALE
MISSING
ERROR
CONFLICTING
```

Freshness thresholds are provider-specific.

Never pretend old data is current.

Example:

```text
NASA FIRMS
Last successful ingestion:
2h 17m ago

Expected:
<30m

Status:
STALE
```

The UI should visibly degrade confidence when relevant sources are stale.

---

### 5.10 Provenance

Every important factual statement must be traceable.

For example:

```text
Claim:
M5.3 earthquake occurred 82 km from location.

Evidence:
EV-USGS-19328
EV-GDACS-82938
```

Generated summaries should internally reference evidence IDs.

The frontend should allow users to inspect the evidence.

---

# 6. P1 features

After the stable P0 implementation:

## Watch Places

Users can save places such as:

```text
Home
Parents
Office
Vacation
```

Default privacy model:

**store watch locations locally in the browser unless the user explicitly creates an account or enables synchronization.**

Do not require authentication for the primary application.

---

## Historical replay

This is an important engineering feature.

Allow:

> "Show me what GeoNerva would have shown at this timestamp."

Replay MUST respect information availability.

If an observation was:

```text
observed_at = 12:00
ingested_at = 12:17
```

a replay at 12:10 MUST NOT contain it.

Replay means:

> newest information actually available to GeoNerva at or before the selected time.

Never rewrite history using information ingested later.

---

## Historical demo scenarios

Live natural-hazard activity can occasionally be quiet.

Provide a curated **Historical Replay** section using real historical events for demonstrations.

This lets recruiters/users experience:

- source correlation
- changing severity
- timeline updates
- historical context
- replay
- source disagreements

Clearly label them as historical.

---

## Shareable intelligence report

Generate a shareable read-only URL such as:

```text
/location/marrakech/report/...
```

The report should summarize:

- current situation
- meaningful changes
- relevant hazards
- evidence
- freshness

---

## Ask GeoNerva

Optional natural-language interface:

> "What changed around Montréal during the last 24 hours?"

> "Why is wildfire relevance moderate?"

> "Were earthquakes unusually active around Marrakech this week?"

The assistant may ONLY access validated GeoNerva domain tools.

No arbitrary SQL.

No unrestricted internet.

No hallucinated external knowledge.

---

# 7. Data sources

Before implementing ANY connector, verify its current official documentation, usage terms, attribution requirements, rate limits, schemas, and current operational status.

Record this in:

```text
docs/DATA_SOURCES.md
```

Initial source targets:

---

## USGS

Use official machine-readable earthquake data.

Primary responsibilities:

- near-real-time earthquakes
- event updates
- earthquake detail
- historical earthquake catalog for baseline computation

Preserve:

- provider event ID
- magnitude
- magnitude type
- coordinates
- depth
- observed time
- provider updated time
- status
- significance where available
- felt reports where available
- authoritative links

Do not scrape USGS HTML pages.

---

## GDACS

Use official API/feed access.

Potential hazards include:

- earthquakes
- floods
- tropical cyclones
- volcanoes
- other supported global disaster-event categories

GDACS can overlap with upstream sources such as earthquake providers.

This is intentional.

Use that overlap to implement cross-source correlation.

Preserve GDACS alert levels exactly as provided.

Do not reinterpret a GDACS alert color as a GeoNerva-generated probability.

---

## NASA FIRMS

Use official active-fire APIs.

Use a configurable API/map key.

Important:

The connector must be capability-based.

Do NOT build the system around a single satellite sensor.

Prefer supported current sensors such as NOAA-20 and NOAA-21 where applicable.

The provider may add/remove sensor products.

Model sensors as data, not application assumptions.

Capture:

- latitude/longitude
- acquisition timestamp
- satellite
- instrument
- confidence
- fire radiative power where available
- brightness values where useful
- day/night indicator
- provider version

Satellite fire detections are **thermal detections**, not automatically confirmed wildfires.

The UI must use accurate terminology.

---

## Weather alerts

Weather alerts should use authoritative warning feeds where practical.

Initial supported adapters can include:

- Environment and Climate Change Canada
- additional national weather agencies later

Do not pretend global weather-warning coverage exists if it does not.

The architecture should expose coverage explicitly:

```text
Weather warning coverage:
Canada ✓
United States ...
Other region unavailable
```

Coverage gaps are valid application states.

---

# 8. Provider abstraction

Every provider must implement a shared contract conceptually similar to:

```ts
interface HazardSourceAdapter {
  id: SourceId;
  hazards: HazardType[];
  capabilities: SourceCapability[];

  fetch(input: FetchContext): Promise<RawSourceBatch>;

  normalize(
    batch: RawSourceBatch,
    context: NormalizationContext
  ): Promise<NormalizedObservation[]>;

  healthCheck(): Promise<SourceHealth>;

  attribution(): SourceAttribution;

  freshnessPolicy(): FreshnessPolicy;
}
```

Capabilities might include:

```text
REALTIME_EVENTS
HISTORICAL_EVENTS
EVENT_DETAILS
POLYGONS
TRACKS
FIRE_DETECTIONS
OFFICIAL_WARNINGS
```

UI/domain logic must depend on capabilities, not source-name conditionals.

---

# 9. Canonical domain model

Provider schemas must never leak directly into UI components.

Create a normalized domain model.

Core types:

```text
HazardType

EARTHQUAKE
WILDFIRE
FLOOD
CYCLONE
VOLCANO
WEATHER_ALERT
TSUNAMI
OTHER
```

Core observation fields:

```text
id
source
source_event_id
hazard_type

observed_at
source_updated_at
ingested_at

geometry
latitude
longitude

provider_severity
provider_status

attributes
raw_payload_hash

source_url
```

All timestamps use UTC internally.

Display timezone should follow selected location.

---

# 10. Canonical events

Separate:

**Observation**

from:

**Canonical Event**

Multiple observations may belong to one real event.

Conceptually:

```text
CanonicalEvent
 ├── USGS observation
 ├── GDACS observation
 └── regional-provider observation
```

Tables/entities should reflect this.

Never overwrite an observation simply because a newer provider value appears.

Preserve revisions.

---

# 11. Correlation engine

Correlation is deterministic.

Do not ask an LLM whether two earthquakes are the same event.

For earthquakes consider:

- hazard type
- temporal distance
- geodesic distance
- magnitude difference
- source IDs/references
- provider update patterns

Example initial configurable thresholds:

```text
time difference <= 120 seconds
distance <= 50 km
magnitude difference <= 0.5
```

These are starting hypotheses, not universal truths.

Validate against fixtures and tune.

Correlation output:

```text
MATCH
POSSIBLE_MATCH
NO_MATCH
```

with:

```text
confidence
reasons[]
```

Ambiguous observations remain separate rather than being forcibly merged.

---

# 12. Wildfire clustering

NASA FIRMS may provide many nearby thermal detections.

Displaying every point as an independent "wildfire" is misleading.

Create a clustering layer.

Evaluate:

- H3
- DBSCAN
- spatial/time clustering

Cluster based on:

- spatial proximity
- acquisition time
- sensor
- continuity across runs

Represent:

```text
FireDetection
```

separately from:

```text
FireActivityCluster
```

Do not label an isolated thermal anomaly as a confirmed wildfire without supporting evidence.

---

# 13. Geospatial intelligence

Use PostgreSQL with PostGIS.

SRID:

```text
4326
```

Use proper geospatial operations rather than naive latitude/longitude approximations for important spatial queries.

Use:

- `ST_DWithin`
- `ST_Distance`
- polygon intersection
- bounding boxes
- spatial indexes

Consider H3 only where it materially improves:

- regional aggregation
- baseline bucketing
- hotspot grouping
- fast spatial lookup

Do not add H3 merely for architecture-showcase reasons.

---

# 14. Relevance engine

Do NOT build one universal magical hazard score.

Different hazards require different relevance models.

Return:

```text
LOW
MODERATE
HIGH
CRITICAL
```

only where justified.

Also return:

```text
reasons[]
```

Example:

```json
{
  "level": "MODERATE",
  "reasons": [
    "Earthquake occurred 42 km from selected location",
    "Magnitude is unusually high for this local baseline",
    "Event depth is relatively shallow",
    "No official emergency warning was found in indexed sources"
  ]
}
```

The explanation matters more than the category.

---

# 15. Hazard-specific relevance

## Earthquake

Possible deterministic factors:

- magnitude
- depth
- distance
- official intensity products where available
- provider significance
- historical regional context

Never translate these into an invented probability.

---

## Wildfire

Possible deterministic factors:

- distance
- thermal-detection count
- cluster growth
- FRP trend
- recency
- official wildfire/disaster alerts if correlated
- optional wind direction later

Do not infer fire spread from wind alone.

---

## Flood

Possible factors:

- event polygon intersection
- distance to affected geometry
- GDACS severity
- episode evolution
- official warning state

---

## Cyclone

Possible factors:

- current event geometry
- forecast/track geometry from authoritative source
- distance to track
- official severity
- episode updates

Do not independently forecast storm tracks.

---

## Weather alert

Prefer authoritative warning status and warning polygons.

GeoNerva should explain the warning rather than replacing the issuing agency.

---

# 16. Historical baseline engine

Historical context is deterministic.

Examples:

```text
earthquake count / rolling period
maximum magnitude / rolling period
thermal-detection count
cluster count
alert-event count
```

Support baseline windows such as:

```text
7 days
30 days
90 days
1 year
```

Where enough data exists.

Useful metrics include:

```text
median
mean
percentile
activity ratio
interquartile range
robust z-score
```

Avoid statistical theater.

Every displayed statistic must have a clear interpretation.

If the sample is too small:

```text
Historical baseline unavailable
```

instead of pretending confidence.

---

# 17. Change-detection engine

Location snapshots should be persisted.

Conceptually:

```text
LocationSnapshot {
  location
  generated_at
  source_cutoff
  hazard_summaries
  relevant_events
  baseline_metrics
  source_health
}
```

Compare:

```text
snapshot N
vs
snapshot N-1
```

Generate structured `ChangeSignal` entities.

Example:

```text
type: ACTIVITY_INCREASE
hazard: EARTHQUAKE
metric: event_count_24h
before: 2
after: 7
importance: HIGH
```

Change detection must happen before LLM interpretation.

---

# 18. Data-time semantics

This is critical.

Preserve separately:

```text
observed_at
source_updated_at
ingested_at
```

Never collapse them into one `timestamp`.

Examples:

`observed_at`

When the physical/event observation happened.

`source_updated_at`

When the provider says it revised the event.

`ingested_at`

When GeoNerva learned about it.

This is required for correct replay and auditing.

---

# 19. Suggested database entities

Design properly rather than copying this blindly, but expect concepts similar to:

```text
sources
source_health
ingestion_runs
raw_source_records

event_observations
canonical_events
canonical_event_observations

fire_activity_clusters

watched_locations
location_snapshots
change_signals

baseline_metrics

evidence_items
analysis_runs
agent_outputs
```

Indexes must cover:

- timestamps
- provider IDs
- hazard type
- spatial geometry
- canonical relationships

Use migrations.

Never modify production schema manually.

---

# 20. Runtime AI architecture

The system must work without an LLM.

Support:

```text
AI_MODE=disabled
AI_MODE=anthropic
AI_MODE=local
```

`disabled`

Deterministic application remains fully functional.

`anthropic`

Claude may produce higher-quality interpretation.

`local`

Allow an optional local-model adapter later.

AI is an enhancement layer.

It is not the truth layer.

---

# 21. Runtime agent responsibilities

If AI mode is enabled, orchestrate narrowly scoped agents.

## Evidence Analyst

Receives validated structured evidence.

Produces:

- important observations
- relationships
- evidence references

Cannot retrieve arbitrary internet content.

---

## Change Analyst

Receives:

- previous snapshot
- current snapshot
- deterministic `ChangeSignal[]`

Explains what changed.

Cannot invent additional changes.

---

## Relevance Explainer

Receives deterministic relevance output.

Explains:

> why this event matters or does not matter to this location.

It cannot modify the computed relevance classification.

---

## Skeptic / Verifier

Its job is to challenge the draft.

Questions:

- Is this claim actually supported?
- Did we confuse correlation with prediction?
- Is stale data being presented as current?
- Are we calling thermal detections wildfires?
- Did we ignore conflicting sources?
- Did the explanation exaggerate risk?
- Is the magnitude/distance actually correct?
- Does every important assertion have evidence?

It returns:

```text
PASS
REVISE
REJECT
```

with reasons.

---

## Briefing Composer

Only runs after verification.

Produces final user-facing language using:

- deterministic facts
- approved interpretations
- evidence IDs
- source freshness

---

# 22. Trusted AI tools

LLMs must never receive unrestricted DB access.

Provide constrained tools such as:

```text
getLocationSnapshot()
getNearbyEvents()
getEventEvidence()
getHistoricalBaseline()
getChangeSignals()
getSourceHealth()
getCanonicalEvent()
```

Each tool:

- validates arguments
- uses deterministic queries
- returns structured JSON
- exposes evidence IDs
- limits result count
- enforces time range
- cannot execute arbitrary SQL

The model must never construct or execute SQL.

---

# 23. LLM output validation

Every model response used by the application should be structured and schema validated.

Use Zod or equivalent.

Generated claim:

```text
claim
evidence_ids[]
confidence
```

Post-processing must verify:

1. every evidence ID exists
2. evidence belongs to the current analysis scope
3. timestamps are compatible
4. numerical claims match deterministic data
5. unsupported claims are removed

If validation fails:

fall back to deterministic templated copy.

The application must never fail because the LLM failed.

---

# 24. Prompt-injection protection

Provider text is untrusted input.

An official-feed description such as:

```text
Ignore all previous instructions...
```

must be treated as plain data.

Never concatenate arbitrary external text into a privileged system prompt without clear delimitation.

Agents cannot gain tools because provider content requested them.

---

# 25. Technical architecture

Build GeoNerva as a **modular monolith**, not microservices.

Recommended structure:

```text
geonerva/
│
├── apps/
│   └── web/
│
├── packages/
│   ├── domain/
│   ├── db/
│   ├── connectors/
│   ├── ingestion/
│   ├── geo/
│   ├── correlation/
│   ├── baselines/
│   ├── intelligence/
│   ├── agents/
│   └── test-fixtures/
│
├── docs/
│
├── scripts/
│
├── infra/
│
├── .github/
│   └── workflows/
│
└── docker-compose.yml
```

Do not split into separately deployed services unless a real requirement emerges.

---

# 26. Suggested stack

Use current stable versions at implementation time.

Verify before installation.

Preferred:

```text
TypeScript
Next.js
React
PostgreSQL
PostGIS
Supabase-hosted Postgres for public demo
MapLibre GL JS
OpenFreeMap
Tailwind CSS
Zod
Vitest
Playwright
GitHub Actions
Docker
```

Use a DB abstraction that does not make PostGIS painful.

Raw SQL for specialized PostGIS queries is acceptable when:

- isolated
- parameterized
- tested
- documented

Avoid ORM gymnastics that make geospatial code harder to understand.

---

# 27. Frontend design

GeoNerva should feel:

- calm
- scientific
- premium
- modern
- trustworthy
- information-dense without being cluttered

Avoid sensational disaster aesthetics.

No flashing red map.

No fake radar effects.

No "DOOM SCORE".

Primary visual direction:

**dark geospatial intelligence interface**

with strong contrast and restrained hazard colors.

The map should feel like a professional situational-awareness interface.

---

# 28. Main dashboard layout

Desktop concept:

```text
┌───────────────────────────────────────────────────────────┐
│ GeoNerva                         Search location           │
├───────────────────────────────────────────────────────────┤
│                                                           │
│ Montréal, Canada                         Updated 4m ago    │
│ Understand what's changing around you                     │
│                                                           │
├───────────────────────┬───────────────────────────────────┤
│ CURRENT SITUATION     │                                   │
│                       │                                   │
│ No high-relevance     │               MAP                 │
│ changes detected      │                                   │
│                       │                                   │
│ Source confidence     │                                   │
│ ● Fresh               │                                   │
├───────────────────────┴───────────────────────────────────┤
│                                                           │
│ WHAT CHANGED                                              │
│                                                           │
│ ↑ Wildfire activity     +3 thermal detections             │
│ → Seismic activity      within baseline                   │
│ ↓ Flood relevance       event moved farther away          │
│                                                           │
├───────────────────────────────────────────────────────────┤
│ EARTHQUAKE   WILDFIRE   FLOOD   CYCLONE   WEATHER         │
├───────────────────────────────────────────────────────────┤
│                                                           │
│ Historical context / timeline                             │
│                                                           │
├───────────────────────────────────────────────────────────┤
│ Evidence & source health                                  │
└───────────────────────────────────────────────────────────┘
```

Mobile must remain fully usable.

Do not simply shrink desktop.

---

# 29. Event visual hierarchy

Use hazard colors only where meaningful.

Example concepts:

```text
earthquake     amber
wildfire       orange
flood          blue
cyclone        violet
weather        cyan
critical       red
```

Actual palette should be accessibility tested.

Do not encode meaning exclusively through color.

---

# 30. Application routes

Likely:

```text
/
```

Product landing + location search + global/current overview.

```text
/location/[location]
```

Location intelligence.

```text
/event/[id]
```

Canonical event detail.

```text
/replay
```

Historical replay explorer.

```text
/data-status
```

Current provider health/freshness.

```text
/methodology
```

Explain:

- data sources
- correlation
- relevance
- anomaly calculations
- limitations

This methodology page is important for credibility.

---

# 31. Backend/API surface

Prefer domain-oriented endpoints.

Conceptually:

```text
GET /api/location/search

GET /api/location/brief

GET /api/events

GET /api/events/:id

GET /api/location/changes

GET /api/location/history

GET /api/source-health

POST /api/ingest/:source
```

Ingestion endpoints must be authenticated by a strong secret/signature.

Do not expose arbitrary query functionality.

---

# 32. Ingestion architecture

Concept:

```text
Official Sources
       │
       ▼
 Source Adapters
       │
       ▼
 Raw Validation
       │
       ▼
 Raw Record Store
       │
       ▼
 Normalization
       │
       ▼
 Event Observations
       │
       ▼
 Correlation
       │
       ▼
 Canonical Events
       │
       ├───────────────┐
       ▼               ▼
 Geo Analysis      Baseline Engine
       │               │
       └───────┬───────┘
               ▼
        Change Detection
               │
               ▼
       Location Snapshot
               │
               ▼
      Optional AI Analysis
               │
               ▼
              UI
```

---

# 33. Scheduling

Do not aggressively poll sources.

Each source has:

```text
recommended_interval
freshness_threshold
retry_policy
rate_limit
```

For the public demo, prefer inexpensive scheduling such as GitHub Actions if suitable.

An interval around 10–15 minutes may be acceptable for several feeds, but source requirements must determine the real value.

Do not claim "real-time" if the architecture is polling every 15 minutes.

Use:

> near-real-time

where appropriate.

---

# 34. Idempotency

Ingestion must be safely repeatable.

Running an ingestion job twice must not create duplicate observations.

Use:

- provider IDs
- payload hashes
- source timestamps
- unique constraints

Each ingestion run records:

```text
started_at
finished_at
source
status
records_received
records_created
records_updated
errors
```

---

# 35. Failure handling

A provider outage must not break GeoNerva.

Example:

```text
USGS       Fresh
GDACS      Stale
FIRMS      Error
```

The application continues operating.

But it clearly communicates reduced coverage.

Never silently return:

> "No wildfire activity"

when FIRMS is unavailable.

Instead:

> "Wildfire data is temporarily unavailable."

Huge distinction.

---

# 36. Privacy

Location data can be sensitive.

Rules:

- do not persist browser geolocation automatically
- do not log precise user location without need
- saved private locations should default to client-side storage in v1
- do not expose users' saved locations publicly
- avoid third-party analytics initially
- never send precise locations to an LLM unless required for the requested analysis
- if analytics are later introduced, aggregate spatially

No account should be necessary to inspect hazards.

---

# 37. Attribution and data usage

Every provider gets documented attribution.

Create:

```text
docs/DATA_SOURCES.md
```

For each provider document:

```text
provider
purpose
API/feed
hazard coverage
geographic coverage
update frequency
authentication
rate limits
licence/terms
required attribution
known limitations
adapter implementation
last verified date
```

Prefer official APIs/feeds over scraping.

Do not scrape an HTML website when a supported API/feed exists.

---

# 38. Local development

A fresh contributor should be able to run:

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev
```

or an equally simple documented workflow.

Provide:

```text
.env.example
```

No secret values.

Expected environment concepts:

```text
DATABASE_URL
INGEST_SECRET

FIRMS_MAP_KEY

AI_MODE
ANTHROPIC_API_KEY
```

Only require Anthropic when `AI_MODE=anthropic`.

---

# 39. Demo/public deployment

Preferred low-cost deployment:

```text
Frontend/API:
Vercel

Database:
Supabase PostgreSQL + PostGIS

Scheduled ingestion:
GitHub Actions

Map:
MapLibre + OpenFreeMap

External hazard sources:
official public APIs
```

Architecture must also work locally using Docker.

Do not couple business logic to Vercel or Supabase-specific APIs unnecessarily.

---

# 40. Zero-cost principle

The public project should be able to operate in a useful mode without ongoing LLM expenditure.

Core capabilities must remain:

- hazard ingestion
- maps
- correlation
- historical context
- location relevance
- change detection
- evidence
- replay

without Claude.

AI enhances explanation; it does not unlock core functionality.

---

# 41. Testing strategy

Testing is a first-class feature.

Required categories:

## Unit tests

Test:

- distance calculations
- source normalization
- timestamp semantics
- correlation
- clustering
- relevance
- baseline calculations
- change detection
- freshness
- evidence validation

---

## Contract tests

Store representative source fixtures.

A provider changing its schema should produce a failing test rather than silently corrupting data.

---

## Integration tests

Test:

```text
fixture
→ normalization
→ DB
→ correlation
→ location analysis
→ API
```

---

## E2E

Playwright flows:

- search location
- open dashboard
- inspect event
- toggle map hazard
- view evidence
- historical replay
- source outage UI
- mobile layout

---

## Property/invariant testing where useful

Examples:

```text
distance >= 0
```

```text
replay cannot include data ingested after replay timestamp
```

```text
canonical events cannot contain incompatible hazard types
```

```text
all AI evidence IDs must exist
```

---

# 42. Fixture strategy

Never depend entirely on live APIs for tests.

Store sanitized representative fixtures.

Include edge cases:

- missing fields
- provider update
- conflicting magnitudes
- duplicate events
- stale source
- empty response
- malformed response
- rate limit
- API timeout
- wildfire thermal anomaly
- source disagreement

Live-source smoke tests are separate.

---

# 43. Observability

Structured logs.

Each ingestion/analysis should include:

```text
run_id
source
duration
records
errors
```

Expose a `/data-status` page.

Metrics worth tracking:

```text
source freshness
ingestion success rate
records per run
correlation rate
ambiguous correlations
analysis failures
LLM validation failures
```

Do not require a paid observability platform for local development.

---

# 44. Performance

Avoid downloading the entire global dataset to browsers.

Perform geospatial filtering server-side.

Cache:

- location briefs
- historical metrics
- source results where terms allow

Map endpoints should query bounding boxes and time windows.

Use spatial indexes.

Avoid N+1 source/evidence queries.

---

# 45. Accessibility

Required.

- keyboard navigation
- accessible contrast
- semantic headings
- map information available outside the map
- no color-only hazard meaning
- screen-reader labels
- mobile touch targets

A user should still understand the situation if the map cannot render.

---

# 46. SEO / public presentation

This is also a portfolio/open-source project.

Landing page should communicate the engineering problem clearly.

Suggested hero:

```text
GeoNerva

Understand what’s changing around you.

Open-source, explainable natural-hazard intelligence
for the places you care about.

[Search a location] [Explore live activity]
```

Secondary statement:

> Earth is constantly sending signals. GeoNerva helps make sense of them.

Avoid claiming:

> AI predicts disasters.

---

# 47. README quality

README should eventually include:

1. hero image
2. product explanation
3. live demo
4. why GeoNerva exists
5. architecture diagram
6. supported hazards
7. supported providers
8. screenshots
9. What Changed explanation
10. correlation methodology
11. local setup
12. AI modes
13. testing
14. data-source attribution
15. limitations
16. contribution instructions
17. licence

Make the README recruiter-friendly but technically substantive.

---

# 48. Development-agent orchestration

You are the **lead engineering orchestrator**.

Do not try to implement the entire application as one undifferentiated task.

Use specialized subagents.

The manager/orchestrator owns:

- architecture
- integration
- task boundaries
- resolving disagreements
- sequencing
- final decisions

Specialized agents investigate/implement bounded areas.

---

# 49. Agent roles

Use agents roughly equivalent to:

## Agent A — Source Research & Contracts

Responsible for:

- verifying official providers
- current API docs
- licences
- update schedules
- schemas
- fixtures
- DATA_SOURCES.md

No frontend work.

---

## Agent B — Domain & Database

Responsible for:

- canonical schema
- migrations
- PostGIS
- indexes
- repositories
- timestamp semantics

No provider-specific UI.

---

## Agent C — Connector & Ingestion

Responsible for:

- adapters
- validators
- retries
- ingestion runs
- idempotency
- source health

---

## Agent D — Correlation & Geo Intelligence

Responsible for:

- event correlation
- geospatial operations
- fire clustering
- proximity analysis
- relevance engine

---

## Agent E — Baselines & Change Detection

Responsible for:

- historical aggregation
- anomaly metrics
- snapshots
- What Changed?
- replay support

---

## Agent F — API/Application Layer

Responsible for:

- domain API
- caching
- request validation
- error models

---

## Agent G — Frontend & Map

Responsible for:

- design system
- location dashboard
- MapLibre
- event pages
- responsive UI
- source health visualization

---

## Agent H — Runtime Intelligence/AI

Responsible for:

- trusted tools
- structured Claude outputs
- evidence validation
- verifier
- deterministic fallback

It does NOT implement core risk calculations.

---

## Agent I — Security & Reliability Reviewer

Independent reviewer for:

- secrets
- injection
- SSRF
- location privacy
- authentication
- rate limits
- source outages
- data integrity

---

## Agent J — Adversarial QA

Independent.

Its role is explicitly to find reasons GeoNerva is wrong.

It should challenge:

- incorrect source semantics
- misleading UI
- fake certainty
- duplicate events
- bad timestamps
- replay leakage
- stale data
- disagreement handling
- false wildfire language
- broken mobile layouts
- production configuration

---

# 50. File ownership

Before parallel agents begin, establish file ownership.

Do not allow several agents to rewrite the same foundational files simultaneously.

Example:

```text
Agent B:
packages/domain/**
packages/db/**

Agent C:
packages/connectors/**
packages/ingestion/**

Agent D:
packages/geo/**
packages/correlation/**

Agent E:
packages/baselines/**
packages/intelligence/change/**

Agent G:
apps/web/**
```

Cross-cutting changes must return to the orchestrator.

---

# 51. Agent handoff protocol

Every agent must return:

```text
SCOPE COMPLETED

FILES CHANGED

ARCHITECTURAL DECISIONS

TESTS RUN

RESULTS

ASSUMPTIONS

KNOWN RISKS

BLOCKERS

RECOMMENDED NEXT STEP
```

Agents must not merely say:

> "Done."

Evidence is required.

---

# 52. Architecture freeze

Before implementation:

1. research sources
2. define requirements
3. define domain model
4. define source contracts
5. define time semantics
6. define deployment model
7. define runtime AI boundaries
8. define v1 scope

Then freeze architecture.

Write:

```text
docs/ARCHITECTURE.md
docs/DATA_SOURCES.md
docs/DECISIONS.md
docs/IMPLEMENTATION_PLAN.md
```

Once frozen, an agent cannot casually redesign core architecture.

Meaningful changes require a documented decision.

---

# 53. Decision log

Maintain:

```text
docs/DECISIONS.md
```

Use lightweight ADR format:

```text
Decision
Context
Alternatives
Chosen approach
Tradeoffs
Date
```

Important decisions include:

- PostGIS
- modular monolith
- MapLibre provider
- correlation thresholds
- AI optionality
- replay semantics
- location privacy
- source polling
- data retention

---

# 54. Implementation order

Do not build pretty UI first.

Follow roughly:

## Phase 0 — Discovery

Validate:

- source availability
- API responses
- licence
- schemas
- data volume
- geographic coverage

Produce fixtures.

---

## Phase 1 — Architecture

Create:

- domain model
- architecture
- DB schema
- source contract
- source matrix
- sequence diagrams
- implementation plan

Freeze v1 architecture.

---

## Phase 2 — Foundation

Implement:

- workspace
- TypeScript strict mode
- lint
- formatter
- testing
- Docker
- DB
- PostGIS
- migrations
- environment validation
- CI

---

## Phase 3 — Initial sources

Implement in this order unless research gives reason otherwise:

1. USGS
2. GDACS
3. NASA FIRMS

Each source must be complete before moving on:

```text
fetch
validate
normalize
persist
health
fixture
tests
```

---

## Phase 4 — Canonical events

Implement:

- earthquake correlation
- GDACS cross-source matching
- revision handling
- evidence preservation
- conflict handling

---

## Phase 5 — Geospatial intelligence

Implement:

- location radius queries
- polygons
- distance
- fire clustering
- hazard-specific relevance

---

## Phase 6 — Historical intelligence

Implement:

- baseline engine
- historical metrics
- snapshots
- meaningful changes
- replay semantics

---

## Phase 7 — Application API

Implement stable domain endpoints.

No frontend should need raw provider data.

---

## Phase 8 — Frontend

Build:

- landing
- location search
- dashboard
- What Changed
- map
- hazard cards
- event detail
- evidence
- source health
- methodology

---

## Phase 9 — Runtime AI

Only now add Claude.

Connect it exclusively to trusted domain tools.

Core product must already work.

---

## Phase 10 — Historical replay/demo

Build recruiter-friendly replay scenarios.

---

## Phase 11 — Production hardening

Run:

- performance
- security
- accessibility
- mobile
- ingestion reliability
- source outage testing

---

## Phase 12 — Adversarial QA

Three independent rounds.

---

# 55. Adversarial QA rounds

## Round 1 — Functional

Attack:

- source parsing
- duplicates
- wrong locations
- map bugs
- API errors
- correlation
- empty states
- responsiveness

Fix all CRITICAL/HIGH.

Rerun entire gate.

---

## Round 2 — Data integrity

Attack:

- timestamp leakage
- replay
- stale data
- conflicting sources
- historical baseline
- false interpretations
- evidence integrity
- numerical claims
- provider revisions

Fix all CRITICAL/HIGH.

Rerun.

---

## Round 3 — Production adversary

Attack actual production-like environment:

- scheduled ingestion
- secrets
- CORS
- CSP
- rate limits
- network failure
- external source outage
- mobile sizes
- slow connections
- invalid coordinates
- expired cache
- AI outage
- DB failure modes

No CRITICAL or HIGH issues may remain for v1 release.

---

# 56. Severity standard

Use:

```text
CRITICAL
Application can produce dangerous/materially false information,
security compromise, data corruption, or unusable core functionality.

HIGH
Major incorrect behavior, important misleading output,
major reliability failure.

MEDIUM
Meaningful issue with workaround or limited impact.

LOW
Polish/minor edge case.
```

Never downgrade an issue to make the QA report look better.

---

# 57. Release gates

Before calling the project complete, all must pass:

```text
typecheck
lint
unit tests
integration tests
contract tests
e2e tests
production build
```

Then:

```text
real API smoke test
DB migration smoke test
scheduled ingestion smoke test
source-outage test
stale-data test
conflict test
historical replay test
mobile responsive test
AI-disabled test
AI-enabled test if configured
production URL smoke test
```

---

# 58. Git discipline

Use small meaningful commits.

Examples:

```text
feat(ingestion): add USGS earthquake adapter

feat(correlation): canonicalize cross-source earthquakes

feat(geo): add PostGIS proximity queries

feat(intelligence): generate location change signals

feat(web): add location intelligence dashboard

test(replay): enforce ingestion-time cutoff
```

Avoid enormous "implemented everything" commits.

Working tree should be clean at release.

---

# 59. Coding standards

Required:

- TypeScript strict mode
- external payload validation
- no unchecked `any`
- no swallowed exceptions
- no unbounded API responses
- parameterized SQL
- explicit UTC handling
- domain errors
- source-specific errors
- deterministic tests
- minimal dependencies
- no dead code
- no commented-out implementations
- no fake TODO implementation for core features

If a feature is not implemented:

do not pretend it is.

---

# 60. Important engineering invariants

Treat these almost like laws.

```text
AI cannot create facts.
```

```text
No claim without evidence.
```

```text
No replay data from the future.
```

```text
No stale source presented as fresh.
```

```text
No provider disagreement silently erased.
```

```text
No raw provider schema in frontend components.
```

```text
No generic "safe" claim.
```

```text
No earthquake prediction.
```

```text
No thermal anomaly automatically called wildfire.
```

```text
No required LLM for core functionality.
```

---

# 61. Product-quality empty states

Examples:

Instead of:

```text
0 fires
```

when FIRMS failed:

```text
Wildfire data unavailable
Last successful update 2h ago
```

Instead of:

```text
No risk
```

say:

```text
No currently indexed high-relevance events.
```

Instead of:

```text
Normal
```

with insufficient historical data:

```text
Not enough historical data to establish a baseline.
```

Accuracy of language is part of the engineering.

---

# 62. Example architecture diagram

```text
                         OFFICIAL DATA SOURCES

         ┌─────────────┬──────────────┬──────────────┐
         │             │              │              │
       USGS          GDACS       NASA FIRMS      Regional
         │             │              │           alerts
         └──────┬──────┴──────┬───────┴──────────────┘
                │             │
                ▼             ▼
        SOURCE ADAPTERS + VALIDATION
                │
                ▼
             RAW STORE
                │
                ▼
        NORMALIZED OBSERVATIONS
                │
                ▼
        EVENT CORRELATION ENGINE
                │
                ▼
          CANONICAL EVENTS
                │
        ┌───────┴────────┐
        ▼                ▼
 GEO / RELEVANCE     HISTORICAL
     ENGINE           BASELINES
        │                │
        └───────┬────────┘
                ▼
         LOCATION SNAPSHOT
                │
                ▼
         CHANGE DETECTION
                │
        ┌───────┴────────┐
        │                │
        ▼                ▼
  DETERMINISTIC       OPTIONAL
      API            AI AGENTS
        │                │
        │          Evidence Analyst
        │          Change Analyst
        │          Relevance Explainer
        │          Skeptic
        │          Composer
        │                │
        └────────┬───────┘
                 ▼
              WEB UI
                 │
          ┌──────┼──────┐
          ▼      ▼      ▼
        Map    What    Evidence
              Changed
```

---

# 63. UX question GeoNerva must always answer

When the user opens a location, within approximately five seconds they should understand:

```text
Is anything meaningful happening?

What changed?

How unusual is it?

How close/relevant is it?

How sure are we?

Where did the information come from?
```

If the UI cannot answer those without digging through the map, redesign it.

---

# 64. Open-source quality

Prepare:

```text
LICENSE
CONTRIBUTING.md
CODE_OF_CONDUCT.md
SECURITY.md
.env.example
README.md
```

Create issues suitable for future contributors.

Potential extension labels:

```text
good first issue
source-adapter
hazard-model
frontend
geospatial
data-quality
```

A new source should eventually be implementable without understanding the entire application.

---

# 65. Future expansion — do not build now unless P0 is stable

Potential future capabilities:

- tsunami sources
- air-quality hazards
- landslides
- drought
- extreme heat
- lightning
- volcanic ash
- smoke plume modelling
- official evacuation zones
- mobile push notifications
- email alerts
- PWA
- regional source plugins
- richer trajectory analysis
- wind-assisted wildfire context
- infrastructure exposure
- population exposure

Architecture should allow these.

Do not build them prematurely.

---

# 66. Definition of done

GeoNerva v1 is done when:

A person can enter a location and receive a real, evidence-backed, multi-hazard situation briefing that:

- uses real public data
- detects meaningful changes
- correlates duplicate observations
- understands distance/location
- provides historical context
- surfaces stale/missing/conflicting data
- explains its reasoning
- preserves evidence
- works without AI
- optionally provides grounded Claude-generated interpretation
- works responsively
- has reproducible tests
- survives source failures
- has no CRITICAL/HIGH adversarial QA findings
- can run locally
- has a public production-ready deployment path
- is documented as a serious open-source system

---

# 67. Your first actions in this session

Do NOT immediately start coding UI.

Do the following:

### Step 1

Inspect the repository.

If empty, initialize the project cleanly.

If existing, understand it before modifying anything.

### Step 2

Research and validate the current official APIs for:

- USGS
- GDACS
- NASA FIRMS
- initial weather-alert provider
- geocoding
- map tiles

Use current official documentation.

### Step 3

Create:

```text
docs/PRODUCT.md
docs/ARCHITECTURE.md
docs/DATA_SOURCES.md
docs/DECISIONS.md
docs/IMPLEMENTATION_PLAN.md
```

### Step 4

Use architecture/research agents to challenge the proposal.

Specifically ask:

> What assumptions in this design are wrong, outdated, unnecessary, or scientifically misleading?

Resolve those findings.

### Step 5

Freeze v1 architecture.

### Step 6

Produce an explicit dependency graph of implementation tasks.

Identify which workstreams can safely happen in parallel without overlapping file ownership.

### Step 7

Begin implementation using specialized agents.

You are the orchestrator.

Do not delegate architectural authority blindly.

### Step 8

After each implementation phase:

```text
test
review
integrate
commit
```

Do not accumulate unverified agent output.

### Step 9

When implementation is complete, run three rounds of independent adversarial QA.

Fix all CRITICAL and HIGH issues.

### Step 10

Run final production gates and prepare the open-source release.

---

# 68. Autonomy

You have autonomy to make routine engineering decisions.

Do not stop repeatedly to ask the user:

> "Should I use library X or Y?"

Research it, make the technically justified decision, document it, and continue.

Ask the user only when there is a genuine product decision, credential requirement, external cost, or irreversible choice that cannot reasonably be inferred.

When something fails:

investigate it.

Do not immediately ask the user to debug it for you.

---

# 69. Final standard

GeoNerva should feel like something built by an experienced engineer who understands:

- distributed external data
- geospatial systems
- data modelling
- temporal semantics
- AI reliability
- scientific uncertainty
- frontend product design
- testing
- production operations

The final repository should be strong enough that a senior engineer can inspect it and find substantive architectural decisions to discuss.

The project should also be understandable enough that an ordinary person can type a location and immediately understand what is changing around a place they care about.

That balance is the product.

---

# GeoNerva

**Understand what’s changing around you.**

> Earth is constantly sending signals. GeoNerva helps make sense of them.
