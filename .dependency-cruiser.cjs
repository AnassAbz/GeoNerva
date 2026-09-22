/**
 * Architecture rules from docs/ARCHITECTURE.md §3 ("Dependency direction") and ADR-028.
 * CI fails on any violation. Changing these rules requires an ADR.
 */

const PURE_ENGINES = '^packages/(domain|geo|correlation|relevance|baselines|changes)/';
const TEST_FILES = '\\.(int\\.)?test\\.ts$';

// Entries are regular-expression alternatives: 'pg-[a-z-]+' covers pg-pool, pg-cursor, pg-native, …
const DATABASE_PACKAGES = ['pg', 'pg-[a-z-]+', 'postgres', 'kysely', '@supabase', '@neondatabase'];
const NETWORK_PACKAGES = ['undici', 'ws', 'axios', 'node-fetch', 'got', 'ky'];
const NETWORK_CORE_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram'];
const IO_PACKAGES = [
  ...DATABASE_PACKAGES,
  ...NETWORK_PACKAGES,
  'next',
  'react',
  'react-dom',
  'pino',
  'croner',
];
const IO_CORE_MODULES = [
  ...NETWORK_CORE_MODULES,
  'fs',
  'fs/promises',
  'dns',
  'dns/promises',
  'child_process',
  'worker_threads',
  'cluster',
  'module',
  'process',
  'os',
  'sqlite',
  'vm',
  'inspector',
  'v8',
];

/** @param {string[]} names */
function coreModule(names) {
  return `^(node:)?(${names.join('|')})$`;
}

/**
 * Matches npm modules as resolved by pnpm (node_modules/.pnpm/<name>@<version>/…, where a
 * scoped name is encoded as <scope>+<name>) and by flat installs (node_modules/<name>/…).
 * @param {string[]} names
 */
function npmModule(names) {
  return `node_modules/(\\.pnpm/)?(${names.join('|')})[@/+]`;
}

