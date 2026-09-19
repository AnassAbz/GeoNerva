# Gate G1 — P1 Foundation

- **Date:** 2026-09-19
- **Decision:** **PASSED, with one documented exception** (E-1 below).
- **Scope:** commits `7eb14c5..HEAD` on `main`.

## Criteria (docs/IMPLEMENTATION_PLAN.md §3)

| Criterion | Result | Evidence |
|---|---|---|
| CI green on the scaffolded workspace | **Locally verified, not yet run on a remote** (E-1) | Every CI job's commands were executed locally, including from a fresh `git clone` with `pnpm install --frozen-lockfile`: typecheck, lint, format, depcruise, 74 unit tests, 1 PostGIS integration test, `build:canary`, 6 Playwright tests (desktop + mobile). `actionlint` clean. `gitleaks git` clean. Action SHAs verified against upstream tags via the GitHub API. |
| `pnpm db:up` + `pnpm db:check` on a clean machine | PASS | PostgreSQL 17.5, PostGIS 3.5.2, pg_trgm 1.6, from a clean volume. The same check runs as an integration test, and CI uses the same digest-pinned image (enforced by `scripts/infra-consistency.test.ts`). |
| Strict TypeScript, lint, formatting, architecture rules | PASS | TypeScript 6.0 strict + `noUncheckedIndexedAccess` + `erasableSyntaxOnly`; ESLint 9 `strictTypeChecked`; dependency-cruiser encodes ARCHITECTURE §3. **Every rule was probed with a deliberate violation**, not merely observed passing. |
| Environment validation fails fast without leaking values | PASS | `packages/config`, 21 tests, plus an independent 128-case fuzz by the reviewer with zero value leaks. |
| Security review | **Signed off** | `docs/reviews/security-p1.md`: review, re-review and re-check. No CRITICAL or HIGH open. All MEDIUM defects in P1 code fixed and verified. |
| Open-source community files | PASS | Apache-2.0 (owner decision Q1), NOTICE, README, CONTRIBUTING, Contributor Covenant 2.1, vulnerability policy. |

## Exceptions

**E-1 — CI has never executed on a hosted runner.** The repository has no git remote, so the
workflow is unproven in its real environment. What must be confirmed on the first remote run:

1. the `security` job with `.gitleaks.toml` (and whether `gitleaks-action` requires
   `GITLEAKS_LICENSE` for the account that owns the repository);
2. `build:canary` inside CI;
3. Dependabot's handling of the pnpm 12 lockfile;
4. `actions/setup-node` pnpm caching with `packageManager` pinned via Corepack.

Creating a remote is an outward-facing action and is left to the product owner. Until it happens,
"CI green" means "every CI command passes locally from a clean clone", which is stated rather than
implied. This does not block P2, whose work is entirely local.

## Carried forward

Nine security findings are exit criteria of later phases (docs/IMPLEMENTATION_PLAN.md §3a):
F-5 to F-8, F-12, F-15 to F-17, F-2b, N-5 and R-7. The next mandatory security review points are
the P2 migrations, database roles and RLS, and `packages/db/src/spatial/**`.
