# Security review — P1 Foundation

- **Reviewer:** Security Reviewer (independent)
- **Date:** 2026-09-19
- **Scope:** `git diff 7eb14c5..HEAD` on `main` (commits `f2444fd` … `d1cda7c`), 86 files.
- **References:** `docs/SECURITY.md`, `docs/IMPLEMENTATION_PLAN.md` §2.3 and P1, `docs/DECISIONS.md` ADR-024..027, `docs/ARCHITECTURE.md` §3 and §15.
- **Severity scale:** `docs/GEONERVA_MASTER_BRIEF.md` §56.

## Summary

There are no CRITICAL findings. There is one HIGH finding: the `NEXT_PUBLIC_*` secret lint rule, which `docs/SECURITY.md` C2 lists as a control, never fires on code that passes the type check. I proved that such a secret reaches the client bundle with lint green. Three MEDIUM findings are defects now:

- a connection-string leak in `check-config`;
- gaps in the XSS lint rules;
- a mismatch between the web outbound-HTTP rules and ARCHITECTURE §3.

Four MEDIUM items must be closed in named later phases. The LOW items are hardening.

Config validation, the error messages, the worker redaction (apart from F-2), the security headers, the CI permissions and triggers, the lockfile integrity and the compose port binding are correct. I verified each of them. The evidence is listed below.

## Findings

| Sev | ID | Location | Summary | When |
|---|---|---|---|---|
| HIGH | F-1 | `eslint.config.js:47-55` | The NEXT_PUBLIC secret rule misses bracket access. Bracket access is the only form the repo's TS settings allow, and Next inlines it into the client bundle. | Defect now |
| MEDIUM | F-2 | `apps/worker/src/cli/check-config.ts:8`, `packages/config/src/env.ts:21-25` | `check-config` prints the full DB URL with its password when the URL is malformed. It also reports "valid" first. | Defect now |
| MEDIUM | F-3 | `eslint.config.js:7,61-68` | Three XSS lint gaps: `react/no-danger` is bypassed by `createElement` and by `innerHTML` refs, and `.jsx/.js` files in `apps/web` are not linted at all. | Defect now (before P9a) |
| MEDIUM | F-4 | `.dependency-cruiser.cjs:56-62,85-94` | The web outbound-HTTP boundary does not hold. Web can reach `http` transitively via `briefing`, which §3 does not allow, and nothing restricts global `fetch`. | Defect now; decide before P8 |
| MEDIUM | F-5 | `apps/web/next.config.ts:13-16` | CSP has no `default-src`/`script-src` yet. The H1 "strict CSP" control is absent. | Later: P9a (must land before P9b renders provider text) |
| MEDIUM | F-6 | `scripts/lib/db-requirements.ts:22-24`, `vitest.config.ts:6` | The integration suite connects to `DATABASE_URL_WORKER`/`DATABASE_URL`, not to a dedicated test DB. | Later: P2 (before any writing integration test) |
| MEDIUM | F-7 | `packages/config/src/env.ts:21-25` | No TLS requirement on DB URLs in production. | Later: P2 (db client) / P10 |
| MEDIUM | F-8 | `packages/config/src/env.ts:41-55,113-116` | Nothing prevents the web config object (DB URL, rate-limit secret) from being serialized into RSC props or the client. | Later: P8 |
| LOW | F-9 | `.dependency-cruiser.cjs:46` | The pure-engine I/O rule misses `node:fs/promises`, `tls`, `worker_threads`, `createRequire`, global `fetch` and `process.env`. | Defect now |
| LOW | F-10 | `.dependency-cruiser.cjs` (no rule), `:112` | Unresolvable imports are silently skipped. The `@/` alias in apps/web is invisible to depcruise. | Defect now |
| LOW | F-11 | `packages/config/src/env.ts:27` | Secrets accept whitespace-only or placeholder values (32 spaces pass). | Defect now |
| LOW | F-12 | `packages/config/src/env.ts:36` | `NODE_ENV` defaults to `development`, so a production process with it unset runs as development. | Later: P3 / P10 |
| LOW | F-13 | `.github/workflows/ci.yml:25,57,72,94` | `actions/checkout` persists the token (no `persist-credentials: false`). There is no Dependabot/Renovate for the SHA-pinned actions and dependencies (M8 claims one). | Now (cheap) / P10 |
| LOW | F-14 | `infra/docker-compose.yml:13`, `ci.yml:44` | The PostGIS image is pinned by a mutable tag, not a digest. | Now (cheap) |
| LOW | F-15 | `SECURITY.md:7-8`, `CODE_OF_CONDUCT.md:39` | The only reporting channel is GitHub private vulnerability reporting, which is off by default, and there is no fallback. The CoC contact is indirect. | Before the repo is made public |
| LOW | F-16 | `packages/config/src/env.ts:48-54` | `MAP_STYLE_URL` is kept as a raw string. If P9 derives the CSP from it, a directive can be injected. | Later: P9a |
| LOW | F-17 | `package.json:33`, `ci.yml:106-108` | ESLint 9.39 is marked deprecated/unsupported in the lockfile. `pnpm audit` is report-only (as planned). | Later: P11 |

