import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { EditableResult } from '../../../src/core/model/editability';
import type {
  Driver,
  ExecuteEvent,
  ExecuteOptions,
  MetadataReader,
  Session,
  TransactionState,
} from '../../../src/drivers/driver';
import { ResultEditor } from '../../../src/services/result-editor';
import { ResultSaver } from '../../../src/services/result-saver';
import { type NewResult, ResultStore } from '../../../src/services/result-store';
import type { CellValue } from '../../../src/shared/cell-value';
import { mssqlDialect } from '../../../src/drivers/mssql/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { RecordingLogger } from '../../helpers/fakes';

const DOC = 'untitled:Query-1.sql';

const EDIT: EditableResult = {
  editable: true,
  table: { name: 'users' },
  columnMap: ['id', 'name'],
  columns: [
    { name: 'id', dataType: 'int', nullable: false, kind: 'integer' },
    { name: 'name', dataType: 'text', nullable: true, kind: 'text' },
  ],
  keyColumns: ['id'],
  keyIndexes: [0],
};

const noMetadata: MetadataReader = {
  listDatabases: () => Promise.resolve([]),
  listSchemas: () => Promise.resolve([]),
  listTables: () => Promise.resolve([]),
  listColumns: () => Promise.resolve([]),
  listUniqueKeys: () => Promise.resolve([]),
  listForeignKeys: () => Promise.resolve([]),
  listObjects: () => Promise.resolve([]),
  listIndexes: () => Promise.resolve([]),
  describeTable: () => Promise.reject(new Error('no table')),
  getDefinition: () => Promise.resolve([]),
  getTableDump: () => Promise.resolve({ before: [], create: [], after: [], owns: [] }),
  listTypeDumps: () => Promise.resolve([]),
};

/** A session that records statements and answers as a script says. */
class ScriptedSession implements Session {
  readonly metadata = noMetadata;
  readonly executed: string[] = [];
  /** Rows the re-read of the result returns. */
  reread: CellValue[][] = [
    [1, 'fresh'],
    [5, 'generated'],
  ];
  affected: (sql: string) => number | undefined = () => 1;
  fail: (sql: string) => Error | undefined = () => undefined;
  readonly limits: (number | undefined)[] = [];
  /** What the server would say about the transaction; undefined: cannot tell. */
  transaction: TransactionState | undefined = undefined;

  transactionState(): TransactionState | undefined {
    return this.transaction;
  }

  execute(sql: string, options?: ExecuteOptions): AsyncIterable<ExecuteEvent> {
    this.executed.push(sql);
    this.limits.push(options?.rowLimit);
    return this.stream(sql);
  }

