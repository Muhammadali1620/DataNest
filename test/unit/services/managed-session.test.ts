import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ExecuteEvent } from '../../../src/drivers/driver';
import { KEEP_ALIVE_STATEMENT, ManagedSession } from '../../../src/services/managed-session';
import { FakeSession, linkLostError } from '../../helpers/fake-driver';

function managed(session: FakeSession) {
  const lost = vi.fn();
  return { session: new ManagedSession(session, { onLinkLost: lost }), lost };
}

async function collect(events: AsyncIterable<ExecuteEvent>): Promise<ExecuteEvent[]> {
  const seen: ExecuteEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

function fake(): FakeSession {
  return new FakeSession({ id: 'c1', name: 'c1', driver: 'mysql' });
}

describe('ManagedSession', () => {
  it('passes execute events through untouched', async () => {
    const inner = fake();
    const { session, lost } = managed(inner);
    const events = await collect(session.execute('SELECT 1'));
    expect(events.map((e) => e.kind)).toEqual(['columns', 'rows', 'done']);
    expect(inner.executed).toEqual(['SELECT 1']);
    expect(lost).not.toHaveBeenCalled();
  });

  it('reports a lost link from execute and rethrows the error', async () => {
    const inner = fake();
    inner.executeError = linkLostError();
    const { session, lost } = managed(inner);
    await expect(collect(session.execute('SELECT 1'))).rejects.toMatchObject({
      code: 'connection-failed',
    });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('does not report ordinary query errors as a lost link', async () => {
    const inner = fake();
    inner.executeError = new DbError('syntax', 'bad sql');
    const { session, lost } = managed(inner);
    await expect(collect(session.execute('SELECTT 1'))).rejects.toMatchObject({ code: 'syntax' });
    expect(lost).not.toHaveBeenCalled();
  });

  it('wraps non-DbError failures and reports nothing', async () => {
    const inner = fake();
    inner.executeError = new Error('weird');
    const { session, lost } = managed(inner);
    await expect(collect(session.execute('SELECT 1'))).rejects.toBeInstanceOf(DbError);
    expect(lost).not.toHaveBeenCalled();
  });

  it('delegates cancel and close', async () => {
    const inner = fake();
    const { session } = managed(inner);
    await session.cancel();
    await session.close();
    expect(inner.cancelCount).toBe(1);
    expect(inner.closeCount).toBe(1);
  });

  describe('metadata', () => {
    it('passes readers through', async () => {
      const inner = fake();
      const { session } = managed(inner);
      expect(await session.metadata.listDatabases()).toEqual(['main']);
      expect(await session.metadata.listTables({ database: 'main' })).toEqual([
        { name: 'customers', kind: 'table' },
      ]);
      expect(await session.metadata.listColumns({ name: 'customers' })).toHaveLength(1);
      expect(inner.metadata.calls).toEqual([
        'listDatabases',
        'listTables:main/',
        'listColumns:customers',
      ]);
    });

    it('reports a lost link from any reader', async () => {
      const inner = fake();
      inner.metadata.error = linkLostError();
      const { session, lost } = managed(inner);
      await expect(session.metadata.listDatabases()).rejects.toMatchObject({
        code: 'connection-failed',
      });
      await expect(session.metadata.listSchemas()).rejects.toMatchObject({
        code: 'connection-failed',
      });
      await expect(session.metadata.listTables({})).rejects.toMatchObject({
        code: 'connection-failed',
      });
      await expect(session.metadata.listColumns({ name: 't' })).rejects.toMatchObject({
        code: 'connection-failed',
      });
      await expect(session.metadata.listObjects({}, 'function')).rejects.toMatchObject({
        code: 'connection-failed',
      });
      await expect(session.metadata.listIndexes({ name: 't' })).rejects.toMatchObject({
        code: 'connection-failed',
      });
      await expect(
        session.metadata.getDefinition({ kind: 'table', name: 't' }),
      ).rejects.toMatchObject({ code: 'connection-failed' });
      await expect(session.metadata.getTableDump({ name: 't' })).rejects.toMatchObject({
        code: 'connection-failed',
      });
      await expect(session.metadata.listTypeDumps({})).rejects.toMatchObject({
        code: 'connection-failed',
      });
      expect(lost).toHaveBeenCalledTimes(9);
    });

    it('passes the structure readers of V3 through', async () => {
      const inner = fake();
      inner.metadata.objects = [{ name: 'f', kind: 'function' }];
      inner.metadata.indexes = [{ name: 'i', columns: ['a'], unique: false, primary: false }];
      inner.metadata.definitions.set('function:f', ['CREATE FUNCTION f']);
      const { session } = managed(inner);
      expect(await session.metadata.listObjects({}, 'function')).toEqual([
        { name: 'f', kind: 'function' },
      ]);
      expect(await session.metadata.listObjects({}, 'event')).toEqual([]);
      expect(await session.metadata.listIndexes({ name: 't' })).toHaveLength(1);
      expect(await session.metadata.getDefinition({ kind: 'function', name: 'f' })).toEqual([
        'CREATE FUNCTION f',
      ]);
    });

    it('passes the dump readers of V5 through', async () => {
      const inner = fake();
      const parts = { before: [], create: ['CREATE TABLE t'], after: [], owns: [] };
      inner.metadata.tableDumps.set('t', parts);
      inner.metadata.typeDumps = [{ name: 'm', create: 'CREATE TYPE m', drop: 'DROP TYPE m' }];
      const { session } = managed(inner);
      expect(await session.metadata.getTableDump({ name: 't' })).toEqual(parts);
      expect(await session.metadata.listTypeDumps({}, ['t'])).toHaveLength(1);
    });

    it('keeps unsupported readers as plain errors', async () => {
      const inner = fake();
      inner.metadata.error = new DbError('unsupported', 'no schemas here');
      const { session, lost } = managed(inner);
      await expect(session.metadata.listSchemas()).rejects.toMatchObject({
        code: 'unsupported',
      });
      expect(lost).not.toHaveBeenCalled();
    });
  });

  describe('transactions (V4.8)', () => {
    it('reports what the driver says and tells the owner when it changes', async () => {
      const inner = fake();
      inner.tracksTransactions = true;
      const changes: string[] = [];
      const session = new ManagedSession(inner, {
        onLinkLost: () => undefined,
        onTransaction: (state) => changes.push(state),
      });
      expect(session.transactionState()).toBe('idle');
      await collect(session.execute('BEGIN'));
      await collect(session.execute('UPDATE t SET a = 1'));
      expect(session.transactionState()).toBe('open');
      await collect(session.execute('COMMIT'));
      expect(changes).toEqual(['open', 'idle']);
    });

    it('tells the owner about a transaction a failed statement spoiled', async () => {
      const inner = fake();
      inner.tracksTransactions = true;
      const changes: string[] = [];
      const session = new ManagedSession(inner, {
        onLinkLost: () => undefined,
        onTransaction: (state) => changes.push(state),
      });
      await collect(session.execute('BEGIN'));
      inner.failExecuteWhen = (sql) => sql.startsWith('INSERT');
      await expect(collect(session.execute('INSERT INTO t VALUES (1)'))).rejects.toThrow();
      expect(changes).toEqual(['open', 'failed']);
    });

    it('stays silent for a driver that cannot tell', async () => {
      const onTransaction = vi.fn();
      const session = new ManagedSession(fake(), { onLinkLost: () => undefined, onTransaction });
      await collect(session.execute('BEGIN'));
      expect(session.transactionState()).toBeUndefined();
      expect(onTransaction).not.toHaveBeenCalled();
    });
  });

  describe('keep-alive (V4.9)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function keeping(inner: FakeSession, ms = 1000) {
      const lost = vi.fn();
      const session = new ManagedSession(inner, { onLinkLost: lost, keepAliveMs: ms });
      session.scheduleKeepAlive();
      return { session, lost };
    }

    it('sends SELECT 1 after each stretch of quiet', async () => {
      const inner = fake();
      keeping(inner);
      await vi.advanceTimersByTimeAsync(999);
      expect(inner.executed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(inner.executed).toEqual([KEEP_ALIVE_STATEMENT]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(inner.executed).toEqual([KEEP_ALIVE_STATEMENT, KEEP_ALIVE_STATEMENT]);
    });

    it('counts quiet from the end of the last statement, and never pings during one', async () => {
      const inner = fake();
      let release: () => void = () => undefined;
      inner.gate = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const { session } = keeping(inner);
      const running = collect(session.execute('SELECT sleep(5)'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(inner.executed).toEqual(['SELECT sleep(5)']);
      inner.gate = undefined;
      release();
      await running;
      await vi.advanceTimersByTimeAsync(999);
      expect(inner.executed).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(inner.executed.at(-1)).toBe(KEEP_ALIVE_STATEMENT);
    });

    it('reports a dead link it finds and stops', async () => {
      const inner = fake();
      inner.executeError = linkLostError();
      const { lost } = keeping(inner);
      await vi.advanceTimersByTimeAsync(1000);
      expect(lost).toHaveBeenCalledTimes(1);
    });

    it('lets other errors pass and keeps pinging', async () => {
      const inner = fake();
      inner.failExecuteWhen = () => true;
      const { lost } = keeping(inner);
      await vi.advanceTimersByTimeAsync(2000);
      expect(lost).not.toHaveBeenCalled();
      expect(inner.executed).toHaveLength(2);
    });

    it('stops when closed, and does nothing without an interval', async () => {
      const inner = fake();
      const { session } = keeping(inner);
      await session.close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(inner.executed).toEqual([]);
      const quiet = fake();
      new ManagedSession(quiet, { onLinkLost: () => undefined }).scheduleKeepAlive();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(quiet.executed).toEqual([]);
    });
  });
});
