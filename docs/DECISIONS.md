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
