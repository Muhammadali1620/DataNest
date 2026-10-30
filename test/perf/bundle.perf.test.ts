// The production build: how big the bundles are and how long the extension bundle takes
// to load. Run by `npm run test:perf`, which builds dist/ in production mode first.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { median, record, round } from '../helpers/perf';
import { ROOT } from '../helpers/repo';
import { BUNDLE_KB, EXTENSION_LOAD_MS } from './budgets';

const DIST = join(ROOT, 'dist');

function kilobytes(path: string): number {
  return round(statSync(path).size / 1024);
}

/** The largest .js file of a folder, by name and size. */
function largest(dir: string): { name: string; kb: number } {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, kb: kilobytes(join(dir, name)) }));
  expect(files.length).toBeGreaterThan(0);
  return files.reduce((big, file) => (file.kb > big.kb ? file : big));
}

// A stand-in for the editor's `vscode` module: any name is a value that can be called,
// constructed and read further, so the bundle's top level runs as it would in VS Code.
// The bundle copies the module's properties through its prototype, hence Object.create.
const VSCODE_STUB = `
const Module = require('node:module');
const anything = new Proxy(function () {}, {
  get: (_target, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : anything),
  apply: () => anything,
  construct: () => anything,
});
const vscode = Object.create(anything);
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};
`;

describe('production build', () => {
  let stubDir: string;

  beforeAll(() => {
    if (!existsSync(join(DIST, 'extension.js'))) {
      throw new Error('dist/ is missing: run the perf tests with npm run test:perf');
    }
    stubDir = mkdtempSync(join(tmpdir(), 'datanest-perf-'));
    writeFileSync(join(stubDir, 'vscode-stub.cjs'), VSCODE_STUB);
  });

  afterAll(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('keeps the extension bundle small', () => {
    record({
      name: 'dist/extension.js',
      value: kilobytes(join(DIST, 'extension.js')),
      unit: 'KB',
      budget: BUNDLE_KB.extension,
    });
  });

  it('keeps every driver bundle within its budget', () => {
    const { name, kb } = largest(join(DIST, 'drivers'));
    record({ name: `largest driver (${name})`, value: kb, unit: 'KB', budget: BUNDLE_KB.driver });
  });

  it('keeps every webview app script within its budget', () => {
    const { name, kb } = largest(join(DIST, 'webview'));
    record({
      name: `largest webview app (${name})`,
      value: kb,
      unit: 'KB',
      budget: BUNDLE_KB.webviewApp,
    });
  });

  it('loads the extension bundle quickly', () => {
    // A fresh Node each time: a module loads only once per process.
    const script = `
      const started = performance.now();
      require(${JSON.stringify(join(DIST, 'extension.js'))});
      process.stdout.write(String(performance.now() - started));
    `;
    const runs = Array.from({ length: 5 }, () =>
      Number(
        execFileSync(
          process.execPath,
          ['--require', join(stubDir, 'vscode-stub.cjs'), '-e', script],
          { encoding: 'utf8' },
        ),
      ),
    );
    expect(runs.every((ms) => Number.isFinite(ms) && ms > 0)).toBe(true);
    record({
      name: 'load dist/extension.js (median of 5)',
      value: round(median(runs)),
      unit: 'ms',
      budget: EXTENSION_LOAD_MS,
    });
  });
});
