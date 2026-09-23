# Gate reports — the canonical numbering

Two numbering schemes grew side by side in this repository. `docs/IMPLEMENTATION_PLAN.md` §2.4
defines gates against phases (P8's criterion is **G6**, P9b's is **G7**, P11's is **G8**), while the
continuation prompts each session was given numbered the gate after P8 "G8" and the one after P9
"G9". The files in this directory use the prompts' numbering, and every report since `gate-g7.md`
opens with a warning saying so.

**The plan is the source of truth.** A gate letter on its own means the plan's gate.

## The rule for new reports

1. **Name the file after the phase it closes**, not after a gate number:
   `docs/reviews/gate-p10.md`, `gate-p11.md`. A phase number cannot diverge from a second scheme,
   which is the whole failure this replaces.
2. **The title names the phase and, if the plan defines one for it, the plan's gate**, e.g.
   `# Gate P11 — hardening & adversarial QA (plan gate G8)`. A phase with no gate in §2.4 — P10 is
   one — says so instead of inventing a number.
3. **Do not renumber or rewrite the existing `gate-g*.md` files.** They are the record of what was
   verified and when, and their numbers are cited from `DECISIONS.md`, `IMPLEMENTATION_PLAN.md` and
   each other. The table below is how a reader resolves them.

## What each existing file actually reports on

| File | Phase it closes | The plan's gate for that phase | Verdict |
|---|---|---|---|
| `gate-g1.md` | P1 — foundation | G1 | PASSED 2026-09-19, with exception E-1 |
| `gate-g2.md` | P2 — domain model & database (architecture freeze) | G2 | PASSED 2026-09-19 |
| `gate-g3.md` | P3 — ingestion framework + USGS slice | G3 | PASS, with scope deviations (ADR-032) |
| `gate-g4.md` | historical earthquake ingestion & reconciliation (split out of P3) | — (no gate of its own in §2.4) | PASS |
| `gate-g5.md` | the remaining P0 adapters — the plan's **P4**, run as session P5 | G4 | PASS |
| `gate-g6.md` | the plan's **P5–P6** (geo, correlation, clustering, relevance) | G5 | PASS, three open items |
| `gate-g7.md` | the plan's **P7** (baselines & change detection) | G5 | PASS |
| `gate-g8.md` | the plan's **P8** (the read-only domain API) | **G6** | PASS at checkpoint 2 (checkpoint 1 was a FAIL) |
| `gate-g9.md` | the plan's **P9** (the frontend) | **G7** | PASSED 2026-09-23 at `7bb4ae2` |

The divergence begins at `gate-g6.md`: from there on, **file G*n* is the plan's G*n−1*** until the
scheme is retired by rule 1 above.

## Work that is not a gate

An ADR resolved between phases is recorded in `docs/DECISIONS.md` and, where it changed behaviour a
gate had already signed off, in the next phase's report and in `session-handoff.md`. It does not get
a gate report of its own — a gate is a phase's acceptance criterion, and nothing else is.
