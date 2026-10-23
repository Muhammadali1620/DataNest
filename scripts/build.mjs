// @ts-check
import { build as esbuild, context } from 'esbuild';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { createHostBuildOptions } from './build-config.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');

// Start from an empty dist/ so removed drivers or apps never end up in the .vsix.
rmSync(join(rootDir, 'dist'), { recursive: true, force: true });

const hostOptions = createHostBuildOptions({ rootDir, production });

/** @type {import('vite').InlineConfig} */
const webviewConfig = {
  configFile: fileURLToPath(new URL('../webview/vite.config.mts', import.meta.url)),
  mode: production ? 'production' : 'development',
  logLevel: 'warn',
  build: watch ? { watch: {} } : {},
};

if (watch) {
  const ctx = await context(hostOptions);
  await Promise.all([ctx.watch(), viteBuild(webviewConfig)]);
} else {
  await Promise.all([esbuild(hostOptions), viteBuild(webviewConfig)]);
}
