// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { boundaryConfigs } from './scripts/lint/boundaries.mjs';

export default defineConfig(
  {
    ignores: ['dist/', 'out/', 'coverage/', '.vscode-test/', 'test/fixtures/'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Host code and webview code have different libs (Node vs DOM), hence two projects.
        project: ['./tsconfig.json', './webview/tsconfig.json', './test/e2e/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // ARCHITECTURE.md §10
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports only.',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'prefer-const': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    files: ['webview/**/*.{ts,svelte}', 'test/unit/webview/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    // Tool configs must use a default export.
    files: ['*.config.mjs', '*.config.mts', 'webview/*.config.mts', '.vscode-test.mjs'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // JS files are typed with JSDoc, which this rule does not see.
    files: ['**/*.mjs'],
    rules: { 'no-console': 'off', '@typescript-eslint/explicit-module-boundary-types': 'off' },
  },
  {
    files: ['test/e2e/**/*.ts'],
    languageOptions: { globals: globals.mocha },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  ...boundaryConfigs,
  prettier,
  svelte.configs['flat/prettier'],
);
