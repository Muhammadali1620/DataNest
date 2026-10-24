import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ExecuteEvent } from '../../../src/drivers/driver';
import { ManagedSession } from '../../../src/services/managed-session';
import { FakeSession, linkLostError } from '../../helpers/fake-driver';

function managed(session: FakeSession) {
  const lost = vi.fn();
  return { session: new ManagedSession(session, lost), lost };
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
      expect(lost).toHaveBeenCalledTimes(4);
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
});