  private async *stream(sql: string): AsyncGenerator<ExecuteEvent> {
    await Promise.resolve();
    const error = this.fail(sql);
    if (error !== undefined) {
      throw error;
    }
    if (sql.startsWith('SELECT')) {
      yield { kind: 'columns', columns: [{ name: 'id' }, { name: 'name' }] };
      yield { kind: 'rows', rows: this.reread };
    }
    const affectedRows = this.affected(sql);
    yield affectedRows === undefined ? { kind: 'done' } : { kind: 'done', affectedRows };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('ResultSaver', () => {
  let session: ScriptedSession;
  let store: ResultStore;
  let editor: ResultEditor;
  let saver: ResultSaver;
  let busy: boolean;
  let id: string;
  let acquired: { owner: string; connectionId: string }[];

  function addResult(overrides: Partial<NewResult> = {}): string {
    return store.add({
      documentUri: DOC,
      statement: 'SELECT * FROM users',
      statementStart: 0,
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [
        [1, 'alice'],
        [2, 'bob'],
        [3, 'carol'],
      ],
      truncated: false,
      durationMs: 1,
      edit: EDIT,
      origin: { target: { connectionId: 'c1' }, owner: 'editor:doc' },
      ...overrides,
    }).id;
  }

  beforeEach(() => {
    session = new ScriptedSession();
    store = new ResultStore();
    editor = new ResultEditor(store);
    busy = false;
    acquired = [];
    const driver = { id: 'mysql', dialect: postgresDialect } as unknown as Driver;
    saver = new ResultSaver({
      manager: {
        acquire: (owner, target) => {
          acquired.push({ owner, connectionId: target.connectionId });
          return Promise.resolve(session);
        },
        driverOf: () => Promise.resolve(driver),
        transactionState: () => session.transaction,
      },
      results: store,
      isBusy: () => busy,
      rowLimit: (summary) => (summary.page === undefined ? 1000 : 50),
      logger: new RecordingLogger(),
    });
    id = addResult();
  });

  function makeChanges(): void {
    editor.editCell(id, 0, 1, { kind: 'text', text: 'alicia' });
    editor.rowAction(id, 'delete', [1]);
    editor.rowAction(id, 'add', []);
    editor.editCell(id, 3, 1, { kind: 'text', text: 'dave' });
  }

  describe('save', () => {
    it('runs deletes, updates and inserts in one transaction, then re-reads the rows', async () => {
      makeChanges();
      const outcome = await saver.save(id);
      expect(outcome).toEqual({ ok: true, statements: 3, refreshed: true, inTransaction: false });
      expect(session.executed).toEqual([
        'BEGIN',
        'DELETE FROM "users" WHERE "id" = 2',
        `UPDATE "users" SET "name" = 'alicia' WHERE "id" = 1`,
        `INSERT INTO "users" ("name") VALUES ('dave')`,
        'COMMIT',
        'SELECT * FROM users',
      ]);
    });

    it('joins a transaction the user opened, fenced by a savepoint (V4.8)', async () => {
      makeChanges();
      session.transaction = 'open';
      const outcome = await saver.save(id);
      expect(outcome).toEqual({ ok: true, statements: 3, refreshed: true, inTransaction: true });
      expect(session.executed[0]).toBe('SAVEPOINT datanest_save');
      expect(session.executed[4]).toBe('RELEASE SAVEPOINT datanest_save');
      expect(session.executed).not.toContain('BEGIN');
      expect(session.executed).not.toContain('COMMIT');
    });

    it('undoes only its own statements when one fails inside the user transaction', async () => {
      makeChanges();
      session.transaction = 'open';
      session.fail = (sql) =>
        sql.startsWith('UPDATE') ? new DbError('constraint', 'Duplicate entry') : undefined;
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'constraint' });
      expect(session.executed.at(-1)).toBe('ROLLBACK TO SAVEPOINT datanest_save');
      expect(session.executed).not.toContain('ROLLBACK');
      expect(store.get(id)?.changedCells).toBe(1);
    });

    it('refuses to save into a failed transaction', async () => {
      makeChanges();
      session.transaction = 'failed';
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'transaction-failed' });
      expect(session.executed).toEqual([]);
    });

    it('uses its own transaction when the driver cannot tell', async () => {
      makeChanges();
      session.transaction = undefined;
      await saver.save(id);
      expect(session.executed[0]).toBe('BEGIN');
    });

    it('goes through the session that produced the rows', async () => {
      makeChanges();
      await saver.save(id);
      expect(acquired).toEqual([{ owner: 'editor:doc', connectionId: 'c1' }]);
    });

    it('shows the fresh rows and clears the pending changes', async () => {
      makeChanges();
      await saver.save(id);
      expect(store.get(id)).toMatchObject({
        rowCount: 2,
        changedCells: 0,
        insertedRows: 0,
        deletedRows: 0,
      });
      expect(store.window(id, 0, 5)?.rows).toEqual([
        [1, 'fresh'],
        [5, 'generated'],
      ]);
    });

    it('reads back up to the row limit, or the page size for a table view', async () => {
      makeChanges();
      await saver.save(id);
      expect(session.limits.at(-1)).toBe(1000);
      const paged = addResult({ page: { offset: 0, pageSize: 50 } });
      editor.editCell(paged, 0, 1, { kind: 'text', text: 'x' });
      await saver.save(paged);
      expect(session.limits.at(-1)).toBe(50);
    });

    it('keeps the sort the user chose', async () => {
      editor.editCell(id, 0, 1, { kind: 'text', text: 'x' });
      store.sort(id, 0, 'desc');
      await saver.save(id);
      expect(store.window(id, 0, 5)?.rows.map((row) => row[0])).toEqual([5, 1]);
    });

    it('rolls back and keeps the changes when a statement fails', async () => {
      makeChanges();
      session.fail = (sql) =>
        sql.startsWith('UPDATE') ? new DbError('constraint', 'Duplicate entry') : undefined;
      const outcome = await saver.save(id);
      expect(outcome).toEqual({
        ok: false,
        code: 'constraint',
        message: 'Duplicate entry',
        statement: `UPDATE "users" SET "name" = 'alicia' WHERE "id" = 1`,
      });
      expect(session.executed.at(-1)).toBe('ROLLBACK');
      expect(session.executed).not.toContain('COMMIT');
      expect(store.get(id)).toMatchObject({ changedCells: 1, insertedRows: 1, deletedRows: 1 });
    });

    it('rolls back when a row was not found, saying so', async () => {
      editor.editCell(id, 0, 1, { kind: 'text', text: 'x' });
      session.affected = (sql) => (sql.startsWith('UPDATE') ? 0 : 1);
      const outcome = await saver.save(id);
      expect(outcome).toMatchObject({
        ok: false,
        code: 'row-missing',
        statement: `UPDATE "users" SET "name" = 'x' WHERE "id" = 1`,
      });
      expect(session.executed.at(-1)).toBe('ROLLBACK');
      expect(store.get(id)?.changedCells).toBe(1);
    });

    it('rolls back when a statement touched more rows than the key allows', async () => {
      editor.rowAction(id, 'delete', [0]);
      session.affected = () => 2;
      const outcome = await saver.save(id);
      expect(outcome).toMatchObject({ ok: false, code: 'row-missing' });
      expect((outcome as { message: string }).message).toContain('2 rows instead of 1');
    });

    it('treats a server that reports nothing as a missing row', async () => {
      editor.rowAction(id, 'delete', [0]);
      session.affected = () => undefined;
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'row-missing' });
    });

    it('rolls back when the commit itself fails', async () => {
      makeChanges();
      session.fail = (sql) =>
        sql === 'COMMIT' ? new DbError('connection-failed', 'gone') : undefined;
      const outcome = await saver.save(id);
      expect(outcome).toMatchObject({ ok: false, code: 'connection-failed', statement: 'COMMIT' });
      expect(session.executed.at(-1)).toBe('ROLLBACK');
    });

    it('survives a rollback that fails too', async () => {
      editor.rowAction(id, 'delete', [0]);
      session.affected = () => 0;
      session.fail = (sql) => (sql === 'ROLLBACK' ? new Error('link is down') : undefined);
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'row-missing' });
    });

    it('keeps saved changes out of the queue when the re-read fails', async () => {
      makeChanges();
      session.fail = (sql) =>
        sql.startsWith('SELECT') ? new DbError('timeout', 'slow') : undefined;
      const outcome = await saver.save(id);
      expect(outcome).toEqual({
        ok: true,
        statements: 3,
        refreshed: false,
        inTransaction: false,
      });
      expect(store.get(id)).toMatchObject({ changedCells: 0, insertedRows: 0, deletedRows: 0 });
    });

    it('does nothing when there is nothing to save', async () => {
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'no-changes' });
      expect(session.executed).toEqual([]);
    });

    it('does nothing while a query runs in the editor', async () => {
      makeChanges();
      busy = true;
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'busy' });
      expect(session.executed).toEqual([]);
      expect(store.get(id)?.changedCells).toBe(1);
    });

    it('refuses a second save of the same result while one is running', async () => {
      makeChanges();
      const first = saver.save(id);
      const second = await saver.save(id);
      expect(second).toMatchObject({ ok: false, code: 'busy' });
      expect(await first).toMatchObject({ ok: true });
    });

    it('refuses a read-only result, an unknown one, and one with no origin', async () => {
      const readOnly = addResult({ edit: { editable: false, reason: 'no-key' } });
      expect(await saver.save(readOnly)).toMatchObject({ ok: false, code: 'not-editable' });
      expect(await saver.save('result-404')).toMatchObject({ ok: false, code: 'not-editable' });
      const { origin: _origin, ...rest } = {
        documentUri: DOC,
        statement: 'SELECT * FROM users',
        statementStart: 0,
        columns: [{ name: 'id' }],
        rows: [[1]],
        truncated: false,
        durationMs: 1,
        edit: EDIT,
        origin: undefined,
      };
      const orphan = store.add(rest).id;
      expect(await saver.save(orphan)).toMatchObject({ ok: false, code: 'not-editable' });
    });

    it('reports a connection that cannot be reached', async () => {
      makeChanges();
      const failing = new ResultSaver({
        manager: {
          acquire: () => Promise.reject(new DbError('connection-failed', 'refused')),
          driverOf: () =>
            Promise.resolve({ id: 'mysql', dialect: postgresDialect } as unknown as Driver),
          transactionState: () => undefined,
        },
        results: store,
        isBusy: () => false,
        rowLimit: () => 10,
        logger: new RecordingLogger(),
      });
      expect(await failing.save(id)).toMatchObject({ ok: false, code: 'connection-failed' });
      expect(store.get(id)?.changedCells).toBe(1);
    });

    it('can be tried again after a failure', async () => {
      editor.rowAction(id, 'delete', [0]);
      session.affected = () => 0;
      await saver.save(id);
      session.affected = () => 1;
      expect(await saver.save(id)).toMatchObject({ ok: true });
    });
  });

  describe('preview', () => {
    it('shows the transaction a save would run, without running anything', async () => {
      makeChanges();
      const outcome = await saver.preview(id);
      expect(outcome).toEqual({
        ok: true,
        sql: [
          '-- DataNest: pending changes of  SELECT * FROM users',
          'BEGIN;',
          'DELETE FROM "users" WHERE "id" = 2;',
          `UPDATE "users" SET "name" = 'alicia' WHERE "id" = 1;`,
          `INSERT INTO "users" ("name") VALUES ('dave');`,
          'COMMIT;',
          '',
        ].join('\n'),
      });
      expect(session.executed).toEqual([]);
    });

    it('previews the savepoint when the editor has a transaction open', async () => {
      makeChanges();
      session.transaction = 'open';
      const outcome = await saver.preview(id);
      expect(outcome.ok && outcome.sql.split('\n')[1]).toBe('SAVEPOINT datanest_save;');
      expect(outcome.ok && outcome.sql).toContain('RELEASE SAVEPOINT datanest_save;');
    });

    it('keeps a long statement on one comment line', async () => {
      const wide = addResult({ statement: 'SELECT *\n  FROM users\n WHERE id > 0' });
      editor.rowAction(wide, 'delete', [0]);
      const outcome = await saver.preview(wide);
      expect(outcome.ok && outcome.sql.split('\n')[0]).toBe(
        '-- DataNest: pending changes of  SELECT * FROM users WHERE id > 0',
      );
    });

    it('says when there is nothing to preview or the result is read-only', async () => {
      expect(await saver.preview(id)).toMatchObject({ ok: false, code: 'no-changes' });
      const readOnly = addResult({ edit: { editable: false, reason: 'view' } });
      expect(await saver.preview(readOnly)).toMatchObject({ ok: false, code: 'not-editable' });
    });
  });

  describe('on SQL Server (V6.2)', () => {
    beforeEach(() => {
      const driver = { id: 'mssql', dialect: mssqlDialect } as unknown as Driver;
      saver = new ResultSaver({
        manager: {
          acquire: () => Promise.resolve(session),
          driverOf: () => Promise.resolve(driver),
          transactionState: () => session.transaction,
        },
        results: store,
        isBusy: () => busy,
        rowLimit: () => 1000,
        logger: new RecordingLogger(),
      });
    });

    it('fences a save with BEGIN TRANSACTION and COMMIT TRANSACTION', async () => {
      makeChanges();
      expect(await saver.save(id)).toMatchObject({ ok: true, inTransaction: false });
      expect(session.executed[0]).toBe('BEGIN TRANSACTION');
      expect(session.executed[4]).toBe('COMMIT TRANSACTION');
      expect(session.executed[1]).toBe('DELETE FROM [users] WHERE [id] = 2');
    });

    it('joins an open transaction with SAVE TRANSACTION and lets nothing go after it', async () => {
      makeChanges();
      session.transaction = 'open';
      expect(await saver.save(id)).toMatchObject({ ok: true, inTransaction: true });
      expect(session.executed).toEqual([
        'SAVE TRANSACTION datanest_save',
        'DELETE FROM [users] WHERE [id] = 2',
        "UPDATE [users] SET [name] = N'alicia' WHERE [id] = 1",
        "INSERT INTO [users] ([name]) VALUES (N'dave')",
        'SELECT * FROM users',
      ]);
    });

    it('goes back to the savepoint when a statement fails inside the transaction', async () => {
      makeChanges();
      session.transaction = 'open';
      session.fail = (sql) =>
        sql.startsWith('UPDATE') ? new DbError('constraint', 'Duplicate key') : undefined;
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'constraint' });
      expect(session.executed.at(-1)).toBe('ROLLBACK TRANSACTION datanest_save');
    });

    it('previews the savepoint without a release line', async () => {
      makeChanges();
      session.transaction = 'open';
      const outcome = await saver.preview(id);
      expect(outcome.ok && outcome.sql.split('\n')).toEqual([
        '-- DataNest: pending changes of  SELECT * FROM users',
        'SAVE TRANSACTION datanest_save;',
        'DELETE FROM [users] WHERE [id] = 2;',
        "UPDATE [users] SET [name] = N'alicia' WHERE [id] = 1;",
        "INSERT INTO [users] ([name]) VALUES (N'dave');",
        '',
      ]);
    });
  });
});
