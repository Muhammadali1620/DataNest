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
  findE2eTests,
  findDriverEntries,
  findWebviewApps,
  NODE_TARGET,
  WEBVIEW_OUT_DIR,
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
