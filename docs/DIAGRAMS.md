# GeoNerva — System Diagrams

> Status: **current as of v1.0.0-rc.1 (2026-09-24)**. These diagrams describe what the code does
> today, not a target state. Where a path is switched off or deliberately absent, the diagram says
> so rather than omitting it — the same rule the product applies to its own data.
>
> `ARCHITECTURE.md` is the prose authority and `DOMAIN_MODEL.md` owns the table shapes. If they
> disagree with a picture here, they are right and the picture is stale.

---

## 1. The whole system

Public providers on the left, a reader on the right, and exactly one process that writes.

```mermaid
flowchart LR
  subgraph prov["Public data providers"]
    direction TB
    USGS["USGS ComCat<br/><i>earthquakes</i>"]
    EMSC["EMSC FDSN<br/><i>earthquakes</i>"]
    GDACS["GDACS<br/><i>FL · VO · DR · TC · WF · EQ</i>"]
    FIRMS["NASA FIRMS<br/><i>VIIRS NOAA-20 / NOAA-21</i>"]
    ECCC["ECCC weather warnings<br/><i>not enabled</i>"]
  end

  subgraph worker["Worker — the only writer"]
    direction TB
    ADAPT["Ingestion jobs<br/>8 adapters · 300–600 s"]
    FIRE["FIRMS ingestion<br/>2 sensors · 1800 s"]
    subgraph deriv["Derivations — gated, advisory-locked"]
      direction TB
      CORR["correlation:earthquakes<br/>60 s"]
      SEED["seed:single-source<br/>60 s"]
      CLUST["clustering:fire<br/>300 s"]
    end
  end

  subgraph store["PostgreSQL 17 + PostGIS 3.4"]
    direction TB
    FACTS[("Facts<br/>source_records<br/>observation_versions")]
    EVENTS[("Canonical events<br/>canonical_links<br/>canonical_event_state")]
    DET[("fire_detections<br/><i>daily partitions</i>")]
    CLU[("fire_clusters<br/>fire_cluster_versions")]
    AGG[("fire_daily_counts<br/>fire_daily_coverage")]
    LEDGER[("feed_coverage_hours<br/>feed_coverage_frontier")]
    RUNS[("ingestion_runs<br/>analysis_runs")]
  end

  ASOF{{"As-of read layer<br/><b>the only way to read a fact</b><br/>invariant I2"}}

  subgraph web["Next.js web app — read-only"]
    direction TB
    API["/api/v1 · 11 endpoints"]
    PAGES["Pages<br/>dashboard · place · event<br/>fire · data-status · methodology"]
  end

  NOM["Nominatim<br/><i>the web app's only outbound call</i>"]
  READER(["Reader"])

  USGS --> ADAPT
  EMSC --> ADAPT
  GDACS --> ADAPT
  FIRMS --> FIRE
  ECCC -.->|"switched off in the sources table"| ADAPT

  ADAPT --> FACTS
  ADAPT --> LEDGER
  ADAPT --> RUNS
  FIRE --> DET
  FIRE --> AGG
  FIRE --> LEDGER
  FIRE --> RUNS

  FACTS --> CORR
  FACTS --> SEED
  DET --> CLUST
  CORR --> EVENTS
  SEED --> EVENTS
  CLUST --> CLU
  CORR --> RUNS
  SEED --> RUNS
  CLUST --> RUNS

  FACTS --> ASOF
  EVENTS --> ASOF
  DET --> ASOF
  CLU --> ASOF
  AGG --> ASOF
  LEDGER --> ASOF
  RUNS --> ASOF

  ASOF --> API
  API --> PAGES
  PAGES --> READER
  API --> READER
  PAGES -.->|"place search on submit"| NOM

  classDef provider fill:#e8f0fe,stroke:#4a6fa5,color:#1a2b40
  classDef off fill:#f4f4f5,stroke:#9ca3af,color:#4b5563,stroke-dasharray:4 3
  classDef derivation fill:#fff4e5,stroke:#b8763e,color:#3d2a14
  classDef data fill:#eef7ee,stroke:#4f8a52,color:#1c3320
  classDef gate fill:#f3e8ff,stroke:#7c5cbf,color:#2b1a47

  class USGS,EMSC,GDACS,FIRMS provider
  class ECCC off
  class CORR,SEED,CLUST derivation
  class FACTS,EVENTS,DET,CLU,AGG,LEDGER,RUNS data
  class ASOF gate
```

**What the shape is telling you**

- **One writer.** The worker is the only process that writes facts. The web app is read-only, and
  its single outbound call is Nominatim on an explicit place submit (ADR-028) — never during a
  briefing.
- **Everything readable goes through the as-of layer.** Invariant I2 makes it the only path to a
  fact, which is what allows any answer to be reproduced for a past knowledge time.
- **FIRMS bypasses the fact store entirely**, and that is deliberate — see §2.
- **A derivation is not the same as an ingestion.** Ingestion records what a provider said;
  a derivation decides what it means. They fail, and degrade, independently.
