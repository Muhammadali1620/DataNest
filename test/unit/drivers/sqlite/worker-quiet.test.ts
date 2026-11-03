// The SQLite worker starts without node:sqlite's "ExperimentalWarning" (V14.1): the editor logs
// anything a worker prints to stderr as an error of the extension, and the user cannot act on it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqliteDriver } from '../../../../src/drivers/sqlite';
import { buildSqliteWorker, type BuiltWorker } from '../../../helpers/sqlite-worker';
import { firstColumn, runAll } from '../../../helpers/driver-run';

describe('sqlite worker output', () => {
  let worker: BuiltWorker;
  let dir: string;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-sqlite-quiet-'));
  });

  afterAll(() => {
    worker.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('prints no warning while it opens a file and answers a query', async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      const driver = createSqliteDriver({ workerPath: worker.workerPath });
      const session = await driver.openSession({
        id: 'quiet',
        name: 'quiet',
        driver: 'sqlite',
        file: join(dir, 'quiet.db'),
      });
      expect(firstColumn(await runAll(session, 'SELECT 41 + 1 AS answer'))).toEqual([42]);
      // The worker's stderr reaches this thread through a stream; give it a moment.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await session.close();
    } finally {
      process.stderr.write = original;
    }
    expect(written.join('')).not.toMatch(/ExperimentalWarning|experimental feature/);
  });
});
