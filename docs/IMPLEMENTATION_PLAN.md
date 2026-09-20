# GeoNerva — Implementation Plan (v1)

> Status: proposed, 2026-09-19. The plan implements `PRODUCT.md` P0 on the architecture in `ARCHITECTURE.md`. Phase numbering here supersedes §54 of the master brief. Differences are explained in `DECISIONS.md`.

## 1. Dependency graph

```text
                 ┌──────────────┐
                 │ P0 Fixtures & │  (research; no production code)
                 │ source verif. │─────────────────────────────────────────┐
                 └──────┬───────┘                                          │
┌──────────────┐        │ fixtures                                         │
│ P1 Foundation │────────┼──────────────┐                                   │
└──────┬───────┘        │              │                                   │
       │                ▼              ▼                                   │
       │        ┌──────────────┐  ┌──────────┐                             │
       ├───────►│ P2 Domain+DB  │  │ P5a geo  │ (pure; starts after P1)     │
       │        │  ★ FREEZE     │  └────┬─────┘                             │
       │        └──────┬───────┘       │                                   │
       │   ┌───────────┼───────────────┼──────────────┬──────────────┐     │
       │   ▼           ▼               ▼              ▼              ▼     │
       │ ┌─────────┐ ┌─────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐
       │ │P3 Ingest│ │P5b EQ correl│ │P5c fire    │ │P6 Relevance│ │P9a UI shell + │
       │ │framework│ │(pure)       │ │clustering  │ │(pure)      │ │design system  │
       │ │+ USGS   │ └──────┬──────┘ └─────┬──────┘ └─────┬──────┘ │(mock read-    │
       │ └────┬────┘        │              │              │        │ models)       │
       │      ▼             │              │              │        └──────┬───────┘
       │ ┌────────────────┐ │   ┌──────────────────────┐  │               │
       │ │P4a EMSC ║ P4b   │ │   │P7 Baselines + changes│◄─┘               │
       │ │GDACS ║ P4c FIRMS│ │   │(pure + backfill CLI) │                  │
       │ └────┬───────────┘ │   └──────────┬───────────┘                  │
       │      └──────┬──────┴──────────────┘                              │
       │             ▼                                                    │
       │     ┌──────────────────────┐                                     │
       │     │P8 Briefing svc + API │                                     │
       │     └──────────┬───────────┘                                     │
       │                ▼                                                 │
       │     ┌──────────────────────┐◄────────────────────────────────────┘
       │     │P9b UI integration    │
       │     └──────────┬───────────┘
       ▼                ▼
┌───────────────────────────────┐
│P10 Deployment & ops           │  (worker VM, DB, Vercel, CI smoke)
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│P11 Hardening + QA rounds 1–3  │ ─► v1 release
└───────────────────────────────┘
```

**Critical path:** P1 → P2 → P3 → P4 (slowest adapter: FIRMS) → P8 → P9b → P10 → P11.

**Safe parallelism** (no shared file ownership):
- P0 ∥ P1.
- P5a ∥ P2.
- After the P2 freeze: P3 ∥ P5b ∥ P5c ∥ P6 ∥ P7 (pure parts) ∥ P9a.
- P4a ∥ P4b ∥ P4c (one adapter folder each; the framework is frozen at the end of P3).

## 2. Development-agent orchestration

### 2.1 Roles and ownership

The **orchestrator** (lead architect) owns architecture, sequencing, integration, merges, conflict resolution, ADRs and all **foundational files**. Specialized agents work in **separate git worktrees on separate branches**, and only the orchestrator merges.

