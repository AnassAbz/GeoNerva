# GeoNerva — Architecture Decision Log

Lightweight ADRs. Status values: **Accepted** (frozen for v1), **Proposed** (awaiting product-owner input), **Superseded**.
A frozen decision changes only through a new ADR that supersedes it.

Index:
| # | Decision | Status |
|---|---|---|
| 001 | Modular monolith, two processes (web + worker), one database | Accepted |
| 002 | PostgreSQL + PostGIS, `geography(4326)` | Accepted |
| 003 | Append-only, bitemporal fact store | Accepted |
| 004 | What Changed = as-of diff; snapshots are a cache | Accepted |
| 005 | Deterministic correlation: identity references first, misfit second | Accepted |
| 006 | Add EMSC to P0; treat GDACS earthquakes as derived | Accepted |
| 007 | Ingestion runs in a worker, not GitHub Actions / Vercel Cron | Accepted |
| 008 | Portable Postgres; Supabase as host only; private schema + RLS deny-all | Accepted |
| 009 | FIRMS: NOAA-20/21 only, sensors as data, two-part freshness | Accepted |
| 010 | No public ingestion endpoint | Accepted |
| 011 | No H3 in v1 | Accepted |
| 012 | Runtime AI: pushed packet, two calls, deterministic validator, P1, worker-only | Accepted (model/budget: Proposed) |
| 013 | Geocoding: local GeoNames suggestions + Nominatim submit | Accepted |
| 014 | Basemap: OpenFreeMap, MapLibre GL JS v6, Protomaps fallback | Accepted |
| 015 | Location privacy: 0.01° rounding, no server persistence of user coordinates | Accepted |
| 016 | Baselines: completeness-aware empirical percentiles; rarity statements | Accepted |
| 017 | Relevance ≠ risk; CRITICAL requires an authoritative basis | Accepted |
| 018 | Retention profiles and an explicit replay horizon | Accepted (profile choice: Proposed) |
| 019 | Weather alerts move to P1; ECCC via GeoMet first | Accepted |
| 020 | `THERMAL_ACTIVITY` vs `WILDFIRE_EVENT` terminology | Accepted |
| 021 | Data access: Kysely + node-postgres + SQL migrations | Accepted |
| 022 | Source health derived from run history; no "CONFLICTING" health state | Accepted |
| 023 | Evidence as typed references | Accepted |
| 024 | Tooling | Accepted |
| 025 | Runtime/toolchain versions: Node 24 LTS, TypeScript 6.0, pnpm 12 | Accepted |
| 026 | Internal packages ship TypeScript source; no package build step | Accepted |
| 027 | Lint/tooling version constraints and supply-chain defaults | Accepted |
| 028 | Geocoding package is the web app's only outbound route | Accepted |
| 029 | GDACS incremental sync: RSS trigger + bounded SEARCH windows + content hash | Accepted |
| 030 | Contributor identity decides independence; EMSC tombstones by reconcile | Accepted |
| 031 | Target PostGIS 3.3; local/CI images pinned to 17-3.4 | Accepted |

> **2026-09-19, product-owner review:** Architecture approved (gate G0 passed). ADR-012 model/budget is resolved: `AI_MODE=disabled` in production for v1, and no paid AI at launch. ADR-018 is resolved: `lean` profile on free infrastructure. Licence is Apache-2.0. The deployment is non-commercial.

---

## ADR-001 — Modular monolith, two processes, one database
- **Date:** 2026-09-19
- **Context:** The brief mandates a modular monolith. It also places ingestion in GitHub Actions calling Vercel functions. Ingestion is long-running, CPU-bound on FIRMS (~20 MB CSV per poll), and must never share failure modes with page rendering.
- **Alternatives:**
  - (a) Everything in Next.js route handlers.
  - (b) Microservices per source.
  - (c) One codebase, two entry points (web, worker).
- **Chosen:** (c). The packages are shared; `apps/web` is read-only and `apps/worker` is the only writer of provider facts. Dependency rules forbid web from importing `sources`/`pipeline`.
- **Trade-offs:** Two deployables instead of one. In exchange, the web process has no outbound calls to providers (smaller SSRF surface), ingestion has no serverless time/CPU limits, and there is a natural home for P1 push subscribers.

## ADR-002 — PostgreSQL + PostGIS with `geography(4326)`
- **Context:** Radius, distance and point-in-polygon queries are central. Global data crosses the antimeridian and reaches high latitudes.
- **Alternatives:** `geometry(4326)` with degree math; `geometry` in local projections; application-side geodesy only.
- **Chosen:** `geography` for storage and distance/containment. A GiST expression index on `geog::geometry` serves viewport `&&` queries.
- **Trade-offs:** Some PostGIS functions are geometry-only (e.g. `ST_ConvexHull`), which means explicit casts in isolated, tested SQL. Spheroidal distance is slightly slower but correct everywhere.

## ADR-003 — Append-only, bitemporal fact store
- **Context:** Providers revise events (USGS magnitude and preferred ID, GDACS episodes). The brief requires revision preservation, replay without future leakage, and auditability.
- **Alternatives:** Mutable current-state tables with an audit log; event sourcing with a separate projection service.
- **Chosen:** Immutable `observation_versions` keyed by `(source_record_id, version_seq)`, with `observed_at`, `valid_from/to`, `source_updated_at` and `ingested_at`. The as-of views are the only read path. `*_heads`/`*_state` caches serve "now" and are tested for equivalence with the as-of path.
- **Trade-offs:** More storage, and more complex queries hidden behind `packages/db/asof.ts`. This is the enabling decision for ADR-004 and replay.

## ADR-004 — What Changed = as-of diff; snapshots are a cache
- **Context:** The brief defines What Changed as "snapshot N vs snapshot N−1". That only exists for locations GeoNerva already tracks. It gives different answers to different visitors depending on who last triggered a snapshot, and "since previous analysis" means nothing to a first-time visitor.
- **Alternatives:** Persist snapshots for every searched location on a schedule, which is expensive and a privacy problem for coordinate searches; or per-user snapshot history, which requires accounts.
- **Chosen:** `diff(buildSnapshot(L, now−Δ), buildSnapshot(L, now))` over explicit windows (6 h/24 h/7 d, or "since my last visit" from browser storage). Both snapshots use the current engine version. Persisted snapshots exist only for materialized locations (cache, change history, AI caching, reports).
- **Trade-offs:** Two snapshot computations per request, mitigated by CDN caching and index-backed queries. The meaning is precise, the same for every visitor, and replay-safe.

