# GeoNerva — Product Definition (v1)

> **Understand what's changing around you.**
> Status: proposed for freeze, 2026-09-19. Derived from `GEONERVA_MASTER_BRIEF.md`, then corrected by source research (`DATA_SOURCES.md`) and architecture review (`DECISIONS.md`).

## 1. Purpose

GeoNerva answers one question for a place a person cares about:

> What is changing around this place, how unusual is it, how relevant is it here, how sure are we, and where did the information come from?

It is a **situational-awareness and decision-support tool**, not an emergency-warning system. When an official warning exists, GeoNerva links to it and never replaces it.

## 2. Users and jobs

| User | Job | What they need in the first 5 seconds |
|---|---|---|
| Resident / traveller / family member | "Is anything happening near my parents in Marrakech?" | A calm headline, the top changes, and honesty about gaps |
| Journalist / analyst | "What changed near this earthquake since yesterday, and do sources agree?" | Change list, source agreement, evidence links, timestamps |
| Engineer / recruiter evaluating the project | "Is this real engineering?" | Methodology, provenance, replay, data-status, a readable repository |

## 3. Non-goals (hard)

GeoNerva is not:
- a generic weather app
- a hazard dot-map
- an earthquake predictor
- an LLM wrapper or chatbot
- an emergency alert replacement
- a single "risk score"

It never invents probabilities, never says a place is "safe", never calls a satellite thermal detection a "wildfire", and never says "real-time" (it is **near-real-time**, and each source has its own latency, which is shown).

## 4. v1 scope

The rule for P0: keep everything needed to preserve the differentiators, which are:
- location-specific intelligence
- multi-source ingestion
- deterministic correlation
- What Changed?
- historical context
- freshness
- provenance
- explainable relevance
- graceful failure

Cut everything else.

### 4.1 P0: must ship

| # | Capability | Why it is P0 |
|---|---|---|
| 1 | **Location search**: local type-ahead (GeoNames), submit search (Nominatim, cached), coordinate entry, "Use my location" (explicit click; coordinates rounded to ~1 km, never stored) | Entry point |
| 2 | **Sources**: USGS, **EMSC**, GDACS (EQ, FL, TC, VO, WF, DR), NASA FIRMS (NOAA-20, NOAA-21) | EMSC is the only independent second earthquake source (GDACS copies USGS). Without it, "source agreement" is theatre, and outside the US (e.g. Morocco) USGS alone is nearly empty below M4.5 |
| 3 | **Append-only, bitemporal fact store** + `as_of` in the API | Required for What Changed, auditing and replay. Retrofitting it later means rewriting the storage layer |
| 4 | **Deterministic earthquake correlation**: identity references first, spatiotemporal second, ambiguity kept separate, agreement computed from independent sources only | Core differentiator |
| 5 | **Fire activity clustering** (detections → clusters), labelled as thermal activity | Showing 200k raw points as "wildfires" is misleading |
| 6 | **Hazard-specific relevance** for earthquakes, fire activity, floods, cyclones and volcanoes, with `level + reasons[] + evidence_ids[]` | Core differentiator |
| 7 | **Historical context**: earthquake baselines (completeness-aware percentile or rarity statement), fire *trend* (7 d vs 28 d), GDACS event context | Core differentiator, limited to what the data can honestly support |
| 8 | **What Changed?** over a selectable window (6 h / 24 h / 7 d), with materiality filters, prominence, and visible suppressed changes | Flagship |
| 9 | **Source health & coverage**: per-source status, data currency vs poll freshness, per-location coverage (including "not covered") | "No data" ≠ "no hazard" |
| 10 | **Evidence & provenance**: evidence IDs on every derived statement, evidence drawer, resolver endpoint, original source links | Trust |
| 11 | **Location dashboard, map, event detail, fire-cluster detail, /data-status, /methodology** | Delivery surface |
| 12 | **Deterministic templated language** for every briefing sentence | The product must be complete with `AI_MODE=disabled` |
| 13 | Accessibility (WCAG 2.2 AA target), mobile-first layouts, map-independent list view | Required by the brief and by users on phones |
| 14 | Deployment: web + worker + Postgres, lean retention profile, CI, nightly live smoke tests | "Can run locally; has a production path" |

### 4.2 P1: after launch, in order

