# P3 — Ingestion framework + USGS vertical slice: plan and assumptions

- **Date:** 2026-09-19
- **Gate:** G3. Depends on G2 (frozen: schema, domain types, read-model contracts).
- **Scope discipline:** no API endpoints, no frontend, no other adapters, no correlation engine
  (P5 owns it), no AI. P3 ends when a second adapter could be written by copying this one.

## 1. What is already frozen and must not move

| Frozen thing | Where | Consequence for P3 |
|---|---|---|
| Adapter contract (`descriptor` / `fetch` / `parse` / `normalize`) | ARCHITECTURE §4.1 | Implement exactly this shape. `normalize` is **pure**: no clock, no IO |
| Run lifecycle, 6 steps | ARCHITECTURE §4.2 | Lease → fetch → parse → normalize → persist (1 txn) → post-commit |
| Error taxonomy | ARCHITECTURE §4.2 | Extended additively by **ADR-032** with `NETWORK`, `CONFIG_ERROR`, `ABORTED` — the only frozen contract P3 changes |
| Batch verdict rules | ARCHITECTURE §4.2 | Top-level shape invalid, or >20 % rejects → FAILED, **write nothing** |
| `ingested_at` is one stamp per batch, at commit | DOMAIN_MODEL §2 | `finishRun` is the last statement of the transaction |
| Content hash is the only change detector | DOMAIN_MODEL §4.7, ADR-029 | `source_updated_at` changing alone must **not** create a version |
| Identity is the alias set, never the current id | DATA_SOURCES §1.3, DOMAIN_MODEL §4.6 | Use `resolveSourceRecord`, which already merges two records that ComCat associated |
| Writes go through repositories, reads through `asof.ts` | ADR-003, ARCHITECTURE §3 | The pipeline must not write SQL of its own |
| TLS, roles, RLS, partition bounds | P2 security rounds | Use `createDatabase`; do not touch grants |

## 2. Modules

```text
packages/http/          hardened outbound client: host allowlist, private-IP block, timeout,
                        size cap, conditional GET, retry with jitter, Retry-After, redaction,
                        AbortSignal propagation, error classification
packages/sources/       contract.ts  — SourceAdapter, descriptor, FetchResult, ParseResult,
                                       NormalizedRecord, batch verdict
                        usgs/        — descriptor, feed URLs, Zod parse, pure normalize
packages/pipeline/      run.ts       — the 6-step lifecycle, stage timings, counters
                        logging.ts   — structured events with a redaction allowlist
apps/worker/            `run --source usgs [--feed all_day] [--reconcile]`
```

## 3. Identity and idempotency, stated precisely

- **Source identity:** `sources.id = 'usgs'`, product `usgs:comcat`. One lease per
  `(source, product)`, enforced by the partial unique index from P2.
- **Event identity:** the USGS feature's `ids` field (a comma-delimited alias list) is the
  identity. `primary_key` is the `id` first seen; every member of `ids` becomes an alias. A later
  feature whose `ids` intersect an existing record **is** that record, even when its preferred
  `id` has changed. Two records whose alias sets collide are merged (ComCat associated them).
- **Revision semantics:** a new version is written only when `content_sha256` differs from the
  head. The hash covers the normalized content — magnitude, depth, position, status, place,
  attributes — and deliberately **excludes** `source_updated_at`, feed metadata and anything
  GeoNerva derives. A provider that re-stamps `updated` without changing anything produces
  `unchanged`, not a version.
- **Conflict behaviour:** raw payloads dedupe on `(source_id, payload_sha256)`; versions dedupe
  on the head hash; aliases are `ON CONFLICT DO NOTHING`. Re-running the same input is a no-op
  in every table, which is asserted by an integration test that runs the same fixture twice and
  compares full table digests.

## 4. Assumptions that could invalidate this design

Each is either tested in P3 or explicitly recorded as a risk.

1. **`ids` always contains the current `id`.** If it did not, alias lookup could miss and create a
   duplicate record. *Test:* the `fdsn-eventid-by-alias` fixture, plus an assertion that the
   preferred id is always inside its own alias set; a violation raises rather than inserting.
2. **`time` and `updated` are epoch milliseconds, UTC.** *Test:* exact-timestamp fixtures and a
   non-UTC server run.
3. **A summary feed never contains deletions.** Deletions come only from FDSN
   `includedeleted=only` (P0, V-item). So the feed path must never infer a deletion from absence.
   *Test:* an event absent from a later feed stays `ACTIVE`.
4. **`mag` can be null** (real: sonic booms) and depth can be negative (above sea level, 308 of
   10,823 in a real month). Normalization must accept both. *Fixture exists.*
5. **>20 % rejects means drift, not bad luck.** With ~400 events/day a single malformed record is
   0.25 %, so the threshold does not fire on noise. *Test:* 1 bad record of 20 proceeds with a
   reject row; 5 of 20 fails the batch and writes nothing.
6. **Feed size stays far below the 20 MB cap.** Real `all_day` is ~1 MB. *Test:* the cap trips on
   a synthetic oversize body and classifies `TOO_LARGE`.
7. **Raw payload retention is affordable.** Per-event raw JSON at ~400 events/day is the storage
   question this phase must answer by measurement, not assumption (§8 of the brief).
8. **`clock_timestamp()` at `finishRun` is the batch stamp.** Versions must be written with the
   *same* `ingested_at` the run commits with, so replay cannot see half a batch.

## 5. Failure handling — no silent degradation

Every stage fails loudly with structured context:

| Situation | Classification | Written |
|---|---|---|
| Host not allowlisted, private IP after DNS | `CONFIG_ERROR` (raises before any request) | run FAILED |
| Timeout | `TIMEOUT` | run FAILED, no facts |
| DNS / connection / TLS failure | `NETWORK`, retried | run FAILED after retries |
| Caller cancelled (SIGTERM) | `ABORTED`, never retried | run FAILED, not counted against source health |
| 4xx (not 429) | `HTTP_4XX` | run FAILED |
| 429 / 5xx | `RATE_LIMITED` / `HTTP_5XX`, retried with backoff | run FAILED after retries |
| Body over cap | `TOO_LARGE` | run FAILED |
| 304, or identical payload hash | — | run **SKIPPED** (still health evidence) |
| Top-level shape invalid, or >20 % rejects | `SCHEMA_DRIFT` | run FAILED, **nothing written** |
| Zero records where quiet is not normal | `EMPTY_SUSPICIOUS` | run FAILED |
| A record fails its schema | — | reject row, run continues, counted |
| Persist throws | `DB_ERROR` | transaction rolls back; run FAILED; next run recovers |

An invariant violation inside normalization (e.g. preferred id absent from `ids`) raises a typed
error carrying the record's provider id — it is never skipped quietly.

## 6. Observability

One structured event per run and per stage, with counters: `fetched, accepted, rejected,
inserted, updated, unchanged, failed`, plus `fetchMs, parseMs, normalizeMs, persistMs`, the feed
URL, the HTTP status, whether the body was conditional, and the error class on failure. These
land in `ingestion_runs` (already frozen) and in the log line. No metrics platform.

## 7. Definition of done

- The six-step lifecycle runs end to end against the real USGS feed and against fixtures.
- Every case in the brief's §3 list has a test, including the database-failure and abort paths.
- Idempotency proven by digest comparison across repeated runs.
- Storage impact measured, not estimated.
- Full gate green; adversarial and security review with no CRITICAL/HIGH open.
