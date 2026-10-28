import { defineConfig } from '@vscode/test-cli';
import { E2E_WORKSPACE_DIR, MIN_EDITOR } from './scripts/build-config.mjs';

// E2E smoke tests run in a real VS Code. The minimum supported version is used,
// so APIs newer than engines.vscode fail here first.
export default defineConfig({
  label: 'e2e',
  files: 'out/test/e2e/**/*.test.js',
  version: MIN_EDITOR.vscode,
  workspaceFolder: E2E_WORKSPACE_DIR,
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
  mocha: {
    ui: 'bdd',
    timeout: 20_000,
  },
});
