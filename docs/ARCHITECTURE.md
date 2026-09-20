# GeoNerva — Architecture

> Status: **proposed for architecture freeze** (2026-09-19). Companion documents: `DOMAIN_MODEL.md` (entities, schema), `DATA_SOURCES.md` (provider contracts), `DECISIONS.md` (why), `IMPLEMENTATION_PLAN.md` (how/when).

## 1. System overview

GeoNerva is a **modular monolith deployed as two processes that share one database**:

- **worker**: ingestion, correlation, clustering and materialization. Long-running, scheduled, and the only writer of provider facts.
- **web**: a Next.js UI plus a read-only domain API. It computes briefings on demand from the database and never calls hazard providers.

```text
                    ┌──────────── Official providers ────────────┐
                    │ USGS   EMSC   GDACS   NASA FIRMS   (ECCC P1)│
                    └───────────────────┬────────────────────────┘
                                        │ HTTPS (allowlisted hosts, bounded bodies, timeouts)
┌───────────────────────────── worker (Node, container) ─────────────────────────────┐
│ scheduler ─► adapter.fetch ─► adapter.parse (Zod) ─► adapter.normalize (pure)      │
│      │                                   │ rejects / schema drift → run FAILED      │
│      ▼                                   ▼                                          │
│ run lease ─► persist versions (append-only, content-hash dedupe, one txn/batch)    │
│      ─► correlate (EQ) ─► cluster (fires) ─► refresh projections                   │
│      ─► materialize snapshots for curated locations ─► (P1) AI briefing cache       │
└───────────────────────────────────────┬────────────────────────────────────────────┘
                                        │ SQL (session pooler / direct)
                         ┌──────────────▼───────────────┐
                         │ PostgreSQL + PostGIS          │  schema "geonerva"
                         │ append-only facts + caches    │  RLS deny-all, not API-exposed
                         └──────────────▲───────────────┘
                                        │ SQL (transaction pooler, prepare=false)
┌───────────────────────────── web (Next.js on Vercel) ──────────────────────────────┐
│ /api/v1/* (read-only, Zod-validated, CDN-cached)                                    │
│   briefing = buildSnapshot(L, now) ⊕ buildSnapshot(L, now−Δ) → diff → ChangeSignals │
│ UI: dashboard · map (MapLibre) · event detail · data status · methodology          │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**The core design choice.** The brief's pipeline ends with "Location Snapshot → UI" and computes "What Changed?" by diffing a location's snapshot N against snapshot N−1. That works only for locations the system already tracks, and "since the previous analysis" means nothing to a first-time visitor. GeoNerva instead stores **append-only, bitemporal facts**, which makes any snapshot reproducible for any knowledge time. "What Changed?" becomes `diff(snapshot(L, now−Δ), snapshot(L, now))`. That works for any location, any window, and replay, and snapshot persistence becomes a cache. (ADR-004.)

## 2. Deployment topology

| Component | Default (zero-cost demo) | Alternative | Notes |
|---|---|---|---|
| web | Vercel Hobby | any Node host / Docker | Hobby is **non-commercial only**. It has no ingestion work, and CPU (4 h/month) is only spent on reads |
| worker | 1 small always-on container on a free-tier VM (Oracle Cloud Always Free or GCP e2-micro) | any Docker host, Fly/Render paid, or a home server | Runs `node apps/worker` with its internal scheduler. It is the natural place for P1 push subscribers (EMSC websocket, ECCC AMQPS) |
| database | Supabase Free with `RETENTION_PROFILE=lean` | Supabase Pro (8 GB), or Postgres+PostGIS on the worker VM | Business logic uses plain SQL/PostGIS only, with no Supabase APIs (ADR-008) |
| scheduler | inside the worker (croner, jittered) | external cron calling `worker run --source X` (single-shot mode) | Single-shot mode is for local dev, CI smoke tests and emergency use |
| basemap | OpenFreeMap (browser → OpenFreeMap directly) | self-hosted Protomaps PMTiles (P1) | Provider is a config value (`MAP_STYLE_URL`) |
| local dev | `docker compose up` (postgis, worker, web) | — | FIRMS keyless mode, so no secrets are needed for a first run |

**Why not GitHub Actions + Vercel Cron, as the brief proposes** (ADR-007):
- Vercel Hobby cron is limited to **once per day**.
- GitHub's terms allow hosted runners only to "develop and test your application(s)" and exclude activity "unrelated to the production, testing, deployment, or publication of the software project". A production ingestion cron is at best a grey area.
- Scheduled workflows are delayed at the top of the hour, can be dropped, and are **auto-disabled after 60 days** without repository activity.
- A 30 MB/day global FIRMS stream parsed every 30 minutes would consume most of Vercel Hobby's CPU budget.

GitHub Actions stays in the design for CI, nightly live-API smoke tests and one-off backfills.

**Database connections:**
- **worker** uses the session pooler or a direct connection, because it needs prepared statements, long transactions and `COPY`.
- **web** uses the Supabase transaction pooler (port 6543) with `prepare: false`.
- Direct Supabase connections are IPv6-only unless the IPv4 add-on is purchased, so the default is the pooler.

## 3. Repository and package architecture

pnpm workspaces, TypeScript strict. Dependency rules are enforced in CI by `dependency-cruiser`.

```text
geonerva/
├── apps/
│   ├── web/                    Next.js (App Router): UI + /api/v1 route handlers (thin)
│   └── worker/                 CLI + scheduler: `worker start`, `worker run --source usgs`, `worker backfill …`
├── packages/
│   ├── domain/                 Types, enums, Zod schemas, invariants, evidence-id codec, read-model contracts. NO IO.
│   ├── geo/                    Pure geodesy: distance, bbox/antimeridian, coordinate parsing & rounding, grid cells.
│   ├── sources/                One folder per adapter: usgs/, emsc/, gdacs/, firms/ (eccc/, nws/ in P1).
│   │                           fetch (injected HTTP client) + parse (Zod) + normalize (pure). No DB.
│   ├── db/                     Migrations (SQL), Kysely types, repositories, as-of query helpers. Only package with SQL.
│   ├── correlation/            Pure EQ correlation engine + fire clustering (union-find). Operates on domain types.
│   ├── relevance/              Pure hazard-specific relevance models + data-confidence rules.
│   ├── baselines/              Pure statistics (empirical percentile, Mc estimation, bands) + metric definitions.
│   ├── changes/                Pure snapshot diff → ChangeSignal[], importance & prominence.
│   ├── briefing/               Application services: buildSnapshot(L, asOf), buildBriefing(L, window), evidence manifest,
│   │                           deterministic templated copy. Depends on db repositories + pure engines.
│   ├── pipeline/               Ingestion orchestration: run lease, persist, correlate, cluster, materialize.
│   ├── ai/                     (P1) Runtime AI: packet builder, prompts, Anthropic client, validator, fallback.
│   ├── http/                   Hardened outbound HTTP client: host allowlist, timeouts, size caps, retries, UA.
│   ├── geocoding/              Place search behind a provider interface (local suggestions, Nominatim, reverse).
│   │                           The web app's only route to an external host (ADR-028).
│   ├── config/                 Env parsing & validation (Zod), feature flags, retention profiles.
│   └── test-fixtures/          Captured provider payloads + builders + scenario datasets.
├── docs/
├── scripts/                    One-off tools: fixture capture, GeoNames import, storage estimator.
├── infra/                      docker-compose.yml, worker Dockerfile, VM bootstrap notes, Supabase notes.
└── .github/workflows/          ci.yml, live-smoke.yml (nightly), backfill.yml (manual)
```

**Dependency direction** (arrows point to dependencies; no cycles):

```text
domain ◄── geo
domain, geo, http, config ◄── sources
domain, geo, http, config ◄── geocoding
domain, config ◄── db
domain, geo ◄── correlation | relevance | baselines | changes      (pure engines; no IO)
domain, geo, db, relevance, baselines, changes, config ◄── briefing
domain, geo, sources, db, correlation, briefing, http, config ◄── pipeline
domain, briefing, config ◄── ai
briefing, geocoding, ai, config ◄── apps/web
  db/asof ◄── apps/web   (P3: reads only through the as-of layer; the dependency-cruiser rule
                          `web-reads-facts-only-through-asof` refuses the write side, and the
                          `@geonerva/db/asof` subpath is what makes that satisfiable)
