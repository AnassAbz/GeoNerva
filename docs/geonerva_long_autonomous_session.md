# GeoNerva — Long Autonomous Build Session

You are continuing work on **GeoNerva**.

GeoNerva is an explainable natural-hazard intelligence web application.

The purpose of this session is to execute multiple remaining phases sequentially, without waiting for approval after every phase, while preserving the architecture and quality bar already established.

You are **NOT** being asked to rush toward a demo.

You are being asked to build a production-grade system incrementally, with explicit gates, adversarial review, tests, measurements, and architectural discipline.

---

# CURRENT PROJECT STATE

P0, P1, P2, and P3 are complete.

G2 passed after three security/reliability review rounds.

P3 completed successfully and produced a working ingestion architecture plus a real USGS vertical slice.

Current major modules include:

- `packages/http`
- `packages/sources`
- `packages/pipeline`
- `apps/worker`

The architecture currently includes:

- frozen schema
- frozen domain types
- frozen read-model contracts
- outbound HTTP boundary
- source adapter contract
- ingestion lifecycle
- scheduler
- circuit breaker
- heartbeat
- structured logging
- USGS live earthquake ingestion
- idempotency
- revision tracking
- alias-based source identity
- as-of read model
- RLS/security protections
- partitioning
- PostgreSQL/PostGIS persistence

Current verified P3 baseline:

- 434 unit tests
- 174 integration tests
- real PostGIS integration tests
- working tree clean at P3 completion
- live USGS ingestion verified
- repeated ingestion verified idempotent
- cross-feed event identity verified
- scheduler verified against live source
- frozen-contract change documented through ADR-032

Important P3 results:

- `run --source usgs` ingested ~233 events in ~1.85 s
- second identical run correctly SKIPPED
- `--feed all_week` processed ~1,970 records
- ~1,737 new
- ~233 recognised unchanged
- cross-feed identity/content-hash matching works

P3 also discovered important correctness defects and converted them into regression tests:

- longitude exactly `180`
- invalid record poisoning subsequent polls
- drift detection counting only parser rejects
- raw payload duplication
- floating-point rounding disagreement with PostgreSQL numeric semantics
- unknown `--feed` silently falling back
- non-UTC tests that did not actually change DB timezone
- over-normalization damaging source precision

This standard must continue.

---

# FROZEN CONTRACT POLICY

The following are frozen:

- database schema contracts already declared frozen
- public domain types
- read-model contracts
- source identity semantics
- core ingestion lifecycle semantics

Do not casually change them.

If one truly must change:

1. stop
2. explain why the frozen contract is insufficient
3. write an ADR
4. characterize compatibility impact
5. add migration/versioning if necessary
6. test both old and new assumptions
7. continue only if the change is justified

Do not mutate a frozen contract merely because a later phase becomes inconvenient.

---

# GLOBAL EXECUTION RULES

You may proceed through multiple phases autonomously.

Do **NOT** ask for approval between phases if the gate passes.

At every gate:

1. run all relevant tests
2. run integration tests
3. run static/type/lint gates
4. perform an adversarial review
5. use independent reviewer agents if available
6. fix all CRITICAL and HIGH findings
7. investigate MEDIUM findings
8. update architecture/review docs
9. commit in small coherent commits
10. verify working tree cleanliness
11. issue a gate report
12. continue automatically to the next phase

STOP the entire session only if:

- a frozen contract must be materially changed
- credentials/API keys are required and unavailable
- an architectural ambiguity cannot safely be resolved
- a migration would risk destructive behavior
- storage/performance constraints prove the planned architecture invalid
- a security invariant cannot be maintained
- implementation would require inventing requirements not present in project docs
- repeated review reveals an unresolved CRITICAL/HIGH issue

If stopped, provide the exact blocker and the smallest decision needed from the human.

Do not stop because a task is difficult.

---

# NON-NEGOTIABLE ENGINEERING PRINCIPLES

## 1. No silent success

Anything that claims success while doing nothing is a defect.

This applies to:

- migrations
- ingestion
- backfills
- APIs
- health checks
- source adapters
- schedulers
- briefings
- UI
- security checks
- CLI commands

Unexpected assumptions must fail loudly.

---

