// The whole editing path against real servers: run a query, edit the result, save,
// and look at the table. Everything from the SELECT parser to the transaction is the
// production code; only the editor UI is missing.

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
import { ResultEditor } from '../../../src/services/result-editor';
import { ResultSaver } from '../../../src/services/result-saver';
import { ResultStore } from '../../../src/services/result-store';
import { cellText } from '../../../src/shared/cell-text';
import type { CellValue } from '../../../src/shared/cell-value';
import type { ConnectionInput, DriverId, SqlDriverId } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

const DOC = 'untitled:Edit-1.sql';

interface Target {
  readonly label: string;
  readonly driver: DriverId;
  readonly input: () => ConnectionInput;
  readonly password?: string;
  /** DDL that creates `edit_people` with the same columns on every database. */
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

describe('editing a result and saving it', () => {
  let worker: BuiltWorker;
  let dir: string;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-edit-save-'));
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
        "CREATE TABLE edit_people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NULL, age INT NULL, born DATE NULL, note VARCHAR(50) NOT NULL DEFAULT 'none')",
      drop: 'DROP TABLE IF EXISTS edit_people',
    },
    {
      label: 'mariadb',
      driver: 'mysql',
      input: server('mariadb', 'mysql'),
      password: testDatabase('mariadb').password,
      create:
        "CREATE TABLE edit_people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NULL, age INT NULL, born DATE NULL, note VARCHAR(50) NOT NULL DEFAULT 'none')",
      drop: 'DROP TABLE IF EXISTS edit_people',
    },
    {
      label: 'postgres',
      driver: 'postgres',
      input: server('postgres', 'postgres'),
      password: testDatabase('postgres').password,
      create:
        "CREATE TABLE edit_people (id SERIAL PRIMARY KEY, name VARCHAR(50), age INT, born DATE, note VARCHAR(50) NOT NULL DEFAULT 'none')",
      drop: 'DROP TABLE IF EXISTS edit_people',
    },
    {
      label: 'sqlite',
      driver: 'sqlite',
      input: () => ({ name: 'sqlite', driver: 'sqlite', file: join(dir, 'edit.db') }),
      create:
        "CREATE TABLE edit_people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, born TEXT, note TEXT NOT NULL DEFAULT 'none')",
      drop: 'DROP TABLE IF EXISTS edit_people',
    },
  ];

  describe.each(targets)('$label', (target) => {
    let manager: ConnectionManager;
    let results: ResultStore;
    let runner: QueryRunner;
    let editor: ResultEditor;
    let saver: ResultSaver;
    let connectionId: string;

    beforeAll(async () => {
      const logger = new RecordingLogger();
      const store = new ConnectionStore({
        state: new FakeMemento(),
        secrets: new FakeSecretStorage(),
        logger,
      });
      const sqlite = createSqliteDriver({ workerPath: worker.workerPath });
      const drivers: Record<SqlDriverId, Driver> = {
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
      runner = new QueryRunner({
        manager,
        results,
        cache: new MetadataCache({ logger }),
        limits: { rowLimit: () => 1000 },
        logger,
      });
      editor = new ResultEditor(results);
      saver = new ResultSaver({
        manager,
        results,
        isBusy: (uri) => runner.isRunning(uri),
        rowLimit: () => 1000,
        logger,
      });
      connectionId = (await store.add(target.input(), target.password)).id;
    }, 60_000);

    afterAll(async () => {
      await sql(target.drop);
      manager.dispose();
    });

    async function sql(text: string, uri = 'untitled:Setup.sql') {
      const outcome = await runner.run({
        documentUri: uri,
        target: { connectionId },
        statements: splitStatements(text, target.driver),
      });
      const failed = outcome.results.find((result) => result.error !== undefined);
      if (failed?.error !== undefined) {
        throw new Error(`${text} → ${failed.error.message}`);
      }
      return outcome.results;
    }

    async function load(select: string): Promise<string> {
      const [result] = await sql(select, DOC);
      if (result === undefined) {
        throw new Error('no result');
      }
      return result.id;
    }

    async function rowsOf(select: string): Promise<CellValue[][]> {
      const id = await load(select);
      return results.window(id, 0, 1000)?.rows.map((row) => [...row]) ?? [];
    }

    async function reset(): Promise<void> {
      await sql(target.drop);
      await sql(target.create);
      await sql(
        "INSERT INTO edit_people (name, age, born) VALUES ('alice', 30, '1994-05-06'), ('bob', NULL, NULL), ('carol', 41, '1983-01-02')",
      );
    }

    it('saves edited cells, NULL and DEFAULT', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      expect(results.get(id)?.edit).toMatchObject({ editable: true, keyColumns: ['id'] });
      expect(editor.editCell(id, 0, 1, { kind: 'text', text: 'Al\'ice \\ "q"' })).toEqual({
        ok: true,
      });
      expect(editor.editCell(id, 0, 2, { kind: 'null' })).toEqual({ ok: true });
      expect(editor.editCell(id, 1, 2, { kind: 'text', text: '25' })).toEqual({ ok: true });
      expect(editor.editCell(id, 1, 3, { kind: 'text', text: '2000-02-29' })).toEqual({ ok: true });
      expect(editor.editCell(id, 2, 4, { kind: 'text', text: 'changed' })).toEqual({ ok: true });
      expect(editor.editCell(id, 2, 4, { kind: 'default' })).toEqual({ ok: true });

      expect(await saver.save(id)).toMatchObject({ ok: true, statements: 3, refreshed: true });

      const rows = await rowsOf('SELECT name, age, born, note FROM edit_people ORDER BY id');
      expect(rows.map((row) => row[0])).toEqual(['Al\'ice \\ "q"', 'bob', 'carol']);
      expect(rows.map((row) => row[1])).toEqual([null, 25, 41]);
      expect(cellText(rows[1]?.[2] ?? null)).toContain('2000-02-29');
      expect(rows[2]?.[3]).toBe('none');
      // The grid now shows what the server has, with nothing pending.
      expect(results.get(id)).toMatchObject({ changedCells: 0, rowCount: 3 });
      expect(results.window(id, 0, 3)?.rows[0]?.[1]).toBe('Al\'ice \\ "q"');
    });

    it('inserts, duplicates and deletes rows', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.rowAction(id, 'add', []);
      editor.editCell(id, 3, 1, { kind: 'text', text: 'dave' });
      editor.rowAction(id, 'duplicate', [0]);
      editor.rowAction(id, 'delete', [1]);
      expect(await saver.save(id)).toMatchObject({ ok: true, statements: 3 });

      const rows = await rowsOf('SELECT name FROM edit_people ORDER BY id');
      expect(rows.map((row) => row[0])).toEqual(['alice', 'carol', 'dave', 'alice']);
      // The server generated the keys of the new rows, and the grid shows them.
      const shown = results.window(id, 0, 10)?.rows ?? [];
      expect(shown).toHaveLength(4);
      expect(shown.every((row) => row[0] !== null)).toBe(true);
    });

    it('inserts a row of defaults', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.rowAction(id, 'add', []);
      expect(await saver.save(id)).toMatchObject({ ok: true, statements: 1 });
      const rows = await rowsOf('SELECT name, note FROM edit_people ORDER BY id DESC LIMIT 1');
      expect(rows).toEqual([[null, 'none']]);
    });

