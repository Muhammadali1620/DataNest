import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import {
  createE2eBuildOptions,
  createHostBuildOptions,
  E2E_OUT_DIR,
  EXTERNALS,
  NATIVE_OPTIONALS,
  nativeOptionalsPlugin,
  OPTIONAL_PEERS,
  optionalPeersPlugin,
  UNUSED_MODULES,
  unusedModulesPlugin,
  findE2eTests,
  findDriverEntries,
  findLazyEntries,
  findWebviewApps,
  MIN_EDITOR,
  NODE_TARGET,
  WEBVIEW_OUT_DIR,
  WEBVIEW_TARGET,
} from '../../../scripts/build-config.mjs';
import { createTempDir } from '../../helpers/repo';

function write(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

describe('build-config', () => {
  let tmp: ReturnType<typeof createTempDir>;

  beforeEach(() => {
    tmp = createTempDir();
  });

  afterEach(() => {
    tmp.dispose();
  });

  describe('MIN_EDITOR (D23)', () => {
    it('is VS Code 1.105 with the Node and Chromium it ships', () => {
      expect(MIN_EDITOR).toEqual({
        vscode: '1.105.0',
        electron: '37.6.0',
        node: '22.19.0',
        chromium: '138',
      });
    });

    it('derives the build targets from it', () => {
      expect(NODE_TARGET).toBe('node22');
      expect(WEBVIEW_TARGET).toBe('chrome138');
    });

    it('has Node with built-in node:sqlite (22.13+ without a flag)', () => {
      const [major = 0, minor = 0] = MIN_EDITOR.node.split('.').map(Number);
      expect(major > 22 || (major === 22 && minor >= 13)).toBe(true);
    });
  });

  describe('findDriverEntries', () => {
    it('returns nothing when src/drivers does not exist', () => {
      expect(findDriverEntries(tmp.path)).toEqual({});
    });

    it('returns nothing for an empty drivers folder', () => {
      mkdirSync(join(tmp.path, 'src', 'drivers'), { recursive: true });
      expect(findDriverEntries(tmp.path)).toEqual({});
    });

    it('finds one entry per driver folder with index.ts, sorted by id', () => {
      write(tmp.path, 'src/drivers/postgres/index.ts', '');
      write(tmp.path, 'src/drivers/mysql/index.ts', '');
      const entries = findDriverEntries(tmp.path);
      expect(Object.keys(entries)).toEqual(['drivers/mysql', 'drivers/postgres']);
      expect(entries['drivers/mysql']).toBe(join(tmp.path, 'src/drivers/mysql/index.ts'));
    });

    it('ignores folders without index.ts and loose files', () => {
      write(tmp.path, 'src/drivers/driver.ts', '');
      write(tmp.path, 'src/drivers/registry.ts', '');
      write(tmp.path, 'src/drivers/wip/session.ts', '');
      write(tmp.path, 'src/drivers/sqlite/index.ts', '');
      expect(Object.keys(findDriverEntries(tmp.path))).toEqual(['drivers/sqlite']);
    });

    it('bundles a driver worker as <id>-worker next to the driver', () => {
      write(tmp.path, 'src/drivers/sqlite/index.ts', '');
      write(tmp.path, 'src/drivers/sqlite/worker.ts', '');
      write(tmp.path, 'src/drivers/mysql/index.ts', '');
      const entries = findDriverEntries(tmp.path);
      expect(Object.keys(entries)).toEqual([
        'drivers/mysql',
        'drivers/sqlite',
        'drivers/sqlite-worker',
      ]);
      expect(entries['drivers/sqlite-worker']).toBe(join(tmp.path, 'src/drivers/sqlite/worker.ts'));
    });
  });

  describe('findWebviewApps', () => {
    it('returns nothing when webview/src/apps does not exist', () => {
      expect(findWebviewApps(tmp.path)).toEqual({});
    });

    it('finds one entry per app folder with main.ts, sorted by name', () => {
      write(tmp.path, 'webview/src/apps/result-grid/main.ts', '');
      write(tmp.path, 'webview/src/apps/connection-form/main.ts', '');
      const apps = findWebviewApps(tmp.path);
      expect(Object.keys(apps)).toEqual(['connection-form', 'result-grid']);
      expect(apps['result-grid']).toBe(join(tmp.path, 'webview/src/apps/result-grid/main.ts'));
    });

    it('ignores folders without main.ts and loose files', () => {
      write(tmp.path, 'webview/src/apps/readme.md', '');
      write(tmp.path, 'webview/src/apps/draft/App.svelte', '');
      write(tmp.path, 'webview/src/apps/ping/main.ts', '');
      expect(Object.keys(findWebviewApps(tmp.path))).toEqual(['ping']);
    });

    it('builds into dist/webview', () => {
      expect(WEBVIEW_OUT_DIR).toBe('dist/webview');
    });
  });

  describe('createHostBuildOptions', () => {
    it('bundles the extension as CommonJS for Node without the vscode module', () => {
      const options = createHostBuildOptions({ rootDir: tmp.path });
      expect(options.format).toBe('cjs');
      expect(options.platform).toBe('node');
      expect(options.bundle).toBe(true);
      expect(options.target).toBe(NODE_TARGET);
      expect(options.external).toEqual(EXTERNALS);
      expect(options.plugins).toEqual([
        nativeOptionalsPlugin,
        unusedModulesPlugin,
        optionalPeersPlugin,
      ]);
      expect(EXTERNALS).toContain('vscode');
      expect(options.entryPoints).toEqual({ extension: join(tmp.path, 'src', 'extension.ts') });
      expect(options.outdir).toBe(join(tmp.path, 'dist'));
    });

    it('produces linked source maps and readable code in development', () => {
      const options = createHostBuildOptions({ rootDir: tmp.path });
      expect(options.sourcemap).toBe('linked');
      expect(options.minify).toBe(false);
      expect(options.define?.['process.env.NODE_ENV']).toBe('"development"');
    });

    it('minifies without source maps in production', () => {
      const options = createHostBuildOptions({ rootDir: tmp.path, production: true });
      expect(options.sourcemap).toBe(false);
      expect(options.minify).toBe(true);
      expect(options.keepNames).toBe(true);
      expect(options.define?.['process.env.NODE_ENV']).toBe('"production"');
    });

    it('bundles the formatter apart, to load it on first use', () => {
      expect(findLazyEntries(tmp.path)).toEqual({});
      write(tmp.path, 'src/services/formatter/index.ts', '');
      expect(findLazyEntries(tmp.path)).toEqual({
        formatter: join(tmp.path, 'src', 'services', 'formatter', 'index.ts'),
      });
      expect(Object.keys(createHostBuildOptions({ rootDir: tmp.path }).entryPoints ?? {})).toEqual([
        'extension',
        'formatter',
      ]);
    });

    it('bundles ssh2 apart and leaves its native add-ons out', () => {
      write(tmp.path, 'src/services/ssh/index.ts', '');
      expect(findLazyEntries(tmp.path)).toEqual({
        ssh: join(tmp.path, 'src', 'services', 'ssh', 'index.ts'),
      });
      expect(NATIVE_OPTIONALS.test('cpu-features')).toBe(true);
      expect(NATIVE_OPTIONALS.test('./crypto/build/Release/sshcrypto.node')).toBe(true);
      expect(NATIVE_OPTIONALS.test('cpu-features-extra')).toBe(false);
      expect(NATIVE_OPTIONALS.test('node:crypto')).toBe(false);
    });

    it('leaves the Azure sign-in libraries of tedious out, and nothing else', () => {
      expect(UNUSED_MODULES.test('@azure/identity')).toBe(true);
      expect(UNUSED_MODULES.test('@azure/keyvault-keys')).toBe(true);
      expect(UNUSED_MODULES.test('@azure/core-auth')).toBe(false);
      expect(UNUSED_MODULES.test('@azure/identity-extra')).toBe(false);
    });

    it('makes a stub that loads but throws when used', async () => {
      write(tmp.path, 'entry.js', "module.exports = require('@azure/identity');");
      await build({
        entryPoints: [join(tmp.path, 'entry.js')],
        outfile: join(tmp.path, 'stubbed.js'),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        logLevel: 'silent',
        plugins: [unusedModulesPlugin],
      });
      const stub = createRequire(join(tmp.path, 'x.js'))('./stubbed.js') as Record<string, unknown>;
      expect(stub.__esModule).toBeUndefined();
      expect(() => stub.DefaultAzureCredential).toThrow(
        'DataNest does not ship "@azure/identity": DefaultAzureCredential',
      );
    });

    it('leaves the optional packages of the MongoDB driver out, and nothing else (V7.5)', () => {
      for (const name of [
        'kerberos',
        'snappy',
        'socks',
        'gcp-metadata',
        'mongodb-client-encryption',
        '@mongodb-js/zstd',
        '@aws-sdk/credential-providers',
      ]) {
        expect(OPTIONAL_PEERS.test(name)).toBe(true);
      }
      expect(OPTIONAL_PEERS.test('mongodb')).toBe(false);
      expect(OPTIONAL_PEERS.test('bson')).toBe(false);
      expect(OPTIONAL_PEERS.test('@mongodb-js/saslprep')).toBe(false);
      expect(OPTIONAL_PEERS.test('kerberos-extra')).toBe(false);
    });

    it('makes an optional package fail to load as if it were not installed', async () => {
      write(
        tmp.path,
        'entry.js',
        "let found; try { found = require('kerberos'); } catch (error) { found = error; } module.exports = found;",
      );
      await build({
        entryPoints: [join(tmp.path, 'entry.js')],
        outfile: join(tmp.path, 'peer.js'),
        bundle: true,
        format: 'cjs',
        platform: 'node',
        logLevel: 'silent',
        plugins: [optionalPeersPlugin],
      });
      const loaded = createRequire(join(tmp.path, 'x.js'))('./peer.js') as Error & {
        code?: string;
      };
      expect(loaded).toBeInstanceOf(Error);
      expect(loaded.code).toBe('MODULE_NOT_FOUND');
      expect(loaded.message).toContain("'kerberos'");
    });

    it('adds driver bundles as separate entry points', () => {
      write(tmp.path, 'src/drivers/mysql/index.ts', '');
      const options = createHostBuildOptions({ rootDir: tmp.path });
      expect(Object.keys(options.entryPoints ?? {})).toEqual(['extension', 'drivers/mysql']);
    });

    it('respects a custom output directory', () => {
      const outDir = join(tmp.path, 'out');
      expect(createHostBuildOptions({ rootDir: tmp.path, outDir }).outdir).toBe(outDir);
    });
  });

  describe('findE2eTests', () => {
    it('returns nothing when test/e2e does not exist', () => {
      expect(findE2eTests(tmp.path)).toEqual({});
    });

    it('finds *.test.ts files recursively, keeping subfolders in output names', () => {
      write(tmp.path, 'test/e2e/extension.test.ts', '');
      write(tmp.path, 'test/e2e/tree/connections.test.ts', '');
      const tests = findE2eTests(tmp.path);
      expect(Object.keys(tests)).toEqual(['extension.test', 'tree/connections.test']);
      expect(tests['tree/connections.test']).toBe(
        join(tmp.path, 'test/e2e/tree/connections.test.ts'),
      );
    });

    it('skips helpers and configs that are not tests', () => {
      write(tmp.path, 'test/e2e/tsconfig.json', '{}');
      write(tmp.path, 'test/e2e/helpers.ts', '');
      write(tmp.path, 'test/e2e/smoke.test.ts', '');
      expect(Object.keys(findE2eTests(tmp.path))).toEqual(['smoke.test']);
    });
  });

  describe('createE2eBuildOptions', () => {
    it('bundles each e2e test as CommonJS with vscode and mocha external', () => {
      write(tmp.path, 'test/e2e/smoke.test.ts', '');
      const options = createE2eBuildOptions({ rootDir: tmp.path });
      expect(options.format).toBe('cjs');
      expect(options.platform).toBe('node');
      expect(options.external).toEqual(['vscode', 'mocha']);
      expect(options.plugins).toEqual([
        nativeOptionalsPlugin,
        unusedModulesPlugin,
        optionalPeersPlugin,
      ]);
      expect(options.outdir).toBe(join(tmp.path, E2E_OUT_DIR));
      expect(Object.keys(options.entryPoints ?? {})).toEqual(['smoke.test']);
    });

    it('matches the files pattern in .vscode-test.mjs', () => {
      expect(E2E_OUT_DIR).toBe('out/test/e2e');
    });
  });

  describe('real build', () => {
    beforeEach(() => {
      write(
        tmp.path,
        'src/extension.ts',
        [
          "import * as vscode from 'vscode';",
          "import { shared } from './shared';",
          'export function activate(): string { return shared + String(vscode.version); }',
        ].join('\n'),
      );
      write(tmp.path, 'src/shared.ts', "export const shared = 'shared:';");
      write(tmp.path, 'src/drivers/fake/index.ts', "export const driverId: string = 'fake';");
    });

    it('keeps vscode external, inlines local modules and builds drivers separately', async () => {
      await build({ ...createHostBuildOptions({ rootDir: tmp.path }), logLevel: 'silent' });

      const host = readFileSync(join(tmp.path, 'dist/extension.js'), 'utf8');
      expect(host).toContain('require("vscode")');
      expect(host).toContain('shared:');
      expect(host).not.toContain("'fake'");
      expect(existsSync(join(tmp.path, 'dist/extension.js.map'))).toBe(true);

      const requireFromTmp = createRequire(join(tmp.path, 'index.js'));
      const driver = requireFromTmp('./dist/drivers/fake.js') as { driverId: string };
      expect(driver.driverId).toBe('fake');
    });

    it('leaves native add-ons out, so an optional require falls back to JS', async () => {
      write(
        tmp.path,
        'src/services/ssh/index.ts',
        [
          "let binding = 'js';",
          "try { binding = require('./crypto/build/Release/sshcrypto.node'); } catch {}",
          "try { binding = require('cpu-features')(); } catch {}",
          'export const loaded = binding;',
        ].join('\n'),
      );
      // Copies that Node could find at runtime must never be picked up.
      write(tmp.path, 'dist/crypto/build/Release/sshcrypto.node', 'not a binary');
      write(
        tmp.path,
        'node_modules/cpu-features/index.js',
        "module.exports = () => { throw new Error('native code loaded'); };",
      );
      await build({ ...createHostBuildOptions({ rootDir: tmp.path }), logLevel: 'silent' });

      const bundle = readFileSync(join(tmp.path, 'dist/ssh.js'), 'utf8');
      expect(bundle).toContain('is not shipped');
      expect(bundle).not.toMatch(/require\("(cpu-features|[^"]*\.node)"\)/);
      const requireFromTmp = createRequire(join(tmp.path, 'index.js'));
      const ssh = requireFromTmp('./dist/ssh.js') as { loaded: string };
      expect(ssh.loaded).toBe('js');
    });

    it('emits no source maps in production', async () => {
      await build({
        ...createHostBuildOptions({ rootDir: tmp.path, production: true }),
        logLevel: 'silent',
      });
      expect(existsSync(join(tmp.path, 'dist/extension.js'))).toBe(true);
      expect(existsSync(join(tmp.path, 'dist/extension.js.map'))).toBe(false);
    });

    it('fails on a type-free syntax error instead of emitting a broken bundle', async () => {
      write(tmp.path, 'src/extension.ts', 'export function activate( {');
      await expect(
        build({ ...createHostBuildOptions({ rootDir: tmp.path }), logLevel: 'silent' }),
      ).rejects.toThrow();
      expect(existsSync(join(tmp.path, 'dist/extension.js'))).toBe(false);
    });
  });
});
