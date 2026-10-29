// Server-side filtering and sorting of a table view against real servers: the SQL the
// filter builder writes must mean the same thing on every database.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { driver as clickhouseDriver } from '../../../src/drivers/clickhouse';
import { driver as oracleDriver } from '../../../src/drivers/oracle';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { QueryRunner } from '../../../src/services/query-runner';
import { ResultStore } from '../../../src/services/result-store';
import { TableViewer } from '../../../src/services/table-view';
import { cellText } from '../../../src/shared/cell-text';
import type { ConnectionInput, DriverId } from '../../../src/shared/connection';
import type { TableFilter } from '../../../src/shared/table-filter';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

interface Target {
  readonly label: string;
  readonly driver: DriverId;
  readonly input: () => ConnectionInput;
  readonly password?: string;
  /** DDL that creates `filter_people` with the same columns on every database. */
  readonly create: string;
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

describe('table view filter and sort', () => {
  let worker: BuiltWorker;
  let dir: string;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-table-filter-'));
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
      create:
        "CREATE TABLE filter_people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NULL, age INT NULL, born DATE NULL, note VARCHAR(50) NOT NULL DEFAULT 'none')",
      drop: 'DROP TABLE IF EXISTS filter_people',
    },
    {
      label: 'mariadb',
      driver: 'mysql',
      input: server('mariadb', 'mysql'),
      password: testDatabase('mariadb').password,
      create:
        "CREATE TABLE filter_people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NULL, age INT NULL, born DATE NULL, note VARCHAR(50) NOT NULL DEFAULT 'none')",
      drop: 'DROP TABLE IF EXISTS filter_people',
    },
    {
      label: 'postgres',
      driver: 'postgres',
      input: server('postgres', 'postgres'),
      password: testDatabase('postgres').password,
      create:
        "CREATE TABLE filter_people (id SERIAL PRIMARY KEY, name VARCHAR(50), age INT, born DATE, note VARCHAR(50) NOT NULL DEFAULT 'none')",
      drop: 'DROP TABLE IF EXISTS filter_people',
    },
    {
      label: 'sqlite',
      driver: 'sqlite',
      input: () => ({ name: 'sqlite', driver: 'sqlite', file: join(dir, 'filter.db') }),
      create:
        "CREATE TABLE filter_people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, born TEXT, note TEXT NOT NULL DEFAULT 'none')",
      drop: 'DROP TABLE IF EXISTS filter_people',
    },
  ];

