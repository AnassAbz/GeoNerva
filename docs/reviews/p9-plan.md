# P9 — Frontend: plan

- **Date:** 2026-09-22
- **Gate:** the plan's **G7** (`IMPLEMENTATION_PLAN.md` §2.4): "E2E green desktop + mobile; axe
  clean; **QA round 2 (data integrity)**". Note the numbering: the continuation prompts call the
  gate after P8 "G8" while the plan calls it G6, so this phase's gate file will be `gate-g9.md`
  under the prompts' scheme and is the plan's **G7**. Reports state which scheme they use.
- **Depends on:** P8 (the service layer) and P9a (merged in `f959e5d`). ADR-038, ADR-040 and
  ADR-041 are accepted and implemented, so `/evidence`, `/history` and coverage are stable to
  build on.
- **Governing spec:** `docs/PRODUCT.md` §6, plus `docs/TESTING.md` §5 for the flows.

## 1. What is already done, and what 9b actually is

P9a is merged and complete: tokens, the component set, the MapLibre wrapper, and every page —
landing, `/place/[slug]`, `/event/[publicId]`, `/fire/[publicId]`, `/data-status`, `/methodology` —
built against mock read models validated by `apps/web/lib/fixtures/fixtures.test.ts`. 65 component
tests and 69 Playwright checks with axe clean at desktop and mobile.

9b is one sentence in the plan — "wire to the API; loading and error states; replay banner
(`as_of`); `/data-status`; `/methodology` rendered from exported configs; landing" — and the survey
of the tree turns it into this:

| # | Deliverable | Files |
|---|---|---|
| 1 | The data seam: nine functions in `lib/view/data.ts` call `lib/server/services.ts` instead of returning fixtures; `?scenario` is deleted | `apps/web/lib/view/data.ts` |
| 2 | Loading and error states | new `app/**/loading.tsx`, `app/**/error.tsx` |
| 3 | `/methodology` rendered from the exported configs | `app/methodology/page.tsx`, `lib/view/copy.ts`, `lib/view/families.ts` |
| 4 | Landing search completed: submit search (Nominatim, cached), coordinate entry, "Use my location" | `components/place-search.tsx`, `app/page.tsx`, new `lib/client/api-client.ts` |
| 5 | Evidence "Raw record": the payload's lifecycle and digest, never the provider's bytes (ADR-038) | `components/evidence.tsx` |
| 6 | The fire-cluster withheld/truncated state (ADR-039 interim) | `app/fire/[publicId]/page.tsx` |

## 2. Three things block the gate rather than the work

1. **F-5, the strict Content-Security-Policy, is open.** `apps/web/next.config.ts:16-18` says the
   strict script policy was deferred; the shipped CSP has no `default-src` and no `script-src`.
   §3a makes it an exit criterion of P9a — "a phase gate cannot pass while its items are open" —
   and its own wording is "before any provider text is rendered", which fixture-sourced provider
   text already is. It is security-review-relevant. **It goes first.**
2. **The E2E prerequisites do not exist.** `docs/TESTING.md` §5 requires a seeded scenario database
   (`test-fixtures/scenarios/*.sql`) and a fixed clock (`GEONERVA_FAKE_NOW`). Neither is in the
   repository: no `scenarios/` directory, and the only occurrence of the variable is that line of
   the document. Every current E2E spec runs against fixtures, so **the seam swap breaks all 69 at
   once unless the seed and the clock land first**. This is the long pole.
3. **The component tests ran nowhere.** Fixed in `ebd6dc3`: `pnpm test:components` exists, `check`
   runs it, CI runs it.

Two rulings, mine as orchestrator, recorded here rather than left implicit:

- **R-7** (`apps/web/lib/client/api-client.ts` is the only module exempt from the network-call ban,
  must reject absolute URLs and anything outside `/api/v1`, with a test) is **not satisfied
  vacuously**. P8 removed the need on the server side, but deliverable 4 adds a browser type-ahead,
  so the module is written and tested as §3a specifies. §3a stands unamended.
- **F-5 is closed with a per-request nonce and `'strict-dynamic'`, and three routes lose static
  prerendering** (`/`, `/methodology`, `/_not-found`). F-5 asks for "hashes or `strict-dynamic`",
  and hashes were shown to be impossible here rather than merely inconvenient: the second inline
  script Next emits is the RSC flight payload, whose bytes *are* the page's rendered data, so its
  hash differs per route and changes with any content edit, and `next.config.ts`'s `headers()` is
  evaluated before any HTML exists. A nonce cannot reach prerendered HTML — measured: with the
  proxy in place, `/` still built as static and served two nonce-less inline scripts against a
  fresh nonce, i.e. a blank page — so `app/layout.tsx` declares `force-dynamic`. This contradicts
  no frozen document: ARCHITECTURE §13.3's CDN layer keys `/api/v1` responses, not HTML, and the
  four routes that render provider text were already dynamic. The cost is one request-time hop on
  three data-free routes, which is the cheaper side of the trade against a script policy that
  cannot hold. Revisiting it means reopening F-5, so it is recorded here and in SECURITY.md §6.
- **ADR-039 is binding while Proposed**: no `fire_detection` map feature at any zoom. PRODUCT §6.5's
  "detections at zoom ≥ 8" is stale pending the owner's decision and is **not** built. The
  fire-cluster page instead renders the withheld state ADR-039 describes.

## 3. Order of work

Ownership: Frontend owns `apps/web/**` except `app/api/**` and `lib/server/**`.

```text
wave 1 (parallel, disjoint files)
  A  F-5 strict CSP                     next.config.ts (+ layout.tsx)     → security review
  B  scenario seed + GEONERVA_FAKE_NOW  packages/test-fixtures/**, clock  ← the long pole
  C  /methodology from configs          app/methodology, lib/view/copy
  D  evidence "Raw record" + ADR-039 withheld state   components/evidence.tsx, app/fire

wave 2 (single writer)
  E  the data seam                      lib/view/data.ts, `?scenario` deleted

wave 3
  F  loading and error states           new files only
  G  landing search + api-client (R-7)  place-search.tsx, lib/client/**

wave 4
  H  full E2E desktop + mobile, axe, 320 px; then QA round 2 (data integrity)
```

A depends on nothing. E depends on B (or the specs fail) and is a single-writer chokepoint: one
agent, no overlap. F is best after E, so the boundaries it renders are real. H is the gate.

## 4. What the gate will measure

Every flow of `docs/TESTING.md` §5 at both viewports, against a production build with the seeded
scenario database and the fixed clock, plus one run with WebGL2 disabled; axe with no serious or
critical violations on every page; no horizontal scroll at 320 px and touch targets ≥ 44 px;
`pnpm check` and `pnpm test:integration` green; mutation controls on the new logic; QA round 2 run
by an independent agent into `docs/reviews/qa-round-2.md`, scoped by `SECURITY.md:53` (H5,
misleading scientific output) — with no CRITICAL or HIGH left open.

Two absences the UI must render honestly, not hide: `FIRE_TREND` is `INSUFFICIENT_COVERAGE` until
35 covered days exist (ADR-040), and every GDACS family's baseline refuses while the worker
schedules only USGS. A fixture-backed page showed charts where the live system correctly refuses;
the wired page must show the refusal.