---

### F-1 — HIGH — the NEXT_PUBLIC secret rule is ineffective (defect now)

**Location:** `eslint.config.js:47-55`, together with `tsconfig.base.json:15` (`noPropertyAccessFromIndexSignature: true`).

**Issue:** The selector `MemberExpression[property.name=/^NEXT_PUBLIC_.*(SECRET|KEY|TOKEN|PASSWORD|DATABASE)/]` matches only dot access (`process.env.NEXT_PUBLIC_X`). Because `noPropertyAccessFromIndexSignature` is on, dot access to `process.env` is a type error (TS4111, verified). Type-correct code must write `process.env['NEXT_PUBLIC_X']`, and the rule ignores that form: its property is a `Literal`, which has no `name`. Other misses:

- destructuring (`const { NEXT_PUBLIC_DB_SECRET } = process.env`);
- lowercase names;
- secret-bearing names outside the list (`NEXT_PUBLIC_DB_URL`, `_PASS`, `_CREDENTIALS`, `_PRIVATE_*`, `_AUTH`, `_DSN`);
- `.jsx/.js` files (F-3);
- the `env` key in `next.config.ts`, which inlines any variable without the prefix.

**Proof:** A temporary client page (removed afterwards) contained `process.env['NEXT_PUBLIC_PROBE_SECRET_KEY']`. `eslint` exited 0. After `NEXT_PUBLIC_PROBE_SECRET_KEY=PROBEVALUE9731 pnpm build`, the value was present in `apps/web/.next/static/chunks/0_34zepfh1_fs.js`, a public client chunk. I then removed the probe and rebuilt clean.

**Scenario:** P9 adds a map-tiles or geocoder key as `NEXT_PUBLIC_MAPTILER_KEY` and writes it the only way the compiler allows. CI stays green and the key ships to every browser. The same happens with a DB URL named `NEXT_PUBLIC_DB_URL`. This is the C2 (CRITICAL) threat with one of its listed controls not working.

**Fix:** Replace the selector with patterns that cover all forms:

- `MemberExpression[property.value=/^NEXT_PUBLIC_.*(SECRET|KEY|TOKEN|PASS|DATABASE|DB_|DSN|CREDENTIAL|PRIVATE|AUTH)/i]`, which catches computed literals;
- the same regex on `property.name`;
- `VariableDeclarator[init.property.name='env'] > ObjectPattern > Property[key.name=/^NEXT_PUBLIC_.../i]`;
- `Literal[value=/^NEXT_PUBLIC_.*(…)/i]`, the most robust option: it flags the string anywhere, including `next.config.ts`.

Then:

1. Add a regression test that lints fixture snippets, using ESLint's `Linter` API in a unit test, so the rule cannot silently rot.
2. Forbid the `env` key in `next.config.ts`.
3. Put all security `no-restricted-syntax` selectors in one shared array. In flat config, a later block that sets `no-restricted-syntax` replaces the earlier options instead of merging them (a future `sql.raw` ban would silently drop this rule).
4. Consider `eslint-plugin-eslint-comments`' `no-restricted-disable` for the security rules.