## 2. No semantic ambiguity

The system must never confuse:

- unavailable
- unknown
- empty
- inactive
- failed
- stale
- not applicable

Examples:

> "No known active earthquake"

must **NOT** mean:

> "We could not read the earthquake source."

Likewise:

> "No sources returned"

must **NOT** mean:

> "No hazard exists."

RLS returning zero rows must **NOT** silently become "nothing is happening."

---

## 3. Idempotency is required

Anything replayable must be safe to replay.

Especially:

- source ingestion
- backfills
- reconciliation
- job retries
- derived hazard computation
- briefing generation where persistence exists
- webhook/task-like processing

---

## 4. Real database behavior wins over assumptions

When behavior depends on PostgreSQL/PostGIS:

- test against PostgreSQL/PostGIS
- do not infer behavior from JavaScript
- do not rely only on mocked persistence

---

## 5. Measurements beat estimates

Measure:

- storage
- query latency
- ingestion throughput
- index size
- payload size
- backfill cost
- endpoint latency
- bundle size
- critical frontend timing

Do not report guessed values as verified.

---

# LONG SESSION ROADMAP

Execute these phases sequentially:

- P4 — historical earthquake ingestion and reconciliation
- P5 — multi-source hazard ingestion foundation
- P6 — spatial hazard intelligence and synthesis
- P7 — explainable briefing domain
- P8 — API
- P9a — frontend foundation
- P9b — production UX and map experience
- P10 — deployment, CI, operations, soak, security hardening

Each phase has its own gate.

---

# P4 — HISTORICAL EARTHQUAKE INGESTION & RECONCILIATION

## Goal

Turn the live USGS ingestion slice into a trustworthy earthquake catalogue that can support historical queries and later location intelligence.

Implement the USGS FDSN historical/query interface.

Do not treat this as simply another feed.

Historical ingestion has different operational semantics.

---

## P4.1 FDSN adapter

Implement the official USGS FDSN query interface.

Support bounded queries by:

- start time
- end time
- optional magnitude thresholds
- optional geographic constraints if architecture supports it safely

Do not build arbitrary query-string passthrough.

All parameters must be typed and validated.

---

## P4.2 Historical backfill orchestration

Build a resumable backfill mechanism.

Properties:

- bounded windows
- deterministic window generation
- checkpointing
- restartability
- safe replay
- explicit progress
- no dependence on process memory
- no hidden mutable cursor

Example lifecycle:

```text
backfill requested
→ generate bounded intervals
→ persist plan/checkpoint
→ fetch interval
→ parse
→ normalize
→ persist
→ reconcile identity/revisions
→ commit checkpoint
→ next interval
```

A process crash after persistence but before checkpoint update must not duplicate logical facts.

A process crash before persistence must safely retry.

---

## P4.3 Window splitting

USGS historical responses may have practical result limits.

Implement deterministic subdivision.

If a time range is too large:

- split it
- continue recursively or iteratively
- maintain deterministic ordering
- avoid infinite splitting
- enforce minimum interval size
- detect impossible completion explicitly

Test dense seismic periods.

---

## P4.4 Live ↔ historical reconciliation

Prove that an event seen first via live feed and later via FDSN resolves to the same logical event.

Also prove the inverse.

Cases:

- historical first → live later
- live first → historical later
- revised event
- deleted/retracted event if source supports it
- changed magnitude
- changed coordinates
- changed review status
- duplicate aliases
- timestamps changing within legitimate source revision semantics

No duplicate logical earthquake may result solely from interface differences.

---

## P4.5 Retention policy

P3 proved the old storage assumption was wrong.

Existing lean baseline:
~335 MB

Projected previous strategy:
~727 MB or otherwise materially above the 500 MB lean budget depending on full retained dataset.

The raw-payload retention strategy must therefore become explicit.

Design and implement a policy for:

- live polling raw payloads
- backfill raw payloads
- rejected input payloads
- source revisions
- normalized facts
- diagnostics

Preferred principle:

> normalized facts and meaningful revisions are durable; raw payloads are not automatically retained forever.

But verify project architecture before choosing specifics.

Document:

- what is retained
- for how long
- why
- storage cost
- audit implications

---

