// @ts-check
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The oldest supported editor and what it runs on (measured in V0.12, see
 * docs/research/v0.12-sqlite-engine.md). package.json engines, build targets and the
 * e2e VS Code version are all derived from or checked against this.
 */
export const MIN_EDITOR = {
  vscode: '1.105.0',
  electron: '37.6.0',
  node: '22.19.0',
  chromium: '138',
};

/** Extension host code runs on the Node of the oldest supported editor. */
export const NODE_TARGET = `node${MIN_EDITOR.node.split('.')[0]}`;

/** Webviews run in the Chromium of the oldest supported editor. */
export const WEBVIEW_TARGET = `chrome${MIN_EDITOR.chromium}`;

/** Modules provided by the editor at runtime and never bundled. */
export const EXTERNALS = ['vscode'];

/**
 * Each driver lives in src/drivers/<id>/index.ts and is bundled separately to
 * dist/drivers/<id>.js, so it is loaded only on the first connection to that DBMS.
 * A driver may also ship a worker (src/drivers/<id>/worker.ts), bundled next to it
 * as dist/drivers/<id>-worker.js (e.g. the SQLite worker, D5).
 *
 * @param {string} rootDir project root
 * @returns {Record<string, string>} esbuild entry name → source path
 */
export function findDriverEntries(rootDir) {
  const driversDir = join(rootDir, 'src', 'drivers');
  if (!existsSync(driversDir)) {
    return {};
  }
  /** @type {Record<string, string>} */
  const entries = {};
  const dirs = readdirSync(driversDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const id of dirs) {
    const index = join(driversDir, id, 'index.ts');
    if (existsSync(index)) {
      entries[`drivers/${id}`] = index;
    }
    const worker = join(driversDir, id, 'worker.ts');
    if (existsSync(worker)) {
      entries[`drivers/${id}-worker`] = worker;
    }
  }
  return entries;
}

/**
 * Code that is large and needed only for one feature, bundled apart and loaded on
 * first use like a driver: sql-formatter (dist/formatter.js).
 *
 * @param {string} rootDir project root
 * @returns {Record<string, string>} esbuild entry name → source path
 */
export function findLazyEntries(rootDir) {
  const formatter = join(rootDir, 'src', 'services', 'formatter', 'index.ts');
  return existsSync(formatter) ? { formatter } : {};
}

/**
 * @param {{ rootDir: string; outDir?: string; production?: boolean }} options
 * @returns {import('esbuild').BuildOptions}
 */
export function createHostBuildOptions({ rootDir, outDir, production = false }) {
  return {
    absWorkingDir: rootDir,
    entryPoints: {
      extension: join(rootDir, 'src', 'extension.ts'),
      ...findDriverEntries(rootDir),
      ...findLazyEntries(rootDir),
    },
    outdir: outDir ?? join(rootDir, 'dist'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: NODE_TARGET,
    external: EXTERNALS,
    sourcemap: production ? false : 'linked',
    sourcesContent: false,
    minify: production,
    keepNames: true,
    logLevel: 'info',
    define: {
      'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
    },
  };
}

/** Webview bundles are written here; panels restrict localResourceRoots to this folder. */
export const WEBVIEW_OUT_DIR = 'dist/webview';

/**
 * Each webview app lives in webview/src/apps/<name>/main.ts and is built to
 * dist/webview/<name>.js (+ <name>.css), so the host can reference it by a fixed name.
 *
 * @param {string} rootDir project root
 * @returns {Record<string, string>} app name → entry path
 */
export function findWebviewApps(rootDir) {
  const appsDir = join(rootDir, 'webview', 'src', 'apps');
  if (!existsSync(appsDir)) {
    return {};
  }
  /** @type {Record<string, string>} */
  const apps = {};
  const dirs = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of dirs) {
    const main = join(appsDir, name, 'main.ts');
    if (existsSync(main)) {
      apps[name] = main;
    }
  }
  return apps;
}

/** Compiled e2e tests; @vscode/test-cli runs them inside VS Code. */
export const E2E_OUT_DIR = 'out/test/e2e';

/**
 * @param {string} dir
 * @param {string} prefix
 * @returns {string[]} files relative to `dir`, POSIX separators
 */
function listRecursive(dir, prefix = '') {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listRecursive(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

/**
 * @param {string} rootDir project root
 * @returns {Record<string, string>} output name (without .js) → test source path
 */
export function findE2eTests(rootDir) {
  const e2eDir = join(rootDir, 'test', 'e2e');
  /** @type {Record<string, string>} */
  const entries = {};
  for (const file of listRecursive(e2eDir).sort()) {
    if (file.endsWith('.test.ts')) {
      entries[file.slice(0, -'.ts'.length)] = join(e2eDir, file);
    }
  }
  return entries;
}

/**
 * Each e2e test file becomes a standalone CommonJS bundle; `vscode` and `mocha`
 * come from the test host at runtime.
 *
 * @param {{ rootDir: string; outDir?: string }} options
 * @returns {import('esbuild').BuildOptions}
 */
export function createE2eBuildOptions({ rootDir, outDir }) {
  return {
    absWorkingDir: rootDir,
    entryPoints: findE2eTests(rootDir),
    outdir: outDir ?? join(rootDir, E2E_OUT_DIR),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: NODE_TARGET,
    external: [...EXTERNALS, 'mocha'],
    sourcemap: 'inline',
    logLevel: 'warning',
  };
}
