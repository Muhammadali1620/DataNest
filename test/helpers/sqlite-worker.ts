// Builds the SQLite worker bundle for tests. In the packaged extension the worker
// ships as dist/drivers/sqlite-worker.js; tests build the same bundle on the fly.

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_SOURCE = fileURLToPath(new URL('../../src/drivers/sqlite/worker.ts', import.meta.url));

export interface BuiltWorker {
  readonly workerPath: string;
  dispose(): void;
}

export async function buildSqliteWorker(): Promise<BuiltWorker> {
  const dir = mkdtempSync(join(tmpdir(), 'datanest-sqlite-worker-'));
  const workerPath = join(dir, 'sqlite-worker.js');
  await build({
    entryPoints: [WORKER_SOURCE],
    outfile: workerPath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  return {
    workerPath,
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