pipeline, config ◄── apps/worker
```

Rules (enforced by `.dependency-cruiser.cjs` and `eslint.config.js`):
1. Pure engines never import `db`, `http`, `sources`, Next.js, or any IO/process module, and do not use `fetch` or `process`.
2. `apps/web` never reaches `sources` or `pipeline`, even transitively. Its only route to an external host is `geocoding` (ADR-028). No code in `apps/web` calls `fetch` except a single same-origin API-client module.
3. Only `db` contains SQL and imports a Postgres client. Only `http`, `sources`, `pipeline` and `geocoding` import the outbound HTTP client, and only `http` may import raw network modules (`node:https`, `undici`, …).
4. Only `sources` knows provider field names. Everything after `normalize` is provider-agnostic, and UI code branches on capabilities and hazard types, never on source IDs.

## 4. Ingestion

### 4.1 Adapter contract (revised from the brief)

```ts
interface SourceAdapter<TRaw> {
  descriptor: SourceDescriptor;              // id, products, capabilities, freshness policy, attribution, allowed hosts
  fetch(ctx: FetchContext): Promise<FetchResult>;           // conditional GET (ETag/Last-Modified), bounded body
  parse(body: Uint8Array, ctx: ParseContext): ParseResult<TRaw>;   // Zod; returns records + rejects + batch verdict
  normalize(raw: TRaw, ctx: NormalizeContext): NormalizedRecord;   // PURE, deterministic, no clock, no IO
}
```

Changes from the brief:
- `healthCheck()` is removed, because health is derived from run history (`DOMAIN_MODEL.md` §4.3).
- `normalize` is synchronous and pure, which makes contract tests trivial and deterministic.
- `parse` returns a **batch verdict**, so schema drift is decided per batch, not per record.

Corrections from the P3 implementation, which is the authoritative shape:

- **The descriptor does not carry attribution or the freshness policy.** Both are seeded in
  `geonerva.sources`; copying them into code would let the two drift, and the drift would be
  invisible. The descriptor names the policy (`policyKey`) and an integration test asserts every
  descriptor matches a seeded product.
- **It carries one `productCode`, not a list.** One adapter serves one product; a source with
  several products has several descriptors.
- **It carries `emptyBatchIsSuspicious`, which is *not* the policy's `quietIsNormal`.** "Is it
  normal for the newest observation to be old?" (USGS: yes) and "is it normal for a whole poll to
  return nothing?" (USGS: no) are different questions, and one flag for both forces a wrong answer
  to one of them.
- **Conditional GET is supported by the HTTP client but not used.** The frozen schema has nowhere
  to persist an ETag between runs, so "nothing changed" is detected by comparing the body digest
  with the previous run's `ingestion_runs.payload_sha256`. The cost is one ~1 MB download per poll
  that a 304 could have avoided; adding a column to a frozen table was not judged worth it. A feed
  that *does* answer 304 is still handled, and a 304 deliberately carries the **previous** digest
  forward rather than the hash of the empty body, which would otherwise erase the comparison.
- **That digest is scoped to `(source, product)`, not to the feed [G3 carry-over, closed P4].**
  `all_hour` and `all_day` are one product, so alternating between them compares a digest from a
  different feed. This can only ever cost a wasted re-parse, never a wrongful skip: every summary
  body carries its own feed URL in `metadata`, so two feeds cannot produce identical bytes. Scoping
  it properly needs a column on `ingestion_runs`, which is not worth a change to a frozen table to
  save a re-parse nobody has measured. A **backfill never consults it at all** — it asks a bounded
  question, so "the body is identical to the last run" is meaningless there, and a SKIPPED outcome
  would leave its interval unmarked.

### 4.2 Run lifecycle

```text
1. acquire lease     INSERT ingestion_runs(status=RUNNING)      -- partial unique index = mutex per product
2. fetch             allowlisted host, timeout 30 s (FIRMS 120 s), max body (USGS 20 MB, FIRMS 40 MB, GDACS 5 MB)
                     304 Not Modified / identical payload hash → SKIPPED (still health evidence)
3. parse             Zod per record; verdict:
                       - top-level shape invalid                     → FAILED(SCHEMA_DRIFT), write nothing
                       - rejected records > 20 % of batch            → FAILED(SCHEMA_DRIFT), write nothing
                       - zero records where quiet_is_normal = false  → FAILED(EMPTY_SUSPICIOUS)
                       - otherwise proceed; rejects → ingestion_rejects
4. normalize         pure; content_sha256 per record
5. persist (1 txn)   upsert raw payloads (by hash) → resolve record identity (aliases) → insert versions where hash differs
                     → update heads → stamp ingested_at = clock_timestamp() on the batch → run SUCCEEDED/PARTIAL → COMMIT
6. post-commit       correlation (EQ) / clustering (FIRMS) for affected records → projections → snapshot materialization
```

- Failures are classified as `HTTP_4XX | HTTP_5XX | TIMEOUT | TOO_LARGE | SCHEMA_DRIFT | EMPTY_SUSPICIOUS | RATE_LIMITED | DB_ERROR | LEASE_EXPIRED | NETWORK | CONFIG_ERROR | ABORTED | UNKNOWN` (ADR-032).
  `CONFIG_ERROR` and `ABORTED` describe GeoNerva's own state, not the provider's. They are treated differently, on purpose (ADR-032): **`ABORTED` is excluded** from the failure count, because a run we cancelled says nothing about the source and counting it would mark everything `DEGRADED` after a routine deploy; **`CONFIG_ERROR` still counts**, because a broken allowlist means we genuinely have no data and the status must fall — what changes is that `lastErrorClass` tells the operator the fault is ours.
- **The drift threshold is re-checked after persistence, not only after parsing.** Records can
  also be refused by the time-semantics invariants (a future observation, an inverted validity
  interval). If that pushes the batch past the threshold, the transaction is rolled back and the
  run fails writing nothing — otherwise a feed whose timestamps drifted would commit as `PARTIAL`
  with zero facts and report itself as merely degraded.
- **One unusable *record* is a reject; one broken *identity* fails the batch.** A bad value (an
  out-of-range intensity, an impossible coordinate) is a reject row and the batch survives, because
  a summary feed republishes the same record for 24 hours and failing on it would take the source
  dark for a day. A preferred id missing from its own alias set fails the batch, because carrying
  on would fabricate a duplicate record that later reads as a second independent source.
- **A product the database does not know is `CONFIG_ERROR` with no run row at all.** The lease is
  taken *after* the product lookup, so there is nothing to hang a run on, and this failure is
  therefore invisible in source health by construction. The worker exits non-zero for it — that
  exit code is the only signal, which is why `CONFIG_ERROR` is the one class the CLI does not
  treat as routine.
- Retries use exponential backoff with jitter and honour `Retry-After`.
- A per-source circuit breaker opens after 5 consecutive failures and probes every 15 minutes.
- Step 6 failures never roll back facts. They are recorded as `analysis_runs` failures and retried on the next cycle, because projections are rebuildable.

### 4.3 Per-source ingestion plan

| Source | Poll | Request | Reconcile |
|---|---|---|---|
| USGS | 5 min | `summary/all_day.geojson` (conditional GET) | Hourly FDSN `updatedafter=last_success−2h`. Daily `includedeleted=only` for the last 30 d. Cold start or gap > 20 h: `all_week` |
| EMSC | 5 min | FDSN `format=json&updatedafter=last_success−30min&limit=2000`. `updatedafter` is **not** ordered by `lastupdate` and resurfaces old revised events | Daily re-query of the last 7 d. A `unid` absent from two consecutive reconciles is tombstoned `MISSING_FROM_SOURCE` (ADR-030): FDSN has no deleted-event query |
| GDACS | 10 min | `rss_24h.xml` (conditional) as the change trigger. For new or changed `(eventid, episodeid)`: `geteventdata` (+ `getgeometry` for FL/TC/WF; cap/simplify geometry, observed up to 1.8 MB per call) | `SEARCH` over windows sized to return **< 100 events**, split recursively, `alertlevel=green;orange;red` always, dedupe by `(eventtype, eventid)`. **Never page**: pages overlap (ADR-029) |
| FIRMS | 30 min | Area API `world`, `DAY_RANGE=2`, per active VIIRS product. Keyless CSV if no key / key exhausted — note the keyless "24 h" file actually spans ≈ 42 h, so it is a rolling window, not a day | `missing_data` daily (the keyless `?action=fetch_data` JSON works without a key), which marks "no satellite data" days |

### 4.4 Backfills (worker CLI, idempotent, resumable)

- `backfill usgs --from 2000-01-01 --minmag 4.5`: count-guided recursive chunking under the 20,000 limit.
- `backfill emsc --from <profile> --minmag <profile>` (lean: 2021 / M3.0, standard: 2012 / M2.5). Same chunking.
- `backfill gdacs --years 5`
- `import geonames cities15000`

Backfilled versions receive `ingested_at = backfill time`. Replay correctly treats them as unknown before that moment; this is intentional and documented.

## 5. Read path: building a briefing

```text
GET /api/v1/briefing?place=p:2542997&window=24h
  1. resolve location (place table / rounded coords), coverage per family
  2. S_now  = buildSnapshot(L, as_of = now)                        ┐ same code path,
  3. S_prev = buildSnapshot(L, as_of = now − 24h)                   ┘ different knowledge time
  4. signals = diff(S_prev, S_now)                                  → ChangeSignal[] with prominence
  5. copy = templates(S_now, signals)                               → deterministic sentences with evidence ids
  6. (P1) ai = cached AgentOutput for S_now.content_sha256 if validated, else none
  7. respond LocationBriefing { snapshot, changes, copy, ai?, evidence_manifest }
