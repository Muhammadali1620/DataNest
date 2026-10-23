import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { findWebviewApps } from '../../../scripts/build-config.mjs';
import { createTempDir, ROOT } from '../../helpers/repo';

// Builds the real webview apps into a temp folder and checks what panels rely on.
describe('webview build', () => {
  const tmp = createTempDir();
  const apps = Object.keys(findWebviewApps(ROOT));

  beforeAll(async () => {
    await build({
      configFile: join(ROOT, 'webview/vite.config.mts'),
      mode: 'production',
      logLevel: 'silent',
      build: { outDir: tmp.path },
    });
  }, 60_000);

  afterAll(() => {
    tmp.dispose();
  });

  it('has at least the ping app', () => {
    expect(apps).toContain('ping');
  });

  it('emits <app>.js and <app>.css with fixed names for every app', () => {
    const files = readdirSync(tmp.path);
    for (const app of apps) {
      expect(files).toContain(`${app}.js`);
      expect(files).toContain(`${app}.css`);
    }
  });

  it('emits no HTML and no source maps in production', () => {
    const files = readdirSync(tmp.path, { recursive: true }).map(String);
    expect(files.filter((file) => file.endsWith('.html'))).toEqual([]);
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
  });

  it('produces code that does not need eval (CSP forbids it)', () => {
    for (const app of apps) {
      const code = readFileSync(join(tmp.path, `${app}.js`), 'utf8');
      expect(code).not.toMatch(/\beval\(/);
      expect(code).not.toMatch(/new Function\(/);
    }
  });

  it('loads nothing from the network', () => {
    for (const app of apps) {
      const css = readFileSync(join(tmp.path, `${app}.css`), 'utf8');
      expect(css).not.toMatch(/url\(\s*['"]?https?:/);
      expect(css).not.toMatch(/@import\s+['"]?https?:/);
    }
  });
});
