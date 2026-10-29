// Working with data on SQL Server (V2 on V6.2): a query result is edited and saved, a
// table is opened, filtered, sorted and paged, all through the production services.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { QueryRunner } from '../../../src/services/query-runner';
import { ResultEditor } from '../../../src/services/result-editor';
import { ResultSaver } from '../../../src/services/result-saver';
import { ResultStore } from '../../../src/services/result-store';
import { TableViewer } from '../../../src/services/table-view';
import { cellText } from '../../../src/shared/cell-text';
import type { CellValue } from '../../../src/shared/cell-value';
import type { TableFilter } from '../../../src/shared/table-filter';
import { testDatabase } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

const DOC = 'untitled:Edit-1.sql';

describe('data on SQL Server', () => {
  let manager: ConnectionManager;
  let results: ResultStore;
  let runner: QueryRunner;
  let editor: ResultEditor;
  let saver: ResultSaver;
  let viewer: TableViewer;
  let connectionId: string;

  beforeAll(async () => {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    manager = new ConnectionManager({
      store,
      drivers: { get: () => Promise.resolve(mssqlDriver) },
      logger,
    });
    results = new ResultStore();
    const cache = new MetadataCache({ logger });
    runner = new QueryRunner({ manager, results, cache, limits: { rowLimit: () => 1000 }, logger });
    editor = new ResultEditor(results);
    saver = new ResultSaver({
      manager,
      results,
      isBusy: (uri) => runner.isRunning(uri),
      rowLimit: () => 1000,
      logger,
    });
    viewer = new TableViewer({ manager, results, cache, limits: { pageSize: () => 3 }, logger });
    const db = testDatabase('mssql');
    connectionId = (
      await store.add(
        {
          name: 'mssql',
          driver: 'mssql',
          host: db.host,
          port: db.port,
          user: db.user,
          database: db.database,
        },
        db.password,
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    await sql('DROP TABLE IF EXISTS dbo.edit_people');
    manager.dispose();
  });

  async function sql(text: string, uri = 'untitled:Setup.sql') {
    const outcome = await runner.run({
      documentUri: uri,
      target: { connectionId },
      statements: splitStatements(text, 'mssql'),
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
    await sql('DROP TABLE IF EXISTS dbo.edit_people');
    await sql(
      `CREATE TABLE dbo.edit_people (id INT IDENTITY PRIMARY KEY, name NVARCHAR(50), age INT,
         born DATE, active BIT, note NVARCHAR(20) NOT NULL DEFAULT N'none')`,
    );
    await sql(
      `INSERT INTO dbo.edit_people (name, age, born, active) VALUES
         (N'alice', 30, '1994-05-06', 1), (N'bob', NULL, NULL, 0), (N'carol', 41, '1983-01-02', 1),
         (N'50%_off', 8, NULL, NULL), (N'Ünï', 12, NULL, 1)`,
    );
  }

  describe('editing', () => {
    it('saves edited cells, NULL, DEFAULT and a boolean', async () => {
      await reset();
      const id = await load('SELECT TOP (10) * FROM edit_people ORDER BY id');
      expect(results.get(id)?.edit).toMatchObject({ editable: true, keyColumns: ['id'] });
      expect(editor.editCell(id, 0, 1, { kind: 'text', text: 'Al\'ice "q" 🚀' })).toEqual({
        ok: true,
      });
      expect(editor.editCell(id, 0, 2, { kind: 'null' })).toEqual({ ok: true });
      expect(editor.editCell(id, 1, 3, { kind: 'text', text: '2000-02-29' })).toEqual({ ok: true });
      expect(editor.editCell(id, 1, 4, { kind: 'text', text: 'true' })).toEqual({ ok: true });
      expect(editor.editCell(id, 2, 5, { kind: 'default' })).toEqual({ ok: true });
      expect(await saver.save(id)).toMatchObject({ ok: true, statements: 3, refreshed: true });

      const rows = await rowsOf(
        'SELECT name, age, born, active, note FROM edit_people ORDER BY id',
      );
      expect(rows[0]?.slice(0, 2)).toEqual(['Al\'ice "q" 🚀', null]);
      expect(cellText(rows[1]?.[2] ?? null)).toBe('2000-02-29');
      expect(rows[1]?.[3]).toBe(true);
      expect(rows[2]?.[4]).toBe('none');
    });

    it('inserts, duplicates and deletes rows; identity keys come back from the server', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.rowAction(id, 'add', []);
      editor.editCell(id, 5, 1, { kind: 'text', text: 'dave' });
      editor.rowAction(id, 'duplicate', [0]);
      editor.rowAction(id, 'delete', [1]);
      expect(await saver.save(id)).toMatchObject({ ok: true, statements: 3 });
      const rows = await rowsOf('SELECT name FROM edit_people ORDER BY id');
      expect(rows.map((row) => row[0])).toEqual([
        'alice',
        'carol',
        '50%_off',
        'Ünï',
        'dave',
        'alice',
      ]);
      expect((results.window(id, 0, 10)?.rows ?? []).every((row) => row[0] !== null)).toBe(true);
    });

    it('rolls everything back when the server refuses one statement', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.editCell(id, 0, 1, { kind: 'text', text: 'saved?' });
      // Longer than NVARCHAR(50): refused by the server after the first update went through.
      editor.editCell(id, 1, 1, { kind: 'text', text: 'x'.repeat(60) });
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'constraint' });
      const rows = await rowsOf('SELECT name FROM edit_people ORDER BY id');
      expect(rows.slice(0, 2).map((row) => row[0])).toEqual(['alice', 'bob']);
    });

    it('saves inside an open transaction with a savepoint, leaving it open', async () => {
      await reset();
      await sql('BEGIN TRANSACTION', DOC);
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.editCell(id, 0, 1, { kind: 'text', text: 'in transaction' });
      const preview = await saver.preview(id);
      expect(preview).toMatchObject({ ok: true });
      expect(preview.ok && preview.sql).toContain('SAVE TRANSACTION datanest_save;');
      expect(await saver.save(id)).toMatchObject({ ok: true, inTransaction: true });
      expect(manager.transactionState(ConnectionManager.editorOwner(DOC))).toBe('open');
      await sql('ROLLBACK', DOC);
      expect((await rowsOf('SELECT name FROM edit_people ORDER BY id'))[0]?.[0]).toBe('alice');
    });

    it('does not offer to edit a result with two sets', async () => {
      const id = await load('SELECT id FROM edit_people; SELECT 1');
      expect(results.get(id)?.columns.map((column) => column.name)).toEqual(['id']);
    });
  });

  describe('table view', () => {
    const table = { schema: 'dbo', name: 'edit_people' };

    async function names(
      filter?: TableFilter,
      sort?: { column: string; direction: 'asc' | 'desc' },
      offset = 0,
    ) {
      const summary = await viewer.open({
        target: { connectionId },
        table,
        offset,
        ...(filter === undefined ? {} : { filter }),
        ...(sort === undefined ? {} : { sort }),
      });
      expect(summary.error).toBeUndefined();
      const rows = results.window(summary.id, 0, 100)?.rows ?? [];
      const column = summary.columns.findIndex((c) => c.name === 'name');
      return { summary, names: rows.map((row) => cellText(row[column] ?? null)) };
    }

    beforeAll(async () => {
      await reset();
    });

    it('pages through the table with the server estimate, then counts exactly', async () => {
      const first = await names();
      expect(first.names).toEqual(['alice', 'bob', 'carol']);
      expect(first.summary.page).toMatchObject({ offset: 0, pageSize: 3 });
      const second = await names(undefined, undefined, 3);
      expect(second.names).toEqual(['50%_off', 'Ünï']);
      expect(await viewer.reload(first.summary.id, { exactCount: true })).toBe(true);
    });

    it('sorts on the server and pages through the sorted rows', async () => {
      const sorted = await names(undefined, { column: 'age', direction: 'desc' });
      expect(sorted.names).toEqual(['carol', 'alice', 'Ünï']);
      const next = await names(undefined, { column: 'age', direction: 'desc' }, 3);
      expect(next.names).toEqual(['50%_off', 'bob']);
    });

    it('filters regardless of case, with % and _ as plain characters', async () => {
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'contains', value: 'AL' }] }))
          .names,
      ).toEqual(['alice']);
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'startsWith', value: '50%_' }] }))
          .names,
      ).toEqual(['50%_off']);
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'contains', value: 'al_ce' }] }))
          .names,
      ).toEqual([]);
      expect(
        (await names({ conditions: [{ column: 'age', operator: 'contains', value: '4' }] })).names,
      ).toEqual(['carol']);
      expect(
        (await names({ conditions: [{ column: 'name', operator: 'contains', value: 'ünï' }] }))
          .names,
      ).toEqual(['Ünï']);
      const filtered = await names({ conditions: [{ column: 'age', operator: 'isNull' }] });
      expect(filtered.names).toEqual(['bob']);
      expect(filtered.summary.page?.totalRows).toBe(1);
    });

    it('lets a filtered view be edited', async () => {
      const { summary } = await names({
        conditions: [{ column: 'name', operator: 'eq', value: 'bob' }],
      });
      expect(summary.edit).toMatchObject({ editable: true });
      editor.editCell(summary.id, 0, 2, { kind: 'text', text: '77' });
      expect(await saver.save(summary.id)).toMatchObject({ ok: true });
      expect(
        (await names({ conditions: [{ column: 'age', operator: 'eq', value: '77' }] })).names,
      ).toEqual(['bob']);
    });
  });
});
