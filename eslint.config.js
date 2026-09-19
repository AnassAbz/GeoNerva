// @ts-check
import js from '@eslint/js';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Browser-exposed environment variables. Next.js inlines every statically referenced
 * NEXT_PUBLIC_* value into public client bundles, so they are denied by default: a name must
 * be added here, after security review, before it can be referenced anywhere
 * (docs/SECURITY.md C2). Never add anything secret-bearing.
 */
const PUBLIC_ENV_ALLOWLIST = /** @type {string[]} */ ([]);

const publicEnvPattern =
  PUBLIC_ENV_ALLOWLIST.length === 0
    ? '/^NEXT_PUBLIC_/'
    : `/^NEXT_PUBLIC_(?!(${PUBLIC_ENV_ALLOWLIST.map((n) => n.replace(/^NEXT_PUBLIC_/, '')).join('|')})$)/`;
const PUBLIC_ENV_MESSAGE =
  'NEXT_PUBLIC_* variables are inlined into public bundles and are denied unless allowlisted in eslint.config.js after security review.';
const HTML_SINK_MESSAGE =
  'Raw HTML sinks are forbidden: provider text is untrusted (docs/SECURITY.md H1). Render text through React.';

/** Syntax banned in all code. Every entry has a regression test in scripts/lint-rules.test.ts. */
const RESTRICTED_SYNTAX = [
  // NEXT_PUBLIC_* in every syntactic form: dot/bracket access, destructuring, strings, templates.
  { selector: `Identifier[name=${publicEnvPattern}]`, message: PUBLIC_ENV_MESSAGE },
  { selector: `Literal[value=${publicEnvPattern}]`, message: PUBLIC_ENV_MESSAGE },
  { selector: `TemplateElement[value.raw=/NEXT_PUBLIC_/]`, message: PUBLIC_ENV_MESSAGE },
  // HTML injection sinks, including forms that bypass react/no-danger.
  { selector: "Property[key.name='dangerouslySetInnerHTML']", message: HTML_SINK_MESSAGE },
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: HTML_SINK_MESSAGE },
  { selector: "Property[key.value='dangerouslySetInnerHTML']", message: HTML_SINK_MESSAGE },
  {
    selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
    message: HTML_SINK_MESSAGE,
  },
  {
    selector: 'MemberExpression[property.value=/^(innerHTML|outerHTML)$/]',
    message: HTML_SINK_MESSAGE,
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: HTML_SINK_MESSAGE,
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(write|writeln)$/][callee.object.name='document']",
    message: HTML_SINK_MESSAGE,
  },
  {
    selector: "CallExpression[callee.property.name='createContextualFragment']",
    message: HTML_SINK_MESSAGE,
  },
];

/** Outbound network calls are only allowed through @geonerva/http (docs/SECURITY.md M1, ADR-028). */
const NO_DIRECT_NETWORK_GLOBALS = [
  { name: 'fetch', message: 'Use @geonerva/http: host allowlist, timeouts and size caps.' },
  { name: 'XMLHttpRequest', message: 'Use @geonerva/http.' },
  { name: 'WebSocket', message: 'Use @geonerva/http.' },
];

const WEB_FILES = ['apps/web/**/*.{ts,tsx,js,jsx,mjs,cjs}'];
const PURE_ENGINE_FILES = [
  'packages/{domain,geo,correlation,relevance,baselines,changes}/src/**/*.{ts,mts,js,mjs}',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/next-env.d.ts',
      'packages/test-fixtures/sources/**',
      '.claude/**',
    ],
  },

  // JSX files are linted too (they would otherwise be skipped entirely).
  { files: ['**/*.jsx'], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
      'no-restricted-globals': ['error', ...NO_DIRECT_NETWORK_GLOBALS],
    },
  },

  // Next.js rules (react, react-hooks, jsx-a11y, next) apply to the web app only.
  ...nextCoreWebVitals.map((config) => ({ ...config, files: WEB_FILES })),
  {
    files: WEB_FILES,
    settings: { next: { rootDir: 'apps/web/' } },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'react/no-danger': 'error',
      // Browser code may call GeoNerva's own same-origin API; server code may not fetch at all.
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['apps/web/app/api/**/*.{ts,js,mjs}', 'apps/web/lib/server/**/*.{ts,js,mjs}'],
    rules: { 'no-restricted-globals': ['error', ...NO_DIRECT_NETWORK_GLOBALS] },
  },
  {
    // `env` in next.config inlines variables into bundles regardless of their prefix.
    files: ['apps/web/next.config.{ts,mjs,js}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...RESTRICTED_SYNTAX,
        {
          selector: "Property[key.name='env']",
          message: 'next.config `env` inlines values into client bundles (docs/SECURITY.md C2).',
        },
      ],
    },
  },

  // Pure engines: no ambient IO or environment access (ARCHITECTURE §3, rule 1).
  {
    files: PURE_ENGINE_FILES,
    rules: {
      'no-restricted-globals': [
        'error',
        ...NO_DIRECT_NETWORK_GLOBALS,
        { name: 'process', message: 'Pure engines receive configuration as arguments.' },
      ],
    },
  },

  // The hardened HTTP client is the one place that wraps the network primitives.
  { files: ['packages/http/src/**/*.ts'], rules: { 'no-restricted-globals': 'off' } },

  // Tests may use non-null assertions on fixtures they control.
  {
    files: ['**/*.test.ts', '**/*.int.test.ts', '**/e2e/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },

  // Operational scripts print to the console and may call providers directly (fixture capture).
  {
    files: ['scripts/**/*.{ts,mjs}', 'apps/worker/src/main.ts', 'apps/worker/src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  { files: ['scripts/**/*.{ts,mjs}'], rules: { 'no-restricted-globals': 'off' } },

  // The rule definitions and their regression tests necessarily spell out the banned names.
  {
    files: ['eslint.config.js', 'scripts/lint-rules.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // Plain JS/CJS config files are not part of any TypeScript project.
  {
    files: ['**/*.{js,cjs,mjs,jsx}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
);
