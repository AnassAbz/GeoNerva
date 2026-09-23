/**
 * `pnpm smoke <base-url> [--place marrakech,tokyo,...]` — `docs/TESTING.md` §10, the post-deploy
 * check, against a **running deployment** rather than a seeded local world.
 *
 * Nine numbered checks, in §10's order and keeping its numbers, because the number is what an
 * operator reads in a failure and looks up. Each one stops at the first failure and exits with the
 * check number, so a workflow's exit code says which promise broke: **0** everything held,
 * **1–9** that check failed, **10** the arguments were wrong, **11** the deployment could not be
 * reached at all.
 *
 * ### What it deliberately does not do
 *
 *  - **No database.** A smoke test that reads the database is testing the database. This asks the
 *    deployment the same questions a reader's browser would, over HTTP, and believes only the
 *    answers.
 *  - **No seeded fixtures and no frozen clock.** `apps/web/e2e/smoke.spec.ts` covers the same
 *    ground against a seeded scenario with `GEONERVA_FAKE_NOW`; that is a different instrument.
 *    Production has a real clock and whatever data it has ingested, so every assertion here has to
 *    hold for *any* honest state of the world — which is why check 2 accepts a declared outage and
 *    check 3 asks for a manifest rather than for content.
 *  - **No writes.** Nothing here can change what the deployment holds.
 *
 * ### Two checks that are narrower than they look
 *
 *  - **Check 2 judges feeds, not sources.** §10 says each P0 source must be available "or an
 *    explicit known outage", and the explicit part is what the database's `enabled` flag records.
 *    But a source is not one thing: GDACS is six feeds, and activating one family at a time means
 *    five of them are deliberately off while the source itself stays on. Judged at source level
 *    that reads `UNAVAILABLE` and fails — which it did, the first time one GDACS family went live.
 *    So the rule is per **product**: every `UNAVAILABLE` feed must say `DISABLED` among its
 *    reasons. A feed that is switched off is a declared decision; a feed that is enabled and
 *    `UNAVAILABLE` for any other reason is either an outage or a feed nothing polls, and both
 *    deserve to fail a smoke test.
 *  - **Check 6** must not follow redirects. Next normalises a trailing slash with a 308 *before*
 *    the proxy that sets the policy runs, so a redirect carries no CSP by design
 *    (`docs/SECURITY.md` §6). Following one would test the wrong response and report a header as
 *    missing that is present on every page a reader actually sees.
 */

/**
 * The demo places (owner decision Q5), as **coordinate keys** rather than names.
 *
 * `place` takes `p:<geonames id>` or `c:<lat>,<lon>`, and the named form needs the GeoNames import
 * to have run — a provisioning step, documented in `docs/DEPLOYMENT.md`, that a deployment can
 * legitimately not have done yet. A smoke test that failed for that reason would be reporting a
 * missing gazetteer as a broken briefing. Coordinates exercise the same path and depend on
 * nothing, and they are already in the two-decimal form invariant I15 requires of any coordinate
 * GeoNerva echoes back.
 */
const CURATED = [
  'c:31.63,-8.00', // Marrakech
  'c:49.28,-123.12', // Vancouver
  'c:34.05,-118.24', // Los Angeles
  'c:35.68,139.69', // Tokyo
  'c:64.15,-21.94', // Reykjavík
] as const;
const HOME_BUDGET_MS = 2000;
const HEARTBEAT_BUDGET_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

interface Options {
  readonly baseUrl: string;
  readonly places: readonly string[];
}

export function parseArgs(argv: readonly string[]): Options | string {
  const [base, ...rest] = argv;
  if (base === undefined) return 'usage: pnpm smoke <base-url> [--place c:31.63,-8.00,...]';
  if (!URL.canParse(base)) return `not a URL: ${base}`;
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return 'refusing a plaintext base URL for anything but localhost';
  }

  let places: string[] = [...CURATED];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '--place') return `unknown argument: ${rest[index] ?? ''}`;
    const value = rest[index + 1];
    if (value === undefined || value === '') return '--place needs a comma-separated list';
    // Semicolons, because a coordinate key contains a comma.
    places = value.split(';').map((key) => key.trim());
    index += 1;
  }
  return { baseUrl: url.origin, places };
}