## P4.6 Storage measurement

Perform a representative backfill.

Measure actual:

- table size
- index size
- raw payload size
- versions
- aliases
- rejects
- partitions
- overhead per earthquake
- first-sighting cost
- revision cost

Project realistic catalogue size.

Do not declare G4 passed if the chosen retention design violates the defined storage budget without an explicit ADR/budget change.

---

## P4.7 P4 tests

Include at minimum:

- same historical range twice
- overlapping historical ranges
- live then historical
- historical then live
- crash before checkpoint
- crash after data commit before checkpoint
- response limit
- window split
- timeout
- malformed record
- partially malformed result
- invalid query parameters
- future timestamps
- timezone boundaries
- partition boundaries
- DST irrelevant UTC correctness
- event revisions
- precision consistency
- empty range
- aborted backfill
- database failure
- resume after failure

---

# G4 ACCEPTANCE GATE

Before moving to P5, prove:

- historical earthquake ingestion works
- backfills resume
- overlapping runs do not duplicate facts
- live/FDSN reconciliation works
- storage policy exists
- representative storage measurement exists
- projected storage is acceptable
- no CRITICAL/HIGH issues remain
- all tests green

Produce:

`docs/reviews/gate-g4.md`

Then continue automatically.

---

# P5 — MULTI-SOURCE HAZARD INGESTION FOUNDATION

## Goal

Prove that the architecture is genuinely source-agnostic.

Do **NOT** simply copy the USGS adapter shape blindly.

Choose the next available source based on credentials and project requirements.

Priority candidates:

1. NASA FIRMS / wildfire
2. NOAA/NWS weather alerts
3. flood-related official sources

FIRMS requires `MAP_KEY`.

If unavailable, do not block the whole phase.

Implement another credential-free source first if one matches the existing project plan.

Do not fabricate API access.

---

## P5.1 Source capability model

Different sources have different semantics.

Model source capabilities explicitly.

Examples:

- polling
- historical query
- cursor pagination
- bounding-box query
- authoritative revisions
- deletion/retraction
- expiry
- freshness window
- rate limits
- authentication

Do not force every provider into earthquake semantics.

---

## P5.2 Add at least two non-USGS real sources if credentials permit

Goal:

- prove heterogeneous source ingestion
- prove shared ingestion framework
- keep source-specific behavior encapsulated

Examples:

### Wildfire

Potential facts:

- detection timestamp
- latitude/longitude
- brightness
- confidence
- satellite
- FRP
- day/night

### Weather alerts

Potential facts:

- hazard category
- urgency
- severity
- certainty
- polygon/area
- onset
- expiry
- issuing authority

Do not erase provider semantics merely to create one generic object.

Canonical models should preserve source fidelity.

---

## P5.3 Credential safety

Credentials:

- never logged
- never included in errors
- never persisted in raw payload accidentally
- never sent to unexpected hosts
- never leaked through redirects
- never included in tracing

Add negative tests.

---

## P5.4 Rate limits and source health

Model:

- rate-limited
- unavailable
- malformed
- partial
- stale
- successful

Retry rules must differ by class where appropriate.

Do not retry permanent failures endlessly.

---

## P5.5 Drift detection

Generalize source drift detection.

Examples:

- parse rejection percentage
- required-field disappearance
- unit changes
- schema shape drift
- enum explosion
- coordinate anomalies
- timestamp anomalies

A provider returning HTTP 200 with incompatible data must not be reported as healthy.

---

# G5 ACCEPTANCE GATE

Prove:

- more than one hazard family is ingested
- adapter abstraction survives heterogeneous sources
- source-specific semantics remain intact
- credential boundaries are safe
- drift detection works
- health reporting differentiates failure modes
- all tests green
- no CRITICAL/HIGH issues remain

Write:

`docs/reviews/gate-g5.md`

Continue automatically.

---

# P6 — SPATIAL HAZARD INTELLIGENCE

## Goal

Turn independent hazard records into location-aware intelligence.

GeoNerva should begin answering:

> "What is changing around this place?"

without AI hallucination and without simplistic distance-only logic.

---

## P6.1 Location model

Define a location input abstraction.

Support at minimum:

- latitude
- longitude

Potentially:

