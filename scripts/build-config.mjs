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
 * Optional native add-ons of bundled libraries: ssh2's crypto binding and
 * cpu-features. DataNest ships no native modules (D5), so each is replaced by a stub
 * that throws, and the library falls back to its pure JS code. Leaving them external
 * is not enough: from dist/ Node would find a copy in node_modules, built for another
 * Node, and loading it crashes the editor's extension host.
 */
export const NATIVE_OPTIONALS = /^cpu-features$|\.node$/;

/** @type {import('esbuild').Plugin} */
export const nativeOptionalsPlugin = {
  name: 'datanest-native-optionals',
  setup(build) {
    build.onResolve({ filter: NATIVE_OPTIONALS }, (args) => ({
      path: args.path,
      namespace: 'datanest-native-optional',
    }));
    build.onLoad({ filter: /.*/, namespace: 'datanest-native-optional' }, (args) => ({
      contents: `throw new Error(${JSON.stringify(`Native add-on "${args.path}" is not shipped`)});`,
      loader: 'js',
    }));
  },
};

/**
 * Modules a bundled library loads but uses only for features DataNest does not offer:
 * tedious signs in to Azure AD and reads Always Encrypted keys from Key Vault through
 * them, which would add megabytes to the SQL Server bundle. Each becomes a stub that
 * throws the moment anything is taken from it, so nothing can half-work.
 */
export const UNUSED_MODULES = /^@azure\/(identity|keyvault-keys)$/;

/** @type {import('esbuild').Plugin} */
export const unusedModulesPlugin = {
  name: 'datanest-unused-modules',
  setup(build) {
    build.onResolve({ filter: UNUSED_MODULES }, (args) => ({
      path: args.path,
      namespace: 'datanest-unused-module',
    }));
    build.onLoad({ filter: /.*/, namespace: 'datanest-unused-module' }, (args) => ({
      contents: `module.exports = new Proxy({}, { get(_target, name) {
  if (name === '__esModule' || typeof name === 'symbol') return undefined;
  throw new Error(${JSON.stringify(`DataNest does not ship "${args.path}"`)} + ': ' + String(name));
} });`,
      loader: 'js',
    }));
  },
};

/**
 * Optional packages the MongoDB driver tries to `require` for features DataNest does not
 * offer (Kerberos, AWS and GCP sign-in, wire compression, SOCKS proxies, client-side
 * encryption; V7.5). Each becomes a stub that throws on load, as if it were not
 * installed, which is what the driver expects of them; from dist/ Node could otherwise
 * find a copy in node_modules that the .vsix does not ship (D19, D50).
 */
export const OPTIONAL_PEERS =
  /^(kerberos|snappy|socks|gcp-metadata|mongodb-client-encryption|@mongodb-js\/zstd|@aws-sdk\/credential-providers)$/;

/** @type {import('esbuild').Plugin} */
export const optionalPeersPlugin = {
  name: 'datanest-optional-peers',
  setup(build) {
    build.onResolve({ filter: OPTIONAL_PEERS }, (args) => ({
      path: args.path,
      namespace: 'datanest-optional-peer',
    }));
    build.onLoad({ filter: /.*/, namespace: 'datanest-optional-peer' }, (args) => ({
      contents: `throw Object.assign(new Error(${JSON.stringify(`Cannot find module '${args.path}': DataNest does not ship it`)}), { code: 'MODULE_NOT_FOUND' });`,
      loader: 'js',
    }));
  },
};

/** Plugins of every Node bundle. */
export const HOST_PLUGINS = [nativeOptionalsPlugin, unusedModulesPlugin, optionalPeersPlugin];

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
 * first use like a driver: sql-formatter (dist/formatter.js) and ssh2 (dist/ssh.js).
 *
 * @param {string} rootDir project root
 * @returns {Record<string, string>} esbuild entry name → source path
 */
export function findLazyEntries(rootDir) {
  /** @type {Record<string, string>} */
  const entries = {};
  for (const name of ['formatter', 'ssh']) {
    const index = join(rootDir, 'src', 'services', name, 'index.ts');
    if (existsSync(index)) {
      entries[name] = index;
    }
  }
  return entries;
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
    plugins: HOST_PLUGINS,
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

/**
 * A page links only `<app>.css`, but Vite moves the CSS of modules shared by several
 * apps (base.css, controls.css, shared components) into files of their own, which no
 * page links — in the editor every page then ran without the shared styles. This
 * plugin gives each app one self-contained `<app>.css`: the CSS of the chunks it
 * imports, in import order, then its own; the shared files are dropped.
 *
 * @returns {import('vite').Plugin}
 */
export function selfContainedCssPlugin() {
  return {
    name: 'datanest-self-contained-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      /** @param {string} fileName @param {Set<string>} seen @param {string[]} order */
      const collect = (fileName, seen, order) => {
        const chunk = bundle[fileName];
        if (chunk?.type !== 'chunk' || seen.has(fileName)) {
          return;
        }
        seen.add(fileName);
        for (const imported of chunk.imports) {
          collect(imported, seen, order);
        }
        for (const css of chunk.viteMetadata?.importedCss ?? []) {
          if (!order.includes(css)) {
            order.push(css);
          }
        }
      };
      /** @param {string} fileName */
      const cssText = (fileName) => {
        const asset = bundle[fileName];
        return asset?.type === 'asset' ? String(asset.source) : '';
      };
      /** @type {Set<string>} */
      const shared = new Set();
      /** @type {Map<string, string>} */
      const merged = new Map();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) {
          continue;
        }
        /** @type {string[]} */
        const order = [];
        collect(chunk.fileName, new Set(), order);
        const own = `${chunk.name}.css`;
        for (const file of order) {
          if (file !== own) {
            shared.add(file);
          }
        }
        const parts = order.map(cssText).filter((text) => text.length > 0);
        merged.set(own, parts.join('\n'));
      }
      for (const file of shared) {
        Reflect.deleteProperty(bundle, file);
      }
      for (const [file, source] of merged) {
        const asset = bundle[file];
        if (asset?.type === 'asset') {
          asset.source = source;
        } else {
          this.emitFile({ type: 'asset', fileName: file, source });
        }
      }
    },
  };
}

/** Compiled e2e tests; @vscode/test-cli runs them inside VS Code. */
export const E2E_OUT_DIR = 'out/test/e2e';

/**
 * The folder the e2e editor opens, made empty before every run: tests that need a
 * workspace (project connections, V4.7) write their files there.
 */
export const E2E_WORKSPACE_DIR = 'out/e2e-workspace';

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
    plugins: HOST_PLUGINS,
    sourcemap: 'inline',
    logLevel: 'warning',
  };
}
