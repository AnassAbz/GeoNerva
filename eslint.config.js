// @ts-check
import js from '@eslint/js';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const WEB_FILES = ['apps/web/**/*.{ts,tsx}'];

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
      'no-restricted-syntax': [
        'error',
        {
          // Secrets must never be exposed to the browser bundle (docs/SECURITY.md C2).
          selector:
            'MemberExpression[property.name=/^NEXT_PUBLIC_.*(SECRET|KEY|TOKEN|PASSWORD|DATABASE)/]',
          message: 'Secret-like values must never use the NEXT_PUBLIC_ prefix.',
        },
      ],
    },
  },

  // Next.js rules (react, react-hooks, jsx-a11y, next) apply to the web app only.
  ...nextCoreWebVitals.map((config) => ({ ...config, files: WEB_FILES })),
  {
    files: WEB_FILES,
    settings: { next: { rootDir: 'apps/web/' } },
    rules: {
      // Provider text is untrusted; never render raw HTML (docs/SECURITY.md H1).
      'react/no-danger': 'error',
    },
  },

  // Tests may use non-null assertions on fixtures they control.
  {
    files: ['**/*.test.ts', '**/*.int.test.ts', '**/e2e/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },

  // Operational scripts print to the console by design.
  {
    files: ['scripts/**/*.{ts,mjs}', 'apps/worker/src/main.ts', 'apps/worker/src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Plain JS/CJS config files are not part of any TypeScript project.
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
);