## ADR-005 — Deterministic correlation: identity references first, misfit second
- **Context:** The brief proposes fuzzy thresholds (≤120 s, ≤50 km, Δm ≤0.5). Research showed:
  - GDACS earthquakes carry the USGS event ID (`sourceid`, only via `geteventdata`).
  - USGS IDs change over time; the `ids` alias list is authoritative.
  - USGS's own associator code uses ±16 s / 100 km.
  - EMSC's EventID service uses a misfit `d/105 + dt/13 + dm/0.8`.
- **Chosen:**
  - Stage 0: same-source aliasing.
  - Stage 1: explicit references (`DERIVED_COPY`).
  - Stage 2: a normalized misfit with scales of 16 s / 100 km / 0.8, a uniqueness gap of 0.3, POSSIBLE_MATCH kept unmerged, hysteresis for revisions, and a rule of never two records from one source in one canonical event.
- **Rejected:** The brief's 120 s window, which is loose enough to merge aftershocks. Using an LLM for matching.
- **Trade-offs:** The parameters are hypotheses. They are calibrated against a labelled set built from the EMSC EventID service (used for evaluation only, never at runtime).

## ADR-006 — Add EMSC to P0; treat GDACS earthquakes as derived
- **Context:**
  - 99 of 100 sampled GDACS earthquakes are NEIC (USGS) copies with identical values. Counting them as agreement fakes certainty.
  - USGS is complete only to about M4.5 outside the US. Live check: 1 event within 300 km of Marrakech in 12 months, against 10 (M2.4–4.7) from EMSC.
  - EMSC FDSN data is CC BY 4.0, with no key.
- **Chosen:** Add an EMSC adapter in P0. GDACS EQ records are linked as `DERIVED_COPY` and excluded from independent-agreement calculations. The UI says "2 independent sources (GDACS republishes USGS)".
- **Trade-offs:** One more adapter, and EMSC magnitudes are often ML/mb, which is harder to compare. It unlocks genuine agreement/conflict and the brief's own Marrakech story.

## ADR-007 — Ingestion runs in a worker, not GitHub Actions / Vercel Cron
- **Context:**
  - Vercel Hobby cron runs at most once per day and is for non-commercial use only.
  - GitHub's Actions terms restrict hosted runners to developing/testing the project. Scheduled workflows are delayed at the top of the hour, can be dropped, and are auto-disabled after 60 days without repo activity.
  - FIRMS parsing would burn most of Vercel Hobby's 4 CPU-hours/month.
- **Alternatives:** Supabase `pg_cron` + `pg_net` pinging an endpoint (the work still needs a compute home); a Cloudflare Workers cron (10 ms CPU, too small); Upstash QStash (a trigger only).
- **Chosen:** `apps/worker` as a container with an internal scheduler (per-product jittered intervals, DB run leases, backoff, circuit breakers). Default host: an always-free VM. It also has a single-shot CLI mode (`worker run --source usgs`) for local dev, CI smoke tests and emergencies.
- **Trade-offs:** One more thing to operate, and a VM account (which may need a card on file). In return the scheduling is reliable, terms-compliant, and there is room for push-based sources.

## ADR-008 — Portable Postgres; Supabase as host only
- **Context:** Supabase exposes the `public` schema through its Data API. Free-tier projects pause after a week of inactivity. Transaction pooling breaks prepared statements, and direct connections are IPv6-only by default.
- **Chosen:**
  - All tables live in the `geonerva` schema, which is not exposed. RLS is enabled with no policies.
  - No Supabase client SDK, auth, storage or edge functions.
  - Web connects via the transaction pooler with `prepare=false`; the worker connects via the session pooler.
  - Continuous worker writes keep the project active.
  - The same migrations run on local Docker PostGIS.
- **Trade-offs:** No Supabase conveniences (auth, realtime). None are needed for v1.

## ADR-009 — FIRMS: NOAA-20/21 only, sensors as data, two-part freshness
- **Context:**
  - Suomi-NPP product delivery ends 2026-11-01.
  - Terra/Aqua MODIS are shutting down from late 2026 into 2027.
  - VIIRS confidence is categorical while MODIS is numeric.
  - NRT latency is ~3 h, so the brief's "<30 min" freshness is wrong.
  - Global volume is ~115k rows/day per satellite.
- **Chosen:**
  - Ingest `VIIRS_NOAA20_NRT` and `VIIRS_NOAA21_NRT` only.
  - Model sensors with lifecycle fields (`status`, `active_to`, `confidence_scale`).
  - Poll every 30 min with `world`, `DAY_RANGE=2` (~144 transactions per poll of 5,000/10 min).
  - Use the keyless 24 h CSV as fallback / dev mode.
  - Measure freshness separately for *poll freshness* and *data currency*.
- **Trade-offs:** Fewer daily overpasses than ingesting four satellites. Clean, comparable, future-proof data.

## ADR-010 — No public ingestion endpoint
- **Context:** The brief exposes `POST /api/ingest/:source` protected by a secret.
- **Chosen:** Remove it. Ingestion is internal to the worker. An optional worker trigger (`POST /trigger/:source`) uses HMAC-SHA256 over `timestamp.body` with a 5-minute window and is bound to a private interface.
- **Trade-offs:** No convenient manual trigger from the browser. The CLI covers that need.

## ADR-011 — No H3 in v1
- **Context:** The brief asks to evaluate H3 and only adopt it where it materially helps.
- **Chosen:** Not in v1. Radius and area queries are exact with GiST on geography. Baselines compare a place with its own history, so a regular 0.25°/0.5° grid is sufficient. Fire clustering is pixel-distance based.
- **Revisit when:** A cross-region, area-normalized overview (a global "unusual activity" map) or privacy-preserving aggregate analytics is scheduled.

