// Following a foreign key against real servers: from a cell to the row it points at,
// through the metadata, the link and the filtered table view.

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
import { ResultLinks } from '../../../src/services/result-links';
import { TableViewer } from '../../../src/services/table-view';
import type { ConnectionInput, DriverId, SqlDriverId } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

interface Target {
  readonly label: string;
  readonly driver: DriverId;
  readonly input: () => ConnectionInput;
  readonly password?: string;
  /** DDL that creates `fk_child` with the same columns on every database. */
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

describe('foreign key links', () => {
  let worker: BuiltWorker;
  let dir: string;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-fk-follow-'));
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
        'CREATE TABLE fk_parent (id INT PRIMARY KEY, label VARCHAR(50), code VARCHAR(10) UNIQUE); CREATE TABLE fk_child (id INT PRIMARY KEY, parent_id INT, parent_code VARCHAR(10), note VARCHAR(50), CONSTRAINT fk_c1 FOREIGN KEY (parent_id) REFERENCES fk_parent (id), CONSTRAINT fk_c2 FOREIGN KEY (parent_code) REFERENCES fk_parent (code))',
      drop: 'DROP TABLE IF EXISTS fk_child; DROP TABLE IF EXISTS fk_parent',
    },
    {
      label: 'mariadb',
      driver: 'mysql',
      input: server('mariadb', 'mysql'),
      password: testDatabase('mariadb').password,
      create:
        'CREATE TABLE fk_parent (id INT PRIMARY KEY, label VARCHAR(50), code VARCHAR(10) UNIQUE); CREATE TABLE fk_child (id INT PRIMARY KEY, parent_id INT, parent_code VARCHAR(10), note VARCHAR(50), CONSTRAINT fk_c1 FOREIGN KEY (parent_id) REFERENCES fk_parent (id), CONSTRAINT fk_c2 FOREIGN KEY (parent_code) REFERENCES fk_parent (code))',
      drop: 'DROP TABLE IF EXISTS fk_child; DROP TABLE IF EXISTS fk_parent',
    },
    {
      label: 'postgres',
      driver: 'postgres',
      input: server('postgres', 'postgres'),
      password: testDatabase('postgres').password,
      create:
        'CREATE TABLE fk_parent (id INT PRIMARY KEY, label VARCHAR(50), code VARCHAR(10) UNIQUE); CREATE TABLE fk_child (id INT PRIMARY KEY, parent_id INT REFERENCES fk_parent (id), parent_code VARCHAR(10) REFERENCES fk_parent (code), note VARCHAR(50))',
      drop: 'DROP TABLE IF EXISTS fk_child; DROP TABLE IF EXISTS fk_parent',
    },
    {
      label: 'sqlite',
      driver: 'sqlite',
      input: () => ({ name: 'sqlite', driver: 'sqlite', file: join(dir, 'fk.db') }),
      create:
        'CREATE TABLE fk_parent (id INTEGER PRIMARY KEY, label TEXT, code TEXT UNIQUE); CREATE TABLE fk_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES fk_parent (id), parent_code TEXT REFERENCES fk_parent (code), note TEXT)',
      drop: 'DROP TABLE IF EXISTS fk_child; DROP TABLE IF EXISTS fk_parent',
    },
  ];

  describe.each(targets)('$label', (target) => {
    let manager: ConnectionManager;
    let results: ResultStore;
    let runner: QueryRunner;
    let links: ResultLinks;
    let viewer: TableViewer;
    let drivers: Record<SqlDriverId, Driver>;
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
      links = new ResultLinks(results);
      viewer = new TableViewer({
        manager,
        results,
        cache,
        limits: { pageSize: () => 100 },
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

    async function child(): Promise<string> {
      const outcome = await runner.run({
        documentUri: 'untitled:Fk-1.sql',
        target: connection,
        statements: splitStatements('SELECT * FROM fk_child ORDER BY id', target.driver),
      });
      const [result] = outcome.results;
      if (result === undefined || result.error !== undefined) {
        throw new Error('could not read fk_child');
      }
      return result.id;
    }

    async function open(row: number, link: number) {
      const id = await child();
      const outcome = links.follow({ resultId: id, row, link });
      if (!outcome.ok) {
        return outcome;
      }
      const view = await viewer.open({
        target: outcome.target,
        table: outcome.table,
        filter: outcome.filter,
      });
      const names = (results.window(view.id, 0, 100)?.rows ?? []).map((cells) =>
        cells.map((cell) => (typeof cell === 'object' && cell !== null ? '?' : cell)),
      );
      return { ok: true as const, view, names };
    }

    it('shows the keys of the table in the result', async () => {
      await sql('DELETE FROM fk_child');
      await sql('DELETE FROM fk_parent');
      await sql(
        "INSERT INTO fk_parent (id, label, code) VALUES (1, 'one', 'AA'), (2, 'two', 'BB')",
      );
      await sql(
        "INSERT INTO fk_child (id, parent_id, parent_code, note) VALUES (10, 2, 'AA', 'x'), (11, NULL, NULL, 'y')",
      );
      const edit = results.get(await child())?.edit;
      expect(edit).toMatchObject({ editable: true });
      const keys = edit?.editable === true ? (edit.foreignKeys ?? []) : [];
      expect(keys).toHaveLength(2);
      expect(keys.map((key) => key.target.name)).toEqual(['fk_parent', 'fk_parent']);
    });

    it('opens the parent row a numeric key points at', async () => {
      const id = await child();
      const edit = results.get(id)?.edit;
      const keys = edit?.editable === true ? (edit.foreignKeys ?? []) : [];
      const numeric = keys.findIndex((key) => key.columns[0] === 'parent_id');
      const found = await open(0, numeric);
      expect(found.ok).toBe(true);
      expect(found.ok && found.view.error).toBeUndefined();
      expect(found.ok && found.names).toEqual([[2, 'two', 'BB']]);
      expect(found.ok && found.view.page?.totalRows).toBe(1);
    });

    it('opens the parent row a text key points at', async () => {
      const id = await child();
      const edit = results.get(id)?.edit;
      const keys = edit?.editable === true ? (edit.foreignKeys ?? []) : [];
      const text = keys.findIndex((key) => key.columns[0] === 'parent_code');
      const found = await open(0, text);
      expect(found.ok && found.names).toEqual([[1, 'one', 'AA']]);
    });

    it('does not follow a NULL key', async () => {
      const id = await child();
      const edit = results.get(id)?.edit;
      const keys = edit?.editable === true ? (edit.foreignKeys ?? []) : [];
      expect(links.follow({ resultId: id, row: 1, link: 0 })).toEqual({
        ok: false,
        error: 'null-value',
      });
      expect(keys.length).toBeGreaterThan(0);
    });
  });
});
