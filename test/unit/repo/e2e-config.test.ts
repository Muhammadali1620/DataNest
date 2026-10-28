import { describe, expect, it } from 'vitest';
import { E2E_OUT_DIR, E2E_WORKSPACE_DIR } from '../../../scripts/build-config.mjs';
import config from '../../../.vscode-test.mjs';
import { readJson } from '../../helpers/repo';

interface TestConfig {
  files: string;
  version: string;
  launchArgs: string[];
  workspaceFolder?: string;
}

const manifest = readJson('package.json') as { engines: { vscode: string } };
const e2e = config as unknown as TestConfig;

describe('.vscode-test.mjs', () => {
  it('runs the compiled e2e tests', () => {
    expect(e2e.files.startsWith(`${E2E_OUT_DIR}/`)).toBe(true);
    expect(e2e.files.endsWith('.test.js')).toBe(true);
  });

  it('tests against the oldest supported VS Code', () => {
    expect(manifest.engines.vscode).toBe(`^${e2e.version}`);
  });

  it('opens a scratch folder under out/, which the e2e build empties first', () => {
    expect(e2e.workspaceFolder).toBe(E2E_WORKSPACE_DIR);
    expect(E2E_WORKSPACE_DIR.startsWith('out/')).toBe(true);
  });

  it('isolates the test host from other installed extensions', () => {
    expect(e2e.launchArgs).toContain('--disable-extensions');
  });
});