| Agent | Responsibilities | Owns (write access) | Reads |
|---|---|---|---|
| **Orchestrator** | Integration, reviews, ADRs, merges, root config | `/package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.*`, `.dependency-cruiser.*`, `.github/**`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `infra/**` | everything |
| **Source Research** | Verification items V1–V9, fixture capture, `DATA_SOURCES.md` | `packages/test-fixtures/sources/**`, `scripts/capture-fixtures/**`, `docs/DATA_SOURCES.md` | docs |
| **Domain/DB** | Domain types, Zod schemas, migrations, repositories, as-of views, spatial SQL | `packages/domain/**`, `packages/db/**`, `packages/config/**`, `docs/DOMAIN_MODEL.md` | docs, fixtures |
| **Ingestion** | Adapter framework, adapters, HTTP client, pipeline, worker CLI/scheduler, backfills | `packages/sources/**` (one sub-agent per adapter folder in P4), `packages/http/**`, `packages/pipeline/**`, `apps/worker/**` | domain, db (API only) |
| **Correlation/Geo** | Geodesy, EQ correlation, fire clustering, relevance | `packages/geo/**`, `packages/correlation/**`, `packages/relevance/**` | domain, fixtures |
| **Baseline/Change** | Mc, percentiles, fire trend, change diff, importance, templates for change copy | `packages/baselines/**`, `packages/changes/**` | domain, geo |
| **API** | Briefing service, templates, geocoding, route handlers, validation, caching, rate limits | `packages/briefing/**`, `packages/geocoding/**`, `apps/web/app/api/**`, `apps/web/lib/server/**` | all packages |
| **Frontend** | Design system, pages, map, accessibility, responsive layouts | `apps/web/**` except `app/api/**` and `lib/server/**` | domain read-models |
| **Runtime AI** (P1) | Packet builder, prompts, validator, Anthropic client, eval set | `packages/ai/**` | briefing, domain |
| **Security Reviewer** | Independent review; no feature code | `docs/SECURITY.md`, review reports in `docs/reviews/security-*.md` | everything |
| **Adversarial QA** | Independent attack rounds; writes failing tests, not fixes | `docs/reviews/qa-round-*.md`, `tests/adversarial/**` | everything |

Rules:
1. **Foundational files** (root config, `packages/domain/src/**` after the P2 freeze, migrations) change only through the orchestrator. For domain/migrations that means the Domain/DB agent via an orchestrator-approved **change request** (a short ADR or ADR amendment).
2. **One migration writer.** Other agents request schema changes in their handoff; the Domain/DB agent writes the migration.
3. **Read-model contracts** (`packages/domain/src/read-models/*.ts`: `LocationBriefing`, `EventDetail`, `SourceStatus` …) are frozen at the end of P2, so Frontend (P9a) and API (P8) can work in parallel against them. Frontend uses generated mock data from `test-fixtures/read-models/**` until P8 lands.
4. Agents never edit files outside their ownership. If they need to, they stop and report `BLOCKERS`.

### 2.2 Handoff protocol (every agent, every phase)

```text
SCOPE COMPLETED          what was in scope and done; what was explicitly not done
FILES CHANGED            paths (git diff --stat)
ARCHITECTURAL DECISIONS  new decisions, each referencing an ADR or proposing one
TESTS RUN                exact commands
RESULTS                  pass/fail counts, pasted summary output (no "all green" without output)
ASSUMPTIONS              anything not verified
KNOWN RISKS
BLOCKERS                 including requests for changes outside ownership
RECOMMENDED NEXT STEP
```

### 2.3 Review protocol

1. **Orchestrator review** of every handoff:
   - diff read in full
   - tests re-run locally
   - dependency-cruiser clean
   - ADR compliance
   - no scope creep
2. **Security Reviewer** is mandatory for anything touching:
   - `packages/http`, `packages/config`
   - `apps/web/app/api/**`
   - `packages/db/src/spatial/**`
   - migrations
   - `packages/ai`
   - `.github/**`
   - `infra/**`
3. **Adversarial QA** runs at gates G5, G7 and G8 (§3). Findings are filed as failing tests where possible, plus severity per `GEONERVA_MASTER_BRIEF.md` §56.
4. Disagreements are resolved by the orchestrator, recorded in `DECISIONS.md` if architectural.

### 2.4 Integration gates

| Gate | After | Must be true |
|---|---|---|
| G0 | this document | Architecture docs approved by product owner; open questions answered or defaulted |
| G1 ✅ | P1 | **PASSED 2026-09-19** with exception E-1 (see `docs/reviews/gate-g1.md`): CI green on the scaffolded workspace; `pnpm db:up` + `pnpm db:check` (PostgreSQL + PostGIS + pg_trgm available) works on a clean machine. (`pnpm db:migrate` arrives with the migrator in P2, which packages/db owns) |
| G2 ★ ✅ | P2 | **PASSED 2026-09-19** (see `docs/reviews/gate-g2.md`). Schema + domain + read models frozen; as-of invariants I2/I3 pass; storage estimate measured |
| G3 | P3 | Vertical slice: USGS fixture → DB → as-of query; live USGS run in dev; idempotency proven |
| G4 | P4 | All P0 sources ingest in dev for ≥ 24 h; health derivation correct; drift drills pass |
| G5 | P5–P7 | Correlation calibrated on the labelled set (precision ≥ 0.98, recall ≥ 0.95 on M ≥ 4.5 pairs); relevance and baseline boundary tests; **QA round 1 on engines** |
| G6 | P8 | API contract tests; p95 briefing latency < 600 ms on the seeded dataset |
| G7 | P9b | E2E green desktop + mobile; axe clean; **QA round 2 (data integrity)** |
| G8 | P11 | All release gates in `TESTING.md` §11; **QA round 3 (production adversary)**; no CRITICAL/HIGH open |