  describe.each(targets)('$label', (target) => {
    let manager: ConnectionManager;
    let results: ResultStore;
    let runner: QueryRunner;
    let viewer: TableViewer;
    let pageSize = 100;
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
      drivers = {
        mysql: mysqlDriver,
        postgres: postgresDriver,
        sqlite,
        mssql: mssqlDriver,
        clickhouse: clickhouseDriver,
        oracle: oracleDriver,
      };
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
      const literal = drivers[target.driver].dialect.literal('back\\slash');
      await sql(
        `INSERT INTO filter_people (name, age) VALUES ('alice', 30), ('bob', NULL), ('carol', 41), ('50%_off', 5), (${literal}, 7), ('Ünï', 9)`,
      );
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

    /** Opens the table with a filter and returns the names shown and the counted total. */
    async function names(
      filter: TableFilter,
      sort?: { column: string; direction: 'asc' | 'desc' },
      offset = 0,
    ) {
      const summary = await viewer.open({
        target: connection,
        table: { name: 'filter_people' },
        offset,
        filter,
        ...(sort === undefined ? {} : { sort }),
      });
      const rows = results.window(summary.id, 0, 100)?.rows ?? [];
      const nameColumn = summary.columns.findIndex((column) => column.name === 'name');
      return {
        summary,
        names: rows.map((row) => cellText(row[nameColumn] ?? null)),
        total: summary.page?.totalRows,
      };
    }

    it('compares a number given as text with a numeric column', async () => {
      const found = await names({ conditions: [{ column: 'age', operator: 'eq', value: '30' }] });
      expect(found.summary.error).toBeUndefined();
      expect(found.names).toEqual(['alice']);
      expect(found.total).toBe(1);
      const greater = await names({ conditions: [{ column: 'age', operator: 'gt', value: '8' }] });
      expect(greater.names.sort()).toEqual(['alice', 'carol', 'Ünï']);
    });

    it('finds text regardless of case, also in numbers', async () => {
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'contains', value: 'AL' }] }))
          .names,
      ).toEqual(['alice']);
      expect(
        (await names({ conditions: [{ column: 'age', operator: 'contains', value: '4' }] })).names,
      ).toEqual(['carol']);
    });

    it('treats % _ and the escape character in a value as plain characters', async () => {
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'contains', value: '%' }] })).names,
      ).toEqual(['50%_off']);
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'startsWith', value: '50%_' }] }))
          .names,
      ).toEqual(['50%_off']);
      // `_` must not stand for "any character": "al_ce" would otherwise match alice.
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'contains', value: 'al_ce' }] }))
          .names,
      ).toEqual([]);
    });

    it('supports starts with, ends with and does not contain', async () => {
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'endsWith', value: 'ro' }] }))
          .names,
      ).toEqual([]);
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'endsWith', value: 'rol' }] }))
          .names,
      ).toEqual(['carol']);
      const without = await names({
        conditions: [{ column: 'name', operator: 'notContains', value: 'a' }],
      });
      expect(without.names).toContain('bob');
      expect(without.names).not.toContain('alice');
    });

    it('checks for NULL', async () => {
      expect((await names({ conditions: [{ column: 'age', operator: 'isNull' }] })).names).toEqual([
        'bob',
      ]);
      expect((await names({ conditions: [{ column: 'age', operator: 'notNull' }] })).total).toBe(5);
    });

    it('cannot be talked out of its quotes', async () => {
      const injected = await names({
        conditions: [{ column: 'name', operator: 'eq', value: "x' OR '1'='1" }],
      });
      expect(injected.summary.error).toBeUndefined();
      expect(injected.names).toEqual([]);
      expect(injected.total).toBe(0);
    });

    it('matches a value with a backslash', async () => {
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'eq', value: 'back\\slash' }] }))
          .names,
      ).toEqual(['back\\slash']);
    });

    it('matches non-ASCII text', async () => {
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'eq', value: 'Ünï' }] })).names,
      ).toEqual(['Ünï']);
    });

    it('combines conditions with a hand-written WHERE', async () => {
      const found = await names({
        conditions: [{ column: 'age', operator: 'notNull' }],
        where: "age > 6 AND name <> 'carol' -- trailing comment",
      });
      expect(found.summary.error).toBeUndefined();
      expect(found.names.sort()).toEqual(['alice', 'back\\slash', 'Ünï']);
    });

    it('sorts the whole table on the server, then pages through it', async () => {
      pageSize = 2;
      try {
        // NULLs sort first or last depending on the database, so leave them out.
        const filter: TableFilter = { conditions: [{ column: 'age', operator: 'notNull' }] };
        const sort = { column: 'age', direction: 'desc' as const };
        const first = await names(filter, sort);
        // The two oldest, wherever they sit in the table.
        expect(first.names).toEqual(['carol', 'alice']);
        expect(first.summary.sort).toMatchObject({ direction: 'desc' });
        expect(first.total).toBe(5);
        const second = await names(filter, sort, 2);
        expect(second.names).toEqual(['Ünï', 'back\\slash']);
      } finally {
        pageSize = 100;
      }
    });

    it('reports a bad WHERE as an error and recovers when it is removed', async () => {
      const bad = await names({ conditions: [], where: 'no_such_column = 1' });
      expect(bad.summary.error).toBeDefined();
      expect(bad.summary.filter?.where).toBe('no_such_column = 1');
      expect(await viewer.reload(bad.summary.id, { filter: null })).toBe(true);
      const latest = results.forDocument(bad.summary.documentUri).at(-1);
      expect(latest?.error).toBeUndefined();
      expect(latest?.page?.totalRows).toBe(6);
    });

    it('still lets a filtered view be edited', async () => {
      const found = await names({ conditions: [{ column: 'name', operator: 'eq', value: 'bob' }] });
      expect(found.summary.edit).toMatchObject({ editable: true });
    });
  });
});
