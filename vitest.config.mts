import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

// Tests live only in test/ (ARCHITECTURE.md §11). Integration tests have their own config.

/** Executing statements, editing rows, dumps and files: what must never lose its tests. */
const CRITICAL_PATHS = `{${[
  'src/core/sql/{split,script-reader,variables}.ts',
  'src/shared/{merge-sort,cell-search,cell-input}.ts',
  'src/services/{query-runner,result-store,connection-manager,managed-session,transactions,manual-commit,safe-mode,write-policy,session-setup,query-variables}.ts',
  'src/services/{pending-edits,change-sql,result-editor,result-saver,result-editability}.ts',
  'src/services/{sql-dump,dump-script,script-runner,file-sink,text-file,sql-literal,stream-export}.ts',
  'src/services/import/table-import.ts',
].join(',')}}`;

export default defineConfig({
  test: {
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/**/*.mjs', 'webview/src/**/*.{ts,svelte}'],
      // Code that needs the vscode runtime and thin entry points are covered by e2e tests and real builds.
      exclude: [
        'src/extension.ts',
        'src/vscode/commands.ts',
        'src/vscode/logging.ts',
        'src/vscode/panels/webview-panel.ts',
        'src/vscode/panels/ping-panel.ts',
        'webview/src/apps/*/main.ts',
        'scripts/build.mjs',
        'scripts/build-e2e.mjs',
      ],
      reporter: ['text', 'html'],
      // The critical paths (V9.5): running statements, editing rows, dumps and files.
      // Each file must keep this coverage; `npm run test:coverage` (CI) fails below it.
      // Lower a number only with the reason in ROADMAP.md.
      thresholds: {
        [CRITICAL_PATHS]: { perFile: true, lines: 95, functions: 85, branches: 90 },
        // Typed-array reads end in `?? 0` for an index that is always in range, a branch
        // no test can take (`!` is forbidden by the linter).
        'src/shared/cell-compare.ts': { perFile: true, lines: 95, functions: 95, branches: 75 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'host',
          include: ['test/unit/**/*.test.ts'],
          exclude: ['test/unit/webview/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        plugins: [svelte(), svelteTesting()],
        test: {
          name: 'webview',
          include: ['test/unit/webview/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
