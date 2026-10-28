// @ts-check
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createE2eBuildOptions, E2E_OUT_DIR, E2E_WORKSPACE_DIR } from './build-config.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
rmSync(join(rootDir, E2E_OUT_DIR), { recursive: true, force: true });
rmSync(join(rootDir, E2E_WORKSPACE_DIR), { recursive: true, force: true });
mkdirSync(join(rootDir, E2E_WORKSPACE_DIR), { recursive: true });
await build(createE2eBuildOptions({ rootDir }));
