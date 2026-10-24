import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listFiles, PackageManager } from '@vscode/vsce';
import { createTempDir, ROOT } from '../../helpers/repo';
import { encodePng, render } from '../../../scripts/make-icon.mjs';

// Applies the real .vscodeignore to a fake project tree, so the result does not
// depend on whether dist/ is built right now.
const FAKE_FILES = [
  'dist/extension.js',
  'dist/extension.js.map',
  'dist/drivers/mysql.js',
  'dist/webview/ping.js',
  'dist/webview/ping.css',
  'dist/webview/ping.js.map',
  'resources/activity-bar.svg',
  'l10n/bundle.l10n.ru.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'ROADMAP.md',
  'ARCHITECTURE.md',
  'CLAUDE.md',
  'src/extension.ts',
  'webview/src/apps/ping/App.svelte',
  'test/unit/extension.test.ts',
  'scripts/build.mjs',
  'out/test/e2e/extension.test.js',
  'coverage/index.html',
  '.vscode-test/vscode-linux-x64-1.90.0/code',
  'node_modules/esbuild/package.json',
  'tsconfig.json',
  'eslint.config.mjs',
  '.env',
  'datanest-0.0.1.vsix',
];

describe('.vsix contents', () => {
  const tmp = createTempDir();
  let packed: string[] = [];

  beforeAll(async () => {
    for (const file of [
      'package.json',
      'package.nls.json',
      'package.nls.ru.json',
      '.vscodeignore',
    ]) {
      copyFileSync(join(ROOT, file), join(tmp.path, file));
    }
    for (const file of FAKE_FILES) {
      mkdirSync(dirname(join(tmp.path, file)), { recursive: true });
      writeFileSync(join(tmp.path, file), 'x');
    }
    packed = (await listFiles({ cwd: tmp.path, packageManager: PackageManager.None })).sort();
  });

  afterAll(() => {
    tmp.dispose();
  });

  it('contains exactly the runtime files', () => {
    expect(packed).toEqual(
      [
        'CHANGELOG.md',
        'LICENSE',
        'README.md',
        'dist/drivers/mysql.js',
        'dist/extension.js',
        'dist/webview/ping.css',
        'dist/webview/ping.js',
        'l10n/bundle.l10n.ru.json',
        'package.json',
        'package.nls.json',
        'package.nls.ru.json',
        'resources/activity-bar.svg',
      ].sort(),
    );
  });

  it('never ships sources, tests, source maps, secrets or dev docs', () => {
    const forbidden =
      /(^(src|webview|test|scripts|out|coverage|node_modules|\.vscode-test)\/)|\.map$|\.ts$|^\.env|^(ROADMAP|ARCHITECTURE|CLAUDE)\.md$|\.vsix$/;
    expect(packed.filter((file) => forbidden.test(file))).toEqual([]);
  });
});

describe('icon', () => {
  it('is a real 128×128 PNG, so the Marketplace accepts it', () => {
    const bytes = readFileSync(join(ROOT, 'resources/icon.png'));
    // PNG signature, then IHDR with the size in big-endian.
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16)).toBe(128);
    expect(bytes.readUInt32BE(20)).toBe(128);
  });

  it('can be regenerated from the script that drew it', () => {
    const generated = encodePng(render());
    const stored = readFileSync(join(ROOT, 'resources/icon.png'));
    expect(generated.equals(stored)).toBe(true);
  });
});
