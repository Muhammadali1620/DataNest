// A million rows through the SQLite driver of the production build: the worker reads
// them and hands them over in batches, as when a query runs with the largest row limit.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteDriver } from '../../src/drivers/sqlite';
import type { ResultRow } from '../../src/services/result-store';
import { record, round, settledHeap, timed } from '../helpers/perf';
import { ROOT } from '../helpers/repo';
import { SQLITE_MILLION } from './budgets';

const COUNT = 1_000_000;

const QUERY = `
  WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < ${COUNT})
  SELECT v AS id, 'customer ' || v AS name, v * 1.5 AS amount,
         '2024-01-01 10:00:00' AS created_at, 'user' || (v % 5000) || '@example.com' AS email
  FROM n`;

describe('sqlite driver', () => {
  it('reads a million rows', async () => {
    const driver = createSqliteDriver({
      workerPath: join(ROOT, 'dist', 'drivers', 'sqlite-worker.js'),
    });
    const session = await driver.openSession({
      id: 'perf',
      name: 'perf',
      driver: 'sqlite',
      file: ':memory:',
    });
    try {
      const before = settledHeap();
      const rows: ResultRow[] = [];
      const { ms } = await timed(async () => {
        for await (const event of session.execute(QUERY, { rowLimit: COUNT })) {
          if (event.kind === 'rows') {
            for (const row of event.rows) {
              rows.push(row);
            }
          }
        }
      });
      expect(rows).toHaveLength(COUNT);
      record({
        name: 'SQLite: read a million rows',
        value: round(ms),
        unit: 'ms',
        budget: SQLITE_MILLION.readMs,
      });
      record({
        name: 'SQLite: heap per row (5 columns)',
        value: round((settledHeap() - before) / COUNT),
        unit: 'B',
        budget: SQLITE_MILLION.heapBytesPerRow,
      });
    } finally {
      await session.close();
    }
  });
});