- radius
- bounding region
- named location resolved elsewhere

Do not introduce geocoding unless already required.

---

## P6.2 Spatial query layer

Use PostGIS correctly.

Provide spatial operations for:

- events within radius
- polygon containment
- nearest relevant hazard
- area intersection
- source coverage
- time-window filtering

Use geographic/geometric types appropriately.

Verify units.

Test:

- poles
- antimeridian
- longitude ±180
- large-radius behavior

---

## P6.3 Temporal relevance

Hazard relevance must combine space and time.

Examples:

### Earthquake

- origin time
- magnitude
- distance
- revisions

### Weather

- onset
- expiry
- polygon

### Fire

- detection age
- recent detections
- clustering

Do not create one arbitrary universal formula unless project docs explicitly require it.

---

## P6.4 Hazard synthesis

Create a deterministic hazard-context layer.

Input:

- location
- as-of time

Output should include evidence, not conclusions invented by an LLM.

Example conceptual shape:

```ts
{
  asOf,
  location,
  availability,
  hazards: [
    {
      family,
      source,
      status,
      evidence,
      spatialRelationship,
      temporalRelationship,
      provenance
    }
  ]
}
```

Do not freeze this exact shape without checking existing contracts.

---

## P6.5 Provenance

Every synthesized observation must be traceable to:

- provider
- source record
- version/revision
- ingestion run
- observation time
- as-of time

A downstream briefing must be able to cite why it said something.

---

## P6.6 Determinism

Same DB state + same query parameters + same as-of time must yield the same hazard context.

Test this property.

---

## P6.7 Availability semantics

Resolve all ambiguity between:

- AVAILABLE_NO_ACTIVITY
- AVAILABLE_WITH_ACTIVITY
- PARTIAL
- UNAVAILABLE
- UNKNOWN

Or equivalent existing domain terminology.

An empty DB result must not alone determine availability.

Source health/coverage must participate.

---

# G6 ACCEPTANCE GATE

Prove:

- spatial queries are geographically correct
- temporal filtering is correct
- provenance survives synthesis
- availability is explicit
- deterministic re-query produces identical context
- no direct bypass around as-of fact access exists
- all tests green
- no CRITICAL/HIGH findings

Write:

`docs/reviews/gate-g6.md`

Continue automatically.

---

# P7 — EXPLAINABLE BRIEFING DOMAIN

## Goal

Build the domain layer that converts deterministic hazard evidence into a user-facing explanation.

Important:

The LLM is **NOT** the source of truth.

The database and deterministic hazard-context layer are the source of truth.

---

## P7.1 Briefing input

Briefing generation receives a bounded structured evidence object.

Do not let the model independently browse arbitrary database tables.

Input includes:

- location
- as-of timestamp
- hazard evidence
- source availability
- source freshness
- provenance
- uncertainties

---

## P7.2 Deterministic baseline

Before any LLM usage, create a deterministic briefing representation.

Example categories:

- current observations
- notable changes
- nearby activity
- unavailable sources
- stale sources
- uncertainty
- provenance

This ensures the system still works without AI.

---

## P7.3 LLM boundary

If an LLM is used:

The LLM may:

- summarize
- explain
- rephrase
- prioritize already-computed facts

The LLM may **NOT**:

- create hazards not present in evidence
- infer unavailable source status
- invent probabilities
- invent causal relationships
- invent evacuation advice
- override deterministic severity
- hide uncertainty

---

## P7.4 Structured generation

Prefer structured output validated against a schema.

Reject malformed model output.

Do not silently coerce invalid output into success.

---

## P7.5 Grounding validation

After model generation, verify that claims refer to supplied evidence.

Implement whatever limited validation is feasible without pretending NLP verification is perfect.

At minimum:

- source IDs/provenance must exist
- numerical values must originate from evidence
- hazard categories must exist
- unavailable hazards cannot become active hazards

---

## P7.6 Fallback

If AI fails:

- deterministic briefing remains available

AI failure must not make the hazard system unavailable.

---

## P7.7 Safety language

GeoNerva should communicate uncertainty clearly.

Avoid claiming:

- exact disaster prediction
- guaranteed safety
- medical advice
- emergency-command authority

