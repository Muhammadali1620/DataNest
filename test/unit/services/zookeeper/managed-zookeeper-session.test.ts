import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { ZookeeperSession, ZookeeperStat } from '../../../../src/drivers/zookeeper-driver';
import { ManagedZookeeperSession } from '../../../../src/services/zookeeper/managed-zookeeper-session';

const STAT: ZookeeperStat = {
  czxid: '1',
  mzxid: '1',
  pzxid: '1',
  ctime: 1,
  mtime: 1,
  version: 0,
  cversion: 0,
  aversion: 0,
  ephemeralOwner: '0',
  dataLength: 0,
  numChildren: 0,
};

function inner(overrides: Partial<ZookeeperSession> = {}): ZookeeperSession {
  return {
    server: { sessionId: '7', sessionTimeoutMs: 15_000, readOnly: false, address: 'h:2181' },
    children: () => Promise.resolve({ names: ['a'], stat: STAT }),
    getData: () => Promise.resolve({ data: new Uint8Array([1]), stat: STAT }),
    exists: () => Promise.resolve(STAT),
    getAcl: () => Promise.resolve({ acl: [], stat: STAT }),
    setAcl: () => Promise.resolve(STAT),
    serverVersion: () => Promise.resolve('3.9.3'),
    watchNode: () => Promise.resolve(() => undefined),
    create: (path) => Promise.resolve(path),
    setData: () => Promise.resolve(STAT),
    remove: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

describe('ManagedZookeeperSession', () => {
  it('hands every call to the session below and shows its server', async () => {
    const managed = new ManagedZookeeperSession(inner(), { onLinkLost: () => undefined });
    expect(managed.server.sessionId).toBe('7');
    expect((await managed.children('/')).names).toEqual(['a']);
    expect((await managed.getData('/')).data).toEqual(new Uint8Array([1]));
    expect(await managed.exists('/')).toBe(STAT);
    expect((await managed.getAcl('/')).acl).toEqual([]);
    expect(await managed.create('/x', new Uint8Array(), 'persistent')).toBe('/x');
    expect(await managed.setData('/x', new Uint8Array(), 0)).toBe(STAT);
    await managed.remove('/x', -1);
    expect(await managed.setAcl('/x', [], 0)).toBe(STAT);
    expect(await managed.serverVersion()).toBe('3.9.3');
  });

  it('tells the manager when a change of ACL finds the link lost', async () => {
    const lost = vi.fn();
    const managed = new ManagedZookeeperSession(
      inner({ setAcl: () => Promise.reject(new DbError('connection-failed', 'gone')) }),
      { onLinkLost: lost },
    );
    await expect(managed.setAcl('/x', [], 0)).rejects.toMatchObject({ code: 'connection-failed' });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('does not take a failed version question for a lost link', async () => {
    const lost = vi.fn();
    const managed = new ManagedZookeeperSession(
      inner({ serverVersion: () => Promise.reject(new Error('refused')) }),
      { onLinkLost: lost },
    );
    expect(await managed.serverVersion()).toBeUndefined();
    expect(lost).not.toHaveBeenCalled();
  });

  it('tells the manager when the link is lost, and still throws', async () => {
    const lost = vi.fn();
    const managed = new ManagedZookeeperSession(
      inner({
        exists: () => Promise.reject(new DbError('connection-failed', 'gone')),
      }),
      { onLinkLost: lost },
    );
    await expect(managed.exists('/')).rejects.toMatchObject({ code: 'connection-failed' });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('keeps quiet about an error that is not about the link', async () => {
    const lost = vi.fn();
    const managed = new ManagedZookeeperSession(
      inner({ getData: () => Promise.reject(new DbError('not-found', 'no node')) }),
      { onLinkLost: lost },
    );
    await expect(managed.getData('/x')).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      new ManagedZookeeperSession(inner({ remove: () => Promise.reject(new Error('plain')) }), {
        onLinkLost: lost,
      }).remove('/x', -1),
    ).rejects.toBeInstanceOf(DbError);
    expect(lost).not.toHaveBeenCalled();
  });

  it('runs the hook after it closed the session below, also when that fails', async () => {
    const order: string[] = [];
    const managed = new ManagedZookeeperSession(
      inner({
        close: () => {
          order.push('inner');
          return Promise.reject(new Error('already dead'));
        },
      }),
      {
        onLinkLost: () => undefined,
        onClosed: () => {
          order.push('hook');
          return Promise.resolve();
        },
      },
    );
    await expect(managed.close()).rejects.toThrow('already dead');
    expect(order).toEqual(['inner', 'hook']);
  });

  it('closes without a hook', async () => {
    await expect(
      new ManagedZookeeperSession(inner(), { onLinkLost: () => undefined }).close(),
    ).resolves.toBeUndefined();
  });
});

describe('ManagedZookeeperSession: watching', () => {
  it('hands the watch to the session below and returns how to let it go', async () => {
    const stop = vi.fn();
    const watchNode = vi.fn(() => Promise.resolve(stop));
    const managed = new ManagedZookeeperSession(inner({ watchNode }), {
      onLinkLost: () => undefined,
    });
    const onEvent = vi.fn();
    const release = await managed.watchNode('/a', onEvent, () => undefined);
    expect(watchNode).toHaveBeenCalledWith('/a', onEvent, expect.any(Function));
    release();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('tells the manager, and the caller, when the session below loses the link', async () => {
    const lost = vi.fn();
    const heard = vi.fn();
    let onLost: (error: Error) => void = () => undefined;
    const managed = new ManagedZookeeperSession(
      inner({
        watchNode: (_path, _onEvent, callback) => {
          onLost = callback;
          return Promise.resolve(() => undefined);
        },
      }),
      { onLinkLost: lost },
    );
    await managed.watchNode('/a', () => undefined, heard);
    const error = new DbError('connection-failed', 'The connection to ZooKeeper was closed');
    onLost(error);
    expect(lost).toHaveBeenCalledWith(error);
    expect(heard).toHaveBeenCalledWith(error);
  });

  it('tells the manager when the watch cannot be set because the link is gone', async () => {
    const lost = vi.fn();
    const managed = new ManagedZookeeperSession(
      inner({ watchNode: () => Promise.reject(new DbError('connection-failed', 'gone')) }),
      { onLinkLost: lost },
    );
    await expect(
      managed.watchNode(
        '/a',
        () => undefined,
        () => undefined,
      ),
    ).rejects.toMatchObject({
      code: 'connection-failed',
    });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('does not call a refusal a lost link', async () => {
    const lost = vi.fn();
    const managed = new ManagedZookeeperSession(
      inner({ watchNode: () => Promise.reject(new DbError('permission-denied', 'no')) }),
      { onLinkLost: lost },
    );
    await expect(
      managed.watchNode(
        '/a',
        () => undefined,
        () => undefined,
      ),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(lost).not.toHaveBeenCalled();
  });
});
