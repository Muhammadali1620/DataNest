import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { doc, int32 } from '../../../../src/core/mongo/value';
import { ManagedMongoSession } from '../../../../src/services/mongodb/managed-mongo-session';
import { FakeMongoSession } from '../../../helpers/fake-mongo';

describe('ManagedMongoSession (V7.5)', () => {
  let inner: FakeMongoSession;
  let lost: unknown[];
  let closed: number;

  function managed(keepAliveMs = 0): ManagedMongoSession {
    return new ManagedMongoSession(inner, {
      onLinkLost: (error) => lost.push(error),
      onClosed: () => {
        closed += 1;
        return Promise.resolve();
      },
      keepAliveMs,
    });
  }

  beforeEach(() => {
    inner = new FakeMongoSession();
    lost = [];
    closed = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes every call through and shows what the server said about itself', async () => {
    inner.databases = [{ name: 'shop' }];
    const session = managed();
    expect(session.mode).toBe('direct');
    expect(session.server.version).toBe('8.2.12');
    expect(await session.listDatabases()).toEqual([{ name: 'shop' }]);
    await session.command('shop', doc([['ping', int32(1)]]));
    expect(inner.commands).toEqual(['shop: { ping: 1 }']);
  });

  it('tells the manager once a call finds the link gone, and still fails the call', async () => {
    const session = managed();
    inner.failure = new DbError('connection-failed', 'socket closed');
    await expect(session.listCollections('shop')).rejects.toMatchObject({
      code: 'connection-failed',
    });
    expect(lost).toHaveLength(1);
  });

  it('does not drop the session for an error the server sent', async () => {
    const session = managed();
    inner.failure = new DbError('permission-denied', 'not authorized');
    await expect(session.listIndexes('shop', 'orders')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(lost).toHaveLength(0);
  });

  it('watches the cursors it opens as well', async () => {
    inner.documents.set('shop.orders', [doc([['_id', int32(1)]])]);
    const session = managed();
    const cursor = await session.openCursor('shop', { kind: 'find', collection: 'orders' });
    expect((await cursor.next(10)).documents).toHaveLength(1);
    inner.failure = new DbError('connection-failed', 'gone');
    await expect(cursor.next(10)).rejects.toMatchObject({ code: 'connection-failed' });
    await expect(cursor.close()).resolves.toBeUndefined();
    expect(lost).toHaveLength(1);
  });

  it('pings after a quiet spell, and again after the next one', async () => {
    vi.useFakeTimers();
    const session = managed(1000);
    session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(999);
    expect(inner.commands).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(inner.commands).toEqual(['admin: { ping: 1 }']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(inner.commands).toHaveLength(2);
  });

  it('never pings without a keep-alive', async () => {
    vi.useFakeTimers();
    managed(0).scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inner.commands).toEqual([]);
  });

  it('reports a ping that finds the link gone', async () => {
    vi.useFakeTimers();
    const session = managed(500);
    session.scheduleKeepAlive();
    inner.failure = new DbError('connection-failed', 'gone');
    await vi.advanceTimersByTimeAsync(500);
    expect(lost).toHaveLength(1);
  });

  it('stops pinging and lets go of its tunnel when closed', async () => {
    vi.useFakeTimers();
    const session = managed(500);
    session.scheduleKeepAlive();
    await session.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(inner.commands).toEqual([]);
    expect(inner.closed).toBe(true);
    expect(closed).toBe(1);
  });
});