## ADR-012 — Runtime AI: pushed packet, two calls, deterministic validator; P1; worker-only
- **Context:** The brief proposes five sequential agents with query tools on every briefing. All five consume the same validated data and are forbidden from adding facts, so they add cost, latency and failure modes without adding capability.
- **Chosen:**
  - A bounded, deterministic "briefing packet" is pushed to the model; no tool use.
  - Call 1 is the **Interpreter** (Evidence Analyst, Change Analyst, Relevance Explainer and Composer as schema sections, using structured outputs). Call 2 is the **Skeptic**, which may only flag or remove.
  - The **deterministic validator** is the gate: evidence IDs, numeric equality, echoed levels, banned lexicon, timestamps and verbatim-alert rules.
  - Runs in the worker for materialized locations only. Output is cached by snapshot hash and capped by `AI_DAILY_BUDGET_USD`.
  - Falls back to deterministic templates on any failure.
- **Model (Proposed):**
  - `AI_MODEL` defaults to `claude-opus-5` ($5/$25 per MTok).
  - Estimate: ~6k input + ~1.5k output tokens (plus adaptive thinking) for the Interpreter and ~7k + 0.5k for the Skeptic. That is **≈ US$0.10–0.20 per validated briefing**, less with prompt caching.
  - A US$1/day cap allows roughly 5–10 briefings/day.
  - Cheaper models (`claude-sonnet-5` at $2/$10, `claude-haiku-4-5` at $1/$5) are a product-owner cost/quality decision, to be settled by the P1 evaluation set.
- **Trade-offs:** No per-request AI for arbitrary locations. The AI can never block or slow the page.

## ADR-013 — Geocoding: local GeoNames suggestions + Nominatim on submit
- **Context:**
  - Nominatim's public policy forbids autocomplete and allows at most 1 req/s with caching.
  - Mapbox and Google forbid displaying results on non-Mapbox/non-Google maps.
  - OpenCage's free tier is for testing only.
  - Photon's public instance throttles or bans "extensive usage".
- **Chosen:**
  - Type-ahead from a local `places` table (GeoNames `cities15000`, trigram index), with no external calls.
  - Free-text submit and reverse geocoding via Nominatim, server-side, cached 30 d, globally serialized at ≤ 1 req/s, with an identifying User-Agent.
  - Local coordinate parsing.
  - The `Geocoder` interface allows swapping to paid OpenCage or a self-hosted Photon.
- **Trade-offs:** Type-ahead only covers cities with population ≥ 15k. Villages and postal codes resolve on submit, "where supported".

## ADR-014 — Basemap: OpenFreeMap; MapLibre GL JS v6; Protomaps fallback
- **Context:**
  - OpenFreeMap needs no key, has no request limits and allows commercial use, but has no SLA.
  - MapTiler, Stadia, Protomaps-hosted and CARTO free tiers are non-commercial or key-gated.
  - MapLibre v6 (2026-07) is ESM-only and requires WebGL2.
- **Chosen:**
  - `MAP_STYLE_URL` config with the OpenFreeMap dark/fiord style.
  - P1 fallback: self-hosted Protomaps PMTiles (dark), used when tile errors occur.
  - The React wrapper `@vis.gl/react-maplibre` if it is v6-compatible (checked in Phase 1), else a thin in-house wrapper.
  - Map is progressive enhancement: the page works without WebGL2.
- **Trade-offs:** Dependence on a volunteer-run tile service, mitigated by the fallback and by making the map non-essential.

## ADR-015 — Location privacy
- **Chosen:**
  - All coordinates are rounded to 0.01° (~1.1 km) at the API boundary, before logging, caching or querying.
  - Raw-coordinate locations, including "Use my location", are never persisted. Only named public places and curated locations are stored server-side.
  - Watch places live in browser storage (P1).
  - IP-derived keys for rate limiting are HMACs with a daily-rotated secret.
  - No third-party analytics.
  - The AI never receives user coordinates.
- **Trade-offs:** ~1 km imprecision. This is irrelevant for hazards assessed at 10–1,500 km scales. The HIGH fire rule at 10 km absorbs it and says so on the methodology page.

## ADR-016 — Baselines: completeness-aware empirical percentiles
- **Context:**
  - The brief's examples use "30-day daily median" and "7× activity ratio". For earthquakes the daily median is 0 almost everywhere, and ratios over tiny denominators are misleading.
  - Seismicity is clustered (aftershocks), which violates Poisson assumptions.
  - Catalogue completeness varies by region.
- **Chosen:**
  - Magnitude of completeness per reference region (maximum curvature, fallback M4.5).
  - Counts of canonical events M ≥ Mc in 7 d/30 d windows.
  - Empirical mid-rank percentile over non-overlapping historical windows.
  - Minimum samples: 52 windows and 20 events. Otherwise a **rarity statement** or "insufficient history".
  - Ratio shown only when the mean is ≥ 1.
  - Sequence context after large events.
  - A mandatory prediction caveat.
  - Fire: *trend* only in P0 (sensor- and overpass-normalized); seasonal baseline in P1.
- **Rejected:** Robust z-score (MAD = 0 on zero-heavy counts); 1-year earthquake baselines; mixing MODIS/SNPP history with NOAA-20/21.

## ADR-017 — Relevance ≠ risk; CRITICAL requires an authoritative basis
- **Chosen:**
  - Hazard-specific rule tables with reason codes and evidence.
  - Levels LOW/MODERATE/HIGH from GeoNerva heuristics. CRITICAL only when an official provider alert (GDACS Orange/Red, PAGER orange/red, official warning) applies to the location under the documented spatial condition.
  - The methodology page states that relevance is "how much attention this deserves", not probability of harm.
- **Trade-offs:** GeoNerva will under-call some severe situations that lack official alerts. This is the safe failure direction for a non-authoritative tool.

## ADR-018 — Retention profiles and replay horizon
- **Context:** Supabase Free is 500 MB. FIRMS alone is ~40–50 MB/day in Postgres.
- **Chosen:**
  - `RETENTION_PROFILE=lean` (72 h detections, compact aggregates, EQ M ≥ 4.5 kept forever) or `standard` (≥ 8 GB).
  - Detections are partitioned daily and expire by dropping partitions.
  - The replay horizon per family is derived from the profile and enforced by the API and UI.
- **Proposed (owner decision):** Whether the public demo runs `lean` on Supabase Free (US$0) or `standard` on Supabase Pro / self-hosted Postgres (~US$25/month or VM disk).

