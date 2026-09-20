# Earthquake correlation — calibration against the labelled set

- **Date:** 2026-09-20
- **Algorithm version:** `eq-corr-1`
- **Labelled set:** `packages/test-fixtures/sources/correlation/eq-pairs.json` — 250 USGS↔EMSC
  pairs, 186 `MATCH` / 64 `NO_MATCH`, 38 hand-checked, 4 marked `ambiguous`
- **Targets (G5):** precision ≥ 0.98, recall ≥ 0.95, ambiguous pairs reported separately
- **Result: both targets met.** Precision **1.0000**, recall **0.9891**

The calibration runs as a test (`packages/correlation/src/calibrate.test.ts`), not a script, so a
threshold that moves and breaks the targets fails the build rather than a report nobody re-ran.

## 1. The numbers

Ambiguous pairs are excluded from the scores, leaving 246.

| | pairwise | competitive |
|---|---|---|
| True positives | 181 | 181 |
| False positives | **0** | **0** |
| False negatives | 2 | 2 |
| True negatives | 63 | 63 |
| `POSSIBLE_MATCH` on a true pair | 2 | 2 |
| `POSSIBLE_MATCH` on a distinct pair | 1 | 1 |
| **Precision** | **1.0000** | **1.0000** |
| **Recall** | **0.9891** | **0.9891** |

Only a `MATCH` counts as a positive prediction. A `POSSIBLE_MATCH` merges nothing, so counting it
as a hit would score the algorithm for a merge it deliberately refused to make — which is the
behaviour the design is most proud of and would be the easiest to flatter.

### The two misses

Both are `POSSIBLE_MATCH`, so both are **kept apart pending evidence** rather than declared
different — the failure mode that shows as two events rather than destroying a distinction.

| Pair | Δt | d | ΔM | misfit | label source |
|---|---|---|---|---|---|
| `us6000rc4p__20250922_0000346` | 6.31 s | 79.2 km | 0 | 1.186 | hand-checked |
| `us7000t2j3__20260722_0000321` | 5.87 s | 65.5 km | 0.1 | 1.147 | EventID service |

Both sit just above the `matchMisfit` of 1.0, and both are dominated by the distance term — 79 km
and 65 km against a 100 km scale. Loosening `matchMisfit` to 1.2 would convert both to matches and
would still leave precision at 1.0 on this set. **That change has not been made**, because the
distance distributions overlap: distinct events in this same set come as close as 30.2 km at
21 s, and the set is 250 pairs from a few months. Buying 1.1 % of recall by moving a threshold
toward a region where the classes are known to overlap is how a calibration becomes a fit to its
own fixture.

## 2. Two findings that do not flatter the design

### The uniqueness gap is never the deciding factor on this set

Pairwise and competitive scoring give **identical** results, and that is not a coincidence — it is
the finding. Of the 246 scored outcomes, 96 have a competing candidate at all, and in **0** of
them does the gap rule change the answer: no pair is both close enough to match (misfit ≤ 1.0) and
ambiguous (gap < 0.3).

`ARCHITECTURE.md` §6.1 says "no threshold triple separates the hardest cases, and the uniqueness
gap carries the decision". On this set, that is **not what happens**: the thresholds plus the
magnitude veto separate it completely, and the gap never has to intervene. The gap rule is
implemented and unit-tested — a synthetic pair of near-tied candidates produces `POSSIBLE_MATCH`
— but it is **not validated by real data**, and the report says so rather than letting the passing
targets imply it was.

What *does* separate the hardest cases is the veto, below.

### The magnitude veto does all the work at the hard end, at no cost

| | pairs |
|---|---|
| Distinct pairs the veto rejects | **18** of 64 |
| True pairs the veto rejects | **0** of 186 |

The hardest distinct pair in the set — `us7000s8v7`, 1.95 s and 12.9 km apart, which no time or
distance threshold could reject — is separated by ΔM 1.9 and nothing else.

## 3. A documentation error found while measuring

`ARCHITECTURE.md` §6.1 states:

> True pairs reach **16.4 s / 135 km / ΔM 1.9** (medians 0.72 s / 8.5 km / ΔM 0)

Measured directly from the fixture:

| | documented | measured |
|---|---|---|
| max Δt, true pairs | 16.4 s | **16.44 s** ✓ |
| max distance, true pairs | 135 km | **135.0 km** ✓ |
| max ΔM, true pairs | 1.9 | **1.3** ✗ |
| medians | 0.72 / 8.5 / 0 | **0.71 / 8.4 / 0** ✓ |

**ΔM 1.9 is a distinct-pair figure, not a true-pair one** — it belongs to `us7000s8v7`, which the
set labels `NO_MATCH`. The true-pair maximum is 1.3.

This matters rather than being a typo: at ΔM 1.9 the documented veto of 1.2 would look like it
must reject real pairs, which would be an argument for loosening it. At the real 1.3 the veto
rejects exactly one true pair — the Luzon republication — and the suspension rule handles it. The
document has been corrected.

## 4. The republication rule, which the set forced

One hand-checked true pair failed until the rule was implemented correctly:

> `us7000strv__20260605_0000323` — Luzon. Identical origin time and epicentre (Δt 0 s, 0 km), but
> USGS says mb 4.5 and EMSC says M 3.2: ΔM 1.3, above the veto. EMSC credits the solution to
> **`NEIC`**, having kept an earlier NEIC magnitude.

The first implementation compared the two records' contributor strings and found nothing — USGS
credits its own record to `us`, EMSC credits its copy to `NEIC`, and those are not equal. The
correct question is not "are the contributors the same string?" but **"is this record credited to
the *other source's* own agency?"**, which `SOURCE_AGENCY_CODES` answers.

Independence is decided by who computed the solution, never by whether the values agree
(ADR-030) — deciding it from the values would be circular, since the question the veto asks is
precisely whether the values may legitimately disagree.

## 5. The ambiguous four, reported separately

| Pair | Label | Predicted | misfit | gap |
|---|---|---|---|---|
| `us7000rke3__20251207_0000228` | MATCH | POSSIBLE_MATCH | 1.220 | none |
| `us7000s8v7__20260330_0000126` | NO_MATCH | NO_MATCH | 1.438 | 68.07 |
| `us6000sr2n__20260418_0000101` | MATCH | MATCH | 0.409 | 7.20 |
| `us6000t9ke__20260702_0000087` | MATCH | POSSIBLE_MATCH | 1.983 | none |

One correct merge, one correct rejection, and two held apart. No wrong merge among them, which is
the property that matters for pairs whose own label is uncertain.

## 6. What this calibration does **not** establish

- **The ground truth is fallible.** Hand-checking found 2 errors in the reviewed subset, so EMSC's
  EventID service is about 99 % precise. A precision of 1.0000 against it is a statement about
  agreement with a fallible referee, not about being right.
- **The gap rule is unvalidated by data** (§2).
- **Contributor data is absent from the fixture on the USGS side.** The set carries EMSC's `auth`
  but not USGS's `net`, so `Solution.contributor` is `null` for every USGS record here. The
  republication rule is exercised in one direction only — EMSC crediting NEIC — and the
  same-third-agency branch is covered by unit tests alone.
- **The set is 250 pairs over a few months**, drawn from three subsets (`global_m45` 111,
  `sequence_m45` 74, `euromed_m3_4.5` 65). It is not a sample of the whole catalogue, and
  `sequence_m45` deliberately over-represents aftershock sequences, which is where the hard
  negatives live.
- **Nothing here tests correlation against the live database.** These are pure functions over
  fixture rows; wiring them to `canonical_events` is a separate step with its own integration
  tests.