| # | Capability | Why not P0 |
|---|---|---|
| 1 | **Replay UI** + curated **historical scenarios** (reconstructed timelines, clearly labelled) | The engine ships in P0. The UI and scenario curation are polish on top. Scenarios predating GeoNerva must be *reconstructed* from provider revision history and labelled as such |
| 2 | **Runtime AI** (Interpreter + Skeptic, worker-side, cached, budget-capped) | Optional by definition. Needs the deterministic packet and an evaluation set first |
| 3 | **Weather alerts: ECCC** (GeoMet), then **NWS** | Canada/US only. Coverage gaps are already demonstrated by P0. It adds a distinct alert-lifecycle model and a licence constraint (verbatim text) |
| 4 | Watch places (browser storage) + "since my last visit" | Pure client feature on top of P0 APIs |
| 5 | Shareable report = immutable `as_of` permalink + print view | Nearly free once `as_of` exists |
| 6 | Seasonal fire baseline (NOAA-20 archive backfill), persistent heat-source flag, GDACS WF ↔ cluster relation | Needs archive verification and months of data |
| 7 | Earthquake "possibly felt here" (intensity prediction), ShakeMap contour for CRITICAL, PAGER details | Scientific validation effort |
| 8 | Protomaps fallback basemap, vector tiles (MVT), EMSC websocket, ECCC AMQPS push | Operational improvements |

### 4.3 Deferred (not planned for v1.x)

- **Ask GeoNerva** (natural-language Q&A). Large abuse, cost and prompt-injection surface, and weak value until the AI briefing is proven.
- `AI_MODE=local`
- Accounts / sync
- Push or email notifications, PWA
- Tsunami, air quality, landslides, drought modelling, heat, lightning, volcanic ash, smoke plumes, evacuation zones
- Population and infrastructure exposure
- Wind-assisted fire context
- H3 global anomaly map
- MODIS/SNPP historical fire analysis (sensors retiring and not comparable)

### 4.4 Scope changes vs the brief (summary; details in `DECISIONS.md`)

| Change | Direction |
|---|---|
| EMSC earthquake source | **added to P0** |
| Replay *semantics* (bitemporal storage, `as_of`) | P1 → **P0** (UI stays P1) |
| Weather alerts (ECCC) | P0 → **P1** |
| Runtime AI | "optional in v1" → **P1** |
| Ask GeoNerva | P1 → **Deferred** |
| Server-side watched locations | removed (privacy); browser-only in P1 |
| Fire "historical abnormality" | P0 → P0 *trend* only; seasonal baseline P1 |

## 5. Core journey (P0)

1. The user opens `/` and types "Marrak…". Suggestions appear instantly from the local place table.
2. The user selects "Marrakech, Morocco" and is taken to `/place/marrakech-ma-2542997`.
3. Within ~1 s they see the headline, the data time, the top changes in the last 24 h, the family cards and a map.
4. They tap "M4.7 · 61 km SW of Midelt" and open the event page. It shows two sources (USGS Mww 4.7, EMSC mb 4.6), agreement "minor differences", the version timeline and evidence.
5. They open "Sources" and see FIRMS "Data currency: newest detection 3 h 40 min ago (expected ≤ 6 h)". The status is fresh because FIRMS latency is normal.

## 6. Information architecture

### 6.1 Routes

| Route | Purpose |
|---|---|
| `/` | Hero and search. "Try: Marrakech · Montréal · Manila · Istanbul" (curated, materialized places). Short "how it works" + link to methodology |
| `/place/[slug]` | Location intelligence dashboard. Slug = `name-cc-geonameid` for named places, or `@lat,lon` (rounded) for coordinates |
| `/event/[publicId]` | Canonical event detail (EQ, flood, cyclone, volcano, drought, wildfire event) |
| `/fire/[publicId]` | Fire activity cluster detail |
| `/data-status` | Source health, cadence, latency, recent runs, attribution |
| `/methodology` | Sources, correlation, relevance models, baselines, change detection, limitations, disclaimers, attribution. Every threshold rendered from the same config the code uses |
| `/replay` (P1) | Scenario list + time slider on a location |

All routes accept `?as_of=` (P0 API; P1 UI affordances). With `as_of` set, the whole page shows a persistent **Replay banner**.

### 6.2 Dashboard hierarchy

Order is by the questions the page must answer:

| # | Region | Answers | Content |
|---|---|---|---|
| 1 | **Header** | Where / when | Place, country, local time, "Data as of 14:06 local · 4 min ago", window selector (6 h · 24 h · 7 d) |
| 2 | **Situation strip** | Is something meaningful happening? How sure are we? | One headline sentence (§9.8 of ARCHITECTURE), overall data-confidence chip with reasons on hover/tap, coverage line ("Weather warnings: not covered here") |
| 3 | **What Changed** | What changed? | Up to 3 HEADLINE items, then LISTED items, then "Show 12 minor changes" (suppressed, with reasons). Each item: arrow/icon + text, relevance badge, time, evidence link |
| 4 | **Hazard family cards** | How unusual? How relevant? | Earthquakes · Fire activity · Floods · Cyclones · Volcanoes & other · Weather alerts (P0: shows "not covered yet"). Each card: STATUS · CHANGE · CONTEXT · RELEVANCE · CONFIDENCE · SOURCES |
| 5 | **Map** | Where exactly? | Location pin, analysis radius rings, layers per family (toggleable), legend with shapes + colours |
| 6 | **Nearby list** | Same as map, accessibly | Sortable table of assessed items (distance, level, time, source count), the non-map equivalent |
| 7 | **Historical context** | How unusual, in detail | Per family: metric value, reference distribution (small histogram), percentile/rarity statement, Mc/sensor caveats |
| 8 | **Sources & evidence** | Where did it come from? | Per-source health rows, attribution, evidence list for this briefing |

**Desktop (≥ 1024 px):**
- Two columns: left 5/12 holds regions 2–4 and 6–8, scrolling; right 7/12 holds a sticky map.
- The header spans the full width.

**Mobile (< 768 px):**
- Single column: header → situation → What Changed → cards (accordion; the first card with HIGH+ relevance is expanded) → map preview (~200 px, "Open map" opens a full-screen sheet with a layer drawer) → nearby list → context → sources.
- Evidence opens in a bottom sheet.
- Touch targets ≥ 44 px.
- No hover-only information.

### 6.3 Hazard card anatomy

```text
EARTHQUAKES                                   Data: USGS ● EMSC ● GDACS ●   Confidence: MEDIUM ⓘ
STATUS      2 earthquakes (M ≥ 3.1) within 150 km in the last 7 days
CHANGE      +1 since 24 h ago — M4.7 · 61 km SW of Midelt · 2 sources
CONTEXT     Above typical for this area (91st percentile of comparable weeks since 2021)
            Elevated recent activity does not by itself indicate that a larger earthquake will occur.
RELEVANCE   MODERATE — 142 km away · M4.7 · 10 km deep            [Why?]
SOURCES     USGS (Mww 4.7) · EMSC (mb 4.6) · agreement: minor differences      [Evidence]
```

The card has three explicit empty states:

| State | Example |
|---|---|
| Unavailable | "Fire activity data unavailable — NASA FIRMS last updated 5 h ago (expected ≤ 90 min). Absence of detections cannot be confirmed." |
| Not covered | "Weather warnings are not covered for this location." |
| Insufficient history | "Not enough history to establish a baseline." |

### 6.4 Observed vs derived vs AI

Three visual registers, consistent everywhere:
- **Observed**: provider values, set in regular text with a source badge (e.g. `USGS`), plus timestamps.
- **Derived by GeoNerva**: relevance, baselines and changes, marked with a small "Derived" tag and a `Why?` affordance that lists reasons and evidence.
- **AI summary (P1)**: a separate framed block labelled "AI-written summary of the evidence below — checked automatically; may be incomplete". It is never interleaved with observed values. It is hidden when AI is disabled, unavailable or rejected, and nothing else on the page changes.

### 6.5 Map responsibilities

- **The map shows:**
  - location
  - radius rings (per selected family)
  - canonical events (EQ circles sized by magnitude, distinct shape per family)
  - fire clusters, at every zoom. Individual detections at zoom ≥ 8 (ARCHITECTURE §7.5) are **not built**: ADR-039 removed the correctness objection, and the remaining work is scope — payload budget, zoom behaviour and cap semantics the frozen `MapFeaturesResponse` does not describe. The map does not claim to show them.
  - flood areas (hatched fill, labelled "modelled area")
  - cyclone track (solid = observed, dashed = forecast), wind buffers, cone
  - volcanoes
- **The map never carries information that is not also in the list/cards.** It is progressive enhancement, and the page is fully usable if WebGL2 is unavailable (MapLibre v6 requires WebGL2).
- Layer toggles per family, keyboard accessible. Legend uses shape + pattern + colour. Colours are restrained and accessibility-tested:
  - amber: earthquakes
  - orange: fire activity
  - blue: floods
  - violet: cyclones
  - red: reserved for CRITICAL