### F-2 — MEDIUM — `check-config` can print the database password (defect now)

**Location:** `apps/worker/src/cli/check-config.ts:8` (`new URL(config.DATABASE_URL_WORKER)`), `:27` (rethrow). The root cause is `packages/config/src/env.ts:21-25`: the URL is validated by a regex only.

**Issue:** The config accepts any `postgres(ql)://.+` string, including strings that the WHATWG URL parser rejects. `describeWorkerConfig` then calls `new URL()`, which throws `ERR_INVALID_URL`. Because that error is not a `ConfigError`, it is rethrown and Node prints it uncaught, including its `input` property, which holds the full connection string.

**Proof:**

```text
$ DATABASE_URL_WORKER='postgresql://geonerva:Sup3r/Secret#pw@db.example.com:5432/geonerva' node apps/worker/src/main.ts check-config
✓ worker configuration is valid
TypeError: Invalid URL ... {
  code: 'ERR_INVALID_URL',
  input: 'postgresql://geonerva:Sup3r/Secret#pw@db.example.com:5432/geonerva'
}
```

For contrast, `scripts/db-check.ts` with the same URL is safe: `pg-connection-string` redacts `input: '*****REDACTED*****'`.

**Scenario:** An operator pastes a generated password containing `/`, `#` or `?` without percent-encoding it. That is common with base64 secrets, and it is exactly the case where someone runs `check-config`. The password lands in journald, Docker logs, a log shipper, or a CI log. GitHub masks only values registered as secrets, and only verbatim. `check-config` also says "valid" for a URL that no Postgres client can parse, which is misleading.

**Fix:**

1. In `postgresUrl`, add `.refine((v) => URL.canParse(v), 'must be a valid URL (percent-encode special characters in the password)')`, so the error path is the value-free `ConfigError`.
2. In `describeWorkerConfig`, wrap the hostname extraction so that any failure prints `set (unparseable)`.
3. As defence in depth, have `main.ts` catch every error at top level and print only `error.name` and `error.code`, never the object.
4. Add a unit test with the URL above.

### F-3 — MEDIUM — the XSS lint control has bypasses (defect now; must be fixed before P9a UI work)

**Location:** `eslint.config.js:7` (`WEB_FILES = ['apps/web/**/*.{ts,tsx}']`), `:61-68`.

**Issues (all verified with temporary probes):**

- `createElement('div', { dangerouslySetInnerHTML: { __html: html } })` is not flagged by `react/no-danger`.
- `ref={(n) => { n.innerHTML = html }}` is not flagged. `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` have no rule at all.
- `apps/web/app/**/other.jsx` is **not linted at all**: ESLint reports "File ignored because no matching configuration", which `eslint .` suppresses. Next.js builds `.jsx` pages even with `allowJs: false`. The same file also evades F-1.
- Any future shared React package outside `apps/web` gets no React rules.

**Scenario:** Provider text (a GDACS title, an alert text) is rendered through one of these paths in P9. That is H1, stored XSS. React escaping is the primary control, so this is a gap in a documented secondary control ("lint-enforced"), not an exploitable hole today.

**Fix:**

