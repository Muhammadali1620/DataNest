// Paging a big table against real servers: the estimate that stands in for a slow
// COUNT(*), the exact count that replaces it, and page sizes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { QueryRunner } from '../../../src/services/query-runner';
import { ResultStore } from '../../../src/services/result-store';
import { TableViewer, tableDocumentUri } from '../../../src/services/table-view';
import type { ConnectionInput, DriverId } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

interface Target {
  readonly label: string;
  readonly driver: DriverId;
  readonly input: () => ConnectionInput;
  readonly password?: string;
  /** DDL that creates `paging_rows` with the same columns on every database. */
  readonly create: string;
  /** Fills the table with 150 000 rows and refreshes the server's statistics. */
  readonly fill: string;
  /** Whether the server keeps a row estimate that is shown instead of a COUNT(*). */
  readonly estimates: boolean;
  readonly drop: string;
}

function server(id: TestDatabaseId, driver: 'mysql' | 'postgres'): () => ConnectionInput {
  return () => {
    const db = testDatabase(id);
    return {
      name: id,
      driver,
      host: db.host,
      port: db.port,
      user: db.user,
      database: db.database,
    };
  };
}

describe('table view paging', () => {
  let worker: BuiltWorker;
  let dir: string;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-table-paging-'));
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const targets: Target[] = [
    {
      label: 'mysql',
      driver: 'mysql',
      input: server('mysql', 'mysql'),
      password: testDatabase('mysql').password,
      create: 'CREATE TABLE paging_rows (id INT AUTO_INCREMENT PRIMARY KEY, n INT)',
      fill: 'INSERT INTO paging_rows (n) SELECT 1 FROM information_schema.columns a CROSS JOIN information_schema.columns b LIMIT 150000; ANALYZE TABLE paging_rows',
      estimates: true,
      drop: 'DROP TABLE IF EXISTS paging_rows',
    },
    {
      label: 'mariadb',
      driver: 'mysql',
      input: server('mariadb', 'mysql'),
      password: testDatabase('mariadb').password,
      create: 'CREATE TABLE paging_rows (id INT AUTO_INCREMENT PRIMARY KEY, n INT)',
      fill: 'INSERT INTO paging_rows (n) SELECT 1 FROM information_schema.columns a CROSS JOIN information_schema.columns b LIMIT 150000; ANALYZE TABLE paging_rows',
      estimates: true,
      drop: 'DROP TABLE IF EXISTS paging_rows',
    },
    {
      label: 'postgres',
      driver: 'postgres',
      input: server('postgres', 'postgres'),
      password: testDatabase('postgres').password,
      create: 'CREATE TABLE paging_rows (id SERIAL PRIMARY KEY, n INT)',
      fill: 'INSERT INTO paging_rows (n) SELECT 1 FROM generate_series(1, 150000); ANALYZE paging_rows',
      estimates: true,
      drop: 'DROP TABLE IF EXISTS paging_rows',
    },
    {
      label: 'sqlite',
      driver: 'sqlite',
      input: () => ({ name: 'sqlite', driver: 'sqlite', file: join(dir, 'paging.db') }),
      create: 'CREATE TABLE paging_rows (id INTEGER PRIMARY KEY, n INTEGER)',
      fill: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 150000) INSERT INTO paging_rows (n) SELECT x FROM c',
      estimates: false,
      drop: 'DROP TABLE IF EXISTS paging_rows',
    },
  ];

  describe.each(targets)('$label', (target) => {
    let manager: ConnectionManager;
    let results: ResultStore;
    let runner: QueryRunner;
    let viewer: TableViewer;
    const pageSize = 100;
    let drivers: Record<DriverId, Driver>;
    let connection: { connectionId: string };

    beforeAll(async () => {
      const logger = new RecordingLogger();
      const store = new ConnectionStore({
        state: new FakeMemento(),
        secrets: new FakeSecretStorage(),
        logger,
      });
      const sqlite = createSqliteDriver({ workerPath: worker.workerPath });
      drivers = { mysql: mysqlDriver, postgres: postgresDriver, sqlite };
      manager = new ConnectionManager({
        store,
        drivers: { get: (id) => Promise.resolve(drivers[id]) },
        logger,
      });
      results = new ResultStore();
      const cache = new MetadataCache({ logger });
      runner = new QueryRunner({
        manager,
        results,
        cache,
        limits: { rowLimit: () => 1000 },
        logger,
      });
      viewer = new TableViewer({
        manager,
        results,
        cache,
        limits: { pageSize: () => pageSize },
        logger,
      });
      connection = { connectionId: (await store.add(target.input(), target.password)).id };
      await sql(target.drop);
      await sql(target.create);
    }, 60_000);

    afterAll(async () => {
      await sql(target.drop);
      manager.dispose();
    });

    async function sql(text: string): Promise<void> {
      const outcome = await runner.run({
        documentUri: 'untitled:Setup.sql',
        target: connection,
        statements: splitStatements(text, target.driver),
      });
      const failed = outcome.results.find((result) => result.error !== undefined);
      if (failed?.error !== undefined) {
        throw new Error(`${text} → ${failed.error.message}`);
      }
    }

    const table = { name: 'paging_rows' };

    beforeAll(async () => {
      await sql(target.fill);
    }, 120_000);

    function latest() {
      return results.forDocument(tableDocumentUri(connection, table)).at(-1);
    }

    it('shows an estimate for a big table where the server has one, and counts where it has none', async () => {
      const summary = await viewer.open({ target: connection, table });
      expect(summary.error).toBeUndefined();
      expect(summary.page?.approximate === true).toBe(target.estimates);
      if (target.estimates) {
        // Statistics are only roughly right; the point is that it is the right order of size.
        expect(summary.page?.totalRows).toBeGreaterThan(100_000);
        expect(summary.page?.totalRows).toBeLessThan(300_000);
      } else {
        expect(summary.page?.totalRows).toBe(150_000);
      }
    });

    it('replaces the estimate with the exact count on request', async () => {
      const first = await viewer.open({ target: connection, table });
      expect(await viewer.reload(first.id, { exactCount: true })).toBe(true);
      expect(latest()?.page).toEqual({ offset: 0, pageSize: 100, totalRows: 150_000 });
    });

    it('keeps the estimate while moving through the pages', async () => {
      const first = await viewer.open({ target: connection, table });
      await viewer.reload(first.id, { offset: 100 });
      expect(latest()?.page).toMatchObject({ offset: 100, pageSize: 100 });
      expect(latest()?.page?.approximate === true).toBe(target.estimates);
      expect(latest()?.rowCount).toBe(100);
    });

    it('counts a filtered view exactly, never from the estimate', async () => {
      const summary = await viewer.open({
        target: connection,
        table,
        filter: { conditions: [{ column: 'id', operator: 'le', value: '10' }] },
      });
      expect(summary.page).toEqual({ offset: 0, pageSize: 100, totalRows: 10 });
    });

    it('reads as many rows as the page size says, and the last page is short', async () => {
      const first = await viewer.open({ target: connection, table, totalRows: 150_000 });
      await viewer.reload(first.id, { pageSize: 5000 });
      expect(latest()?.rowCount).toBe(5000);
      await viewer.reload(latest()?.id ?? '', { offset: 145_000 });
      expect(latest()?.rowCount).toBe(5000);
      await viewer.reload(latest()?.id ?? '', { pageSize: 40_000 });
      await viewer.reload(latest()?.id ?? '', { offset: 120_000 });
      expect(latest()?.rowCount).toBe(30_000);
      expect(latest()?.page).toMatchObject({ offset: 120_000, pageSize: 40_000 });
    }, 60_000);

    it('reads a page past the end as empty', async () => {
      const first = await viewer.open({ target: connection, table, totalRows: 150_000 });
      await viewer.reload(first.id, { offset: 900_000 });
      expect(latest()?.rowCount).toBe(0);
      expect(latest()?.error).toBeUndefined();
    });
  });
});