## ADR-019 — Weather alerts move to P1; ECCC via GeoMet first
- **Context:**
  - ECCC covers Canada only.
  - The Datamart's usage policy forbids polling directory listings; AMQPS is required, which needs a persistent consumer.
  - GeoMet `weather-alerts` is pollable but lacks CAP lineage.
  - The licence forbids altering alert content or intent.
  - Weather alerts need their own lifecycle model.
  - P0 already demonstrates coverage gaps.
- **Chosen:**
  - P1: ECCC via GeoMet (P1.3), then NWS (whose ~82 % zone-only alerts require a zone-geometry cache), then ECCC CAP via AMQPS.
  - In P0 the weather card renders "not covered".
- **Trade-offs:** Canadian users see no weather warnings at launch. The Montréal demo relies on fire activity and earthquakes.

## ADR-020 — Terminology in the type system
- **Chosen:**
  - `THERMAL_ACTIVITY` for FIRMS detections and clusters; `WILDFIRE_EVENT` only for official wildfire events (GDACS WF).
  - Flood areas are `MODEL_AREA` geometry kind.
  - UI copy is generated from these types, so the wrong word cannot be rendered without a type error.
  - Copy tests scan templates for banned phrases.

## ADR-021 — Data access: Kysely + node-postgres + plain SQL migrations
- **Context:** The brief asks for PostGIS-friendly access and warns against "ORM gymnastics".
- **Alternatives:** Prisma (weak PostGIS support, prepared-statement issues with the transaction pooler); Drizzle (workable, but geography types need custom types); raw `pg` only (no type safety).
- **Chosen:**
  - Kysely for type-safe query building, with raw `sql` fragments for PostGIS in `db/spatial`.
  - `pg` driver; the pool for web uses `prepare=false` semantics (no named statements).
  - Plain `.sql` migration files applied by a small, transactional migrator with a checksum table.
  - Types generated from the live schema in CI (`kysely-codegen`), with a check that they are up to date.
- **Trade-offs:** More SQL written by hand, which is intentional and tested.

## ADR-022 — Source health derived from run history
- **Chosen:**
  - `SourceHealth(as_of)` is a pure function of `ingestion_runs` plus the policy, so health is replayable.
  - States: FRESH / DEGRADED / STALE / UNAVAILABLE.
  - The brief's "CONFLICTING" is an **event** property (agreement = CONFLICT, `SOURCE_CONFLICT` signal), not a source state. "MISSING" is folded into UNAVAILABLE / coverage NOT_COVERED.

## ADR-023 — Evidence as typed references
- **Chosen:**
  - Evidence IDs point to immutable things: `EV:OBS:<version>`, `EV:FCV:<cluster version>`, `EV:RUN:<run>`, `EV:COR:<link>`, plus content-addressed derived items (`EV:BAS|REL|CHG:<sha>`).
  - Each briefing carries an evidence manifest. No separate authored `evidence_items` table.
- **Trade-offs:** A resolver is needed for primary evidence. Duplication and drift between "evidence" and "facts" become impossible.

## ADR-024 — Tooling
| Area | Choice |
|---|---|
| Workspace | pnpm workspaces |
| Language | TypeScript `strict` + `noUncheckedIndexedAccess` |
| Framework | Next.js App Router (current stable at Phase 1, verified then) |
| Validation | Zod |
| Unit / integration tests | Vitest |
| Property tests | fast-check |
| E2E | Playwright |
| Lint / format | ESLint (typescript-eslint, next) + Prettier |
| Architecture rules | dependency-cruiser |
| Logging | pino |
| Scheduling | croner |
| Integration DB | GitHub Actions service `postgis/postgis` |

Turborepo is not adopted until build times justify it.

## ADR-025 — Runtime and toolchain versions
- **Date:** 2026-09-19 (Phase P1)
- **Context:**
  - Node 20 reached end-of-life in April 2026.
  - Vitest 5 and dependency-cruiser 18 require Node ≥ 22.
  - The `latest` TypeScript on npm is 7.0.x (the native compiler), but typescript-eslint 8.x supports `typescript >=4.8.4 <6.1.0`, so typed linting would break on TS 7.
- **Chosen:**
  - **Node 24 LTS** (`engines.node >=24.0.0`, `.nvmrc` 24; Docker images `node:24-*`).
  - **TypeScript 6.0.x**.
  - **pnpm 12** pinned via the `packageManager` field (corepack).
- **Trade-offs:** No TS 7 compile-speed gains yet. Revisit when typescript-eslint supports TS 7, via an ADR that supersedes this one.

## ADR-026 — Internal packages ship TypeScript source; no package build step
- **Date:** 2026-09-19 (Phase P1)
- **Context:** A monorepo of 14 internal packages. Building each to `dist/` adds watch processes, stale-build bugs and declaration-map complexity. Node 24 strips erasable TypeScript types natively. TypeScript 6 supports `erasableSyntaxOnly` and `allowImportingTsExtensions`.
- **Chosen:**
  - Every internal package exports `./src/index.ts`. Relative imports use explicit `.ts` extensions.
  - `erasableSyntaxOnly: true` forbids enums, namespaces and parameter properties (use `as const` objects and unions).
  - The **worker runs directly with `node src/main.ts`**. Next.js transpiles workspace packages it imports (`transpilePackages`).
  - Vitest and tsc (`noEmit`) consume the sources as-is.
- **Verified in P1:** `node apps/worker/src/main.ts check-config` imports `@geonerva/config` across the pnpm symlink and runs with no loader or build.
- **Trade-offs:**
  - Packages cannot be published to npm as-is (not a goal).
  - Only erasable syntax is allowed, which is a stylistic constraint and enforced by the compiler.
  - Worker container images ship source plus production `node_modules`.