1. Extend `WEB_FILES` to `apps/web/**/*.{ts,tsx,js,jsx,mjs}` and add a catch-all config block, so no source file is ever unmatched.
2. Add `no-restricted-properties` / `no-restricted-syntax` for `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, and the `dangerouslySetInnerHTML` property key in object literals (`Property[key.name='dangerouslySetInnerHTML']`).
3. Apply these rules repo-wide, not just to the web app.

### F-4 — MEDIUM — the web outbound-HTTP boundary is not enforceable as designed (defect now in the rules; resolve before P8)

**Location:** `.dependency-cruiser.cjs:56-62` (`web-is-read-only`), `:85-94` (`briefing` allowed `http` and `config`).

**Issue:**

- `web-is-read-only` checks direct edges only. `briefing` may import `http` (and `config`), which ARCHITECTURE §3 does not list: "db, relevance, baselines, changes, geo ◄── briefing". The web app may import `briefing`, so it reaches `http` transitively. I verified that a probe `apps/web → packages/briefing → packages/http` produces **no violation**.
- Nothing restricts the global `fetch`, so web code can call any provider with no import at all. That breaks ADR-001's "the web process has no outbound calls to providers" without the hardened client's allowlist, timeouts or User-Agent (M1, H3).
- The design needs one outbound call from web (Nominatim for `places/search`), and it is undecided which module owns it.

**Fix (needs an ADR):**

- Choose one design: either `apps/web/lib/server/geocoder.ts` may import `http` and the rule gets a narrow `pathNot` exception, or the geocoder lives in `briefing`. Align `.dependency-cruiser.cjs` with ARCHITECTURE §3, or amend §3.
- Use `reachable: true` for `web-is-read-only` against `sources|pipeline`.
- Add an ESLint `no-restricted-globals: fetch` for `apps/web/**` and pure engines, with a single exemption for the hardened client.

### F-5 — MEDIUM — no script-restricting CSP yet (later phase: P9a, before P9b)

**Location:** `apps/web/next.config.ts:13-16`.

**Issue:** The CSP is `frame-ancestors 'none'; base-uri 'self'; object-src 'none'`. `default-src`, `script-src`, `connect-src`, `img-src` and `worker-src` from SECURITY.md §6 are absent. The comment defers them to P9 and states the reason. Today the page renders no untrusted content, so this is acceptable **now**.

The rendered page already contains 2 inline `<script>` blocks (Next's flight data, verified with `curl`). The eventual policy therefore needs nonces or hashes. Per-request nonces force dynamic rendering, which conflicts with the CDN HTML caching in ARCHITECTURE §13.3.

**Fix:** Decide the approach in P9a: a nonce set in middleware plus dynamic rendering, or a hash/SRI-based policy (`experimental.sri`) so HTML stays cacheable. Extend `e2e/smoke.spec.ts` to assert the full policy: no `unsafe-inline` in `script-src`, `Permissions-Policy`, and exact values. It should also cover a 404 route and an API route. Track this as a P9a exit criterion; provider text must not be rendered (P9b) without it.

### F-6 — MEDIUM — the integration suite targets the worker or production URL (later phase: P2)

**Location:** `scripts/lib/db-requirements.ts:22-24`, used by `db-requirements.int.test.ts:12`. `vitest.config.ts:6` says `DATABASE_URL_TEST`, but the code uses `DATABASE_URL_WORKER`, then `DATABASE_URL`.

**Issue:** The current test is read-only, so there is no harm today. P2 adds integration tests that migrate, truncate and seed. With the same resolution, a developer or operator whose shell exports the production `DATABASE_URL_WORKER` would run destructive tests against production. That is data corruption.

**Fix:** Before the first writing integration test, the integration project reads **only** `DATABASE_URL_TEST`. It refuses to run unless the host is loopback, a CI service, or a database name ending in `_test`. The CI job sets `DATABASE_URL_TEST`.

### F-7 — MEDIUM — no TLS enforcement for the database connection (later phase: P2 db client / P10)

**Location:** `packages/config/src/env.ts:21-25`.

**Issue:** Nothing requires `sslmode` on DB URLs. The worker VM connects to Supabase over the Internet. A URL without TLS parameters leaves TLS behaviour to driver defaults, with a risk of credentials and data travelling in cleartext or without certificate verification.

**Fix:** When `NODE_ENV=production` and the host is not loopback, require `sslmode=verify-full` (or configure `ssl: { rejectUnauthorized: true, ca }` in `packages/db`). Reject `sslmode=disable` or `prefer`. Add a unit test.

### F-8 — MEDIUM — no server-only guard on web secrets (later phase: P8)

**Location:** `packages/config/src/env.ts:41-55,113-116`.

**Issue:** `loadWebConfig()` returns an object holding `DATABASE_URL` and `RATE_LIMIT_SECRET`. In the App Router, passing that object, or any object that holds it, from a Server Component to a Client Component serializes it into the RSC payload sent to the browser. The F-1 rule cannot catch this.

**Fix:**

- Expose the web config only through `apps/web/lib/server/config.ts`, which starts with `import 'server-only'`.
- Taint the secret values (`experimental_taintUniqueValue`), or hand out narrowly typed accessors instead of the whole object.
- Add a depcruise rule: `@geonerva/config` is importable in apps/web only from `lib/server/**`.

### F-9 — LOW — gaps in the pure-engine I/O rule (defect now)

**Location:** `.dependency-cruiser.cjs:46`.

**Issue:** The rule matches `^(node:)?(fs|net|http|https|child_process|dns)$`, anchored exactly. I verified that these are **not** flagged from `packages/domain`:

- `node:fs/promises`
- `node:tls`
- `node:worker_threads`
- `createRequire(import.meta.url)('pg')`
- global `fetch`
- `process.env`

Other gaps:

- `(pg|kysely)[@/]` misses `pg-pool`, `postgres`, `pg-promise`, `@neondatabase/serverless` and `@supabase/*`. This also applies to `sql-only-in-db` at `:54`.
- The `pure-engines-have-no-io` list omits `packages/sources`-style HTTP libraries (`undici`).

**Fix:**

- Match `^(node:)?(fs|fs/promises|net|tls|http|http2|https|child_process|dns|dgram|worker_threads|cluster|module|vm)(/|$)`.
- Add `postgres|pg-[a-z-]+|@neondatabase|@supabase|undici` to the DB/IO lists.
- Add ESLint `no-restricted-globals` (`fetch`, `process`) and `no-restricted-properties` (`process.env`) for pure engines.

### F-10 — LOW — unresolvable imports are invisible to depcruise (defect now)

**Location:** `.dependency-cruiser.cjs`; there is no `not-to-unresolvable` rule, and `tsConfig` is `tsconfig.base.json` (`:112`).

**Issue:** An import that cannot be resolved produces no violation. I verified that `import '@geonerva/sources'` from apps/web, without a package.json dependency, passes depcruise silently. Today `tsc` catches that. But:

- apps/web's `@/*` path alias exists only in `apps/web/tsconfig.json`, so every web-internal `@/` edge is unresolved and unchecked;
- files outside any tsconfig (`.jsx`/`.mjs`) are covered by neither tool.

**Fix:** Add a `not-to-unresolvable` error rule, with a narrow `pathNot` for virtual Next.js modules such as `next/image-types/global`. Give depcruise a tsconfig that includes the web `paths`, or configure `tsConfig` per app.

### F-11 — LOW — weak secret validation (defect now)

**Location:** `packages/config/src/env.ts:27`.

**Issue:** `min(32)` without trimming or a character check accepts 32 spaces and `changemechangemechangemechangeme` (verified). A weak `RATE_LIMIT_SECRET` or `WORKER_TRIGGER_SECRET` makes rate-limit keys predictable or the HMAC trigger forgeable (H7).

**Fix:** Trim, require at least 32 non-whitespace characters, and reject low-diversity values (for example, fewer than 10 distinct characters, or a denylist such as `changeme` and `secret`). Add unit tests.

### F-12 — LOW — unsafe `NODE_ENV` default (later phase: P3 / P10)

**Location:** `packages/config/src/env.ts:36`.

**Issue:** A worker started without `NODE_ENV` (for example, a bare `docker run`) is treated as `development`. Nothing depends on this yet. Once dev-only behaviour exists (pretty logs with payloads, verbose errors, relaxed TLS from F-7), production would silently run it.

**Fix:** Make `NODE_ENV` required in the worker, or drive production hardening (TLS, log level) from explicit variables rather than from `NODE_ENV === 'development'`.

### F-13 — LOW — CI hardening (now / P10)

**Location:** `.github/workflows/ci.yml:25,57,72,94`; there is no `.github/dependabot.yml`.

**Issues:**

- `actions/checkout` keeps the default `persist-credentials: true`, so `GITHUB_TOKEN` sits in `.git/config` while third-party dependency code runs (Next build, Vitest, ESLint plugins, Playwright). The token is `contents: read`, so the impact is small, but it costs nothing to remove.
- SECURITY.md M8 claims "Dependabot or Renovate", but none is configured. Without one, the SHA-pinned actions and the `minimumReleaseAge`-pinned versions never receive security updates.

**Fix:** Add `with: persist-credentials: false` to every checkout. Add `.github/dependabot.yml` for the `github-actions` and `npm` ecosystems (weekly, grouped).

### F-14 — LOW — mutable image tag (now)

**Location:** `infra/docker-compose.yml:13`, `.github/workflows/ci.yml:44`.

**Issue:** `postgis/postgis:17-3.5` can be re-pointed upstream, which is a supply-chain risk.

**Fix:** Pin `@sha256:…` alongside the tag, updated by Dependabot's `docker` ecosystem.

### F-15 — LOW — the vulnerability-reporting channel may not exist (before the repo is made public)

**Location:** `SECURITY.md:7-8`, `CODE_OF_CONDUCT.md:39`.

**Issue:**

- The only channel is GitHub private vulnerability reporting, which is **disabled by default** per repository. The repo has no remote yet, so this could not be verified.
- If the setting stays off, reporters see no "Report a vulnerability" button, and the policy forbids public issues.
- The Code of Conduct points to "the contact method listed on the repository owner's GitHub profile", which may not exist.

**Fix:**

- Enable private vulnerability reporting when the GitHub repo is created, and record that in the P10 checklist.
- Add a fallback contact: a dedicated project alias, not a personal address.
- Give the Code of Conduct an explicit enforcement contact.

### F-16 — LOW — `MAP_STYLE_URL` is kept raw (later phase: P9a)

**Location:** `packages/config/src/env.ts:48-54`.

**Issue:** `https://tiles.example.org/s.json;script-src *` passes validation (verified). If P9 builds `connect-src` or `img-src` from this string, the value injects CSP directives. This is operator-controlled, hence LOW.

**Fix:** Transform the value to `new URL(v)` and build the CSP only from `.origin`. Reject values that contain whitespace, `;` or `,`.

### F-17 — LOW — tooling support status and audit (later phase: P11)

**Issue:** `pnpm-lock.yaml:1501` marks `eslint@9.39.5` as "no longer supported". This is dev-only, acknowledged in ADR-027, and is not a runtime risk. `pnpm audit` is `continue-on-error`, as planned. The step works: it ran locally and reported "No known vulnerabilities found". Findings stay invisible unless someone opens the log.

**Fix:** Make the audit blocking for `high` in P11, as planned. Until then, have Dependabot alerts (F-13) surface issues. Track the ESLint 10 migration in ADR-027.

---

## Verified correct (with evidence)

- **Config errors never echo values.** I fuzzed 128 invalid inputs across every web and worker variable with a marker string. The marker never appeared in `message`, `stack` or the serialized error: 0 leaks. `ConfigError` carries only `key: message` and does not attach the `ZodError` as `cause`.
- **AI_MODE:** the default is `disabled`, matching the owner decision. `local` is rejected. `anthropic` without a key is rejected, and a whitespace-only key counts as absent (verified). An empty `AI_DAILY_BUDGET_USD` coerces to 0 (fail-safe: no spend). Negative, `NaN`, `Infinity` and values above 1000 are rejected.
- **Worker summary redaction** (`describeWorkerConfig`): it prints only the hostname, set/absent flags and the model/budget. The unit test asserts that password, user, FIRMS key, Anthropic key and trigger secret are absent. The one exception is F-2.
- **`scripts/db-check.ts`:** it prints `error.message` only. With a malformed URL, pg redacts `input`, as verified above.
- **Security headers:** I checked `next start` responses with `curl` for `/` (200), `/nope/x` (404) and a `/_next/static/*.js` asset. All carry HSTS (`max-age=63072000; includeSubDomains`), `nosniff`, `strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(self), camera=(), microphone=()` and CSP `frame-ancestors 'none'`. `X-Powered-By` is absent.
- **CI:**
  - the workflow-level `permissions: contents: read` is not widened by any job;
  - the triggers are `pull_request` and `push` to main (no `pull_request_target`, no `workflow_run`);
  - no `${{ … }}` expression derived from untrusted input appears in any `run:`;
  - all third-party actions are pinned to 40-character SHAs, with timeouts on every job;
  - `--frozen-lockfile` is used everywhere;
  - gitleaks runs on every PR and push with `fetch-depth: 0`;
  - the `setup-node` pnpm cache is keyed on the lockfile, and GitHub cache scoping stops PR runs from writing main's cache;
  - no production secrets are used.
- **Supply chain:**
  - all 541 lockfile packages resolve from the npm registry with `integrity` hashes, and there are no git, tarball or URL dependencies;
  - pnpm itself is lockfile-pinned with integrity (`packageManagerDependencies`);
  - `minimumReleaseAge: 1440` is set;
  - dependency build scripts are denied by default (`.modules.yaml`: `pendingBuilds: []`, `allowBuilds: {unrs-resolver: false}`);
  - `publicHoistPattern: []`;
  - `pnpm audit --audit-level=high` finds no known vulnerabilities.
- **docker-compose:** Postgres is bound to `127.0.0.1:54320` only. The credentials are labelled local-only.
- **Secrets hygiene:**
  - `.env` and `.env.*` are ignored at any depth, and `.env.example` is the only tracked env file;
  - `.env.example` contains only local compose credentials and empty secret slots;
  - a regex scan of the P1 diff found only obvious test or placeholder credentials;
  - `.claude/` is ignored.
- **The depcruise rules work for direct edges:**
  - `apps/web → packages/sources` gives `web-is-read-only`;
  - `apps/web → pg` gives `sql-only-in-db`, and it resolves `node_modules/.pnpm/pg@8.23.0/...`;
  - `domain → config` gives `domain-allowed-internal-deps`;
  - workspace package-name imports resolve to `packages/*/src/index.ts` through the pnpm symlink, so the rules apply to normal import style.
- **The direct JSX form works:** `<div dangerouslySetInnerHTML=…>` in a `.tsx` file is flagged by `react/no-danger`. The direct dot-access form `process.env.NEXT_PUBLIC_API_KEY` is flagged, but see F-1.

## Tests and probes run

Node v24.21.0, pnpm 12.4.2:

```text
pnpm lint                → exit 0
pnpm depcruise           → ✔ no dependency violations found (31 modules, 13 dependencies cruised)
pnpm test:unit           → Test Files 3 passed (3); Tests 15 passed (15)
pnpm build               → ✓ (routes /, /_not-found)
pnpm audit --audit-level=high → No known vulnerabilities found
next start + curl -I     → headers as listed above
```

Temporary probes, all deleted afterwards:

- an ESLint bypass file in `apps/web/app/zzprobe/`;
- a `tsc` TS4111 check;
- a `NEXT_PUBLIC` bracket-inlining build probe (followed by a clean rebuild);
- depcruise bypass files in `packages/domain`, `packages/briefing` and `apps/web`;
- a config fuzz script in the scratchpad.

I did not run `pnpm test:integration` or `pnpm test:e2e`. They are not needed for these findings, and headers were checked directly.

## Assumptions / not verified

- I could not check the action SHAs against upstream tags: `git ls-remote` failed in the review sandbox with an SSL error. Verify them before the first push, for example with `gh api repos/actions/checkout/git/ref/tags/v7.0.1`.
- The repository has no remote, so CI has never run. The gitleaks default rules might flag test fixture strings (for example `postgresql://worker:s3cr3t-pass@…`); if so, add a narrow `.gitleaksignore` rather than disabling the scan. `gitleaks-action` needs a `GITLEAKS_LICENSE` secret if the repo is owned by a GitHub organization.
- Next.js inlining behaviour was verified on 16.3.5 only.
