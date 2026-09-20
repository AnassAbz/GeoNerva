# Gate G2 — P2 Domain model & database ★ architecture freeze

- **Date:** 2026-09-19
- **Decision:** **PASSED.** The schema, domain types and read-model contracts are frozen.
- **Scope:** `c1f5986..HEAD` (P2 branch merge `f5144f9`, plus three rounds of security fixes).

## Criteria (docs/IMPLEMENTATION_PLAN.md §3)

| Criterion | Result | Evidence |
|---|---|---|
| Schema, domain and read models frozen | **Yes** | 10 migrations, domain value objects and Zod attribute schemas, and the read-model contracts listed below |
| As-of invariants I2/I3 pass | **Yes** | Property-based tests over a randomised timeline sweep every exported read path. Proven non-vacuous by negative control: widening the `linksAsOf` filter by one day fails I2 with the offending timestamp, and restoring it passes |
| Storage estimate measured | **Yes** | 335 MB of the 500 MB lean budget, measured with `pnpm --filter @geonerva/db estimate-storage`. ARCHITECTURE §12 now carries measured figures. Indexes are ~45 % of the cost; the earthquake catalogue, not fire, is the largest consumer |
| Security review | **Signed off** | `docs/reviews/security-p2.md`: review, re-review and re-verification. No CRITICAL or HIGH open |
| §3a exit criteria F-6, F-7 | **Met** | F-6: the test guard requires loopback **and** a `*_test` name (19 adversarial URLs refused independently). F-7: non-TLS production URLs refused, and the driver now receives GeoNerva's `ssl` object including a pinned CA — verified through `client.connectionParameters` |
| Full gate green | **Yes** | typecheck, lint, format, depcruise, **297 unit**, **139 integration**, canary build, E2E, fixture manifests |

## What the reviews changed

Three rounds, each finding something the previous one had not:

1. **Review:** four HIGH. The connection factory could not open a connection at all (a space in the
   `search_path` startup parameter) and nothing tested it; `pg` silently discarded our TLS config
   including the pinned CA whenever the URL carried `sslmode`; the test-database guard reduced to
   "is it loopback", which the development database also satisfies; partition bounds resolved in
   the session timezone while names came from the UTC date.
2. **Re-review:** the fix for the fourth left the *existing* partitions misaligned, so on a non-UTC
   server ingestion would stop permanently at the seam and retention would delete rows a day early.
3. **Re-verification:** the repair written for that could never complete — it tried to write
   generated columns, and repairing one partition while its neighbours were still attached left a
   routing gap that runs forward west of UTC and backward east of it.

Each was fixed and covered by a test that fails without the fix. The last round also found two
places where a change summary claimed more than the code did, and one statement
(`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC`) that runs without error and does
nothing — now replaced by an explicit revoke plus a test asserting the property.

## Frozen read-model contracts

`packages/domain/src/read-models/`: `LocationBriefing`, `EventDetail`, `FireClusterDetail`,
`SourceStatus`, `HistoryResponse`, `EvidenceItem`, map/place responses, and the problem+json error
shape. P8 (API) and P9a (Frontend) build against these in parallel; changing one after this point
requires an ADR.

## Carried forward

`docs/IMPLEMENTATION_PLAN.md` §3a holds the deferred items with their phases. The two to re-check
at **G3** are:

- **S-9** — the dependency rule that makes the as-of layer the only fact reader must land before
  the first endpoint exists; the as-of-free readers in `spatial/queries.ts` have no caller today.
- **C1-forward** — under RLS deny-all a misconfigured role reads **zero rows with no error**, so
  the briefing must treat "no sources known" as *unavailable*, never as "nothing is happening".

## Exception carried from G1

**E-1 still stands:** CI has never run on a hosted runner, because the repository has no remote.
"CI green" continues to mean "every CI command passes locally from a clean clone".