/** A failed check, carrying §10's own number. */
class CheckFailed extends Error {
  readonly check: number;
  constructor(check: number, message: string) {
    super(message);
    this.check = check;
    this.name = 'CheckFailed';
  }
}

async function get(
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; elapsedMs: number }> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'user-agent': 'GeoNerva-smoke/1 (+docs/TESTING.md §10)' },
    ...init,
  });
  return { response, elapsedMs: Date.now() - startedAt };
}

async function json(url: string, check: number): Promise<unknown> {
  const { response } = await get(url);
  if (response.status !== 200) {
    throw new CheckFailed(check, `${url} answered ${String(response.status)}, expected 200`);
  }
  try {
    return await response.json();
  } catch {
    throw new CheckFailed(check, `${url} answered 200 but not JSON`);
  }
}

function asRecord(value: unknown, check: number, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new CheckFailed(check, `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * 1. `/` 200 in under 2 s — **warm**.
 *
 * The first request of the day to an idle serverless deployment pays for a cold function *and* a
 * cold database connection, and `force-dynamic` means no HTML is served from a cache. Two seconds
 * is a budget for what a second reader experiences, not for what the nightly cron happens to
 * trigger; holding a cold start to it would make the cron red for a reason that is not a
 * regression. So the first request is made and discarded, and the budget is applied to the second.
 * The cold time is reported, because it is worth knowing and should never be silently dropped.
 */
async function checkHome(base: string): Promise<string> {
  const cold = await get(base);
  if (cold.response.status !== 200) {
    throw new CheckFailed(1, `/ answered ${String(cold.response.status)}, expected 200`);
  }
  await cold.response.arrayBuffer();

  const { response, elapsedMs } = await get(base);
  if (response.status !== 200) {
    throw new CheckFailed(1, `/ answered ${String(response.status)} when warm, expected 200`);
  }
  if (elapsedMs > HOME_BUDGET_MS) {
    throw new CheckFailed(
      1,
      `/ took ${String(elapsedMs)} ms warm, over the ${String(HOME_BUDGET_MS)} ms budget ` +
        `(${String(cold.elapsedMs)} ms cold)`,
    );
  }
  return `/ answered 200 in ${String(elapsedMs)} ms warm (${String(cold.elapsedMs)} ms cold)`;
}

/** 2. Every feed is available, or explicitly switched off. */
async function checkSources(base: string): Promise<string> {
  const body = asRecord(await json(`${base}/api/v1/sources/status`, 2), 2, 'the source status');
  const sources = body['sources'];
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new CheckFailed(2, 'the deployment reports no sources at all');
  }

  const unexplained: string[] = [];
  let live = 0;
  let declaredOff = 0;

  for (const entry of sources) {
    const source = asRecord(entry, 2, 'a source');
    const sourceId = typeof source['sourceId'] === 'string' ? source['sourceId'] : '?';
    const products = source['products'];
    if (!Array.isArray(products) || products.length === 0) {
      throw new CheckFailed(2, `${sourceId} reports no feeds`);
    }

    for (const productEntry of products) {
      const product = asRecord(productEntry, 2, 'a feed');
      const code = typeof product['code'] === 'string' ? product['code'] : '?';
      /*
       * `health.status` and `health.reasons`, not a top-level field — `sourceStatusEntrySchema`
       * has neither at the top, and an earlier version of this check read one that did not exist
       * and therefore never failed.
       */
      const health = asRecord(product['health'], 2, `the health of ${sourceId}:${code}`);
      if (health['status'] !== 'UNAVAILABLE') {
        live += 1;
        continue;
      }
      const reasons = Array.isArray(health['reasons']) ? health['reasons'].map(String) : [];
      /*
       * `DISABLED` is the database saying "we do not offer this here", which is §10's explicit
       * known outage. `RETIRED` is the provider having withdrawn it — equally declared, and not
       * something a deployment can fix.
       */
      if (reasons.includes('DISABLED') || reasons.includes('RETIRED')) {
        declaredOff += 1;
        continue;
      }
      unexplained.push(`${sourceId}:${code}${reasons.length > 0 ? ` (${reasons.join('/')})` : ''}`);
    }
  }

  if (unexplained.length > 0) {
    throw new CheckFailed(
      2,
      `feeds are UNAVAILABLE without being switched off: ${unexplained.join(', ')}`,
    );
  }
  if (live === 0) {
    throw new CheckFailed(2, 'every feed is switched off, so the deployment reports nothing');
  }
  return `${String(live)} feeds live, ${String(declaredOff)} explicitly off, none unexplained`;
}

/** 3. A briefing for the curated places returns 200 with a manifest. */
async function checkBriefings(base: string, places: readonly string[]): Promise<string> {
  const served: string[] = [];
  for (const place of places) {
    const url = `${base}/api/v1/briefing?place=${encodeURIComponent(place)}`;
    const { response } = await get(url);
    /*
     * A curated place that is not in this deployment's gazetteer is a provisioning gap, not a
     * broken briefing — the GeoNames import may not have run. It is reported rather than passed
     * over, but it does not masquerade as a 500.
     */
    if (response.status === 404) continue;
    if (response.status !== 200) {
      throw new CheckFailed(3, `briefing for ${place} answered ${String(response.status)}`);
    }
    const body = asRecord(await response.json(), 3, `the briefing for ${place}`);
    const manifest = body['evidenceManifest'];
    if (!Array.isArray(manifest)) {
      throw new CheckFailed(3, `the briefing for ${place} carries no evidence manifest`);
    }
    served.push(place);
  }
  if (served.length === 0) {
    throw new CheckFailed(
      3,
      `none of ${places.join(' ')} resolved — every curated place answered 404`,
    );
  }
  return `${String(served.length)} of ${String(places.length)} curated places briefed (${served.join(', ')})`;
}

/**
 * Collects every subject the curated briefings carry.
 *
 * Where a briefing's subjects actually live: `snapshot.families` is a record keyed by hazard
 * family, and each card carries `items` (`locationBriefingSchema` → `locationSnapshotViewSchema`
 * → `familyCardSchema`). The first version of checks 4 and 5 looked for a top-level `items` array
 * that the contract has never had, found nothing every time, and reported "a quiet world" — so
 * neither check ever issued a request. Read against
 * `packages/domain/src/read-models/schemas.ts`, not against memory.
 */
async function collectSubjects(
  base: string,
  places: readonly string[],
): Promise<Record<string, unknown>[]> {
  const subjects: Record<string, unknown>[] = [];
  for (const place of places) {
    const { response } = await get(`${base}/api/v1/briefing?place=${encodeURIComponent(place)}`);
    if (response.status !== 200) continue;
    const body = asRecord(await response.json(), 4, 'a briefing');
    const snapshot = asRecord(body['snapshot'], 4, 'the snapshot');
    const families = asRecord(snapshot['families'], 4, 'the families');

    for (const card of Object.values(families)) {
      const items: unknown = asRecord(card, 4, 'a family card')['items'];
      if (!Array.isArray(items)) continue;
      for (const entry of items as unknown[]) {
        subjects.push(asRecord(entry, 4, 'a briefing item'));
      }
    }
  }
  return subjects;
}

/** 4 and 5. An event page resolves, and the evidence behind it resolves too. */
async function checkEventAndEvidence(base: string, places: readonly string[]): Promise<string[]> {
  const subjects = await collectSubjects(base, places);

  /*
   * `CE:` is a *canonical event*; `EQ` is the prefix of its public id, which is a different thing
   * and is what the first version matched on. `publicId` is a field in its own right, so the ref
   * only decides which kind of page the subject has.
   */
  const event = subjects.find((subject) => {
    const ref = subject['subjectRef'];
    return typeof ref === 'string' && ref.startsWith('CE:');
  });
  const publicId = typeof event?.['publicId'] === 'string' ? event['publicId'] : null;

  const withEvidence = subjects.find((subject) => {
    const ids = subject['evidenceIds'];
    return Array.isArray(ids) && ids.length > 0 && typeof ids[0] === 'string';
  });
  const evidenceIds = withEvidence?.['evidenceIds'];
  const evidenceId =
    Array.isArray(evidenceIds) && typeof evidenceIds[0] === 'string' ? evidenceIds[0] : null;

  const lines: string[] = [];

  if (publicId === null) {
    /*
     * A quiet world is a legitimate answer, and inventing an identifier to test with would be
     * testing the test. But it is reported as a **warning**, carrying the number of subjects seen,
     * so that "nothing to resolve" can never again read the same as "resolved". A check that only
     * ever prints the same reassuring line is not a check.
     */
    lines.push(
      `4. \u26a0 no canonical event among ${String(subjects.length)} subjects in the curated ` +
        'briefings — nothing to resolve, so nothing was proved',
    );
  } else {
    const { response } = await get(`${base}/event/${encodeURIComponent(publicId)}`);
    if (response.status !== 200) {
      throw new CheckFailed(4, `/event/${publicId} answered ${String(response.status)}`);
    }
    lines.push(`4. /event/${publicId} resolved`);
  }

  if (evidenceId === null) {
    lines.push(`5. \u26a0 no evidence id among ${String(subjects.length)} subjects to resolve`);
  } else {
    const url = `${base}/api/v1/evidence/${encodeURIComponent(evidenceId)}`;
    const body = asRecord(await json(url, 5), 5, 'the evidence detail');
    /*
     * `evidenceDetailSchema` is `{ schemaVersion, item, detail, attribution }` — the id and kind
     * are on `item`, not at the top level, and the contract's own refinement is that the manifest
     * entry and the payload describe the same kind of evidence. Asserting that is worth more than
     * asserting a field exists. The first version checked the top level, and would have failed
     * every time had it ever run.
     */
    const item = asRecord(body['item'], 5, 'the evidence manifest entry');
    const detail = asRecord(body['detail'], 5, 'the evidence payload');
    const kind = item['kind'];
    if (typeof kind !== 'string') {
      throw new CheckFailed(5, `evidence ${evidenceId} resolved without a kind`);
    }
    if (kind !== detail['kind']) {
      throw new CheckFailed(
        5,
        `evidence ${evidenceId}: the manifest says ${kind} and the payload says ${String(detail['kind'])}`,
      );
    }
    lines.push(`5. evidence ${evidenceId} resolved as ${kind}`);
  }

  return lines;
}

/** 6. CSP present, HSTS, no `x-powered-by`. */
async function checkHeaders(base: string): Promise<string> {
  // Not the redirect: Next normalises before the proxy sets the policy, so a 308 carries no CSP.
  const { response } = await get(base);
  const headers = response.headers;
  const csp = headers.get('content-security-policy');
  if (csp === null) throw new CheckFailed(6, 'no Content-Security-Policy on /');

  /*
   * Parsed into directives rather than searched as a string. A substring test for
   * `default-src 'self'` matches a policy of `default-src 'self' 'unsafe-inline'`, and a test for
   * `'unsafe-inline'` guarded by `csp.includes('script-src')` skips the policy that has no
   * `script-src` at all — where scripts inherit `default-src` and inline script is permitted.
   * That is exactly the shape a botched header merge produces, and it is the regression this
   * check exists for, so the *effective* script sources are what gets asserted.
   */
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/u);
    if (name !== undefined && name !== '') directives.set(name.toLowerCase(), values);
  }

  const defaultSrc = directives.get('default-src');
  if (!defaultSrc?.includes("'self'")) {
    throw new CheckFailed(6, "the policy has no default-src 'self'");
  }
  // Exactly the fallback chain a browser applies: script-src-elem, then script-src, then default.
  const scriptSrc = directives.get('script-src-elem') ?? directives.get('script-src') ?? defaultSrc;
  if (scriptSrc.includes("'unsafe-inline'")) {
    throw new CheckFailed(6, "the effective script policy allows 'unsafe-inline'");
  }

  const hsts = headers.get('strict-transport-security');
  if (hsts === null) throw new CheckFailed(6, 'no Strict-Transport-Security');
  // `max-age=0` is a header that switches HSTS *off* while looking like it is present.
  const maxAge = Number(/max-age=(\d+)/u.exec(hsts)?.[1] ?? '0');
  if (maxAge <= 0) {
    throw new CheckFailed(6, `Strict-Transport-Security has max-age=${String(maxAge)}`);
  }
  if (headers.get('x-powered-by') !== null) {
    throw new CheckFailed(6, 'x-powered-by is present');
  }
  return 'CSP with no inline script, HSTS with a real max-age, no x-powered-by';
}

/** 7. Worker heartbeat < 3 min old. */
async function checkHeartbeat(base: string): Promise<string> {
  const body = asRecord(await json(`${base}/api/v1/sources/status`, 7), 7, 'the source status');
  const worker = body['worker'];
  if (worker === null || worker === undefined) {
    throw new CheckFailed(7, 'the status response carries no worker heartbeat');
  }
  const record = asRecord(worker, 7, 'the worker heartbeat');
  const lastSeen = record['lastSeenAt'];
  if (typeof lastSeen !== 'string') {
    throw new CheckFailed(7, 'the worker has never been seen');
  }
  const ageMs = Date.now() - new Date(lastSeen).getTime();
  if (!Number.isFinite(ageMs)) throw new CheckFailed(7, `unparseable heartbeat: ${lastSeen}`);
  if (ageMs > HEARTBEAT_BUDGET_MS) {
    throw new CheckFailed(
      7,
      `the worker was last seen ${String(Math.round(ageMs / 1000))} s ago, over the 3 minute budget`,
    );
  }
  return `worker seen ${String(Math.round(ageMs / 1000))} s ago`;
}

/** 8. An `as_of` request comes back flagged as a replay. */
async function checkReplayFlag(base: string, places: readonly string[]): Promise<string> {
  const asOf = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  for (const place of places) {
    const url = `${base}/api/v1/briefing?place=${encodeURIComponent(place)}&as_of=${encodeURIComponent(asOf)}`;
    const { response } = await get(url);
    if (response.status === 404) continue;
    if (response.status !== 200) {
      throw new CheckFailed(8, `replay for ${place} answered ${String(response.status)}`);
    }
    const body = asRecord(await response.json(), 8, 'a replayed briefing');
    const context = asRecord(body['asOfContext'] ?? {}, 8, 'the as-of context');
    if (context['isReplay'] !== true) {
      throw new CheckFailed(8, `a briefing asked for ${asOf} did not call itself a replay`);
    }
    return `replay of ${asOf} flagged for ${place}`;
  }
  throw new CheckFailed(8, 'no curated place resolved, so the replay flag could not be checked');
}

/** 9. The mobile viewport renders — the page is served and carries the viewport meta. */
async function checkMobile(base: string): Promise<string> {
  const { response } = await get(base, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    },
  });
  if (response.status !== 200) {
    throw new CheckFailed(9, `/ answered ${String(response.status)} to a mobile user agent`);
  }
  const html = await response.text();
  if (!/<meta[^>]+name=["']viewport["']/u.test(html)) {
    throw new CheckFailed(9, 'the page carries no viewport meta tag');
  }
  /*
   * A render check over HTTP can go no further than this: whether it *looks* right at 320 px is
   * what `apps/web/e2e/accessibility.spec.ts` asserts in a real browser. Claiming more here would
   * be a check that passes while the page is unusable.
   */
  return 'mobile user agent served a page with a viewport meta';
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    console.error(`✗ ${options}`);
    return 10;
  }
  const { baseUrl, places } = options;
  console.log(`smoke: ${baseUrl}`);

  try {
    console.log(`1. ${await checkHome(baseUrl)}`);
    console.log(`2. ${await checkSources(baseUrl)}`);
    console.log(`3. ${await checkBriefings(baseUrl, places)}`);
    for (const line of await checkEventAndEvidence(baseUrl, places)) console.log(line);
    console.log(`6. ${await checkHeaders(baseUrl)}`);
    console.log(`7. ${await checkHeartbeat(baseUrl)}`);
    console.log(`8. ${await checkReplayFlag(baseUrl, places)}`);
    console.log(`9. ${await checkMobile(baseUrl)}`);
  } catch (error) {
    if (error instanceof CheckFailed) {
      console.error(`✗ check ${String(error.check)}: ${error.message}`);
      return error.check;
    }
    console.error(
      `✗ could not reach ${baseUrl}: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    return 11;
  }

  console.log('✓ all nine checks passed');
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
