# G3 — Ingestion framework + USGS vertical slice

- **Date:** 2026-09-19
- **Gate criterion (IMPLEMENTATION_PLAN):** *"Vertical slice: USGS fixture → DB → as-of query; live
  USGS run in dev; idempotency proven"*, and *"`worker start` ingests live USGS locally for 1 h with
  no errors."*
- **Verdict: PASS**, with the scope deviations recorded in IMPLEMENTATION_PLAN §P3 (FDSN reconciles
  and `backfill usgs` move to P4) and one frozen-contract change (ADR-032).

## 1. The criterion, item by item

| Requirement | Evidence |
|---|---|
| USGS fixture → DB | `packages/pipeline/src/run.int.test.ts`, against real PostGIS, 30 tests |
| → as-of query | `observationsAsOf` returns the 230 ingested events; the as-of layer is the only fact reader, enforced by `web-reads-facts-only-through-asof` |
| Live USGS run in dev | `run --source usgs`: 233 events in 1.85 s. `--feed all_week`: 1,970 records, 1,737 new, **233 recognised as unchanged** — cross-feed idempotency on live data |
| Idempotency proven | Whole-table digests over versions, records, aliases, raw payloads, heads and rejects, compared across repeated runs |
| `worker start` | Polled the live feed 3.6 s after start-up and ingested 233 events under trigger `SCHEDULE` |

The 1-hour soak is **not** claimed. The scheduler ran against the live feed for under a minute;
the interval, jitter, breaker and heartbeat behaviour are covered by unit tests with an injected
clock rather than by elapsed time. Running it for an hour is an operational check for P10, and
pretending otherwise would be the kind of claim this project exists not to make.

## 2. Gate results

| Check | Result |
|---|---|
| `pnpm check` (typecheck, eslint, prettier, depcruise, unit) | green — **434 unit tests** |
| `pnpm test:integration` | green — **174 tests** against PostgreSQL 17 / PostGIS 3.4.3 |
| Migrations | 0011 applied; `ingestion_runs.error_class` extended additively |
| Working tree | clean |

## 3. What the reviews found

Two reviewers went over the slice: one adversarial (silent degradation, concurrency, idempotency,
security), one auditing the implementation against the frozen documents. Every CRITICAL and HIGH
is fixed; the MEDIUMs worth acting on are fixed; the rest are recorded below.

The findings worth remembering, because each was invisible in the happy path:

1. **One bad record killed the source for a day.** An out-of-range value raised from `normalize`
   and failed the whole batch. `all_day` republishes the same record for 24 hours, so that is
   ~288 consecutive failed polls. Now a reject row; only a broken *identity* is batch-fatal.
2. **Longitude exactly 180 was refused.** `isNormalizedLongitude` excludes it by design, and
   Kermadec/Fiji events sit on it. It is wrapped now — and the wrap leaves in-range values
   untouched, which the golden snapshot caught when it introduced error in the 13th decimal.
3. **The drift threshold only counted parse rejects.** If USGS moved `time` to microseconds,
   every record would parse and every version would be refused, and the run would commit as
   `PARTIAL` with zero facts while reporting itself merely degraded.
4. **A version could be written with no payload.** The head-hash snapshot went stale as the loop
   inserted versions, so an in-batch alias merge could produce a committed version with
   `raw_record_id = NULL` and no trace of where the data came from.
5. **A re-stamped `updated` wrote a raw payload row per record per poll** — ~84 MB/day against a
   500 MB budget — because payloads were stored before deciding which records had changed.
6. **`Math.round(v * 100) / 100` disagrees with `numeric(_, 2)`.** `8.245` rounds to 8.24 in
   binary and 8.25 in the database, so the hash covered a value the column did not hold.
7. **An unknown `--feed` silently polled `all_day`**, so an operator closing a three-day gap was
   told "SUCCEEDED, 230 accepted" while the gap stayed open.
8. **Docs had become false** — §4.2 said `CONFIG_ERROR` was excluded from health when the ADR and
   the code say it counts; §12 still concluded "this fits" directly below the measurement showing
   it does not; DOMAIN_MODEL claimed the batch stamp is taken immediately before `COMMIT`.

## 4. Open items, deliberately not fixed

| Item | Why it is acceptable now | Where it lands |
|---|---|---|
| The batch stamp precedes `COMMIT` by the write duration | Identity resolution needs a `first_ingested_at`, and that loop is most of the batch. Atomicity is unaffected; the anomaly needs a replay `T` inside the write window, and the replay horizon is measured in hours. Stated precisely in DOMAIN_MODEL §2 | — |
| A missing `source_product` writes no run row | The lease is taken after the product lookup, so there is nothing to hang a run on. Visible via the log and a non-zero exit | Revisit if a second source hits it |
| `lastPayloadDigest` is not scoped by feed | Alternating `--feed` under one product can only cost a wasted re-parse, never a wrongful skip | P4 |
| Conditional GET unused | Nowhere in the frozen schema to persist a validator; costs ~1 MB per poll | P4, with the FDSN work |
| `rebuildHeads` orders by `ingested_at` | Only reachable with concurrent batches on one record, which the lease prevents | P4 |
| DNS rebinding window between check and connect | Single-host allowlist; the resolved address is checked, then `fetch` resolves again | Noted in SECURITY |
| 1-hour live soak | Not run; unit tests cover the loop deterministically | P10 |

## 5. Carried forward into P4

1. **Raw-payload retention must be decided before any backfill runs.** The measurement says the
   260k-event backfill reaches ~727 MB against a 500 MB budget, and the raw payload is 46 % of the
   per-event cost (ARCHITECTURE §12).
2. **FDSN reconciles (`updatedafter`, `includedeleted=only`) and `backfill usgs`** — deferred from
   P3, and shared machinery with the other adapters.
3. **The briefing engine must fail closed.** Under RLS deny-all the web role gets an *empty*
   health array, not a status of `UNAVAILABLE`, so a briefing looking for `UNAVAILABLE` to detect
   blindness would miss it entirely (ARCHITECTURE §9.8, `blindness.int.test.ts`).
4. **Changing what the content hash covers re-versions every record once.** The P3 rounding and
   alias-sorting changes produced 233 new versions for 9 genuinely new records on the next live
   poll. Correct, self-limiting, and belongs in a release note.