- **ECCC is drawn, not omitted.** No weather-warning source is enabled, so that family answers
  `NOT_COVERED` rather than an empty list. "We have no source here" and "nothing is happening" are
  different statements and the product never merges them.

---

## 2. The fire path, which is shaped unlike everything else

NASA FIRMS answers a different question from every other provider: roughly 230,000 pixel detections
a day, with no identifiers, no revisions and no concept of an event. Forcing that through
`observation_versions` would mean a fact store that is 99.9 % thermal pixels, so **no P0 adapter
writes an observation version with hazard type `THERMAL_ACTIVITY`** (ADR-011, DOMAIN_MODEL §4.9).

```mermaid
flowchart TB
  CSV["FIRMS global 24-hour CSV<br/><i>keyless: no backfill, no area narrowing</i>"]
  PARSE["Parse and reject<br/><i>identity = product + acquired_at + lat/lon to 4 dp</i>"]
  DET[("fire_detections<br/><i>daily partitions · ON CONFLICT DO NOTHING</i>")]
  AGGW[("fire_daily_counts<br/>fire_daily_coverage")]
  COV[("feed_coverage_hours<br/><i>scheduled polls only</i>")]

  GATE{"Any detection newer than<br/>the last successful run's as_of?"}
  LINK["Single-linkage clustering<br/><i>ε = 1.5 km · Δt ≤ 48 h · 0.02° grid hash</i>"]
  IDENT["Identity over time<br/><i>oldest cluster survives a merge</i>"]
  CLU[("fire_clusters<br/>fire_cluster_versions<br/>fire_cluster_heads")]

  TREND["Fire trend<br/><i>mean per covered day</i>"]
  CARD["Fire activity card<br/>+ /fire/:id cluster page"]

  CSV --> PARSE --> DET
  PARSE -->|"same transaction"| AGGW
  PARSE --> COV
  DET --> GATE
  GATE -->|"no"| SKIP["SKIPPED — nothing written"]
  GATE -->|"yes"| LINK --> IDENT --> CLU
  AGGW --> TREND
  CLU --> CARD
  TREND --> CARD

  classDef data fill:#eef7ee,stroke:#4f8a52,color:#1c3320
  classDef decision fill:#fff4e5,stroke:#b8763e,color:#3d2a14
  class DET,AGGW,COV,CLU data
  class GATE,SKIP decision
```

**Three properties that are easy to get wrong**

- **The daily aggregate is written inside the ingestion transaction**, from the detections
  themselves, and does not depend on clustering having run (ADR-040). So a clustering outage
  degrades the cluster cards without corrupting the long-term series.
- **The coverage ledger is written for scheduled polls only.** A manual run produces detections
  with no covered hours, which makes every day `NOT_COVERED` and the trend permanently refuse —
  correct, and surprising the first time.
- **A day GeoNerva did not read every hour of is excluded from both means, never counted as zero.**
  Detection counts depend on overpasses, cloud and view angle as much as on fire.

---

## 3. Why a replay can be trusted

GeoNerva's defining claim is that it can answer *what did you know at time T*, and that the answer
does not drift as the present changes. Facts are versioned, and **derived state that is not a
version obeys the same rule through its own knowledge time** (ADR-039, invariant I16).

```mermaid
flowchart LR
  subgraph t1["Knowledge time T₁"]
    A1["Cluster A"]
    B1["Cluster B"]
  end
  subgraph t2["Knowledge time T₂, after a merge"]
    A2["Cluster A<br/><i>survivor</i>"]
    B2["Cluster B<br/><i>merged_into = A, merged_at = T₂</i>"]
  end

  READ1{{"Replay of T₁"}}
  READ2{{"Read at T₂"}}

  A1 --> READ1
  B1 --> READ1
  A2 --> READ2
  B2 -.->|"followed only when merged_at ≤ asOf"| READ2

  READ1 --> OUT1["<b>two</b> areas of activity<br/><i>what was on the page then</i>"]
  READ2 --> OUT2["<b>one</b> area of activity"]

  classDef gate fill:#f3e8ff,stroke:#7c5cbf,color:#2b1a47
  class READ1,READ2 gate
```

The mechanics, all of which were verified against live data for the release candidate:

- A detection's membership carries **its own knowledge time** — `cluster_assigned_at` is the
  clustering run's `as_of` — so a replay from before the run sees the detection in no cluster.
- **A merge never re-points a detection.** It is recorded on the absorbed cluster and resolved at
  read time, which is what keeps the older replay intact. On the release candidate, a replay of
  19:50 showed the 0 merges known then, 20:30 showed 987, and the present showed 1,121.
- `cluster_assigned_at IS NULL` means the knowledge time is **unknowable**, and such a row is
  excluded from every as-of read rather than given a guessed one.

---

## 4. Package dependency direction