Where appropriate, point users toward official authorities.

Do not make AI-generated emergency decisions.

---

# G7 ACCEPTANCE GATE

Prove:

- deterministic briefing works without AI
- AI cannot introduce unsupported hazard facts in tested cases
- structured generation validates
- fallback works
- unavailable sources are represented correctly
- provenance is preserved
- all tests green
- no CRITICAL/HIGH findings

Write:

`docs/reviews/gate-g7.md`

Continue automatically.

---

# P8 — API

## Goal

Expose the domain safely through a stable API.

This is the first public read interface.

The previous "as-of only" dependency invariant must remain enforced.

---

## P8.1 API architecture

Add the API application using the framework selected by existing architecture docs.

Do not introduce a new framework casually.

Endpoints should be thin.

They should call domain/read-model services.

They must **NOT** directly read fact tables.

---

## P8.2 Initial endpoints

Exact naming may follow existing conventions, but likely include equivalents of:

### Health

`GET /health`

### Source status

`GET /sources/status`

### Hazard context

`GET /hazards?lat=&lon=&radius=&asOf=`

### Briefing

`GET or POST /briefing`

Potential earthquake detail endpoint only if justified.

Do not create endpoint proliferation.

---

## P8.3 Input validation

Validate:

- latitude
- longitude
- radius
- timestamps
- pagination
- enum values

Reject:

- NaN
- infinity
- absurd radius
- invalid timestamps
- ambiguous date formats

---

## P8.4 Security

Implement:

- security headers
- bounded request size
- rate limiting if architecture requires
- safe error responses
- no stack traces
- no SQL leakage
- no credentials
- no internal topology

---

## P8.5 Error contract

Errors must distinguish:

- invalid request
- unsupported request
- unavailable source
- partial data
- internal failure

Do not expose provider secrets.

---

## P8.6 Performance

Measure:

- hazard-context endpoint p50/p95
- briefing deterministic path
- source health
- representative spatial queries

Add indexes only when measurements justify them.

---

## P8.7 Contract testing

Add API contract tests.

Ensure frontend can build against stable schemas.

---

# G8 ACCEPTANCE GATE

Prove:

- API never bypasses as-of read model
- validation works
- error semantics work
- security checks pass
- representative query latency is measured
- API schemas are documented
- all tests green
- no CRITICAL/HIGH issues remain

Freeze the public API contract at G8.

Write:

`docs/reviews/gate-g8.md`

Continue automatically.

---

# P9a — FRONTEND FOUNDATION

## Goal

Create a production-quality frontend consuming only the public API.

Do not read database internals.

Do not duplicate hazard logic in the browser.

---

## P9a.1 Product principle

The app should answer:

> "Understand what's changing around you."

The UI should emphasize:

- location
- current hazard context
- what changed
- evidence
- freshness
- uncertainty
- source status

Not dashboard clutter.

---

## P9a.2 Core screens

At minimum:

### Landing / location entry

User can provide:

- coordinates
- supported location method already chosen by product docs

### Location intelligence view

Show:

- current hazard families
- nearby/relevant events
- timeline/change indicators
- source freshness
- unavailable source warning
- concise briefing

### Event detail

Show:

- evidence
- time
- distance
- provider
- revision/provenance
- source link if appropriate

---

## P9a.3 State model

Explicit frontend states:

- initial
- loading
- success with activity
- success without activity
- partial
- unavailable
- invalid location
- error

Do not treat an empty array as a successful "all clear."

---

## P9a.4 Accessibility

Implement:

- keyboard navigation
- semantic headings
- accessible form labels
- focus states
- color-independent status indicators
- screen-reader descriptions

---

## P9a.5 Responsive design

Support:

- mobile
- tablet
- desktop

Do not design desktop-only then patch mobile.

---

## P9a.6 API client

Generate or strongly type API access from frozen schemas if supported.

No duplicated manual DTO drift.

---

# G9A ACCEPTANCE GATE

Prove:

- frontend consumes API only
- all core state semantics represented
- responsive layout
- accessibility baseline
- no hazard logic duplicated client-side
- build/tests green
- no CRITICAL/HIGH issues

Write:

`docs/reviews/gate-g9a.md`

Continue automatically.