## 3. Phases

### P0 — Source fixtures & verification ✅ COMPLETE (2026-09-19)
- **Goal:** Close verification items V1–V9 and capture the real fixtures every adapter and test depends on.
- **Dependencies:** none (parallel with P1).
- **Agent owner:** Source Research.
- **Files/packages:** `packages/test-fixtures/sources/**`, `scripts/capture-fixtures/**`, `docs/DATA_SOURCES.md`.
- **Tasks:**
  1. Capture scripts per source (bounded, polite, identifying UA).
  2. Capture the fixture list in `TESTING.md` §3, including revision pairs (poll the same USGS/GDACS/EMSC records twice, hours apart).
  3. Resolve V1 (GeoMet identity; for P1), V2 (GDACS `latest`), V3 (FIRMS `mapkey_status`, `data_availability`), V4 (URT/RT rows), V5 (GeoNames licence/size), V6 (EMSC fair use), V7 (react-maplibre v6), V8 (Supabase PostGIS version), V9 (ComCat association config).
  4. Build the **labelled earthquake correlation set**: ~300 USGS/EMSC pairs and non-pairs from the last 12 months via the EMSC EventID service, plus a hand-checked aftershock-sequence subset.
  5. Sanitize fixtures and add a MANIFEST with URL, time and hash.
- **Tests:** manifest hashes verified by a script; fixtures parse as JSON/CSV/XML.
- **Acceptance criteria:** every fixture in `TESTING.md` §3 exists; all V-items resolved or explicitly deferred with a reason; the labelled set exists with ground-truth source documented.
- **Expected commits:** `chore(fixtures): add capture scripts`, `test(fixtures): capture USGS/EMSC/GDACS/FIRMS payloads`, `test(fixtures): add labelled EQ correlation set`, `docs(sources): resolve verification items`.
- **Risks:** a provider changes during capture (re-capture); the EMSC EventID service is itself fuzzy (the hand-checked subset mitigates this).