```

`buildSnapshot(L, T)` performs, per hazard family, a bounded number of indexed queries:
1. Candidate subjects within the family's search radius, using the as-of views.
2. Source health at T.
3. Baseline metrics.
4. The pure relevance and confidence engines.

The target is a p95 under 600 ms warm for a location with fewer than 200 candidate subjects. Both snapshots run in parallel. Results are CDN-cached by rounded location and window (§13.3).

**As-of views** live in `packages/db/src/asof.ts` and are the only way to read facts:
- `observationsAsOf(T)`: latest version per record with `ingested_at ≤ T`, excluding records merged before T.
- `linksAsOf(T)`
- `clusterVersionsAsOf(T)`
- `healthAsOf(T)`

When `T = now`, the query planner uses the `*_heads` / `*_state` caches instead; a test asserts that both paths return identical results on fixtures.

## 6. Event correlation

Correlation is deterministic, versioned (`algorithm_version`) and explainable. An LLM is never involved.

### 6.1 Earthquakes

**Stage 0: same-source identity.** USGS alias sets (`ids`), EMSC `unid`. If ComCat merges two IDs, the source records are merged (`DOMAIN_MODEL.md` §4.6). **Invariant:** a canonical event never contains two active records from the same source. ComCat and EMSC have already decided those are different events, and this rule stops aftershock sequences from being collapsed into one event.

**Stage 1: explicit cross-reference (`IDENTITY_REF`).** If a record carries `derived_from` (GDACS EQ `sourceid`), look it up in the USGS alias table.
- If found: `MATCH`, relation `DERIVED_COPY`, confidence 0.99, reason `GDACS references USGS event us7000tikb`.
- If not found yet (GDACS can arrive before a USGS alias is known): keep as pending and re-check on the next USGS ingestion. After 24 h unresolved, fall back to Stage 2.

**Stage 2: spatiotemporal (`SPATIOTEMPORAL`)**, used for USGS↔EMSC (independent solutions).

```text
candidate generation (indexed):   |Δt| ≤ 90 s  AND  ST_DWithin(epicentres, 150 km)   against canonical_event_state
                                  excluding canonical events that already hold a record from the same source
misfit(c) = |Δt| / 16 s  +  d_epi / 100 km  +  |ΔM| / 0.8
           ΔM compared on each source's preferred magnitude; if magnitude-type families differ (Mw vs mb vs ML)
           the magnitude term is halved (types are not strictly comparable)
veto:      |ΔM| > 1.2                                  → NO_MATCH  (reason MAGNITUDE_INCOMPATIBLE)
decision:  best misfit ≤ 1.0 AND (second-best − best) ≥ 0.3        → MATCH
           best misfit ≤ 2.0 (or ambiguity gap < 0.3)               → POSSIBLE_MATCH (stored as candidate, NOT merged)
           otherwise                                                → NO_MATCH (new canonical event)