## ADR-027 — Lint/tooling version constraints and supply-chain defaults
- **Date:** 2026-09-19 (Phase P1)
- **Context:** `eslint-config-next` 16.3 depends on plugins (`eslint-plugin-react`, `-import`, `-jsx-a11y`) whose peer ranges stop at ESLint 9. pnpm 12 blocks dependency install scripts by default and supports a minimum release age.
- **Chosen:**
  - ESLint **9.39.x** with typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`.
  - `minimumReleaseAge: 1440` (a version must be public for ≥ 1 day before install); versions younger than that are not pinned (older patch versions are pinned instead of adding exemptions).
  - Install scripts are denied unless listed in `allowBuilds` with a justification.
  - Third-party GitHub Actions are pinned by commit SHA.
  - Markdown documentation is excluded from Prettier (wide hand-aligned tables; the docs are prose).
- **Revisit:** Move to ESLint 10 when Next's plugin set supports it.

## ADR-028 — Geocoding is its own package and the web app's only outbound route
- **Date:** 2026-09-19 (P1 security review, finding F-4)
- **Context:**
  - ARCHITECTURE §13 gives the web process exactly one external dependency: Nominatim for place search.
  - §3 did not say which package owns it. The P1 dependency rules allowed `briefing → http`, which let the web app reach the outbound HTTP client transitively.
  - Global `fetch` was unrestricted.
- **Alternatives:**
  - (a) Geocoder inside `briefing`, which requires `briefing → http` and makes every briefing service a potential network caller.
  - (b) Geocoder inside `sources`, which puts a provider-adapter package in the web process and contradicts ADR-001.
  - (c) A dedicated `@geonerva/geocoding` package.
- **Chosen:** (c).
  - `geocoding` depends on `domain, geo, http, config`.
  - `briefing` no longer depends on `http`.
  - Only `http`, `sources`, `pipeline` and `geocoding` may import `@geonerva/http` (`outbound-http-importers`).
  - `apps/web` must not reach `sources`/`pipeline` even transitively (`reachable` rule).
  - ESLint bans `fetch`/`XMLHttpRequest`/`WebSocket` outside `packages/http`, with two exceptions: browser code in `apps/web`, which calls its own same-origin API, and operational scripts.
- **Trade-offs:** One more package. In exchange, the SSRF surface of the web process is a single, reviewable module.

## ADR-029 — GDACS incremental sync: RSS trigger plus bounded SEARCH windows, change by content hash
- **Date:** 2026-09-19 (P0 verification, items V2 and §2.1)
- **Context:** P0 measured the GDACS API rather than trusting its Swagger document:
  - `geteventlist/latest?datemodified=` silently omits Green events unless `alertlevel=green;orange;red` is passed, and it is ordered by `todate`, not by `datemodified`.
  - **Paging overlaps.** Page 1 and page 2 of the same query shared 78 of 100 events (`latest`) and 67 of 100 (`SEARCH`), so `pageNumber > 1` cannot be used for completeness.
  - `datemodified` is **bulk-restamped**: dozens of unrelated old events get the same new timestamp within one minute.
  - `SEARCH` without `alertlevel` reproducibly returns HTTP 204.
- **Chosen:**
  - Poll `rss_24h.xml` as the cheap change trigger (it carries `eventid`, `episodeid` and alert level).
  - Reconcile with `SEARCH` over date windows chosen so each returns **fewer than 100 events**, splitting recursively when a window fills; never page.
  - Always send `alertlevel=green;orange;red`; treat 204 as "empty and suspicious".
  - Deduplicate by `(eventtype, eventid)`.
  - **Detect change only by the content hash of the normalised episode**, never by `source_updated_at`.
- **Consequence for replay:** `getepisodedata` for an old episode returns the *event's current* alert level and severity, so historical episode content cannot be reconstructed. GDACS replay contains only episodes GeoNerva observed live, which is stated in the UI's replay caveats.
- **Trade-offs:** More requests than a true incremental feed, and a small risk of missing an event whose window was sized wrongly — hence the "no window may return ≥ 100 rows" assertion in the ingestion drill.

## ADR-030 — Contributor identity decides independence; EMSC deletions are tombstoned by reconcile
- **Date:** 2026-09-19 (P0 verification, item V6 and the correlation calibration set)
- **Context:**
  - EMSC republishes other agencies' solutions and exposes the agency in `auth`. P0 found a real case where EMSC carried **`auth: NEIC` with a stale magnitude**: USGS M4.5 versus EMSC M3.2 at Δt 0 s and Δdistance 0 km.
  - EMSC's FDSN service has **no deleted-event query**; deletions appear only on its websocket, which v1 does not consume.
  - The 250-pair labelled set shows true pairs reaching 16.4 s / 135 km / ΔM 1.9, while *distinct* events come as close as 21 s / 30 km, and 46 s / 34 km with identical magnitudes.
- **Chosen:**
  - `contributor` (`auth` for EMSC, `net`/`sources` for USGS) is a **first-class normalised field**, not an `attributes` key.
  - An EMSC observation whose contributor is the same agency as the matched USGS record is linked as `DERIVED_COPY`, not as an independent source, and is excluded from the independent-agreement calculation exactly like a GDACS copy (ADR-006).
  - The magnitude veto does **not** apply when time and location are effectively identical and the contributor indicates republication; magnitude disagreement is then expected and is reported as a staleness caveat rather than as a conflict.
  - Thresholds alone cannot separate the hardest true pairs from the hardest distinct events, so the **uniqueness gap is load-bearing**, and the misfit scales must be calibrated against `packages/test-fixtures/sources/correlation/eq-pairs.json` in P5 (target: precision ≥ 0.98, recall ≥ 0.95, with the 4 `ambiguous` pairs reported separately). The scales in ARCHITECTURE §6 are a starting point known to reject the most extreme true pairs.
  - EMSC deletions: re-query the last 7 days daily; a `unid` missing from two consecutive reconciles gets a tombstone version with lifecycle status **`MISSING_FROM_SOURCE`**, which is distinct from `DELETED` (an explicit provider statement).
- **Trade-offs:** A deleted EMSC event stays visible for up to two reconcile cycles. The alternative (a websocket consumer) is P1.

## ADR-031 — Target PostGIS 3.3; local and CI images pinned to 17-3.4
- **Date:** 2026-09-19 (P0 verification, item V8)
- **Context:** Supabase ships **PostGIS 3.3.7 on Postgres 17** (3.3.2 on Postgres 15), and new projects default to Postgres 17. The Docker Hub library publishes no `postgis/postgis:17-3.3` tag.
- **Alternatives:** target 3.5 and accept that production differs (rejected: migrations would fail in production, which is the worst possible place to find out); move the database to Neon, which ships 3.5/3.6 (rejected for now: owner decision Q2 fixed Supabase Free); self-host Postgres on the worker VM (kept as the escape hatch if a 3.3 limitation bites).
- **Chosen:** Migrations and spatial SQL use **PostGIS 3.3 features only**. Local development and CI pin `postgis/postgis:17-3.4@sha256:…` (the closest published tag, enforced identical in both places by `scripts/infra-consistency.test.ts`), and the database layer records `postgis_full_version()` so a mismatch is visible. P10 asserts the live Supabase version.
- **Trade-offs:** A one-minor gap between development and production remains, in the safe direction (development is newer, so a 3.4-only function still compiles locally). This is why the feature restriction is a review item on every migration, not only an image pin.

## ADR-032 — The error taxonomy gains NETWORK, CONFIG_ERROR and ABORTED
- **Date:** 2026-09-19 (P3, raised by the ingestion framework before the first adapter was written)
- **Context:** The taxonomy frozen in G2 (`ingestion_runs.error_class`, `packages/domain/src/enums.ts`) was written from the *provider's* answers: statuses, sizes, schema drift. Building the outbound client surfaced three failures that happen when there is no answer at all, and none of them had a truthful class:
  - **DNS failure, connection refused, TLS failure.** Not a timeout — nothing was ever waited on.
  - **The allowlist, the private-address check and the redirect refusal.** These fire *before* or *instead of* a request. They are our configuration or a hijacked DNS answer, they never self-heal, and they are the security controls in SECURITY.md M1/M2.
  - **A cancelled run** (the worker handling SIGTERM). The provider did nothing wrong.
- **Alternatives:**
  - *Map all three to `UNKNOWN`* — rejected. `UNKNOWN` means "we could not classify this", and source health is derived from `error_class`. Folding a permanent misconfiguration and a security refusal into the bucket that means "mystery" hides the one signal an operator must act on, and would make `/data-status` claim less than we actually know.
  - *Map network and abort to `TIMEOUT`* — rejected for the same reason, more sharply: it is a false statement about the provider. An operator seeing `TIMEOUT` chases USGS; the actual remedies are "fix DNS", "fix the allowlist" and "nothing, we stopped it". This is the same failure the project forbids everywhere else — flattening distinct observations into one confident-looking answer.
  - *Extend the taxonomy* — chosen.
- **Chosen:** `ERROR_CLASSES` and the `ingestion_runs.error_class` CHECK constraint gain `NETWORK`, `CONFIG_ERROR` and `ABORTED`. The change is **additive**: no existing value changes meaning, no row needs rewriting, and every existing reader still matches what it matched before. Retry semantics: `NETWORK` is transient; `CONFIG_ERROR` and `ABORTED` are not, and `ABORTED` is excluded from retry specifically so a cancelled worker cannot hold itself open past its shutdown deadline.
- **Health derivation:** `deriveSourceHealth` counts *failed runs*, and the two new non-provider classes are treated differently on purpose:
  - `CONFIG_ERROR` still counts. A broken allowlist means GeoNerva genuinely has no data for that source, so the status must degrade — what changes is the *explanation*: `lastErrorClass` tells the operator the fault is ours, not the provider's. This is the distinction G3 carryover 2 requires the briefing layer to make: "we are blind to this source" is not "nothing is happening".
  - `ABORTED` is excluded from the failure count. A run we cancelled ourselves says nothing about the source, and counting it would mark every source `DEGRADED` after a routine deploy — a false alarm that trains an operator to ignore the panel.
- **Process note:** this is a frozen-contract change, so it stopped the dependent work (the pipeline's run accounting) until it was resolved here, per the phase rules. It is the only schema contract P3 changes.
- **Trade-offs:** A migration against a frozen table. Accepted because the alternative is a taxonomy that lies about three real failures, and the cost of adding a class later — after rows exist and health rules depend on them — is much higher than now, when the table is empty.

## ADR-033 — Raw payloads are retained by window, and a backfill stores the hash without the body
- **Date:** 2026-09-20 (P4.5, forced by the P3 storage measurement)
- **Context:** P3 measured **2,735 B per first-sighting earthquake**, of which the raw provider payload is **1,269 B — 46 %**. At the planned 260k-event catalogue the payload bodies alone are **~315 MB**, and the whole lean profile reaches ~727 MB against a **500 MB** budget (ARCHITECTURE §12). The previous policy was "keep everything", which was never a decision, only an absence of one. `prunePayloadsBefore` already existed and nothing called it.
- **The asymmetry that decides this.** A **live** payload is a snapshot of something the provider will not serve again: `all_day` moves on, and the bytes we saw at 12:05 are gone by 12:10. A **backfill** payload is different — it is the catalogue as it stands *now*, and everything in it that GeoNerva reads is already in the normalized version, pinned by `content_sha256`. Keeping 315 MB of JSON to preserve fields we deliberately do not read is not provenance, it is hoarding.
- **Alternatives:**
  - *Keep all payload bodies* — rejected: it exceeds the budget on its own, and the owner ruled out paid storage for v1 (Q2).
  - *Store no raw row at all for backfilled records* — rejected. `observation_versions.raw_record_id` would be NULL, which P3 established is provenance silently lost, and the audit chain would have no hash to check against.
  - *Chosen:* a backfill **inserts the raw row with `payload = NULL, payload_pruned = true`** from the outset. The row exists, `raw_record_id` is non-null, and the 32-byte digest is kept forever, so an audit can still prove exactly what was ingested — it simply cannot re-read the body. This is the same end state pruning produces, reached immediately instead of after 30 days, and it reuses a column that already means precisely this.
- **The policy, per retention profile:**

  | What | lean | standard | Why |
  |---|---|---|---|
  | Normalized facts (versions, records, aliases, heads) | **forever** | forever | They are the replayable truth; ADR-002's append-only store is the product |
  | Live raw payload bodies | 30 days | 90 days | Long enough to debug a revision dispute; 400 events/day × 1,269 B × 30 d ≈ **14.5 MB** |
  | Backfill raw payload bodies | **never stored** | never stored | See the asymmetry above |
  | Raw rows and their hashes | forever | forever | The audit chain, ~200 B/event |
  | `ingestion_rejects` excerpts | 14 days | 30 days | Diagnostics. Health derivation never reads them |
  | `ingestion_runs` | 90 days | 1 year | Health looks back 7 days; the rest is trend |
  | Fire detections | 72 h (owner Q2) | 30 days | Unchanged; the replay horizon is built on it |

- **Audit implications, stated plainly:** after the retention window, `GET /api/v1/evidence/{id}` can still say *what* was ingested and prove the bytes by digest, but cannot show them. `findRawPayload` already returns `pruned: true` for exactly this case, so the API reports the absence rather than implying the payload never existed. For a backfilled record that is true from the start, and the API must say so.
- **Storage consequence:** replacing 315 MB of backfill bodies with ~52 MB of rows and hashes brings the projected lean catalogue from ~727 MB to roughly **~460 MB**, which is inside the budget but not comfortably. §4.6's measurement is therefore a gate condition, not a formality, and if the measured figure passes 450 MB the EMSC backfill narrows first (ARCHITECTURE §12).
- **Trade-offs:** a backfilled record can never have its original bytes inspected. Accepted because those bytes are re-derivable in substance from FDSN by `eventid`, the digest still proves what we ingested, and the alternative is a system that does not fit the deployment the owner chose.

## ADR-034 — The v1 USGS catalogue is M ≥ 4.5 from 2016, not from 2000
- **Date:** 2026-09-20 (P4.6, forced by measurement)
- **Context:** `DATA_SOURCES.md` §1.6 and `ARCHITECTURE.md` §12 specify a backfill of **global M ≥ 4.5 from 2000-01-01** (estimated "~7k events/year → ~190k rows") plus all magnitudes for the last 30 days. P4 measured both halves of that sum for the first time:
  - **Per-event cost, measured** from a real 2,266-event FDSN backfill (M ≥ 4.5, June–August 2026) under ADR-033: **1,865 B/event** — `observation_versions` 1,085, `raw_source_records` 231, `source_records` 199, `source_record_aliases` 184, `source_record_heads` 166. Indexes are 39 % of it. This is 32 % below P3's live figure of 2,735 B, which is ADR-033 working.
  - **Event counts, measured** from the FDSN `count` endpoint rather than estimated:

    | Catalogue | Events | Projected |
    |---|---|---|
    | M ≥ 4.5, 2000 → now | **187,173** | 333 MB |
    | M ≥ 4.5, 2010 → now | 126,613 | 225 MB |
    | **M ≥ 4.5, 2016 → now** | **79,929** | **142 MB** |
    | M ≥ 5.0, 2000 → now | 47,959 | 85 MB |
    | all magnitudes, last 30 d | 11,015 | 20 MB |

  The "~190k rows" estimate was accurate. What was never checked is that 187,173 × 1,865 B is **333 MB of a 500 MB budget for one source**, before EMSC, before fire, before places.
- **Alternatives:**
  - *Keep 2000 → now and cut elsewhere* — rejected. The only things large enough to cut are fire retention, which the owner fixed at a 72-hour replay horizon (Q2), and EMSC, which is the source that actually has regional depth: P0 measured EMSC with **187 events within 150 km of Marrakech over five years against USGS's 9**. Spending the budget on the sparser source to preserve a start date would be backwards.
  - *Raise the magnitude floor to M ≥ 5.0 and keep 2000* — 85 MB, cheapest, kept as the fallback lever. Rejected as the default because it discards the M4.5–5.0 band everywhere, and that band is where a location's "notable for here" baseline lives in seismically moderate regions.
  - *Move to the `standard` profile* — rejected: the owner chose lean for v1 and ruled out paid storage (Q2).
  - *Chosen:* narrow the **window**, not the magnitude. **M ≥ 4.5 from 2016-01-01** (79,929 events, 142 MB) plus all magnitudes for the last 30 days (11,015, 20 MB).
- **Why ten years is enough for what the catalogue is for.** It feeds completeness-aware empirical percentiles (ADR-016), not a seismic hazard model. Ten years of global M4.5+ is ~80k events; the percentile estimates that drive "notable for here" are stable long before that sample size in any region with enough activity to have a baseline at all, and in regions without one the honest answer is already "insufficient data", which is a designed outcome rather than a gap. The `standard` profile keeps 2000 → now for anyone who wants the longer record.
- **Budget, with the measured figure:**

  | Item | MB |
  |---|---|
  | USGS M ≥ 4.5 from 2016 | 142 |
  | USGS all magnitudes, last 30 d | 20 |
  | Fire detections, 72 h retention (P2 measured) | 143 |
  | `places` (GeoNames `cities15000`) | ~40 |
  | Operational: runs, rejects, backfill plans, caches | ~30 |
  | **Subtotal** | **~375** |
  | **Reserved for EMSC (P5)** | **~125** |

  P5 must measure EMSC against that line and narrow its own backfill to fit; it does not get to overspend and leave the next phase to discover it.

  > **Corrected by ADR-035.** The "all magnitudes, last 30 d — 20 MB" row above is a **rate presented as a stock**: with facts kept forever it is 0.65 MiB/day, or **238 MiB/year**, which consumes the whole EMSC reserve in about six months. ADR-035 adds a magnitude-tiered replay horizon that makes the 20 MB row true, and revises the EMSC reserve to **~70 MB**. Read ADR-035's budget table, not this one.
- **Caveat, stated because it cuts the other way:** 1,865 B/event was measured on a 2,266-row table, where index pages are lumpy and partly empty. At 80,000 rows the per-row cost usually falls as pages fill, so 142 MB is a **conservative** ceiling rather than a best guess. It is re-measured after the real backfill runs, and this ADR is revisited if the true figure differs by more than 15 %.
- **Trade-offs:** GeoNerva's earthquake history starts in 2016 on the lean profile, and a user asking about 2011 Tōhoku gets "outside the indexed window" rather than a record. That is a visible, explainable limit — which is the kind this project accepts — and it is one configuration change away from the full catalogue on `standard`.

## ADR-035 — Small-magnitude earthquake facts have a replay horizon; M ≥ 4.5 is kept forever
- **Date:** 2026-09-20 (P4 review; corrects an arithmetic error in ADR-034)
- **Context:** ADR-034's budget lists "all magnitudes, last 30 days — 20 MB" as a line item, and the ~375 MB subtotal treats it as a fixed stock. **It is a rate.** The live adapter polls `all_day`, which is all magnitudes, and ADR-034's own measured count says that is 11,015 events per 30 days — **367/day**. At the measured 1,865 B/event, and with ADR-033 keeping normalized facts **forever**, that is:

  | | |
  |---|---|
  | Permanent growth, live all-magnitude | **0.65 MiB/day = 238 MiB/year** |
  | Permanent growth, M ≥ 4.5 only | 7,456 events/year = **13.3 MiB/year** |

  So the ~125 MB ADR-034 reserved for EMSC is consumed by USGS live ingestion alone in **roughly six months**, before EMSC writes a row. ADR-034's conclusion is true on day one and false by about month six — which is precisely the class of unchecked arithmetic that ADR-034 was itself written to catch.
- **The real question this exposes:** "keep normalized facts forever" and "poll an all-magnitude feed" are individually reasonable and jointly unaffordable on a 500 MB budget. One of them has to give.
- **Alternatives:**
  - *Stop polling all magnitudes* (poll `4.5_day` instead) — rejected. A user in Los Angeles or Reykjavík cares about an M2.8 three kilometres away, and the "notable for here" baseline in a moderately active region is built from exactly that band. Discarding it globally to save storage would gut the product in the places it is most useful.
  - *Keep everything and move to the `standard` profile* — rejected: the owner chose lean and ruled out paid storage (Q2).
  - *Chosen:* **retention by magnitude tier.** `M ≥ 4.5` facts are kept **forever**. Facts below M4.5 are kept for a bounded window — **30 days on `lean`**, 2 years on `standard`, which is what ARCHITECTURE §12 already says the standard profile keeps ("2 y small-EQ history", implying lean does not).
- **Why this is retention and not a breach of the append-only rule.** ADR-002 forbids *mutating* a fact. Dropping old data wholesale is a different thing, and this architecture already does it: fire detections are dropped by partition on a 72-hour horizon, and §12 speaks of "batched deletes for the rest". What that design owes the user is a **stated replay horizon**, not an unbounded archive.
- **The consequence that must be surfaced, not swallowed.** After 30 days a replay on the lean profile will not show small earthquakes. That must be reported as *"outside the indexed window for this magnitude"*, never as an empty result — an empty list here would be the system saying nothing happened when what it means is that it no longer remembers. The replay horizon is already an API-exposed concept for fire (§12); earthquakes now have a magnitude-dependent one and it is exposed the same way.
- **Corrected budget** (lean, measured):

  | Item | MB |
  |---|---|
  | USGS M ≥ 4.5 from 2016 (one-off backfill) | 142 |
  | USGS M ≥ 4.5 ongoing, 3 years | 40 |
  | USGS below M4.5, rolling 30 days | 20 |
  | Live raw payload bodies, rolling 30 days (ADR-033) | 15 |
  | Fire detections, 72 h (P2 measured) | 143 |
  | `places` | ~40 |
  | Operational | ~30 |
  | **Subtotal** | **~430** |
  | **Reserved for EMSC (P5)** | **~70** |

  The EMSC reserve falls from 125 MB to **~70 MB**, which is the honest number and is P5's constraint. If EMSC cannot be made useful within it, the levers in order are: shorten the small-magnitude window, narrow the USGS backfill to M ≥ 5.0 (frees 57 MB), and only then touch fire retention — which is what the replay horizon is built on.
- **Implementation:** `pruneSmallMagnitudeVersionsBefore` in `packages/db`, alongside the existing `prunePayloadsBefore` and `dropDetectionPartitionsBefore`. Like those, the **function** exists and is tested; **scheduling** all three as a nightly job is P10, and until that job runs the growth is real. That is stated here so it cannot be mistaken for solved.
- **Trade-offs:** the lean profile forgets small earthquakes after a month, and a replay from last year shows only M ≥ 4.5. It is a visible, explainable, configurable limit — and it is the difference between a system that fits its deployment and one that silently stops fitting in month six.

## ADR-036 — `packages/briefing` may depend on `packages/correlation`
- **Date:** 2026-09-20 (P6.4)
- **Context:** `SubjectSummary.agreement` is part of the frozen read model (G2), and a snapshot is built for an arbitrary knowledge time `T`. Agreement is not a provider fact: it is computed from the members of a canonical event — how many *independent* sources describe it, excluding `DERIVED_COPY` links, and how far their solutions spread. That rule lives in `packages/correlation/agreement.ts`, is calibrated against the labelled set, and is mutation-tested. `.dependency-cruiser.cjs` did not list `correlation` among briefing's allowed dependencies.
- **Why the obvious alternatives are worse:**
  - *Read `canonical_event_state.agreement`* — rejected. That table is the **"now" projection cache** and `ARCHITECTURE.md` §4 says it is never consulted for a replay. A snapshot at `T < now` that read it would report today's agreement against yesterday's facts, which is invariant I2 broken in the one place a user cannot see it.
  - *Reimplement the rule inside briefing* — rejected, and it is the worse option of the two. The count of independent sources is the number the UI may describe as corroboration; two implementations of it would eventually disagree, and the failure mode is an event reporting "2 sources, they agree" for a GDACS copy of a USGS solution. One calibrated rule, used everywhere, is the whole point of keeping the engines pure.
  - *Move agreement into `packages/domain`* — rejected: it needs `vincentyDistanceMeters` for the location spread, and `domain` depends on nothing by design.
- **Chosen:** `briefing` may depend on `correlation`, which is added to its allow-list. `correlation` is a pure engine (`domain` + `geo` only, no IO, enforced by `pure-engines-have-no-io`), so this adds no database, network or framework reach to briefing and creates no cycle. It is the same shape as briefing's existing dependency on `relevance` and `baselines`: application services compose pure engines.
- **What this does not permit:** `correlation` still may not depend on `db`, and briefing still may not write. The edge is one-way and read-only, and the `web-reads-facts-only-through-asof` rule is untouched — briefing reads the members of an event through `linksAsOf` and `observationsAsOf`, then hands them to the pure rule.
- **Trade-offs:** briefing's dependency surface grows by one package. The alternative was a duplicated rule whose divergence would be invisible until it produced a false claim of corroboration.
