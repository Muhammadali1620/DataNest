// @ts-check
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createE2eBuildOptions, E2E_OUT_DIR } from './build-config.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
rmSync(join(rootDir, E2E_OUT_DIR), { recursive: true, force: true });
await build(createE2eBuildOptions({ rootDir }));
