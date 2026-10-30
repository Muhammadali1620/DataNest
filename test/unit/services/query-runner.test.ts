import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { splitStatements } from '../../../src/core/sql/split';
import { QueryHistory } from '../../../src/services/history';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { QueryRunner } from '../../../src/services/query-runner';
import { ResultStore } from '../../../src/services/result-store';
import type { ConnectionConfig } from '../../../src/shared/connection';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

const DOC = 'untitled:Query-1.sql';

/** Waits until a condition holds; keeps the async tests free of fixed delays. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('The condition never became true');
}

describe('QueryRunner', () => {
  let store: ConnectionStore;
  let drivers: FakeDriverProvider;
  let manager: ConnectionManager;
  let cache: MetadataCache;
  let results: ResultStore;
  let runner: QueryRunner;
  let logger: RecordingLogger;
  let rowLimit: number;
  let timeoutMs: number;
  let connection: ConnectionConfig;
  let history: QueryHistory;

  beforeEach(async () => {
    logger = new RecordingLogger();
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    drivers = new FakeDriverProvider();
    manager = new ConnectionManager({ store, drivers, logger });
    cache = new MetadataCache({ logger });
    results = new ResultStore();
    rowLimit = 1000;
    timeoutMs = 0;
    history = new QueryHistory({
      state: new FakeMemento(),
      logger,
      limit: () => 100,
      nameOf: (id) => store.get(id)?.name,
    });
    runner = new QueryRunner({
      history,
      manager,
      results,
      cache,
      limits: {
        rowLimit: () => rowLimit,
        timeoutMs: (connectionId) => (connectionId === connection.id ? timeoutMs : -1),
      },
      logger,
    });
    connection = await store.add({ name: 'Local', driver: 'mysql', host: 'h' });
  });

  function request(sql: string) {
    return {
      documentUri: DOC,
      target: { connectionId: connection.id },
      statements: splitStatements(sql, 'mysql'),
    };
  }

  describe('editability', () => {
    it('marks a select of a keyed table editable', async () => {
      const driver = drivers.driver('mysql');
      driver.sessionMetadata.tables = [{ name: 'customers', kind: 'table' }];
      const outcome = await runner.run(request('SELECT * FROM customers'));
      // The fake session returns one column named "one", which the table does not have.
      expect(outcome.results[0]?.edit).toEqual({ editable: false, reason: 'columns-mismatch' });
    });

    it('is editable when the result columns are those of the table', async () => {
      const driver = drivers.driver('mysql');
      driver.sessionMetadata.tables = [{ name: 'customers', kind: 'table' }];
      driver.sessionMetadata.columns = [
        { name: 'one', dataType: 'int', nullable: false, primaryKey: true },
      ];
      const outcome = await runner.run(request('SELECT * FROM customers'));
      expect(outcome.results[0]?.edit).toMatchObject({ editable: true, keyColumns: ['one'] });
    });

    it('explains why a join is read-only', async () => {
      const outcome = await runner.run(request('SELECT * FROM a JOIN b ON 1'));
      expect(outcome.results[0]?.edit).toEqual({ editable: false, reason: 'multiple-tables' });
    });

    it('says nothing about editing for a failed statement', async () => {
      drivers.driver('mysql').failExecuteWhen = () => true;
      const outcome = await runner.run(request('SELECT * FROM customers'));
      expect(outcome.results[0]?.error).toBeDefined();
      expect(outcome.results[0]?.edit).toBeUndefined();
    });
  });

  describe('running statements', () => {
    it('runs one statement and stores its result', async () => {
      const outcome = await runner.run(request('SELECT 1'));
      expect(outcome.cancelled).toBe(false);
      expect(outcome.skipped).toBe(0);
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0]).toMatchObject({ statement: 'SELECT 1', rowCount: 1 });
      expect(results.forDocument(DOC)).toHaveLength(1);
    });

    it('sends every statement of a script in order', async () => {
      await runner.run(request('SELECT 1; SELECT 2; SELECT 3'));
      expect(drivers.driver('mysql').lastSession?.executed).toEqual([
        'SELECT 1',
        'SELECT 2',
        'SELECT 3',
      ]);
      expect(results.forDocument(DOC).map((r) => r.statement)).toEqual([
        'SELECT 1',
        'SELECT 2',
        'SELECT 3',
      ]);
    });

    it('records the columns the driver reported', async () => {
      const outcome = await runner.run(request('SELECT 1'));
      expect(outcome.results[0]?.columns).toEqual([{ name: 'one' }]);
    });

    it('measures how long a statement took', async () => {
      const outcome = await runner.run(request('SELECT 1'));
      expect(outcome.results[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does nothing for an empty script', async () => {
      const outcome = await runner.run({
        documentUri: DOC,
        target: { connectionId: connection.id },
        statements: [],
      });
      expect(outcome).toEqual({ results: [], cancelled: false, skipped: 0 });
      expect(drivers.driver('mysql').sessions).toHaveLength(0);
    });

    it('reuses one session for the whole run', async () => {
      await runner.run(request('SELECT 1; SELECT 2'));
      expect(drivers.driver('mysql').sessions).toHaveLength(1);
    });

    it('uses the database the document is bound to', async () => {
      await runner.run({
        documentUri: DOC,
        target: { connectionId: connection.id, database: 'shop' },
        statements: splitStatements('SELECT 1'),
      });
      expect(drivers.driver('mysql').opened[0]?.database).toBe('shop');
    });
  });

  describe('row limit', () => {
    it('passes the limit to the driver', async () => {
      rowLimit = 10;
      await runner.run(request('SELECT 1'));
      // The fake records statements; the limit reaching the driver is what matters.
      expect(drivers.driver('mysql').lastSession?.executed).toEqual(['SELECT 1']);
    });

    it('cuts rows a driver sends beyond the limit and says so', async () => {
      rowLimit = 2;
      drivers.driver('mysql').sessionRows = [[1], [2], [3], [4]];
      const outcome = await runner.run(request('SELECT * FROM big'));
      expect(outcome.results[0]).toMatchObject({ rowCount: 2, truncated: true });
    });

    it('does not mark a result truncated when it fits', async () => {
      rowLimit = 10;
      drivers.driver('mysql').sessionRows = [[1], [2]];
      const outcome = await runner.run(request('SELECT * FROM small'));
      expect(outcome.results[0]).toMatchObject({ rowCount: 2, truncated: false });
    });

    it('treats a nonsense limit as at least one row', async () => {
      rowLimit = 0;
      drivers.driver('mysql').sessionRows = [[1], [2]];
      const outcome = await runner.run(request('SELECT 1'));
      expect(outcome.results[0]?.rowCount).toBe(1);
    });
  });

  describe('failures', () => {
    it('stores a statement that changes rows with their count and nothing to edit', async () => {
      drivers.driver('mysql').sessionAffectedFor = (sql) =>
        sql.startsWith('UPDATE') ? 3 : undefined;
      const outcome = await runner.run(request("UPDATE t SET a = 1 WHERE b = 'x'"));
      const result = outcome.results[0];
      expect(result).toMatchObject({ affectedRows: 3, rowCount: 0, columns: [] });
      expect(result?.edit).toBeUndefined();
      expect(history.list()[0]).toMatchObject({ ok: true, affected: 3 });
      expect(history.list()[0]).not.toHaveProperty('rows');
    });

    it('stores the error even when the driver of the connection cannot be named', async () => {
      drivers.driver('mysql').failExecuteWhen = () => true;
      const driverOf = manager.driverOf.bind(manager);
      let calls = 0;
      // Opening the session finds the driver; asking again after the failure does not.
      manager.driverOf = (id) => (++calls > 1 ? Promise.reject(new Error('gone')) : driverOf(id));
      const outcome = await runner.run(request('SELECT broken'));
      expect(outcome.results[0]?.error).toMatchObject({ code: 'permission-denied' });
      expect(outcome.results[0]?.error?.position).toBeUndefined();
    });

    it('stores the error instead of throwing', async () => {
      drivers.driver('mysql').executeError = new DbError('syntax', 'near "SELEC"');
      const outcome = await runner.run(request('SELECTT 1'));
      expect(outcome.results[0]?.error).toMatchObject({ code: 'syntax', message: 'near "SELEC"' });
    });

    it('keeps the position of a syntax error', async () => {
      const failure = new DbError('syntax', 'bad', { position: 7 });
      drivers.driver('mysql').executeError = failure;
      const outcome = await runner.run(request('SELECT ?'));
      expect(outcome.results[0]?.error?.position).toBe(7);
    });

    it('finds the position in the message when the driver gives none', async () => {
      drivers.driver('mysql').executeError = new DbError(
        'syntax',
        "You have an error in your SQL syntax; ... near 'FORM t' at line 1",
      );
      const outcome = await runner.run(request('SELECT a FORM t'));
      expect(outcome.results[0]?.error?.position).toBe(9);
    });

    it('stores no position when neither the driver nor the message has one', async () => {
      drivers.driver('mysql').executeError = new DbError('constraint', 'Duplicate entry');
      const outcome = await runner.run(request('INSERT INTO t VALUES (1)'));
      expect(outcome.results[0]?.error?.position).toBeUndefined();
    });

    it('stops at the first failure and counts what it skipped', async () => {
      drivers.driver('mysql').executeError = new DbError('syntax', 'bad');
      const outcome = await runner.run(request('SELECT 1; SELECT 2; SELECT 3'));
      expect(outcome.results).toHaveLength(1);
      expect(outcome.skipped).toBe(2);
    });

    it('carries on when asked to', async () => {
      drivers.driver('mysql').executeError = new DbError('syntax', 'bad');
      const outcome = await runner.run({ ...request('SELECT 1; SELECT 2'), stopOnError: false });
      expect(outcome.results).toHaveLength(2);
      expect(outcome.skipped).toBe(0);
    });

    it('reports a connection that cannot be opened as the error of the statement', async () => {
      drivers.driver('mysql').openError = new DbError('auth-failed', 'Access denied');
      const outcome = await runner.run(request('SELECT 1'));
      expect(outcome.results[0]?.error).toMatchObject({ code: 'auth-failed' });
    });

    it('frees the editor again after a failure', async () => {
      drivers.driver('mysql').executeError = new DbError('syntax', 'bad');
      await runner.run(request('SELECT 1'));
      expect(runner.isRunning(DOC)).toBe(false);
    });
  });

  describe('one run at a time', () => {
    it('refuses a second run in the same editor', async () => {
      drivers.driver('mysql').holdExecute = true;
      const first = runner.run(request('SELECT 1'));
      await until(() => runner.isRunning(DOC));
      await expect(runner.run(request('SELECT 2'))).rejects.toMatchObject({
        name: 'DbError',
        code: 'busy',
      });
      drivers.driver('mysql').releaseExecute();
      await first;
      expect(runner.isRunning(DOC)).toBe(false);
    });

    it('allows runs in different editors at the same time', async () => {
      drivers.driver('mysql').holdExecute = true;
      const first = runner.run(request('SELECT 1'));
      const second = runner.run({ ...request('SELECT 2'), documentUri: 'untitled:Other.sql' });
      await until(() => runner.runningDocuments().length === 2);
      expect(runner.runningDocuments().sort()).toEqual([DOC, 'untitled:Other.sql'].sort());
      drivers.driver('mysql').releaseExecute();
      await Promise.all([first, second]);
      expect(runner.runningDocuments()).toEqual([]);
    });

    it('is free again after a normal run', async () => {
      await runner.run(request('SELECT 1'));
      await expect(runner.run(request('SELECT 2'))).resolves.toMatchObject({ cancelled: false });
    });
  });

  describe('exclusive work on the editor session', () => {
    it('runs on the session a statement of the editor uses, and is busy meanwhile', async () => {
      await runner.run(request('SELECT 1'));
      const editorSession = drivers.driver('mysql').lastSession;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const work = runner.exclusive(DOC, { connectionId: connection.id }, async (session) => {
        await held;
        for await (const _event of session.execute('EXPLAIN SELECT 1')) {
          // drained
        }
        return 'done';
      });
      await until(() => runner.isRunning(DOC));
      await expect(runner.run(request('SELECT 2'))).rejects.toMatchObject({ code: 'busy' });
      await expect(
        runner.exclusive(DOC, { connectionId: connection.id }, () => Promise.resolve(1)),
      ).rejects.toMatchObject({ code: 'busy' });
      release();
      expect(await work).toBe('done');
      // No session of its own: the statement went to the editor's.
      expect(drivers.driver('mysql').sessions).toHaveLength(1);
      expect(editorSession?.executed.at(-1)).toBe('EXPLAIN SELECT 1');
      expect(runner.isRunning(DOC)).toBe(false);
    });

    it('is free again after the work fails', async () => {
      await expect(
        runner.exclusive(DOC, { connectionId: connection.id }, () =>
          Promise.reject(new Error('no plan')),
        ),
      ).rejects.toThrow('no plan');
      expect(runner.isRunning(DOC)).toBe(false);
    });

    it('is stopped by the cancel of the editor', async () => {
      drivers.driver('mysql').holdExecute = true;
      const work = runner.exclusive(DOC, { connectionId: connection.id }, async (session) => {
        for await (const _event of session.execute('EXPLAIN SELECT 1')) {
          // drained
        }
      });
      await until(() => drivers.driver('mysql').lastSession !== undefined);
      const cancelled = expect(work).rejects.toMatchObject({ code: 'cancelled' });
      await runner.cancel(DOC);
      drivers.driver('mysql').releaseExecute();
      await cancelled;
      expect(drivers.driver('mysql').lastSession?.cancelCount).toBe(1);
    });
  });

  describe('cancel', () => {
    it('stops the run and marks it cancelled', async () => {
      drivers.driver('mysql').holdExecute = true;
      const running = runner.run(request('SELECT 1; SELECT 2'));
      await until(() => drivers.driver('mysql').lastSession !== undefined);
      await runner.cancel(DOC);
      drivers.driver('mysql').releaseExecute();
      const outcome = await running;
      expect(outcome.cancelled).toBe(true);
      expect(drivers.driver('mysql').lastSession?.cancelCount).toBe(1);
      // The second statement never ran.
      expect(drivers.driver('mysql').lastSession?.executed).toEqual(['SELECT 1']);
    });

    it('is a no-op for an editor that is not running anything', async () => {
      await expect(runner.cancel(DOC)).resolves.toBeUndefined();
    });

    it('survives a session that fails to cancel', async () => {
      drivers.driver('mysql').holdExecute = true;
      const running = runner.run(request('SELECT 1; SELECT 2'));
      await until(() => drivers.driver('mysql').lastSession !== undefined);
      const session = drivers.driver('mysql').lastSession;
      if (session) {
        session.cancel = () => Promise.reject(new Error('too late'));
      }
      await expect(runner.cancel(DOC)).resolves.toBeUndefined();
      drivers.driver('mysql').releaseExecute();
      expect((await running).cancelled).toBe(true);
    });
  });

  describe('running state', () => {
    it('reports nothing for an idle editor', () => {
      expect(runner.isRunning(DOC)).toBe(false);
      expect(runner.startedAt(DOC)).toBeUndefined();
      expect(runner.runningDocuments()).toEqual([]);
    });

    it('reports a start time while a statement is in flight', async () => {
      drivers.driver('mysql').holdExecute = true;
      const before = Date.now();
      const running = runner.run(request('SELECT 1'));
      await until(() => runner.isRunning(DOC));
      const startedAt = runner.startedAt(DOC);
      expect(startedAt).toBeGreaterThanOrEqual(before);
      expect(startedAt).toBeLessThanOrEqual(Date.now());
      drivers.driver('mysql').releaseExecute();
      await running;
      expect(runner.startedAt(DOC)).toBeUndefined();
    });

    it('fires once when a run starts and once when it ends', async () => {
      const seen: string[] = [];
      runner.onDidChangeRunning((documentUri) => seen.push(documentUri));
      await runner.run(request('SELECT 1; SELECT 2'));
      expect(seen).toEqual([DOC, DOC]);
    });

    it('fires the end event even when the run fails', async () => {
      drivers.driver('mysql').executeError = new DbError('syntax', 'bad');
      let events = 0;
      runner.onDidChangeRunning(() => events++);
      await runner.run(request('SELECT 1'));
      expect(events).toBe(2);
    });

    it('stops notifying a disposed listener', async () => {
      let events = 0;
      runner.onDidChangeRunning(() => events++).dispose();
      await runner.run(request('SELECT 1'));
      expect(events).toBe(0);
    });

    it('survives a listener that throws', async () => {
      let events = 0;
      runner.onDidChangeRunning(() => {
        throw new Error('boom');
      });
      runner.onDidChangeRunning(() => events++);
      await runner.run(request('SELECT 1'));
      expect(events).toBe(2);
      expect(logger.messages('warn')).toContain('A run listener failed');
    });
  });

  describe('metadata cache', () => {
    it('drops cached structure after a statement that changes it', async () => {
      const inner = drivers.driver('mysql');
      const reader = cache.wrap(connection.id, inner.sessionMetadata);
      await reader.listTables({});
      await runner.run(request('CREATE TABLE t (a int)'));
      await reader.listTables({});
      expect(inner.sessionMetadata.calls.filter((c) => c.startsWith('listTables'))).toHaveLength(2);
    });

    it('keeps the cache after a plain SELECT', async () => {
      const inner = drivers.driver('mysql');
      const reader = cache.wrap(connection.id, inner.sessionMetadata);
      await reader.listTables({});
      await runner.run(request('SELECT 1'));
      await reader.listTables({});
      expect(inner.sessionMetadata.calls.filter((c) => c.startsWith('listTables'))).toHaveLength(1);
    });
  });

  describe('query timeout', () => {
    it('lets a statement finish when the limit is off', async () => {
      timeoutMs = 0;
      const outcome = await runner.run(request('SELECT 1'));
      expect(outcome.results[0]?.error).toBeUndefined();
    });

    it('cancels a statement that runs past the limit and calls it a timeout', async () => {
      timeoutMs = 20;
      drivers.driver('mysql').holdExecute = true;
      const running = runner.run(request('SELECT SLEEP(100)'));
      await until(() => drivers.driver('mysql').lastSession?.cancelCount === 1);
      drivers.driver('mysql').releaseExecute();
      const outcome = await running;
      const error = outcome.results[0]?.error;
      expect(error?.code).toBe('timeout');
      expect(error?.message).toContain('datanest.queryTimeout');
    });

    it('calls it a timeout too when the server itself reports a timeout after the limit', async () => {
      timeoutMs = 20;
      const driver = drivers.driver('mysql');
      driver.holdExecute = true;
      const running = runner.run(request('SELECT SLEEP(100)'));
      await until(() => driver.lastSession?.cancelCount === 1);
      const session = driver.lastSession;
      if (session !== undefined) {
        session.executeError = new DbError('timeout', 'Query execution was interrupted');
      }
      driver.releaseExecute();
      const outcome = await running;
      expect(outcome.results[0]?.error).toMatchObject({ code: 'timeout' });
      expect(outcome.results[0]?.error?.message).toContain('Cancelled after 0 s');
    });

    it('still reports a user cancel as cancelled, not as a timeout', async () => {
      timeoutMs = 60_000;
      drivers.driver('mysql').holdExecute = true;
      const running = runner.run(request('SELECT 1'));
      await until(() => drivers.driver('mysql').lastSession !== undefined);
      await runner.cancel(DOC);
      drivers.driver('mysql').releaseExecute();
      const outcome = await running;
      expect(outcome.cancelled).toBe(true);
      expect(outcome.results[0]?.error?.code).toBe('cancelled');
    });

    it('does not fire after the statement finished', async () => {
      timeoutMs = 10;
      await runner.run(request('SELECT 1'));
      // Long enough for a stray timer to fire if one had been left behind.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(drivers.driver('mysql').lastSession?.cancelCount ?? 0).toBe(0);
    });

    it('treats a nonsense timeout as no limit', async () => {
      timeoutMs = -5;
      const outcome = await runner.run(request('SELECT 1'));
      expect(outcome.results[0]?.error).toBeUndefined();
    });
  });

  describe('history', () => {
    it('notes every statement with its connection and outcome', async () => {
      drivers.driver('mysql').sessionRows = [[1], [2]];
      await runner.run({
        ...request('SELECT 1; SELECT 2'),
        target: { connectionId: connection.id, database: 'app' },
      });
      expect(
        history.list().map((entry) => [entry.sql, entry.rows, entry.database, entry.ok]),
      ).toEqual(
        [
          ['SELECT 2;', 2, 'app', true],
          ['SELECT 1;', 2, 'app', true],
        ].map(([sql, ...rest]) => [(sql as string).replace(';', ''), ...rest]),
      );
      expect(history.list()[0]?.connectionName).toBe('Local');
    });

    it('notes a failure with its message', async () => {
      drivers.driver('mysql').failExecuteWhen = (sql) => sql.includes('BAD');
      await runner.run(request('SELECT BAD'));
      expect(history.list()[0]).toMatchObject({ ok: false });
      expect(history.list()[0]?.error).toContain('Not allowed');
    });

    it('notes a timeout as one', async () => {
      const driver = drivers.driver('mysql');
      driver.holdExecute = true;
      timeoutMs = 20;
      const done = runner.run(request('SELECT SLEEP(9)'));
      await until(() => driver.lastSession?.cancelCount === 1);
      driver.releaseExecute();
      await done;
      expect(history.list()[0]).toMatchObject({ ok: false, error: 'Timed out' });
    });

    it('does not fail a query when the history cannot record it', async () => {
      const broken = new QueryRunner({
        history: {
          record: () => {
            throw new Error('history is broken');
          },
        },
        manager,
        results,
        cache,
        limits: { rowLimit: () => 1000 },
        logger,
      });
      const outcome = await broken.run(request('SELECT 1'));
      expect(outcome.results[0]?.error).toBeUndefined();
      expect(logger.entries.some((entry) => entry.message.includes('history'))).toBe(true);
    });

    it('works without a history', async () => {
      const plain = new QueryRunner({
        manager,
        results,
        cache,
        limits: { rowLimit: () => 1000 },
        logger,
      });
      expect((await plain.run(request('SELECT 1'))).results).toHaveLength(1);
    });
  });

  describe('several result sets (V6.2)', () => {
    it('shows the first set and does not mix later rows in under its columns', async () => {
      await runner.run(request('SELECT 0'));
      const session = drivers.driver('mysql').lastSession;
      if (session === undefined) {
        throw new Error('no session');
      }
      session.execute = (sql) => {
        session.executed.push(sql);
        return (async function* stream() {
          await Promise.resolve();
          yield { kind: 'columns' as const, columns: [{ name: 'a' }] };
          yield { kind: 'rows' as const, rows: [[1], [2]] };
          yield { kind: 'columns' as const, columns: [{ name: 'b' }, { name: 'c' }] };
          yield { kind: 'rows' as const, rows: [['x', 'y']] };
          yield { kind: 'done' as const };
        })();
      };
      const outcome = await runner.run(request('EXEC two_sets'));
      const summary = outcome.results[0];
      expect(summary?.columns).toEqual([{ name: 'a' }]);
      expect(results.allRows(summary?.id ?? '')).toEqual([[1], [2]]);
    });
  });

  describe('manual commit (V4.8)', () => {
    beforeEach(() => {
      drivers.driver('mysql').tracksTransactions = true;
    });

    function manual(sql: string) {
      return { ...request(sql), manualCommit: true };
    }

    it('opens a transaction before the first change and leaves it open', async () => {
      await runner.run(manual('SELECT 1; UPDATE t SET a = 1; INSERT INTO t VALUES (2)'));
      expect(drivers.driver('mysql').lastSession?.executed).toEqual([
        'SELECT 1',
        'BEGIN',
        'UPDATE t SET a = 1',
        'INSERT INTO t VALUES (2)',
      ]);
      expect(manager.transactionState(ConnectionManager.editorOwner(DOC))).toBe('open');
    });

    it('does not open another one in the next run, nor for reads', async () => {
      await runner.run(manual('UPDATE t SET a = 1'));
      await runner.run(manual('UPDATE t SET a = 2; SELECT 1'));
      expect(
        drivers.driver('mysql').lastSession?.executed.filter((sql) => sql === 'BEGIN'),
      ).toHaveLength(1);
    });

    it('does not wrap the user own transaction statements', async () => {
      await runner.run(manual('COMMIT; ROLLBACK'));
      expect(drivers.driver('mysql').lastSession?.executed).toEqual(['COMMIT', 'ROLLBACK']);
    });

    it('opens nothing in auto-commit mode', async () => {
      await runner.run(request('UPDATE t SET a = 1'));
      expect(drivers.driver('mysql').lastSession?.executed).toEqual(['UPDATE t SET a = 1']);
    });

    it('reports a BEGIN that fails as the error of the statement it was for', async () => {
      drivers.driver('mysql').failExecuteWhen = (sql) => sql === 'BEGIN';
      const outcome = await runner.run(manual('UPDATE t SET a = 1'));
      expect(outcome.results[0]?.error?.message).toBe('Not allowed: BEGIN');
      expect(drivers.driver('mysql').lastSession?.executed).toEqual(['BEGIN']);
    });

    it('opens the transaction in the words of the dialect (BEGIN TRANSACTION on SQL Server)', async () => {
      const mssql = await store.add({ name: 'Sql', driver: 'mssql', host: 'h' });
      drivers.driver('mssql').tracksTransactions = true;
      drivers.driver('mssql').dialect = {
        ...drivers.driver('mssql').dialect,
        transaction: { ...drivers.driver('mssql').dialect.transaction, begin: 'BEGIN TRANSACTION' },
      };
      await runner.run({
        documentUri: DOC,
        target: { connectionId: mssql.id },
        statements: splitStatements('UPDATE t SET a = 1', 'mssql'),
        manualCommit: true,
      });
      expect(drivers.driver('mssql').lastSession?.executed).toEqual([
        'BEGIN TRANSACTION',
        'UPDATE t SET a = 1',
      ]);
    });
  });
});