confidence (MATCH) = clamp(1 − best/2, 0.5, 0.98)
```

Threshold rationale:
- The USGS PDL `DefaultAssociator` code uses **±16 s / 100 km** to associate origins from different networks. GeoNerva adopts these as the unit scales, but whether ComCat's production config overrides them is unverified (V9).
- EMSC's own EventID service uses a misfit of the same form with (105 km, 13 s, 0.8 mag).
- The brief's 120 s / 50 km / 0.5 is inverted: 120 s is far too loose in time (it lets aftershocks match), and 50 km is too tight in space for global solutions, which USGS says can be "10s of kilometers" off.
- All parameters live in `correlation/earthquake.config.ts` and are calibrated against a labelled fixture set built from the EMSC EventID service (§TESTING). The EventID service's matches serve as ground truth for evaluation only, not at runtime.

**What the labelled set says [P0 2026-09-19]** (250 pairs, `packages/test-fixtures/sources/correlation/eq-pairs.json`, 38 hand-checked):
- True pairs reach **16.4 s / 135 km / ΔM 1.9** (medians 0.72 s / 8.5 km / ΔM 0); distinct events come as close as **21 s / 30 km**, and 46 s / 34 km with *identical* magnitudes.
- Therefore **no threshold triple separates the hardest cases**, and the uniqueness gap carries the decision. The scales above are a starting point that is known to reject the most extreme true pairs, and P5 must calibrate against this set to the G5 targets (precision ≥ 0.98, recall ≥ 0.95), reporting the 4 `ambiguous` pairs separately.
- A true pair at Δt 0 s / 0 km can still show ΔM 1.3 when EMSC republishes a stale USGS magnitude, so the magnitude veto is suspended when the contributor indicates republication (ADR-030). Independence is decided by contributor identity, never by value agreement.
- The EventID service itself is fallible: hand-checking found 2 errors in the reviewed subset (≈ 99 % precision), so it is usable ground truth but not an oracle.

**Revisions and hysteresis.** When a linked record gets a new version, its link is re-evaluated:

| New misfit | Action |
|---|---|
| ≤ 1.5 | Keep the link (hysteresis prevents flapping), update reasons |
| > 1.5 | Close the link with `REVISION_BROKE_MATCH` and re-correlate the record, which may split it into a new canonical event |

Every decision and its reasons is stored (`canonical_links.reasons`, `correlation_candidates`) and shown on the event page.

**Conflicting values: never flattened.** The canonical view exposes, per field, all source values, their spread, and a **headline value chosen by a documented precedence**:
- Magnitude: USGS reviewed > EMSC > USGS automatic > derived copies. Mw-family is preferred when two sources are at the same rank.
- The UI always says which source the headline came from: "M5.3 (USGS, Mww) · EMSC reports M5.1 (mb)".

**Agreement** is computed **only across independent sources**:

| Level | Condition |
|---|---|
| `SINGLE_SOURCE` | One source only |
| `DERIVED_ONLY` | e.g. USGS plus a GDACS copy. Shown as "1 independent source (GDACS republishes USGS)" |
| `AGREE` | ΔM ≤ 0.2, Δloc ≤ 15 km, Δdepth ≤ 20 km |
| `MINOR_DIFFERENCES` | ΔM ≤ 0.5, Δloc ≤ 50 km |
| `CONFLICT` | Anything beyond `MINOR_DIFFERENCES`. Raises `SOURCE_CONFLICT` if the event is relevant |

The brief's example ("Sources: 3 … Source agreement: HIGH" with GDACS counted) would overstate confidence. A copy agreeing with its original is not corroboration.

### 6.2 Other hazards

| Hazard | v1 identity/correlation | Rationale |
|---|---|---|
| GDACS FL, TC, VO, DR, WF | Each GDACS event is its own canonical event (`PRIMARY`); episodes are versions | Single source in v1. "Correlating" GDACS with itself adds nothing |
| Tropical cyclone (P1 cross-source) | NHC/JTWC ATCF storm ID (e.g. `AL092026`) as `IDENTITY_REF` | Storm identity is officially assigned; fuzzy matching is unnecessary |
| Thermal activity | **Clustering**, not correlation (§7.4) | Detections are samples of activity, not reports of one event |
| GDACS WF ↔ fire clusters (P1) | `event_relations` `RELATED` when the WF area polygon intersects the cluster hull (buffer 5 km) and times overlap | A burnt-area event and thermal pixels describe related but different things. Never `SAME_EVENT` |
| Weather alerts (P1) | CAP `references` chain / GeoMet key = versions of one alert. Multiple regions = multiple geometries of one alert | Alerts are issued products with official lineage |
| Alerts ↔ hazard events (P1) | `RELATED` via spatial overlap + time. Never merged | A flood warning is not a flood event |

## 7. Geospatial architecture

### 7.1 Types and SRID

- All stored geometries are **`geography` in SRID 4326**. Distances and radii are computed on the WGS84 spheroid in metres, and results are correct across the antimeridian and near the poles.
- For viewport queries, a GiST expression index on `(geog::geometry)` supports `&&` against envelopes.
- Nothing is stored in 3857; the browser handles projection.
- Coordinates are validated at the adapter boundary: lat ∈ [−90, 90], lon normalized to [−180, 180), NaN rejected, and `(0,0)` flagged as suspicious (`NULL_ISLAND`).

### 7.2 Query patterns

| Need | SQL shape | Index |
|---|---|---|
| Location radius | `ST_DWithin(x.centroid, $pt, $radius_m)` | GiST(centroid) |
| Distance | `ST_Distance(x.centroid, $pt)` (spheroid). EQ hypocentral distance = `sqrt(d_epi² + depth²)`, computed in `relevance` | — |
| Nearest N | `ORDER BY x.centroid <-> $pt LIMIT n` | GiST KNN |
| Point in area (flood area, wind buffer, alert region) | `ST_Covers(g.geog, $pt)` | GiST(geog) |
| Distance to area | `ST_Distance(g.geog, $pt)` (0 inside) | GiST(geog) + `ST_DWithin` prefilter |
| Viewport | `(geog::geometry) && ST_MakeEnvelope(w,s,e,n,4326)`. When `w > e` (antimeridian) the query is split into two envelopes | GiST((geog::geometry)) |
| Fire hull | `ST_Buffer(ST_ConvexHull(ST_Collect(geog::geometry))::geography, half_pixel_m)` | — |

All spatial SQL lives in `packages/db/src/spatial/*.ts` as parameterized, documented queries with integration tests on known coordinates (Marrakech, Montréal, Fiji at the antimeridian, Svalbard at high latitude).

### 7.3 Search radii (per family, before relevance)

| Family | Search radius | Notes |
|---|---|---|
| Earthquakes | 100 km (M < 4) · 200 (4–5) · 400 (5–6) · 800 (6–7) · 1,500 (≥ 7) | Implemented as one query at 1,500 km with `magnitude` filter bands |
| Fire activity | 150 km | |
| Floods | 500 km to affected area or centroid | |
| Cyclones | 1,500 km to any track, buffer or cone geometry | |
| Volcano / other | 300 km | |
| Weather alerts (P1) | Point in region (plus 25 km "nearby") | |

### 7.4 Fire clustering

Run in the worker after each FIRMS batch.

- **Algorithm:** incremental single-linkage clustering with union-find over detections from the last 72 h.
  - Two detections are linked if their geodesic distance is ≤ **ε = 1.5 km** (VIIRS 375 m pixels grow to ~0.8 km at swath edge, so ε ≈ 2 edge pixels) **and** |Δt| ≤ **48 h**.
  - Neighbour search uses a 0.02° grid hash with an exact geodesic check, O(n).
- **Deterministic identity:**
  - A connected component inherits the **oldest** existing cluster ID among its members.
  - Other existing clusters in the component are marked `MERGED` into it.
  - Components made only of new detections get a new cluster.
  - Input ordering is by `(acquired_at, id)`.
- **Summary:** counts, 24 h counts, distinct overpasses (distinct `(product, acquired_at)` within 10 min), FRP sum/max, confidence mix, a convex hull buffered by half a pixel, and the centroid. A new version is written only if its hash changed.
- **Why not DBSCAN:**
  - Single-linkage with `minPts = 1` is exactly what's wanted, because an isolated detection is still a (tiny) cluster with honest labelling.
  - `ST_ClusterDBSCAN` on 4326 degrees distorts ε with latitude.
- **Why not H3:** see §7.6.
- **Scale:** about 5k new detections per 30-minute batch against about 700k in the window. Neighbour lookups are local.

### 7.5 Map data delivery

- **Low zoom (< 6):** canonical events plus **fire cluster centroids** only, never raw detections. The response is capped at 2,000 features.
- **Zoom ≥ 8:** individual detections within the viewport, capped at 5,000; above the cap the response says `truncated`.
- **Format:** GeoJSON in P0. Vector tiles via `ST_AsMVT` are a P1 optimization if payloads prove too large.
- **Caching:** bboxes are quantized to a tile-aligned grid for cache hits.

### 7.6 H3 evaluation (decision: not in v1)

| Candidate use | Verdict |
|---|---|
| Radius / point-in-polygon for a location | GiST on geography is exact and already indexed. H3 would add approximation error |
| Baseline bucketing | Baselines compare **a location against its own history**, so equal-area cells are unnecessary. A regular 0.25° (lean: 0.5°) lat/lon grid (`fire_daily_cells`) is simpler, dependency-free and produces identical conclusions |
| Hotspot grouping | Fire clustering is pixel-distance based, and H3 cell boundaries would split fires arbitrarily |
| Fast lookup | Not a bottleneck |

H3 would earn its place for **cross-region comparisons** (for example a global "unusual activity" overview map normalized by area) or for anonymized spatial analytics. Both are deferred. Revisit via ADR if either is scheduled.

## 8. Historical intelligence (baselines)

Principles:
1. Compare **like with like**: same radius, same magnitude threshold, same sensors, same window length.
2. Use **non-parametric** statistics (empirical percentiles over historical windows). Seismicity and fire activity are clustered, so they are not Poisson.
3. Refuse to report a statistic that the data cannot support.
4. Every number has a one-sentence interpretation on the methodology page.

### 8.1 Earthquakes

**Magnitude of completeness (Mc):**
- For the reference region (radius `max(R, 300 km)`), estimate Mc from the canonical catalog with the maximum-curvature method (+0.2 correction). This requires ≥ 50 events above the candidate Mc in the reference period.
- If the estimate is not possible, fall back to **Mc = 4.5**, following the USGS global statement.
- Mc is shown in the UI: "Counts include earthquakes of M3.1 and larger (the smallest size reliably recorded here)."

**Metric:** `EQ_COUNT` is the number of canonical earthquakes with preferred M ≥ Mc within R km (default 150 km, user-selectable 50/150/300) in the trailing window W.
- W = 7 d is primary, 30 d secondary. 24 h is shown as a raw count only, with no baseline, because it is too sparse.

**Reference distribution:**
- All non-overlapping windows of length W in the reference period, ending before the current window.
- Reference period: 10 y USGS (M ≥ 4.5 catalog since 2000) or the EMSC backfill horizon, whichever gives the higher sample, recorded in params.

**Minimum sample:**
- `status = OK` needs ≥ 52 reference windows **and** ≥ 20 reference events.
- With ≥ 52 windows but < 20 events → `status = RARE_ACTIVITY`. Show the **rarity statement** instead of a percentile: "3 earthquakes of M4.5+ within 150 km in the past 25 years." This is often the most useful context there is.
- Otherwise → `INSUFFICIENT_HISTORY`: "Not enough history to establish a baseline."

**Outputs (bands with hysteresis on persisted locations):**

| Output | Definition |
|---|---|
| `percentile` | Mid-rank percentile of the observed count among reference windows (ties handled; zero-heavy distributions handled) |
| `band` | `TYPICAL` below p90. `ABOVE_TYPICAL` at ≥ p90 **and** observed ≥ 2. `WELL_ABOVE_TYPICAL` at ≥ p99 **and** observed ≥ 3. No `BELOW_TYPICAL` for earthquakes, because quiet periods are not reportable signals |
| `activity_ratio` | observed / mean-per-window, **shown only when mean ≥ 1**. This avoids "7× the baseline" artifacts from tiny denominators |
| `largest_recent` | Largest M in the last 30 d vs the reference period: "largest within 150 km since 2019" |
| `sequence_context` | If a canonical event with M ≥ Mc + 1.5 occurred within R in the last 30 d: "Activity follows the M6.1 earthquake on 12 Sep; aftershocks commonly follow large earthquakes." (a well-established observation, not a forecast) |

**Mandatory caveat** whenever band ≥ ABOVE_TYPICAL: "Elevated recent activity does not by itself indicate that a larger earthquake will occur."

**Rejected from the brief:**
- "30-day daily median" and "activity ratio 7×": the median of daily counts is 0 almost everywhere, which makes ratios meaningless.
- `robust z-score`: MAD = 0 for zero-heavy counts.
- A 1-year window as a baseline: too short for seismicity.

### 8.2 Fire activity (thermal detections)

Detection counts depend on the number of satellite overpasses, cloud cover, view angle and day/night mix, not just fire. Fire activity is also strongly seasonal.

**P0 `FIRE_TREND` (labelled a "trend", never "abnormal"):**
- Clusters and detections within R = 100 km over the last 7 d vs the previous 28 d.
- Same sensor group (NOAA-20 + NOAA-21), normalized per day and per overpass-day (days with missing satellite data from FIRMS `missing_data` are excluded).
- Band: `INCREASING` / `STABLE` / `DECREASING` when the 7-day daily mean differs from the 28-day daily mean by ≥ 50 % **and** ≥ 10 detections/day absolute. Otherwise `STABLE`.

**P1 `FIRE_SEASONAL`:**
- Same calendar window (±15 d) in prior years from `fire_daily_cells`.
- Requires ≥ 3 prior years of the **same sensor family**, which means a NOAA-20 NRT archive backfill via the FIRMS API (availability V3).
- MODIS/SNPP history is **not** mixed in, because different sensors produce different counts.
- Until then: "Seasonal comparison not available yet."

### 8.3 GDACS events

`GDACS_CONTEXT` counts GDACS events by type within 300 km over the last 5 years (from backfill). It is shown as **context** ("2 GDACS flood events within 300 km since 2021"), never as an anomaly. It is too sparse for a distribution.

### 8.4 Weather alerts (P1)

Alert frequency requires history that GeoMet does not provide, so it accumulates in-house. It is deferred until ≥ 2 years of data exists, and until then it shows "not available".

### 8.5 Terminology (enforced by copy tests)

| Say | Never say |
|---|---|
| "above typical for this area (top 10 % of comparable weeks since 2016)" | "anomalous risk", "danger increased" |
| "unusually high activity relative to the selected baseline" | "earthquake swarm predicts…" |
| "thermal detections" / "fire activity detected by satellite" | "wildfire" (unless an official source says so) |
| "not enough history to establish a baseline" | "normal" when data is missing |
| "rare here: 3 events of M4.5+ in 25 years" | "safe area" |

## 9. Relevance models

**Relevance answers "how much attention does this deserve for this place?"** It is **not** the probability of harm, and the methodology page says so.

Every assessment has the form:

```ts
{ level, reasons: [{ code, text, params, evidence_ids }], evidence_ids, authoritative_basis?, caveats[], model_version }
```

`CRITICAL` requires an `authoritative_basis`, meaning an official alert or warning from a provider. GeoNerva's own heuristics top out at `HIGH`.

All thresholds below are **initial, documented heuristics** in `relevance/<family>.config.ts`. They are unit-tested at every boundary and reviewed against historical scenarios before freeze.

### 9.1 Earthquake (per canonical event within the search radius; d = hypocentral distance)

| Level | Rule (first match) |
|---|---|
| CRITICAL | Official impact alert: PAGER `orange`/`red` **or** GDACS `Orange`/`Red`, **and** epicentral d ≤ 100 km (P1: location inside the ShakeMap MMI ≥ VI contour) |
| HIGH | M ≥ 7.0 & d ≤ 400 · M ≥ 6.0 & d ≤ 150 · M ≥ 5.0 & d ≤ 50 |
| MODERATE | M ≥ 7.5 & d ≤ 1,500 · M ≥ 6.5 & d ≤ 800 · M ≥ 5.5 & d ≤ 300 · M ≥ 4.5 & d ≤ 100 |
| LOW | Within the search radius |

Modifiers and reasons:
- Depth ≥ 300 km: one level down, reason `DEEP_FOCUS`.
- `status = automatic`: reason `PRELIMINARY_SOLUTION`.
- DYFI `felt ≥ 10`: reason only.
- `tsunami = 1`: reason `USGS_TSUNAMI_FLAG` with the exact USGS wording and a link to tsunami warning centres. It never changes the level and never claims a tsunami.
- `CONFLICT` agreement: reason `SOURCES_DISAGREE` plus a caveat.

P1: an intensity-prediction-equation "possibly felt here" indicator, labelled as an estimate and validated against DYFI.

### 9.2 Fire activity (per fire cluster; d = distance from the location to the nearest detection)

| Level | Rule |
|---|---|
| CRITICAL | An official alert covers the location (P0: GDACS WF `Orange`/`Red` area within 10 km; P1: ECCC/NWS fire-weather or evacuation products) |
| HIGH | d ≤ 10 km, cluster `ACTIVE` (detection ≤ 24 h), and (n_24h ≥ 5 or overpasses_24h ≥ 2) |
| MODERATE | d ≤ 30 km & `ACTIVE` · d ≤ 10 km & `COOLING` |
| LOW | d ≤ 150 km & `ACTIVE`/`COOLING` |

Reasons include distance, detection count (24 h / total), distinct overpasses, FRP sum, growth (n_24h ≥ 2× the previous 24 h and ≥ 10 → `GROWING`), recency, related GDACS WF, and (P1) `PERSISTENT_HEAT_SOURCE`, which caps the level at LOW.

Mandatory caveat: "Satellite thermal detections can include non-vegetation heat sources (e.g. gas flares, industrial sites, volcanoes). They are not confirmed wildfires."

### 9.3 Flood (GDACS FL; "area" = `Poly_Affected`)

| Situation | Red | Orange | Green |
|---|---|---|---|
| Location inside area | CRITICAL | HIGH | MODERATE |
| ≤ 25 km from area | HIGH | MODERATE | LOW |
| Centroid-only event ≤ 100 km | MODERATE | MODERATE | LOW |
| Within 500 km | LOW | LOW | LOW |

Language: "inside the GDACS flood-event area (modelled; not an observed flood extent)". Reason `NO_AREA_GEOMETRY` for centroid-only events.

### 9.4 Tropical cyclone (GDACS TC; geometries = current and forecast wind buffers, cone, track)

| Situation | Level |
|---|---|
| Inside the ≥ 120 km/h buffer (current or forecast) & GDACS `Red` | CRITICAL |
| Inside the ≥ 120 km/h buffer | HIGH |
| Inside the ≥ 90 km/h buffer | HIGH if GDACS `Orange`/`Red`, else MODERATE |
| Inside the ≥ 60 km/h buffer or the uncertainty cone | MODERATE |
| ≤ 300 km from the track | LOW |

Reasons state whether the geometry is **observed or forecast**, the forecast time, and the issuing agency (e.g. "JTWC via GDACS"). GeoNerva never computes its own tracks or arrival times.

### 9.5 Volcano (GDACS VO)

Within 100 km: MODERATE (HIGH if Orange/Red). Within 300 km: LOW. Ash dispersion is deferred.

### 9.6 Weather alert (P1, ECCC/NWS; point-in-region)

| Alert | Level |
|---|---|
| warning with risk colour red | CRITICAL |
| warning | HIGH |
| watch | MODERATE |
| advisory | MODERATE |
| statement | LOW |
| ended / cancelled / expired | none (→ `EVENT_RESOLVED`) |

Alert text is always shown **verbatim** with attribution (ECCC licence clause).

### 9.7 Data confidence (per family card)

| Level | Condition |
|---|---|
| LOW | A source needed for this family is STALE/UNAVAILABLE, **or** coverage is NOT_COVERED, **or** an item has `CONFLICT` |
| MEDIUM | A needed source is DEGRADED, **or** coverage is PARTIAL (e.g. Mc = 4.5), **or** the top item is single-source / preliminary |
| HIGH | Otherwise |

Each condition is listed as a reason. Confidence is never a percentage.

### 9.8 Headline logic ("Is something meaningful happening?")

| Condition | Headline |
|---|---|
| Any CRITICAL | "Official alert affecting this area" |
| Else any HIGH | "High-relevance activity nearby" |
| Else any family UNAVAILABLE | "Some data is currently unavailable" + which |
| Else | "No high-relevance hazards detected in the currently indexed sources" |

A coverage line always follows: "Weather warnings not covered here."

**The last row fails closed [G3 carry-over 2, measured P3 2026-09-19].** "No high-relevance
hazards detected" is a claim about the world, and it may only be made when there is *positive
evidence of coverage*. An empty fact list on its own is not that evidence.

The concrete trap, verified against the real database in
`packages/pipeline/src/blindness.int.test.ts`: RLS is enabled on every fact table with no
policies, so the `geonerva_web` role currently reads zero rows. Under that role the fact query and
the health query return **exactly what a genuinely quiet world returns** — and health comes back
as an **empty array, not a status of `UNAVAILABLE`**, because `geonerva.sources` is behind the
same deny-all. A briefing that looked for `status === 'UNAVAILABLE'` to detect blindness would
therefore miss it completely and render an all-clear.

So the rule the briefing engine must implement is:

> If there is no health row for a family's sources, the headline is `DATA_UNAVAILABLE`. The
> absence of health evidence — not a particular health status — is the signal.

`NO_HIGH_RELEVANCE_ITEMS` requires at least one source health row that is not `UNAVAILABLE`.

## 10. What Changed?

### 10.1 Comparison definition

- **Default:** "in the last 24 hours" = `diff(snapshot(L, now − 24h), snapshot(L, now))`, both computed with the **current** engine version.
- **Options:** 6 h, 24 h, 7 d, and "since my last visit" (the browser stores the last visit time locally and sends `since=`; the server clamps it to [1 h, replay horizon]).
- **Replay:** the same diff at `(T − Δ, T)`.

### 10.2 Classification

Subjects are matched by `subject_ref`, following merge redirects.

| Signal | Rule |
|---|---|
| `NEW_EVENT` | Subject assessed in B, absent in A, `observed_at > from`. If `observed_at ≤ from` (reported late): same type, flag `late_report` |
| `ENTERED_AREA` / `LEFT_AREA` | Subject existed in both knowledge states but crossed the search radius / area boundary (cyclone moved, flood area grew) |
| `EVENT_UPDATED` | Provider revision with a material delta: \|ΔM\| ≥ 0.2; epicentre shift ≥ 10 km; depth shift ≥ 15 km; automatic→reviewed (DETAIL only); flood/cyclone area change ≥ 20 %; new forecast track |
| `EVENT_ESCALATED` / `EVENT_DEESCALATED` | Provider severity changed on its own scale (GDACS Green→Orange, PAGER, alert type watch→warning) |
| `EVENT_RESOLVED` | Active in A, not active in B: GDACS `iscurrent=false`/`todate` passed, cluster → INACTIVE, alert ended/expired/cancelled. Earthquakes never "resolve"; they age out silently (`SUPPRESSED: AGED_OUT`) |
| `ACTIVITY_INCREASE` / `ACTIVITY_DECREASE` | Metric-based. Requires a band change, **or** \|Δ\| ≥ max(abs_min, 50 % of before). abs_min: EQ count 3, fire clusters 2, fire detections 20 |
| `ABNORMAL_ACTIVITY` | Baseline band enters ABOVE/WELL_ABOVE (only when baseline `status = OK`) |
| `RELEVANCE_INCREASE` / `RELEVANCE_DECREASE` | The same subject's level changed |
| `SOURCE_STALE` / `SOURCE_RECOVERED` | Health transition of a source covering this location for a family |
| `SOURCE_CONFLICT` | A relevant canonical event's agreement became `CONFLICT` |

### 10.3 Noise control

1. **Materiality thresholds** (above). Sub-threshold revisions are `SUPPRESSED: IMMATERIAL`.
2. **Hysteresis:**
   - Baseline bands: enter ABOVE at p90, leave at p80.
   - Relevance for fire clusters: must hold for 2 consecutive clustering runs on persisted locations.
3. **Pass-aware fire comparison:** fire activity is compared on 24 h windows, never per satellite pass. Otherwise every overpass would "change" something.
4. **Grouping:** multiple signals about one subject collapse into one grouped item with facets (e.g. "M5.1 → M5.3 revised; relevance LOW → MODERATE").
5. **Relevance gate:** changes about subjects that are LOW in both A and B are at most `DETAIL`.
6. **Source relevance gate:** `SOURCE_STALE` is only emitted for sources covering the location's families.

### 10.4 Importance and prominence

```text
importance = base(type) + level_weight(max(level_A, level_B)) + delta_weight + recency_weight   (0..100, integer)
  base:          ESCALATED 30 · NEW_EVENT 25 · SOURCE_STALE 25 · CONFLICT 20 · ABNORMAL 20 · ENTERED 20
                 RELEVANCE_INCREASE 15 · UPDATED 10 · ACTIVITY_* 10 · RESOLVED 10 · DEESCALATED 10 · RECOVERED 5
  level_weight:  CRITICAL 50 · HIGH 35 · MODERATE 15 · LOW 0
prominence:  HEADLINE ≥ 70 (max 3, ties by level then recency) · LISTED ≥ 40 · DETAIL ≥ 15 · else SUPPRESSED
hard rules:  any change involving CRITICAL → HEADLINE;  SOURCE_STALE for a family with a HIGH item → HEADLINE;
             subjects LOW in both states → ≤ DETAIL
```

- Suppressed signals are returned with reasons behind "Show N minor changes", so filtering is transparent.
- If nothing is at least LISTED, the section says: "No meaningful changes in the last 24 hours" and gives the suppressed count.

## 11. Runtime AI (P1, optional)

`AI_MODE=disabled` is the default and a first-class mode. Every screen is complete without AI; the deterministic templated copy (`briefing/templates`) *is* the product's language.

### 11.1 Shape: push, not pull

The brief proposes five sequential agents with query tools. For v1 of the AI layer, GeoNerva instead **pushes** a bounded, deterministic **briefing packet** to the model:
- the snapshot
- the change signals
- the relevance reasons
- the baselines
- the source health
- the evidence manifest

The model never queries anything. This removes tool-selection failure modes, the SQL-adjacent attack surface and most latency. The brief's trusted tools (`getLocationSnapshot`, …) remain the read-model functions in `briefing` and become tools only when "Ask GeoNerva" is built (deferred).

**Two model calls, not five:**
1. **Interpreter**: a single structured-output call that fulfils the Evidence Analyst, Change Analyst, Relevance Explainer and Composer roles as sections of one schema. Those roles all consume the same packet and are forbidden from adding facts, so splitting them into four calls multiplies cost and latency for no added capability.
2. **Skeptic**: an independent call that receives the packet and the draft and returns `PASS | REVISE | REJECT` with findings. It may only remove or flag claims, never add.

Before and after the Skeptic, a **deterministic validator** is the actual gate (§11.4). The roles stay separable in the schema and prompts, so they can be split later if evaluations show a benefit.

### 11.2 Role contracts

| Role | Inputs | Tools | Output schema (section) | Forbidden | On failure |
|---|---|---|---|---|---|
| Evidence Analyst | packet.items, packet.evidence_manifest | none | `key_observations[]: {claim, evidence_ids[], numbers[]}` | New facts; external knowledge; unreferenced numbers | Section dropped → template |
| Change Analyst | packet.changes (non-suppressed), before/after values | none | `change_narrative[]: {signal_id, text, evidence_ids[]}` (one per signal, same order) | Inventing changes; reordering prominence; mentioning suppressed signals as important | Template copy per signal |
| Relevance Explainer | packet.relevance per subject (level + reasons) | none | `relevance_explanations[]: {subject_ref, level (echo), text, reason_codes[]}` | Changing the level; adding reasons not in `reasons[]` | Template reasons list |
| Skeptic / Verifier | packet + Interpreter output | none | `{verdict, findings[]: {claim_path, problem_code, note}}` | Adding claims; rewriting text | Treated as REJECT |
| Briefing Composer | approved sections + packet.headline + source health | none | `summary: {text (≤ 80 words), evidence_ids[]}` | Omitting stale/unavailable sources that affect a relevant family; "safe" language; prediction language | Template summary |

`problem_code` ∈ `UNSUPPORTED_CLAIM | NUMBER_MISMATCH | PREDICTION_LANGUAGE | SAFETY_CLAIM | STALE_AS_CURRENT | THERMAL_AS_WILDFIRE | CONFLICT_IGNORED | EXAGGERATION | ALERT_PARAPHRASED`.

### 11.3 Model and API usage

- Anthropic Messages API with **structured outputs** (`output_config.format` JSON schema), so the response is schema-valid by construction.
- Model is configurable: `AI_MODEL`, default `claude-opus-5`; the per-briefing cost estimate is in `DECISIONS.md` ADR-012.
- A stable system prompt plus schema is cached with prompt caching. The packet goes in the user turn inside explicit delimiters: `<packet>` JSON `</packet>`, where provider text is a JSON string field and never instruction text.
- **Runs only in the worker, for materialized locations,** keyed by `snapshot.content_sha256`, so it is never in the request path. Web requests read cached, validated outputs. Ad-hoc locations get deterministic copy only (cost and abuse control).
- `AI_DAILY_BUDGET_USD` is a hard cap tracked in `agent_outputs.cost_micros`. When exhausted, the system falls back to deterministic copy.
- `AI_MODE=local` stays an interface stub (deferred).

### 11.4 Deterministic validation (the real gate)

1. Schema-valid (guaranteed by structured outputs, re-checked with Zod).
2. Every `evidence_id` exists in the packet's manifest, which also enforces scope.
3. Every number appearing in any text field is extracted and must equal (after unit-aware rounding) a value in the packet at a referenced path. Unmatched numbers fail the claim.
4. The relevance levels echoed must equal the deterministic levels.
5. A banned-lexicon scan runs with context rules:
   - prediction ("will occur", "likely to strike", "probability of", "expected to hit" unless quoting an official forecast field)
   - safety ("safe", "no risk", "nothing to worry")
   - "wildfire" for `THERMAL_ACTIVITY` subjects
   - "real-time"
6. Timestamps mentioned must be ≤ `as_of`.
7. ECCC/NWS alert text must not be paraphrased; the model may only reference an alert by ID and name.
8. If the source health in the packet shows STALE/UNAVAILABLE for a family mentioned, the text must say so.

Outcomes:
- Failing claims are removed (`REPAIRED`) if the rest stands.
- If the summary fails, or more than 30 % of claims fail, the whole output is `REJECTED` and the deterministic template is used.
- Every outcome is stored in `agent_outputs` and counted in metrics.

### 11.5 Privacy

The packet contains the place label, rounded coordinates, and distances. It never contains raw user coordinates, IPs or session data. Ad-hoc (`c:`) locations never reach the model.

## 12. Storage budget and retention profiles

The brief assumes Supabase Free (500 MB) can host a global, multi-hazard, replayable archive. It cannot: FIRMS alone produces roughly **146k detections/day** (NOAA-20 + NOAA-21). Retention is therefore a **profile** (`RETENTION_PROFILE`), and the replay horizon is derived from it and exposed via the API.

> **Volume correction [P0 2026-09-19].** An earlier figure of ~230k/day came from row counts of the keyless "24 h" files. P0 measured that those files actually span **≈ 42 h** of acquisition times (128k rows for NOAA-20 over 42 h), so the real rate is **≈ 73k rows/day/satellite**.

**Measured steady state, lean profile [P2 2026-09-19].** These are real `pg_total_relation_size`
figures from `pnpm --filter @geonerva/db estimate-storage`, which loads a representative volume
into a throwaway database on the same PostgreSQL 17 / PostGIS 3.4 image as CI, not estimates:

| Table | Rows | Total | Heap | Indexes |
|---|---|---|---|---|
| `observation_versions` (250k EQ + 5k GDACS + 5k spare) | 260,000 | **148.3 MB** | 86.7 MB | 61.6 MB |
| `fire_detections`, per daily partition (146k/day) | 146,000 | **47.8 MB** | 23.3 MB | 24.4 MB |
| `fire_detections`, 72 h retention (3 partitions) | 438,000 | **143.3 MB** | 69.9 MB | 73.3 MB |
| `source_records` | 260,000 | **42.3 MB** | 20.5 MB | 21.8 MB |
| everything else at this point (empty caches, seeds, migrations) | — | ~1.4 MB | — | — |
| **Measured total** | | **335.3 MB (67 % of the 500 MB budget)** | | |

**Correction [P3 2026-09-19]: three tables were missing from the measurement above.** P3 ingested
1,737 real USGS events and measured the *delta* across every table the pipeline writes, which
exposed three the P2 figure never populated:

| Per new event | Measured |
|---|---|
| `raw_source_records` (the verbatim payload) | **1,269 B** |
| `observation_versions` | 972 B |
| `source_records` | 184 B |
| `source_record_aliases` | 160 B |
| `source_record_heads` | 151 B |
| **Total per first-sighting** | **≈ 2,735 B** |

At the planned 260k-event backfill the three missing tables add **≈ 392 MB** (raw 315, aliases 40,
heads 37), taking the lean profile from the measured 335 MB to **≈ 727 MB against a 500 MB
budget**. The backfill as specified does not fit, and the largest single line is the raw payload —
46 % of the per-event cost.

This does not change the v1 plan, because live polling is cheap: 400 events/day is **≈ 1.04 MiB
per day**, and raw payloads pruned to 30 days cost 14.5 MB (7 days: 3.4 MB). `prunePayloadsBefore`
already nulls the body while keeping the hash and the row, so provenance survives pruning. What it
does change is that **the backfill must not retain raw payloads**, and the raw-payload retention
window is now a budget lever that has to be set explicitly rather than left at "keep everything".
That decision belongs to the retention job (P6) and is recorded here so it cannot be forgotten.

*Caveat on the numbers:* index pages grow in chunks, so a 1,737-row delta carries some lumpiness;
treat these as ±15 %, and re-measure with `estimate-storage` before the backfill is run.

**Measured again [P4 2026-09-20], this time from a real historical backfill.** 2,266 events
(FDSN, M ≥ 4.5, June–August 2026) ingested under ADR-033, which stores the raw row and digest
without the body:

| Table | Per event | Heap | Index |
|---|---|---|---|
| `observation_versions` | 1,085 B | 719 | 365 |
| `raw_source_records` | **231 B** | 101 | 130 |
| `source_records` | 199 B | 101 | 98 |
| `source_record_aliases` | 184 B | 90 | 94 |
| `source_record_heads` | 166 B | 116 | 51 |
| **Total** | **1,865 B** | | |

ADR-033 works: 1,865 B against P3's 2,735 B with payload bodies, a **32 % reduction**, and the
raw table drops from 1,269 B/event to 231. What it does not do is make the *planned* catalogue
fit — the FDSN `count` endpoint says M ≥ 4.5 since 2000 is **187,173 events**, or **333 MB for one
source**. **ADR-034** therefore narrows the lean v1 catalogue to **M ≥ 4.5 from 2016** (79,929
events, 142 MB) and reserves ~125 MB for EMSC, which P5 must measure against.

Not yet included, because P2 does not populate them: `places` (GeoNames `cities15000`, 34,146
rows), `fire_cluster_versions` and `fire_daily_cells` at steady state, snapshots and caches.
Budgeting ~40 MB for those puts the lean profile at **roughly 375 MB of 500 MB**.

Two things the measurement makes obvious: indexes are ~45 % of the cost on both big tables, and
the earthquake catalogue — not fire — is the largest single consumer. If the EMSC backfill is
widened, that is where the budget goes.
| **Total, P2 accounting** | **~330–380 MB of 500 MB** |

**Superseded by the P3 measurement above.** That table omitted `raw_source_records`,
`source_record_aliases` and `source_record_heads` entirely; with them the 260k-event backfill
reaches **~727 MB**, so the backfill as specified does **not** fit and must not retain raw
payloads. Live polling does fit comfortably (~1.04 MiB/day). If a later measurement passes
450 MB, the lean profile narrows the EMSC backfill (M ≥ 3.5, or fewer years) before it touches
fire retention, because the earthquake catalogue is the bigger consumer and the fire window is
what the replay horizon is built on. **Standard profile** (≥ 8 GB: Supabase Pro at ~US$25/month or
self-hosted Postgres on the worker VM) keeps 30 d detections, 5 y fire cells and 2 y small-EQ
history. The owner chose the lean profile for v1 (Q2).

Retention jobs run nightly in the worker:
- `DROP PARTITION` for detections
- batched deletes for the rest
- `VACUUM (ANALYZE)` on touched tables

Each job is logged as an `analysis_run`.

## 13. Domain API

Versioned under `/api/v1`. Read-only in the web app. Every input is Zod-validated; every error is `application/problem+json` with a stable `code`.

### 13.1 Endpoints

| Method & path | Purpose | Key params | Cache |
|---|---|---|---|
| `GET /places/suggest` | Type-ahead from the local GeoNames table | `q` (2–64 chars), `limit ≤ 10` | `s-maxage=86400` |
| `GET /places/search` | Submit-time geocoding (Nominatim, server-side, cached 30 d, globally serialized to ≤ 1 req/s) | `q` | `s-maxage=86400` |
| `GET /places/reverse` | Label for coordinates (rounded) | `lat`, `lon` | `s-maxage=86400` |
| `GET /briefing` | Full location briefing (snapshot + changes + copy + manifest [+ ai]) | `place` or `lat,lon`; `window=6h\|24h\|7d`; `since?`; `as_of?` (replay) | live: `s-maxage=120, swr=600`; `as_of` older than 1 h: `s-maxage=86400, immutable` |
| `GET /events` | Map features for a viewport | `bbox`, `zoom`, `families[]`, `as_of?` | `s-maxage=120`, bbox quantized |
| `GET /events/{publicId}` | Canonical event detail: source observations, version timeline, agreement, correlation decisions, relevance (if `lat,lon` given) | `as_of?`, `lat?,lon?` | `s-maxage=120` |
| `GET /fire-clusters/{publicId}` | Cluster detail + version history + detections summary | `as_of?` | `s-maxage=300` |
| `GET /history` | Baseline metrics + time series for charts | `place\|lat,lon`, `family`, `metric`, `radius_km` | `s-maxage=3600` |
| `GET /evidence/{id}` | Resolve primary evidence (OBS, FCV, RUN, COR) with raw-payload excerpt and source URL | — | immutable |
| `GET /sources/status` | Per-source health, last runs, policies, attribution | `as_of?` | `s-maxage=60` |
| `GET /replay/horizon` | Earliest replayable time per family (from retention) | — | `s-maxage=3600` |
| `GET /replay/scenarios` (P1) | Curated historical scenarios | — | long |

**There is no public ingestion endpoint** (the brief's `POST /api/ingest/:source` is removed). Ingestion runs in the worker. If an external trigger is ever needed, the **worker** exposes `POST /trigger/{source}` authenticated by HMAC-SHA256 over `timestamp.body` with a 5-minute replay window, bound to a private network or tunnel (ADR-010).

### 13.2 Validation rules

- `lat ∈ [−90, 90]`, `lon ∈ [−180, 180]` (normalized), rounded to 0.01° **before** logging, caching or querying.
- `bbox` must be valid with area ≤ 60° × 60° at zoom < 4. Antimeridian bboxes are accepted.
- `as_of ∈ [replay_horizon, now]`; `since` is clamped.
- `families[]` must be from the enum.
- String params are length-capped.
- Unknown params → 400. This keeps cache keys canonical and prevents cache-busting abuse.

### 13.3 Caching layers

1. **CDN** (Vercel) keyed by canonical URL (rounded coordinates, sorted params).
2. **In-process LRU** in web instances for `sources/status` and baseline metrics (30–300 s).
3. **Database** caches (`*_state`, `baseline_metrics`, `location_snapshots`) maintained by the worker.

Replay (`as_of`) responses are immutable. Provider data is never cached in the browser beyond HTTP semantics; FIRMS/USGS/GDACS terms permit redistribution with attribution.

### 13.4 Rate limiting

Postgres-backed fixed windows (`rate_limit_buckets`, key = HMAC of IP /24 or /48 with a daily-rotated secret, so raw IPs are never stored):

| Endpoint | Limit |
|---|---|
| `places/search` | 10/min/key, **1/s global** (protects our Nominatim standing) |
| `briefing` | 60/min/key |
| everything else | 120/min/key |

CDN caching absorbs most traffic before it reaches these checks.

## 14. Observability

- **Structured JSON logs** (pino) with `run_id`, `source`, `product`, `duration_ms`, `counts`, `error_class`. Precise user coordinates are never logged: the logger has a redaction path for `lat`/`lon`/`q` fields outside the worker.
- **`/data-status` page**, fed by `sources/status`: per source health, last success, newest observation, expected cadence, last error class, 24 h success rate.
- **Operational metrics** are computed from tables, so no paid platform is needed:
  - ingestion success rate
  - records per run
  - correlation rate
  - ambiguous (POSSIBLE_MATCH) rate
  - cluster counts
  - snapshot latency (from `analysis_runs`)
  - AI validation outcomes
- A **worker heartbeat** row is updated every minute. The data-status page shows "worker last seen", and a free external uptime monitor may poll `/api/v1/sources/status`.

## 15. Configuration

```text
DATABASE_URL               web: pooled (transaction mode)           required
DATABASE_URL_WORKER        worker + migrations: session/direct       required (worker)
RETENTION_PROFILE          lean | standard                           default lean
FIRMS_MAP_KEY              optional; absent → keyless 24 h CSV mode (reduced: no backfill, no 2-day window)
NOMINATIM_CONTACT          required for places/search (User-Agent contact per OSMF policy)
MAP_STYLE_URL              default OpenFreeMap dark style
RATE_LIMIT_SECRET          required (web)
WORKER_TRIGGER_SECRET      only if worker HTTP trigger enabled
AI_MODE                    disabled | anthropic | local               default disabled
ANTHROPIC_API_KEY          required iff AI_MODE=anthropic
AI_MODEL                   default claude-opus-5
AI_DAILY_BUDGET_USD        default 1.00
```

`packages/config` validates the environment at process start and fails fast with a readable error.
