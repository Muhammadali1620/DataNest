import { svelte } from '@sveltejs/vite-plugin-svelte';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { findWebviewApps, WEBVIEW_OUT_DIR } from '../scripts/build-config.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const production = mode === 'production';
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: './',
    plugins: [svelte()],
    build: {
      outDir: join(rootDir, WEBVIEW_OUT_DIR),
      emptyOutDir: true,
      // VS Code 1.90 runs webviews in Chromium 122.
      target: 'chrome122',
      sourcemap: !production,
      minify: production,
      // The polyfill would add a script without our CSP nonce.
      modulePreload: false,
      rollupOptions: {
        input: findWebviewApps(rootDir),
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  };
});
