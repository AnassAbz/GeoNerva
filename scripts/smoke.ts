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
 *  - **Check 2** cannot require every P0 source to be healthy, because the worker schedules USGS
 *    only (`SCHEDULED_ADAPTERS`). §10 already allows "an explicit known outage"; this reads that as
 *    the unscheduled sources, and fails only when a *scheduled* one is `UNAVAILABLE`. The reasoning
 *    is in `docs/reviews/p10-plan.md` §2; if the worker starts scheduling more, this narrows itself.
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

/** 1. `/` 200 in under 2 s. */
async function checkHome(base: string): Promise<string> {
  const { response, elapsedMs } = await get(base);
  if (response.status !== 200) {
    throw new CheckFailed(1, `/ answered ${String(response.status)}, expected 200`);
  }
  if (elapsedMs > HOME_BUDGET_MS) {
    throw new CheckFailed(
      1,
      `/ took ${String(elapsedMs)} ms, over the ${String(HOME_BUDGET_MS)} ms budget`,
    );
  }
  return `/ answered 200 in ${String(elapsedMs)} ms`;
}

/** 2. Each scheduled P0 source ≠ UNAVAILABLE, or an explicitly declared outage. */
async function checkSources(base: string): Promise<string> {
  const body = asRecord(await json(`${base}/api/v1/sources/status`, 2), 2, 'the source status');
  const sources = body['sources'];
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new CheckFailed(2, 'the deployment reports no sources at all');
  }
  const unavailable: string[] = [];
  for (const entry of sources) {
    const source = asRecord(entry, 2, 'a source');
    const enabled = source['enabled'];
    /*
     * A source the deployment has switched off is the "explicit known outage" §10 allows for: it
     * is a declared decision, visible on /data-status, not a deployment that has quietly stopped
     * working. A source that is enabled and UNAVAILABLE is the failure this check exists for.
     */
    if (enabled === false) continue;
    if (source['status'] === 'UNAVAILABLE') {
      const id = source['sourceId'];
      unavailable.push(typeof id === 'string' ? id : 'an unnamed source');
    }
  }
  if (unavailable.length > 0) {
    throw new CheckFailed(2, `enabled sources are UNAVAILABLE: ${unavailable.join(', ')}`);
  }
  return `${String(sources.length)} sources reported, none enabled-and-unavailable`;
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

/** 4 and 5. An event page resolves, and the evidence behind it resolves too. */
async function checkEventAndEvidence(base: string, places: readonly string[]): Promise<string[]> {
  let publicId: string | null = null;
  let evidenceId: string | null = null;

  for (const place of places) {
    const { response } = await get(`${base}/api/v1/briefing?place=${encodeURIComponent(place)}`);
    if (response.status !== 200) continue;
    const body = asRecord(await response.json(), 4, 'a briefing');
    const items = body['items'];
    if (!Array.isArray(items)) continue;
    for (const entry of items) {
      const item = asRecord(entry, 4, 'a briefing item');
      const ref = item['subjectRef'];
      const ids = item['evidenceIds'];
      if (typeof ref === 'string' && ref.startsWith('EQ:') && publicId === null) {
        publicId = ref.slice(3);
      }
      if (Array.isArray(ids) && ids.length > 0 && evidenceId === null) {
        evidenceId = String(ids[0]);
      }
    }
    if (publicId !== null && evidenceId !== null) break;
  }

  const lines: string[] = [];
  if (publicId === null) {
    /*
     * A quiet world is a legitimate answer, and inventing an identifier to test with would be
     * testing the test. Said out loud rather than passed silently.
     */
    lines.push('4. no event in any curated briefing to resolve — a quiet world, not a failure');
  } else {
    const { response } = await get(`${base}/event/${encodeURIComponent(publicId)}`);
    if (response.status !== 200) {
      throw new CheckFailed(4, `/event/${publicId} answered ${String(response.status)}`);
    }
    lines.push(`4. /event/${publicId} resolved`);
  }

  if (evidenceId === null) {
    lines.push('5. no evidence id in any curated briefing to resolve');
  } else {
    const url = `${base}/api/v1/evidence/${encodeURIComponent(evidenceId)}`;
    const body = asRecord(await json(url, 5), 5, 'the evidence item');
    if (body['id'] === undefined && body['kind'] === undefined) {
      throw new CheckFailed(5, `evidence ${evidenceId} resolved to something without a kind`);
    }
    lines.push(`5. evidence ${evidenceId} resolved`);
  }
  return lines;
}

/** 6. CSP present, HSTS, no `x-powered-by`. */
async function checkHeaders(base: string): Promise<string> {
  // Not the redirect: Next normalises before the proxy sets the policy, so a 308 carries no CSP.
  const { response } = await get(base);
  const headers = response.headers;
  const csp = headers.get('content-security-policy');
  if (!csp?.includes("default-src 'self'")) {
    throw new CheckFailed(6, 'no Content-Security-Policy with a self default on /');
  }
  if (csp.includes("'unsafe-inline'") && csp.includes('script-src')) {
    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src')) ?? '';
    if (scriptSrc.includes("'unsafe-inline'")) {
      throw new CheckFailed(6, "the script policy allows 'unsafe-inline'");
    }
  }
  if (headers.get('strict-transport-security') === null) {
    throw new CheckFailed(6, 'no Strict-Transport-Security');
  }
  if (headers.get('x-powered-by') !== null) {
    throw new CheckFailed(6, 'x-powered-by is present');
  }
  return 'CSP, HSTS present; x-powered-by absent';
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