    it('can change the key itself and find the row by the old key', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.editCell(id, 0, 0, { kind: 'text', text: '900' });
      expect(await saver.save(id)).toMatchObject({ ok: true });
      const rows = await rowsOf('SELECT id, name FROM edit_people WHERE id >= 900');
      expect(rows).toEqual([[900, 'alice']]);
    });

    it('rolls everything back when one statement fails', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.editCell(id, 0, 1, { kind: 'text', text: 'saved?' });
      // bob takes carol's key: rejected by the server after the first update went through.
      editor.editCell(id, 1, 0, { kind: 'text', text: '3' });
      const outcome = await saver.save(id);
      expect(outcome.ok).toBe(false);
      const rows = await rowsOf('SELECT name FROM edit_people ORDER BY id');
      expect(rows.map((row) => row[0])).toEqual(['alice', 'bob', 'carol']);
    });

    it('rolls back when the row was deleted by someone else', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.editCell(id, 0, 1, { kind: 'text', text: 'mine' });
      editor.editCell(id, 1, 1, { kind: 'text', text: 'also mine' });
      await sql(
        'DELETE FROM edit_people WHERE id = (SELECT MIN(id) FROM (SELECT id FROM edit_people) t)',
      );
      const outcome = await saver.save(id);
      expect(outcome).toMatchObject({ ok: false, code: 'row-missing' });
      const rows = await rowsOf('SELECT name FROM edit_people ORDER BY id');
      expect(rows.map((row) => row[0])).toEqual(['bob', 'carol']);
      // The changes stay queued for another try.
      expect(results.get(id)?.changedCells).toBe(2);
    });

    it('edits a table opened through a filter and ordering', async () => {
      await reset();
      const id = await load(
        'SELECT id, name FROM edit_people WHERE age IS NOT NULL ORDER BY id DESC',
      );
      expect(results.get(id)?.edit).toMatchObject({ editable: true });
      editor.editCell(id, 0, 1, { kind: 'text', text: 'CAROL' });
      await saver.save(id);
      const rows = await rowsOf('SELECT name FROM edit_people ORDER BY id');
      expect(rows.map((row) => row[0])).toEqual(['alice', 'bob', 'CAROL']);
      // The saved result was read again with the same filter.
      expect(results.window(id, 0, 5)?.rows.map((row) => row[1])).toEqual(['CAROL', 'alice']);
    });
  });
});