---

# P9b — MAP & PRODUCTION UX

## Goal

Turn the functional frontend into a compelling GeoNerva experience.

---

## P9b.1 Map

Add an interactive map if already part of product vision.

Map should support:

- user location
- hazard markers/areas
- appropriate clustering
- relevant polygons
- time-aware data
- selected event
- source attribution

Do not dump every historical event onto the map.

---

## P9b.2 Visual hierarchy

The map should not overpower meaning.

Prioritize:

1. What is relevant?
2. How close?
3. How recent?
4. How certain?
5. Which source?
6. What changed?

---

## P9b.3 Change intelligence

Surface meaningful changes since previous observation.

Examples:

- new earthquake
- revised magnitude
- newly active alert
- expired alert
- new nearby fire detection
- source unavailable

Do not imply causality.

---

## P9b.4 Timeline

If useful, provide a compact timeline/history showing:

- recent hazard activity
- revisions
- status transitions

---

## P9b.5 Performance

Measure:

- initial bundle
- map initialization
- API waterfall
- largest contentful paint if tooling available
- marker count behavior

Avoid shipping giant datasets to the client.

---

## P9b.6 UX polish

Include:

- loading skeletons
- meaningful empty states
- source freshness
- retry behavior
- partial-data banners
- provenance/detail affordances

No fake certainty.

---

# G9B ACCEPTANCE GATE

Perform a real UX review.

Test:

- small viewport
- large viewport
- keyboard-only
- source outage
- no hazards
- many hazards
- partial provider availability
- slow API
- invalid location

Fix all CRITICAL/HIGH UX issues.

Write:

`docs/reviews/gate-g9b.md`

Continue automatically.

---

# P10 — PRODUCTIONIZATION

## Goal

Make GeoNerva deployable, observable, recoverable, and independently reproducible.

---

## P10.1 GitHub remote

If still missing, configure project for remote hosting.

Do not fabricate repository credentials.

If credentials are unavailable, prepare everything locally and mark the one external action.

---

## P10.2 Hosted CI

This is mandatory before final production gate.

CI should run:

- install
- formatting
- lint
- typecheck
- unit tests
- integration tests
- build
- migration validation
- dependency/security checks if project tooling supports them

Use a real PostgreSQL/PostGIS service where required.

The statement:

> "CI passes"

must not be made until a hosted runner actually passed.

---

## P10.3 Deployment

Deploy according to architecture.

Separate:

- web
- API
- worker
- database

or existing topology.

Verify environment isolation.

---

## P10.4 Secrets

Audit:

- API keys
- DB credentials
- source credentials
- application secrets
- CI secrets
- logs

No secrets in:

- repository
- client bundle
- stack traces
- telemetry
- test snapshots

---

## P10.5 Migrations

Production migration procedure must include:

- backup assumptions
- forward compatibility
- rollback or recovery strategy
- lock impact
- failure handling

Do not auto-run destructive migration behavior blindly.

---

## P10.6 Operational observability

Add enough instrumentation to answer:

- is ingestion running?
- when did each source last succeed?
- how stale is the data?
- are retries increasing?
- is a circuit breaker open?
- how many rejects?
- how many facts ingested?
- is API latency degrading?
- are briefings failing?
- what is DB size?

Do not build an excessive observability platform.

---

## P10.7 Health

Separate:

- process alive
- service ready
- provider health
- data freshness

Do not make `/health` return green merely because Node is running.

---

## P10.8 Backups and recovery

Document and test where practical:

- DB backup
- restore
- ingestion resume
- backfill resume
- worker restart
- lost process during transaction
- failed deployment

---

## P10.9 Security review

Perform another adversarial security review covering:

- SSRF
- credential leakage
- authorization
- RLS
- SQL injection
- oversized responses
- resource exhaustion
- malformed GeoJSON
- map/client injection
- unsafe logs
- provider-controlled strings
- AI prompt injection if AI exists
- dependency boundaries

Fix all CRITICAL/HIGH issues.

---

## P10.10 One-hour live soak

This was explicitly deferred from P3.

Run the real worker against the live sources for at least one hour.

Observe:

- scheduler behavior
- overlapping prevention
- retries
- breaker behavior
- heartbeats
- source freshness
- memory
- DB growth
- log volume
- raw payload retention
- repeated-event idempotency

Do not mark this criterion complete without actually running the soak.

If environment/session constraints prevent a real hour-long soak, leave it explicitly **NOT VERIFIED** rather than simulating it.

---

# G10 — PRODUCTION READINESS GATE

G10 may pass only if:

- hosted CI actually passed
- production build succeeds
- production migrations tested
- source ingestion works
- API works
- frontend works
- availability semantics are correct
- security review has no CRITICAL/HIGH findings
- representative performance is measured
- storage usage is measured
- live soak completed or explicitly documented as the only remaining operational blocker
- working tree clean
- deployment instructions complete

Write:

`docs/reviews/gate-g10.md`

---

# REVIEW STRATEGY

At every major phase, perform at least two independent passes.

## Reviewer A — correctness/reliability

Look for:

- race conditions
- retries
- idempotency
- transactions
- timezone bugs
- precision
- pagination
- partial failure
- stale data
- silent skips
- crash recovery

## Reviewer B — security/architecture

Look for:

- trust boundary violations
- RLS bypass
- source spoofing
- SSRF
- credential leakage
- inappropriate PUBLIC privileges
- unsafe migrations
- dependency inversion violations
- frozen-contract drift

For frontend phases add:

## Reviewer C — UX/accessibility

Look for:

- misleading semantics
- inaccessible states
- mobile failures
- loading/error issues
- false confidence
- visual clutter
- hidden source unavailability

---

# BUG POLICY

Whenever you discover a real bug:

1. reproduce it
2. add a test that fails without the fix
3. fix it
4. prove the test now passes
5. check for sibling variants of the same bug

Do not simply patch reported symptoms.

---

# COMMIT POLICY

Prefer small commits.

Examples:

- `feat(backfill): add deterministic window planner`
- `fix(usgs): reconcile cross-interface event aliases`
- `test(pipeline): prove checkpoint crash recovery`
- `feat(spatial): add as-of radius query`
- `fix(api): distinguish unavailable from empty`
- `feat(web): add partial-source state`

No giant "finish P6" commits.

---

# DOCUMENTATION

Continuously maintain:

- architecture docs
- ADRs
- schema docs
- source contracts
- operational procedures
- gate reports
- known limitations
- deferred work

Documentation must describe actual behavior, not intended behavior.

If an assumption is proven false, correct the documentation immediately.

---

# FINAL SESSION REPORT

When you reach the end of the autonomous session, provide one consolidated report.

For every phase completed:

## Pn

- objective
- architecture introduced
- major implementation
- tests added
- real-data validation
- measurements
- bugs discovered
- security findings
- ADRs
- commits
- gate result

Then provide:

## Final test state

- unit tests
- integration tests
- e2e tests
- contract tests
- hosted CI state

## Data

- DB size
- biggest tables
- index size
- projected growth
- ingestion throughput

## Sources

- source list
- freshness
- credentials required
- live validation status

## Product

- API endpoints
- frontend screens
- map status
- briefing status

## Operations

- deployment
- worker
- scheduler
- health
- observability
- backups
- live soak

## Remaining blockers

Only real blockers.

## Deferred items

Items deliberately excluded.

## Frozen contracts changed

For each:

- what
- why
- ADR
- compatibility impact

## Gate summary

- G4: PASS / FAIL
- G5: PASS / FAIL
- G6: PASS / FAIL
- G7: PASS / FAIL
- G8: PASS / FAIL
- G9a: PASS / FAIL
- G9b: PASS / FAIL
- G10: PASS / FAIL

Never mark a gate PASS merely because most work is done.

---

# EXECUTION START

Begin now.

First:

1. inspect the full repository
2. inspect P0–P3 documentation
3. inspect all ADRs
4. inspect `gate-g2.md` and `gate-g3.md`
5. inspect current git history
6. run the current complete test suite
7. record the baseline
8. identify any unresolved G3 discrepancy
9. produce a concise P4 implementation plan
10. begin P4

Do not wait for approval after P4 if G4 passes.

Proceed phase by phase until:

- G10 is reached, or
- a legitimate stop condition defined above occurs.
