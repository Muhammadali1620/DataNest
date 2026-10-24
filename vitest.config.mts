import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

// Tests live only in test/ (ARCHITECTURE.md §11). Integration tests have their own config.
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
        'webview/src/apps/*/main.ts',
        'scripts/build.mjs',
        'scripts/build-e2e.mjs',
      ],
      reporter: ['text', 'html'],
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