### P1 — Foundation
- **Goal:** A clean, strict, reproducible workspace with CI.
- **Dependencies:** none.
- **Agent owner:** Orchestrator.
- **Files/packages:** root configs, `.github/workflows/ci.yml`, `infra/docker-compose.yml`, `packages/config`, `packages/http` (skeleton), empty package scaffolds with `package.json` + `tsconfig`, `README.md` (stub), `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, root `SECURITY.md`, `.env.example`.
- **Tasks:**
  1. `git init`, `main` branch, commit conventions.
  2. pnpm workspace; TS strict + `noUncheckedIndexedAccess`; ESLint + Prettier; dependency-cruiser rules from ARCHITECTURE §3.
  3. Vitest workspace config; Playwright scaffold.
  4. docker-compose with `postgis/postgis` (version pinned to match Supabase major), web and worker services.
  5. Env validation (`packages/config`) with fail-fast messages.
  6. CI:
     - install with cache
     - typecheck
     - lint
     - depcruise
     - unit
     - integration with a PostGIS service
     - build
     - gitleaks
     - `pnpm audit` (report-only)
  7. Verify current stable versions of Next.js, MapLibre (v6), `@vis.gl/react-maplibre` and Kysely before pinning.
- **Tests:** a smoke unit test per package; an env-validation test; the CI pipeline itself.
- **Acceptance criteria:** G1.
- **Expected commits:** `chore: initialize pnpm workspace`, `chore: strict TypeScript and lint`, `chore(ci): add CI pipeline`, `chore(infra): add docker compose with PostGIS`, `feat(config): validate environment`, `docs: add open-source community files`.
- **Risks:** MapLibre v6 wrapper incompatibility (fallback: in-house wrapper); PostGIS version mismatch between local and Supabase.

### P2 — Domain model & database ★ freeze ✅ COMPLETE (2026-09-19)
- **Goal:** Implement `DOMAIN_MODEL.md`: types, schemas, migrations, repositories, as-of views, spatial SQL, read-model contracts.
- **Dependencies:** P1 (P0 fixtures helpful but not blocking).
- **Agent owner:** Domain/DB.
- **Files/packages:** `packages/domain/**`, `packages/db/**`, `scripts/estimate-storage.ts`, `packages/test-fixtures/read-models/**`.
- **Tasks:**
  1. Enums, value objects, Zod schemas per hazard `attributes`; evidence-ID codec.
  2. Migrations `0001…` for all P0 tables in `DOMAIN_MODEL.md` §6, including partitions, indexes, RLS, schema, roles (web / worker), and seeds for `sources` and `source_products`.
  3. Migrator (checksummed, transactional); `kysely-codegen` in CI.
  4. Repositories: record upsert via aliases, version insert with hash compare, heads maintenance, run lease.
  5. `asof.ts` views and spatial query module.
  6. Health derivation function (pure) + repository.
  7. Read-model types + mock generators.
  8. Measure the storage footprint with a 3-day FIRMS sample + EQ backfill sample, and update ARCHITECTURE §12 numbers.
- **Tests:** schema/migration tests; repository integration tests; invariants I2, I3, I6, I8, I13 (property-based on DB); spatial SQL vs `geo` (after P5a, or with inline reference values).
- **Acceptance criteria:** G2. Storage estimate within the lean budget, or an ADR adjusting the profile.
- **Expected commits:** `feat(domain): add core types and schemas`, `feat(db): add initial schema migrations`, `feat(db): add as-of query layer`, `feat(db): add spatial queries`, `feat(domain): derive source health`, `feat(domain): define read-model contracts`, `test(db): enforce replay invariants`.
- **Risks:** as-of query performance (mitigated by heads caches + equivalence tests); partitioning on Supabase free (verify `pg_partman` isn't needed; manual daily partition creation by the worker).

### P3 — Ingestion framework + USGS (vertical slice)
- **Goal:** The adapter contract, hardened HTTP, run lifecycle, scheduler and the first complete adapter end to end.
- **Dependencies:** P2 (frozen), P0 USGS fixtures.
- **Agent owner:** Ingestion.
- **Files/packages:** `packages/http/**`, `packages/sources/src/contract.ts`, `packages/sources/usgs/**`, `packages/pipeline/**`, `apps/worker/**`.
- **Tasks:**
  1. HTTP client: allowlist, DNS private-IP block, timeouts, size caps, conditional GET, retries with `Retry-After`, URL secret redaction.
  2. Adapter contract + batch verdict logic.
  3. Pipeline: lease → fetch → parse → normalize → persist (one txn, `ingested_at` stamping) → post-commit hooks (no-op registry for now).
  4. USGS adapter: summary feed, FDSN `updatedafter` reconcile, `includedeleted` reconcile, alias merge handling.
  5. Worker: `start` (croner, jitter, breakers, heartbeat), `run --source`, `backfill usgs` (count-guided chunking). **[P0]** Treat HTTP **503 "table is full"** on a large FDSN query as "split the range", exactly like 400; `count` answers 200 with an `error` field when over the limit.
- **Tests:** contract tests on USGS fixtures incl. drift; integration idempotency, revision and alias merge; scheduler unit tests with a fake clock; HTTP client tests (redirect to another host, private IP, oversize).
- **Acceptance criteria:** G3. `worker start` ingests live USGS locally for 1 h with no errors.
- **Expected commits:** `feat(http): add hardened outbound client`, `feat(sources): define adapter contract`, `feat(pipeline): add ingestion run lifecycle`, `feat(ingestion): add USGS earthquake adapter`, `feat(worker): add scheduler and CLI`, `feat(worker): add USGS backfill`.
- **Risks:** the transaction size for backfills (chunk commits); deciding which volatile fields to exclude from the USGS hash.
- **Delivered [P3 complete, 2026-09-19]** — tasks 1, 2, 3 and 5's `start`/`run --source` in full. Deviations, each deliberate:
  - **Task 4's FDSN reconciles and task 5's `backfill usgs` were not built.** Both are *additional interfaces* to USGS (`fdsnws/event/1/query` with `updatedafter` and `includedeleted=only`, plus count-guided chunking), not part of the vertical slice the phase brief scoped: fixture → parse → normalize → persist → as-of read, proven idempotent. They move to **P4 alongside the other adapters**, where the deletion and reconcile machinery is shared work rather than a USGS special case. The storage measurement is the second reason: a 260k-event backfill needs the raw-payload retention decision (ARCHITECTURE §12) made first, or it will not fit the budget.
  - **`croner` was not introduced.** Every v1 schedule is an interval, not a calendar; the scheduler uses injected timers, which is what makes the jitter and the breaker testable without waiting. The first genuinely calendar-based job (the daily reconcile, the retention sweep) is the right moment for a cron dependency.
  - **Conditional GET is implemented in the client but unused.** The frozen schema has nowhere to persist a validator between runs, so "nothing changed" compares the body digest against the previous run's `payload_sha256`. See ARCHITECTURE §4.1.
  - **The error taxonomy was extended** (ADR-032), the only frozen-contract change P3 made.

### P4 — Remaining P0 adapters (parallel: 4a ∥ 4b ∥ 4c)
- **Goal:** EMSC, GDACS and FIRMS complete to the same standard as USGS.
- **Dependencies:** P3 (framework frozen), P0 fixtures.
- **Agent owner:** Ingestion (three sub-agents, one per folder).
- **Files/packages:** `packages/sources/emsc/**`, `packages/sources/gdacs/**`, `packages/sources/firms/**`; `apps/worker/src/registry.ts` is orchestrator-merged.
- **Tasks:**
  - 4a EMSC: FDSN `format=json` polling with `updatedafter`, degree-radius handling, `unid` identity, deletion sweep, backfill.
  - 4b GDACS: RSS change trigger → `geteventdata`/`getgeometry`, episode versions, role-tagged geometries, UTC parsing, 204/timeout handling, `derived_from` for EQ, 5-year backfill.
  - 4c FIRMS: sensor capability discovery (`data_availability`), world `DAY_RANGE=2` per active product, keyless fallback, CSV streaming parse with caps, COPY into daily partitions, `missing_data`, partition creation + retention job, `EMPTY_SUSPICIOUS`.
- **Tests:** contract tests for every fixture + drift fixture; integration idempotency; FIRMS midnight-span test; partition retention test.
- **Acceptance criteria:** G4.
- **Expected commits:** `feat(ingestion): add EMSC earthquake adapter`, `feat(ingestion): add GDACS adapter with episodes and geometries`, `feat(ingestion): add NASA FIRMS thermal detection adapter`, `feat(worker): add retention jobs`.
- **Risks:** GDACS API instability (the RSS-first design mitigates this); FIRMS volume on lean storage; EMSC fair-use.

### P5 — Geo, correlation, clustering
- **Goal:** Pure geodesy (5a), deterministic EQ correlation (5b) and fire clustering (5c), wired as pipeline post-commit hooks.
- **Dependencies:** 5a: P1. 5b/5c: P2 (+ P0 labelled set for 5b). Wiring: P3.
- **Agent owner:** Correlation/Geo.
- **Files/packages:** `packages/geo/**`, `packages/correlation/**`; hook registration through a pipeline handoff (orchestrator merges).
- **Tasks:**
  - 5a: distance, bbox/antimeridian, parsing, rounding, grid cells.
  - 5b: stages 0–2, misfit, veto, uniqueness gap, hysteresis, same-source rule, `canonical_event_state` projection, agreement, headline precedence; a calibration script producing precision/recall on the labelled set.
  - 5c: union-find clustering, identity inheritance/merge, summaries, hulls, versions, heads.
- **Tests:** §2 unit tables; invariants I1, I4, I5, I7; integration fixture → canonical events; calibration report committed to `docs/reviews/correlation-calibration.md`.
- **Acceptance criteria:** G5 correlation metrics; clustering deterministic under permutation; 30-min FIRMS batch clustered in < 20 s on the worker VM class.
- **Expected commits:** `feat(geo): add geodesic utilities`, `feat(correlation): canonicalize cross-source earthquakes`, `feat(correlation): cluster thermal detections`, `test(correlation): add calibration report`.
- **Risks:** EMSC ML/mb vs USGS Mw magnitude differences cause false NO_MATCH (the halving and veto are calibrated on data).

### P6 — Relevance
- **Goal:** Hazard-specific relevance models + data confidence per `ARCHITECTURE.md` §9.
- **Dependencies:** P2, P5a.
- **Agent owner:** Correlation/Geo.
- **Files/packages:** `packages/relevance/**`.
- **Tasks:** one module per family with its config file; reason codes with templates; `authoritative_basis`; confidence rules; methodology export (config → JSON for the methodology page).
- **Tests:** boundary tests at every threshold; I10; historical scenario checks (e.g. Al Haouz 2023 at Marrakech → HIGH/CRITICAL as expected).
- **Acceptance criteria:** all boundaries covered (CI threshold parser); scenario table reviewed by the orchestrator.
- **Expected commits:** `feat(relevance): add earthquake relevance model`, `feat(relevance): add fire, flood, cyclone, volcano models`, `feat(relevance): add data-confidence rules`.
- **Risks:** thresholds feel wrong on real scenarios (tune before G5; every change documented).

### P7 — Baselines & change detection
- **Goal:** `ARCHITECTURE.md` §8 and §10.
- **Dependencies:** P2, P5a (pure parts). Backfill-dependent tests need P3/P4 backfills.
- **Agent owner:** Baseline/Change.
- **Files/packages:** `packages/baselines/**`, `packages/changes/**`.
- **Tasks:** Mc estimation; windowed counts; mid-rank percentile; bands + hysteresis; rarity statements; sequence context; fire trend (overpass-normalized); GDACS context; the diff classifier; materiality; grouping; importance/prominence; suppression reasons.
- **Tests:** §2 tables; zero-heavy distributions; replay-window diff tests; "nothing changed" output.
- **Acceptance criteria:** G5 (with P5/P6); a methodology text draft for each metric.
- **Expected commits:** `feat(baselines): add completeness-aware earthquake baselines`, `feat(baselines): add fire activity trend`, `feat(changes): classify snapshot differences`, `feat(changes): rank change prominence`.
- **Risks:** EMSC backfill depth insufficient for OK status in many regions (rarity/insufficient states are the designed outcome, not a bug).

### P8 — Briefing service & domain API
- **Goal:** `buildSnapshot`, `buildBriefing`, templates, the evidence manifest/resolver, and all P0 `/api/v1` endpoints.
- **Dependencies:** P3, P4 (data), P5, P6, P7.
- **Agent owner:** API.
- **Files/packages:** `packages/briefing/**`, `apps/web/app/api/**`, `apps/web/lib/server/**`.
- **Tasks:**
  1. Snapshot builder (parallel family queries); diff wiring; deterministic templates.
  2. Geocoding (GeoNames import script + Nominatim adapter with queue/cache). **[P0]** `cities15000` is **34,146 rows / 19 columns**, and type-ahead must index `alternatenames`: the primary name is "Marrakesh" and "Marrakech" exists only as an alternate.
  3. Rate limiting; problem+json errors; cache headers; canonical URL normalization.
  4. Worker-side materialization for curated places.
  5. OpenAPI document generated from Zod.
- **Tests:** API contract tests (Zod ↔ OpenAPI); integration through HTTP; I9, I11, I14, I15; latency benchmark on the seeded DB.
- **Acceptance criteria:** G6.
- **Expected commits:** `feat(briefing): build location snapshots as of a time`, `feat(briefing): generate deterministic briefing copy`, `feat(api): add briefing and events endpoints`, `feat(api): add place search with local suggestions`, `feat(api): add evidence resolver and source status`.
- **Risks:** latency of two snapshots for dense regions (caps + CDN); Nominatim policy compliance.

### P9 — Frontend (9a ∥ P3–P8; 9b after P8)
- **Goal:** `PRODUCT.md` §6.
- **Dependencies:** 9a: P2 read models. 9b: P8.
- **Agent owner:** Frontend.
- **Files/packages:** `apps/web/**` except API/server.
- **Tasks:**
  - **9a:**
    - design tokens (dark, accessible palette), typography
    - components: situation strip, change item, hazard card with states, source chip, evidence drawer/bottom sheet, relevance "Why?" popover, nearby table, history mini-chart
    - map wrapper (MapLibre v6, layers per family, legend, keyboard toggles, WebGL2 fallback). **[P0]** Pin `@vis.gl/react-maplibre@^8.1.3`: v6 support landed in 8.1.2 and the peer range (`maplibre-gl >=4`) will not warn about older wrappers
    - pages against mock read models
  - **9b:** wire to the API; loading and error states; replay banner (`as_of`); `/data-status`; `/methodology` rendered from exported configs; landing.
- **Tests:** component tests; Playwright flows in `TESTING.md` §5; axe; visual regression for key states (optional).
- **Acceptance criteria:** G7.
- **Expected commits:** `feat(web): add design system tokens and primitives`, `feat(web): add location intelligence dashboard`, `feat(web): add multi-hazard map`, `feat(web): add event and fire cluster pages`, `feat(web): add data status and methodology pages`.
- **Risks:** the mobile map UX; the MapLibre bundle size (dynamic import, client-only).

### P10 — Deployment & operations
- **Goal:** A public, reproducible deployment path.
- **Dependencies:** P8 (web), P4 (worker); P9b for the full release.
- **Agent owner:** Orchestrator (+ Security Reviewer).
- **Files/packages:** `infra/**`, `.github/workflows/**`, `docs/DEPLOYMENT.md` (new).
- **Tasks:**
  1. Worker Dockerfile (non-root, read-only FS) and VM bootstrap (systemd or compose, auto-restart, log rotation).
  2. Supabase project setup notes (schema, roles, pooler URLs).
  3. Vercel project; headers/CSP.
  4. Nightly live-smoke workflow; manual backfill workflow; staging environment (a second DB or schema).
  5. 24 h staging soak.
- **Tests:** migration smoke; scheduled-ingestion smoke; production smoke (`TESTING.md` §10).
- **Acceptance criteria:** a 24 h staging soak with ≥ 99 % non-provider run success; production smoke green.
- **Expected commits:** `chore(infra): add worker container`, `chore(infra): document VM deployment`, `chore(ci): add nightly live smoke`, `chore(web): add security headers`.
- **Risks:** free-VM availability/account requirements (owner decision Q2); Supabase free pausing (continuous writes).

### P11 — Hardening & adversarial QA → v1
- **Goal:** Release quality.
- **Dependencies:** P10.
- **Agent owner:** Security Reviewer + Adversarial QA (independent), fixes by the owning agents.
- **Tasks:**
  1. Performance pass.
  2. Accessibility audit.
  3. Outage/stale/conflict drills.
  4. QA Round 3 (production adversary, brief §55).
  5. Fix all CRITICAL/HIGH and re-run the full gate.
  6. README with architecture diagram, screenshots, limitations.
  7. Good-first-issue backlog.
- **Acceptance criteria:** G8.
- **Expected commits:** `fix(...)` per finding, `test(adversarial): ...`, `docs: complete README`, `chore(release): v1.0.0`.
- **Risks:** late scientific-language findings (mitigated by round 1 at G5 and round 2 at G7).

### P1.x — Post-launch (order from `PRODUCT.md` §4.2)
Replay UI + reconstructed scenarios → Runtime AI (Interpreter + Skeptic, eval set first) → ECCC GeoMet → NWS → watch places / since-last-visit → share permalinks → fire seasonal baseline → EQ felt-intensity → Protomaps fallback / MVT / push subscribers. Each follows the same phase template and gates.

## 3a. Carried-forward security requirements (from docs/reviews/security-p1.md)

These are **exit criteria** of the named phases. A phase gate cannot pass while its items are open.

| Finding | Requirement | Phase |
|---|---|---|
| F-6 | Integration tests use a dedicated `DATABASE_URL_TEST`. Any test that writes must refuse to run against a non-local host unless `GEONERVA_ALLOW_REMOTE_TEST_DB=1`, and must use an isolated schema or database | P2 (before the first writing integration test) |
| F-7 | Production database URLs require TLS (`sslmode=require` or stronger); the config refuses a non-TLS URL when `NODE_ENV=production` | P2 (db client), verified in P10 |
| F-12 | Production processes must set `NODE_ENV=production` explicitly. Deployment manifests set it, and the worker/web start-up logs it | P3 (worker), P10 |
| F-8 | Web configuration is loaded only in server-only modules (`server-only` import); secrets never reach RSC props or client components (a test asserts it). Client components must never read `process.env`: a prerendered client page embeds the value in public HTML (verified in the P1 re-review; the `build:canary` check catches it) | P8 |
| F-5 | A strict Content-Security-Policy (`default-src 'self'`, a script policy compatible with CDN-cached HTML, i.e. hashes or `strict-dynamic`, no `unsafe-inline` for scripts). It must land before any provider text is rendered | P9a (before P9b) |
| R-7 | `apps/web/lib/client/api-client.ts` is the only module exempt from the network-call ban. It must reject absolute URLs and anything outside `/api/v1` at runtime, with a test, and counts as security-review-relevant | P9a |
| F-16 | `MAP_STYLE_URL` is parsed into an origin and validated before use in CSP or fetches | P9a |
| F-15 | Enable GitHub private vulnerability reporting, and publish a fallback security contact and a Code of Conduct contact | Before the repository is made public (P10) |
| F-2b | The worker installs `unhandledRejection` and `uncaughtException` handlers using the same redaction as `describeUnexpectedError`, once asynchronous commands exist | P3 |
| N-5 | `apps/web` must not reach the Anthropic client even transitively: add a `reachable` dependency rule when `packages/ai` gains it | P1.x (Runtime AI) |
| S-9 | Every exported fact reader takes `as_of`, or is provably not a fact reader. Add the dependency rule docs/SECURITY.md C4 claims ("the as-of module is the only fact reader") and extend the property test to assert coverage of the exported read surface, not a hand-written list. The as-of-free readers in `spatial/queries.ts` are unused today; this must land **before** any web or briefing code can reach for one | P8 (rule before the first endpoint) |
| S-15b | ADR-008 requires no *named* server-side prepared statements behind the transaction pooler. This holds **by construction** — Kysely's Postgres dialect calls `client.query(sql, params)` with no statement name, so pg uses the unnamed portal — rather than by configuration; Kysely has no `preparedStatements` option, and the flag that pretended to set one has been removed. Confirm against the real Supabase pooler that no prepared-statement error appears under load | P10 |
| C1-forward | Under RLS deny-all a misconfigured role reads **zero rows with no error**, so `healthAsOf` would return an empty list rather than "unavailable". The briefing must treat "no sources known" as UNAVAILABLE, never as "nothing is happening" (docs/SECURITY.md C1) | P8 |
| F-17 | Upgrade to a supported ESLint major once Next's plugins allow it; make `pnpm audit` blocking for high/critical | P11 |

## 4. Product-owner decisions (resolved 2026-09-19)

| # | Decision |
|---|---|
| Q1 | **Apache-2.0** licence |
| Q2 | **Free VM worker + Supabase Free + `RETENTION_PROFILE=lean`** for public v1. No paid database/storage. The 72 h fire replay horizon is accepted and documented |
| Q3 | Initial public deployment is **non-commercial** (Vercel Hobby acceptable) |
| Q4 | **`AI_MODE=disabled` is the production default for v1.** No paid runtime AI at launch. The P1 Claude architecture is preserved; the deterministic system ships first |
| Q5 | Demo places: **Marrakech, Vancouver, Los Angeles, Tokyo, Reykjavík**, where data coverage permits. P0 verifies coverage and may propose substitutions only if materially better |

The original question table is kept below for traceability.

| # | Question | Default if unanswered | Blocks |
|---|---|---|---|
| Q1 | **Repository licence**: MIT, Apache-2.0 or AGPL-3.0? (AGPL keeps hosted forks open; MIT/Apache maximize adoption) | Apache-2.0 (patent grant, permissive) | End of P1 |
| Q2 | **Hosting budget & accounts**: OK to use an always-free VM (Oracle Cloud / GCP, may require a card on file) for the worker? Is any monthly spend acceptable (e.g. Supabase Pro ~US$25/mo for the `standard` profile: longer replay horizon, 30-day detections)? | Free VM + Supabase Free + `lean` profile (72 h fire replay horizon) | P10 (and P2 storage tuning) |
| Q3 | **Commercial intent**: will the public deployment ever be monetized (ads, donations tied to the product, company use)? Vercel Hobby is non-commercial only. OSM/Nominatim/OpenFreeMap are fine either way | Non-commercial demo on Vercel Hobby | P10 |
| Q4 | **Runtime AI model and daily budget** (P1): default `claude-opus-5` at a US$1/day cap (~5–10 validated briefings/day), vs a cheaper model for more coverage | `claude-opus-5`, US$1/day, curated places only | P1.x AI phase |
| Q5 | **Curated/demo places** shown on the landing page and materialized (need ~8–12; suggested: Marrakech, Montréal, Manila, Istanbul, Los Angeles, Tokyo, Jakarta, Mexico City, Kathmandu, Reykjavík, Suva, Santiago) | Suggested list | P8 |

## 5. Go / No-Go

**GO**, conditional on product-owner review of this document set (gate G0). The open questions all have safe defaults, so none blocks the start.

**First phase: P1 — Foundation**, owned by the orchestrator, with **P0 — Source fixtures & verification** running in parallel by the Source Research agent. P1 touches only foundational files, and P0 only fixtures and `DATA_SOURCES.md`, so they cannot conflict. P2 (Domain & DB) must not start until G1 is green, and nothing else may start until the G2 freeze.