/** @param {string} pkg @param {string[]} allowed */
function onlyDependsOn(pkg, allowed) {
  const allowedPattern = allowed.length === 0 ? '(?!)' : `^packages/(${allowed.join('|')})/`;
  return {
    name: `${pkg}-allowed-internal-deps`,
    comment: `packages/${pkg} may only depend on: ${allowed.join(', ') || '(no internal packages)'}`,
    severity: 'error',
    from: { path: `^packages/${pkg}/` },
    to: {
      path: '^packages/',
      pathNot: [`^packages/${pkg}/`, allowedPattern, '^packages/test-fixtures/'],
    },
  };
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'Every import must resolve, so that no edge escapes these rules.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-test-fixtures-in-production-code',
      comment: 'Fixtures may only be imported from tests.',
      severity: 'error',
      from: {
        pathNot:
          '(\\.test\\.ts$|\\.int\\.test\\.ts$|/e2e/|^packages/test-fixtures/' +
          // The scenario seeder's whole job is to load a fixture into a disposable database,
          // and it is a developer command, never part of a shipped bundle. Named here so the
          // exception is reviewed rather than invisible (security review F-20).
          '|^scripts/seed-scenario\\.ts$)',
      },
      to: { path: '^packages/test-fixtures/' },
    },
    {
      name: 'no-test-harness-in-production-code',
      comment:
        'The integration-test database harness creates and truncates databases. Only tests may ' +
        'import it; production code reaching it would make the safety guard irrelevant.',
      severity: 'error',
      from: {
        pathNot:
          '(\\.test\\.ts$|\\.int\\.test\\.ts$|/e2e/|^packages/db/src/testing/' +
          // The storage-measurement script builds a disposable database on purpose; that is the
          // harness's whole job, and measuring against a real schema is the point of the script.
          '|^packages/db/src/estimate-storage\\.ts$' +
          // Same for the benchmark and the scenario seeder: both exist to build a throw-away
          // database, and both are developer commands (security review F-20).
          '|^scripts/(bench-api|seed-scenario)\\.ts$)',
      },
      to: { path: '^packages/db/src/testing/' },
    },
    {
      name: 'pure-engines-have-no-io',
      comment:
        'Pure engines must not import database, network, filesystem, process or framework modules.',
      severity: 'error',
      from: { path: PURE_ENGINES, pathNot: TEST_FILES },
      to: { path: `(${npmModule(IO_PACKAGES)}|${coreModule(IO_CORE_MODULES)})` },
    },
    {
      name: 'sql-only-in-db',
      comment: 'Only packages/db (and operational scripts) may talk to Postgres directly.',
      severity: 'error',
      from: { pathNot: '^(packages/db/|scripts/)' },
      to: { path: npmModule(DATABASE_PACKAGES) },
    },
    {
      name: 'raw-network-only-in-http',
      comment:
        'Raw network modules bypass the host allowlist, SSRF checks and size caps; only packages/http (and operational scripts) may use them (ADR-028).',
      severity: 'error',
      from: { pathNot: '^(packages/http/|scripts/)' },
      to: { path: `(${npmModule(NETWORK_PACKAGES)}|${coreModule(NETWORK_CORE_MODULES)})` },
    },
    {
      name: 'outbound-http-importers',
      comment:
        'Only provider adapters, the ingestion pipeline and the geocoder may use the outbound HTTP client (ADR-028).',
      severity: 'error',
      from: { pathNot: '^packages/(http|sources|pipeline|geocoding)/' },
      to: { path: '^packages/http/' },
    },
    {
      name: 'web-is-read-only',
      comment:
        'The web app never reaches provider adapters or ingestion, even transitively (ADR-001).',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^packages/(sources|pipeline)/', reachable: true },
    },
    {
      name: 'web-reads-facts-only-through-asof',
      comment:
        'G3 carry-over 1, enforced before the first endpoint exists. Every read of a provider ' +
        'fact goes through the as-of layer, which is the only place that applies the knowledge- ' +
        'time filter (ADR-003). A repository read would return the newest row instead of the row ' +
        'as of T, and replay would silently show the present. The P8 route handlers reach the ' +
        'as-of layer through `apps/web/lib/server/db.ts`, which imports the `/client` and ' +
        '`/asof` subpaths rather than the `@geonerva/db` root barrel — the barrel re-exports ' +
        'the repositories and makes all five of them reachable. Tests are excluded for the same ' +
        'reason `briefing-reads-facts-only-through-asof` excludes them: an integration test ' +
        'builds the state the read path then reads, and the only writers are the repositories. ' +
        'The exclusion was verified not to hide a production violation — reintroducing the ' +
        'root-barrel import in `db.ts` still fails this rule.',
      severity: 'error',
      from: { path: '^apps/web/', pathNot: TEST_FILES },
      to: { path: '^packages/db/src/repositories/', reachable: true },
    },
    {
      name: 'briefing-reads-facts-only-through-asof',
      comment:
        'P6 review finding. The `web-reads-facts-only-through-asof` rule is enforced from ' +
        '`apps/web`, so it stays vacuously green until the first route handler imports a ' +
        'service — and `packages/briefing` had already made every repository reachable by ' +
        'importing the `@geonerva/db` root barrel. A repository read returns the newest row ' +
        'rather than the row as of T, so a replay would silently show the present. Briefing ' +
        'imports `@geonerva/db/asof`, which is what that subpath exists for. Tests may reach ' +
        'repositories: they are building the state the read path then reads.',
      severity: 'error',
      from: { path: '^packages/briefing/', pathNot: TEST_FILES },
      to: { path: '^packages/db/src/repositories/', reachable: true },
    },
    {
      name: 'worker-does-not-import-web',
      severity: 'error',
      from: { path: '^apps/worker/' },
      to: { path: '^apps/web/' },
    },
    {
      name: 'packages-do-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    onlyDependsOn('domain', []),
    onlyDependsOn('geo', ['domain']),
    onlyDependsOn('config', []),
    onlyDependsOn('http', ['config']),
    onlyDependsOn('correlation', ['domain', 'geo']),
    onlyDependsOn('relevance', ['domain', 'geo']),
    onlyDependsOn('baselines', ['domain', 'geo']),
    onlyDependsOn('changes', ['domain', 'geo']),
    onlyDependsOn('sources', ['domain', 'geo', 'http', 'config']),
    onlyDependsOn('geocoding', ['domain', 'geo', 'http', 'config']),
    onlyDependsOn('db', ['domain', 'config']),
    onlyDependsOn('briefing', [
      'domain',
      'geo',
      'db',
      'relevance',
      'baselines',
      'changes',
      // Agreement is computed from an event's members at the snapshot's knowledge time, by the
      // same calibrated rule correlation uses. Reimplementing it here, or reading the "now"
      // projection cache during a replay, are both worse (ADR-036).
      'correlation',
      'config',
    ]),
    onlyDependsOn('pipeline', [
      'domain',
      'geo',
      'sources',
      'db',
      'correlation',
      'briefing',
      'http',
      'config',
    ]),
    onlyDependsOn('ai', ['domain', 'briefing', 'config']),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // node_modules is handled by doNotFollow; excluding it would also drop npm dependency edges.
    // next-env.d.ts is generated by Next.js and gitignored.
    exclude: { path: '((^|/)(\\.next|dist|coverage)/|(^|/)next-env\\.d\\.ts$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