- No flashing and no radar sweeps.

### 6.6 Event detail (`/event/[id]`)

Sections, in order:
1. Title (e.g. "M4.7 earthquake · 61 km SW of Midelt, Morocco"), canonical ID, hazard type, status.
2. Key facts with **per-source values** side by side (magnitude + type, time, depth, location), the spread, and the agreement level with explanation. "Headline value from USGS (reviewed)".
3. Relevance for the selected place (if arriving from a place), with reasons and evidence.
4. Timeline of versions, per source: `observed_at`, `source_updated_at`, `ingested_at`, and what changed.
5. Correlation decisions: why these observations are one event (identity reference / misfit breakdown), and possible matches not merged.
6. Historical context near the event.
7. Geometry on a small map.
8. Official links: provider event pages, GDACS report, and tsunami warning centre links when the USGS flag is set.
9. Evidence list with raw excerpts.

### 6.7 Source health presentation

**Global view (`/data-status`).** Each source row shows:
- status chip (FRESH / DEGRADED / STALE / UNAVAILABLE) with a text label, not just colour
- last successful poll + expected cadence
- newest observation + expected latency
- 24 h success sparkline
- last error class
- coverage and attribution

**In the dashboard.** Compact per-card source dots with the same statuses. The situation strip degrades to "Some data is currently unavailable" when a relevant source is STALE/UNAVAILABLE, and the card's content switches to the Unavailable state; it never shows "0".

### 6.8 Evidence presentation

Every derived sentence ends with an unobtrusive evidence affordance (e.g. `[2]`). The evidence drawer lists items with:
- kind: observation · cluster · baseline · health run · correlation
- source + badge
- `observed_at` / `ingested_at`
- a one-line summary
- "View original" (provider URL)
- "Raw record": the payload's lifecycle — held, pruned (with the date it expired), or never captured — and its SHA-256 digest; the provider's bytes themselves are not shown (ADR-038)

### 6.9 Methodology page

Written for an intelligent non-specialist, with expandable technical detail:
- What each source is, its latency and its known limits (Mc, thermal ≠ fire, modelled flood areas)
- Correlation method with thresholds
- Relevance tables
- Baseline methods with minimum samples
- Change rules
- What GeoNerva does *not* do
- Disclaimers (GDACS, EMSC, FIRMS)
- Attribution

### 6.10 Replay UI (P1)

- **Entering replay:** from `/replay` scenarios, or from a place page via "View as of…".
- **Controls:**
  - date-time picker clamped to the replay horizon (disabled beyond, with the reason)
  - step buttons (−1 h / +1 h)
  - persistent banner: "Replay — showing what GeoNerva knew at 12:10 UTC, 8 Sep 2026. Information that arrived later is hidden."
- **Scenario cards** are labelled either "Recorded by GeoNerva" or "**Reconstructed** from provider revision history (for events before GeoNerva existed)".

## 7. Language rules (enforced by copy tests)

| Instead of | Say |
|---|---|
| "0 fires" when FIRMS failed | "Fire activity data unavailable · last update 2 h ago" |
| "No risk" / "Safe" | "No high-relevance hazards detected in the currently indexed sources." |
| "Normal" with thin data | "Not enough history to establish a baseline." |
| "Wildfire" (for FIRMS) | "Satellite thermal detections" / "fire activity" |
| "Flooded area" (GDACS) | "GDACS flood-event area (modelled)" |
| "Earthquake danger up 7×" | "Recent activity is above typical for this area (96th percentile)." + prediction caveat |
| "Real-time" | "Near-real-time; each source's delay is shown" |
| "3 sources agree" (with GDACS copy) | "2 independent sources (GDACS republishes USGS)" |

## 8. v1 definition of done

A person can enter any location worldwide and within seconds receive a briefing with these properties:
- It uses real public data from USGS, EMSC, GDACS and FIRMS.
- It shows meaningful changes over a chosen window.
- It correlates duplicate earthquake reports without faking agreement.
- It understands distance and areas.
- It gives honest historical context or says it cannot.
- It surfaces stale, missing, uncovered and conflicting data.
- It explains every level with reasons and evidence.
- It works entirely without AI and responsively on mobile.
- It survives source outages.
- It has reproducible tests, no CRITICAL/HIGH findings from three adversarial QA rounds, a documented local setup and a public deployment path.