Enforced by `dependency-cruiser` in CI, not by convention. Arrows point the only way a dependency
is allowed to run; changing this requires an ADR.

```mermaid
flowchart TB
  subgraph pure["Pure engines — no IO, no clock, no database"]
    direction LR
    DOMAIN["domain"]
    GEO["geo"]
    CORRP["correlation"]
    RELE["relevance"]
    BASE["baselines"]
    CHG["changes"]
  end

  CONFIG["config"]
  HTTP["http"]
  DB["db<br/><i>the only package that speaks SQL</i>"]
  SOURCES["sources<br/><i>provider adapters</i>"]
  PIPE["pipeline<br/><i>ingestion + derivations</i>"]
  BRIEF["briefing<br/><i>read composition</i>"]
  GEOC["geocoding"]
  AI["ai<br/><i>P1 · disabled by default</i>"]
  WORKER["apps/worker"]
  WEB["apps/web"]

  GEO --> DOMAIN
  CORRP --> DOMAIN & GEO
  RELE --> DOMAIN & GEO
  BASE --> DOMAIN & GEO
  CHG --> DOMAIN & GEO
  HTTP --> CONFIG
  DB --> DOMAIN & CONFIG
  SOURCES --> DOMAIN & GEO & HTTP & CONFIG
  GEOC --> DOMAIN & GEO & HTTP & CONFIG
  PIPE --> DOMAIN & GEO & SOURCES & DB & CORRP & BRIEF & HTTP & CONFIG
  BRIEF --> DOMAIN & DB & CORRP & RELE & BASE & CHG
  AI --> DOMAIN & BRIEF & CONFIG
  WORKER --> PIPE & DB & SOURCES & CONFIG
  WEB --> BRIEF & DB & GEOC & DOMAIN & CONFIG

  classDef pureEngine fill:#eef7ee,stroke:#4f8a52,color:#1c3320
  classDef off fill:#f4f4f5,stroke:#9ca3af,color:#4b5563,stroke-dasharray:4 3
  class DOMAIN,GEO,CORRP,RELE,BASE,CHG pureEngine
  class AI off
```

Four rules this encodes, each with a reason:

- **Only `packages/db` talks to PostgreSQL.** Every other package receives a connection or a row.
- **Pure engines import no IO, no clock and no framework**, which is what lets a stated distance or
  relevance band be re-derived from a stored row years later.
- **Only `packages/http` may use raw network modules**, because it owns the host allowlist, the SSRF
  checks and the size caps (ADR-028).
- **`apps/web` may not import `apps/worker`**, and may not write facts at all.

---

## 5. How a claim earns the right to be stated

The availability model is the reason GeoNerva can be quiet without being misleading. Five answers,
and none of them collapses into another.

```mermaid
flowchart TB
  START(["A family, at a place, at a knowledge time"]) --> COV{"Does any source<br/>cover this place?"}
  COV -->|"no"| NC["<b>NOT_COVERED</b><br/><i>we have no source here</i>"]
  COV -->|"yes"| HOR{"Inside the<br/>replay horizon?"}
  HOR -->|"no"| BEY["<b>UNAVAILABLE</b><br/><i>outside the window we still hold</i>"]
  HOR -->|"yes"| HEALTH{"Can any source<br/>support a claim?"}
  HEALTH -->|"no"| UNAV["<b>UNAVAILABLE</b><br/><i>the feed is down, or never read</i>"]
  HEALTH -->|"yes"| DERIV{"Has the derivation<br/>run over these facts?"}
  DERIV -->|"no"| NOTRUN["<b>UNAVAILABLE</b><br/><i>ingested, not yet processed</i>"]
  DERIV -->|"yes"| ASSESS{"Any subject held here<br/>that no model can assess?"}
  ASSESS -->|"yes"| PART["<b>AVAILABLE</b>, zero withheld<br/><i>the list is incomplete and says so</i>"]
  ASSESS -->|"no"| OK["<b>AVAILABLE</b><br/><i>a zero here is an observation</i>"]

  classDef refuse fill:#fdecec,stroke:#b4544f,color:#3f1a18
  classDef ok fill:#eef7ee,stroke:#4f8a52,color:#1c3320
  classDef partial fill:#fff4e5,stroke:#b8763e,color:#3d2a14
  class NC,BEY,UNAV,NOTRUN refuse
  class OK ok
  class PART partial
```

The distinction that does the most work is the last one. A GDACS wildfire event has no relevance
model, so it is **counted rather than dropped** — which is what makes the fire card say *"GeoNerva
is holding fire activity here that it has no model to describe, so this list is not complete"*
instead of *"no fire activity to report"*. Reporting the second over an event the map was drawing
was a real defect, fixed for the release candidate.

Independence is judged the same way. A GDACS republication of a USGS earthquake is a
`DERIVED_COPY` link and **never counts as corroboration**, so that event reads two links and *one*
independent source. On the release candidate: 4 earthquakes `AGREE` with two independent sources,
33 `DERIVED_ONLY` with one.
