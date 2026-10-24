import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ConnectionConfig } from '../../../src/core/model/connection';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { FakeDriverProvider, linkLostError } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Only reaching the end matters here.
  }
}

describe('ConnectionManager', () => {
  let store: ConnectionStore;
  let secrets: FakeSecretStorage;
  let drivers: FakeDriverProvider;
  let logger: RecordingLogger;
  let manager: ConnectionManager;
  let mysql: ConnectionConfig;

  beforeEach(async () => {
    secrets = new FakeSecretStorage();
    logger = new RecordingLogger();
    store = new ConnectionStore({ state: new FakeMemento(), secrets, logger });
    drivers = new FakeDriverProvider();
    manager = new ConnectionManager({ store, drivers, logger });
    mysql = await store.add(
      {
        name: 'Local',
        driver: 'mysql',
        host: '127.0.0.1',
        port: 7306,
        user: 'root',
        database: 'app',
      },
      'secret',
    );
  });

  describe('acquire', () => {
    it('opens a session on first use and reuses it for the same owner', async () => {
      const first = await manager.acquire('editor:a', { connectionId: mysql.id });
      const second = await manager.acquire('editor:a', { connectionId: mysql.id });
      expect(second).toBe(first);
      expect(drivers.driver('mysql').sessions).toHaveLength(1);
    });

    it('gives every owner its own session', async () => {
      const a = await manager.acquire('editor:a', { connectionId: mysql.id });
      const b = await manager.acquire('editor:b', { connectionId: mysql.id });
      expect(a).not.toBe(b);
      expect(drivers.driver('mysql').sessions).toHaveLength(2);
    });

    it('passes the stored password and database to the driver', async () => {
      await manager.acquire('editor:a', { connectionId: mysql.id });
      expect(drivers.driver('mysql').opened[0]).toMatchObject({
        host: '127.0.0.1',
        port: 7306,
        user: 'root',
        database: 'app',
        password: 'secret',
      });
    });

    it('omits the password when none is stored', async () => {
      const bare = await store.add({ name: 'Bare', driver: 'mysql', host: 'h' });
      await manager.acquire('editor:a', { connectionId: bare.id });
      expect(drivers.driver('mysql').opened[0]).not.toHaveProperty('password');
    });

    it('overrides the database when the target asks for another one', async () => {
      await manager.acquire('editor:a', { connectionId: mysql.id, database: 'other' });
      expect(drivers.driver('mysql').opened[0]?.database).toBe('other');
    });

    it('replaces the session when the same owner switches database', async () => {
      const first = await manager.acquire('editor:a', { connectionId: mysql.id });
      const second = await manager.acquire('editor:a', {
        connectionId: mysql.id,
        database: 'other',
      });
      expect(second).not.toBe(first);
      expect(drivers.driver('mysql').sessions[0]?.isClosed).toBe(true);
      expect(drivers.driver('mysql').sessions).toHaveLength(2);
    });

    it('shares one open between concurrent callers', async () => {
      const [a, b] = await Promise.all([
        manager.acquire('editor:a', { connectionId: mysql.id }),
        manager.acquire('editor:a', { connectionId: mysql.id }),
      ]);
      expect(a).toBe(b);
      expect(drivers.driver('mysql').sessions).toHaveLength(1);
    });

    it('rejects an unknown connection id', async () => {
      await expect(manager.acquire('editor:a', { connectionId: 'missing' })).rejects.toMatchObject({
        name: 'DbError',
        code: 'not-found',
      });
    });

    it('reports a failed open as connection-failed and allows a retry', async () => {
      const driver = drivers.driver('mysql');
      driver.openError = new Error('server down');
      await expect(manager.acquire('editor:a', { connectionId: mysql.id })).rejects.toMatchObject({
        code: 'connection-failed',
      });
      expect(manager.getState(mysql.id)).toMatchObject({ status: 'error' });
      driver.openError = undefined;
      await manager.acquire('editor:a', { connectionId: mysql.id });
      expect(manager.getState(mysql.id).status).toBe('connected');
    });

    it('keeps a driver error code instead of masking it', async () => {
      drivers.driver('mysql').openError = new DbError('auth-failed', 'Access denied');
      await expect(manager.acquire('editor:a', { connectionId: mysql.id })).rejects.toMatchObject({
        code: 'auth-failed',
      });
    });
  });

  describe('state', () => {
    it('is disconnected until something connects', () => {
      expect(manager.getState(mysql.id)).toEqual({ status: 'disconnected' });
      expect(manager.connectedIds()).toEqual([]);
    });

    it('reports connecting, then connected', async () => {
      const seen: string[] = [];
      manager.onDidChangeState((id) => seen.push(`${id}:${manager.getState(id).status}`));
      await manager.connect(mysql.id);
      expect(seen).toEqual([`${mysql.id}:connecting`, `${mysql.id}:connected`]);
      expect(manager.connectedIds()).toEqual([mysql.id]);
    });

    it('stops notifying a disposed listener', async () => {
      let fired = 0;
      const subscription = manager.onDidChangeState(() => fired++);
      subscription.dispose();
      await manager.connect(mysql.id);
      expect(fired).toBe(0);
    });

    it('survives a throwing listener and logs it', async () => {
      let fired = 0;
      manager.onDidChangeState(() => {
        throw new Error('boom');
      });
      manager.onDidChangeState(() => fired++);
      await manager.connect(mysql.id);
      expect(fired).toBeGreaterThan(0);
      expect(logger.messages('warn')).toContain('A connection state listener failed');
    });
  });

  describe('release and disconnect', () => {
    it('closes the session of one owner and leaves others connected', async () => {
      await manager.acquire('editor:a', { connectionId: mysql.id });
      await manager.acquire('editor:b', { connectionId: mysql.id });
      await manager.release('editor:a');
      expect(drivers.driver('mysql').sessions[0]?.isClosed).toBe(true);
      expect(manager.getState(mysql.id).status).toBe('connected');
    });

    it('goes back to disconnected when the last session is released', async () => {
      await manager.acquire('editor:a', { connectionId: mysql.id });
      await manager.release('editor:a');
      expect(manager.getState(mysql.id)).toEqual({ status: 'disconnected' });
      expect(manager.connectedIds()).toEqual([]);
    });

    it('releasing an unknown owner is a no-op', async () => {
      await expect(manager.release('nobody')).resolves.toBeUndefined();
    });

    it('disconnect closes every session of the connection', async () => {
      await manager.acquire('editor:a', { connectionId: mysql.id });
      await manager.acquire('editor:b', { connectionId: mysql.id, database: 'other' });
      await manager.connect(mysql.id);
      await manager.disconnect(mysql.id);
      expect(drivers.driver('mysql').sessions.every((s) => s.isClosed)).toBe(true);
      expect(manager.getState(mysql.id)).toEqual({ status: 'disconnected' });
    });

    it('disconnecting an idle connection is a no-op', async () => {
      await expect(manager.disconnect(mysql.id)).resolves.toBeUndefined();
      expect(manager.getState(mysql.id)).toEqual({ status: 'disconnected' });
    });

    it('a failing close is logged but does not stop the caller', async () => {
      await manager.acquire('editor:a', { connectionId: mysql.id });
      const session = drivers.driver('mysql').lastSession;
      if (!session) {
        throw new Error('expected a session');
      }
      session.close = () => Promise.reject(new Error('socket gone'));
      await expect(manager.release('editor:a')).resolves.toBeUndefined();
      expect(logger.messages('warn').some((m) => m.includes('editor:a'))).toBe(true);
    });
  });

  describe('reconnect after a dropped link', () => {
    it('drops the dead session and opens a fresh one on the next acquire', async () => {
      const driver = drivers.driver('mysql');
      const session = await manager.acquire('editor:a', { connectionId: mysql.id });
      const first = driver.lastSession;
      if (!first) {
        throw new Error('expected a session');
      }
      first.executeError = linkLostError();
      await expect(drain(session.execute('SELECT 1'))).rejects.toMatchObject({
        code: 'connection-failed',
      });
      expect(manager.getState(mysql.id)).toMatchObject({ status: 'error' });

      const next = await manager.acquire('editor:a', { connectionId: mysql.id });
      expect(next).not.toBe(session);
      expect(driver.sessions).toHaveLength(2);
      expect(manager.getState(mysql.id).status).toBe('connected');
      await drain(next.execute('SELECT 1'));
    });

    it('never retries the statement that hit the broken link', async () => {
      const driver = drivers.driver('mysql');
      const session = await manager.acquire('editor:a', { connectionId: mysql.id });
      const first = driver.lastSession;
      if (!first) {
        throw new Error('expected a session');
      }
      first.executeError = linkLostError();
      await expect(drain(session.execute('INSERT INTO t VALUES (1)'))).rejects.toMatchObject({
        code: 'connection-failed',
      });
      // Exactly one attempt reached the driver, and no second session ran it.
      expect(first.executed).toEqual(['INSERT INTO t VALUES (1)']);
      expect(driver.sessions).toHaveLength(1);
    });

    it('keeps other owners of the same connection connected', async () => {
      const driver = drivers.driver('mysql');
      const a = await manager.acquire('editor:a', { connectionId: mysql.id });
      await manager.acquire('editor:b', { connectionId: mysql.id });
      const broken = driver.sessions[0];
      if (!broken) {
        throw new Error('expected a session');
      }
      broken.executeError = linkLostError();
      await expect(drain(a.execute('SELECT 1'))).rejects.toMatchObject({
        code: 'connection-failed',
      });
      expect(manager.getState(mysql.id).status).toBe('connected');
    });
  });

  describe('test', () => {
    it('opens a throwaway session, runs one statement and closes it', async () => {
      await manager.test({ name: 'probe', driver: 'mysql', host: 'h' }, 'pw');
      const driver = drivers.driver('mysql');
      expect(driver.opened[0]).toMatchObject({ host: 'h', password: 'pw' });
      expect(driver.lastSession?.executed).toEqual(['SELECT 1']);
      expect(driver.lastSession?.isClosed).toBe(true);
    });

    it('leaves saved connections and statuses untouched', async () => {
      await manager.test({ name: 'probe', driver: 'mysql', host: 'h' });
      expect(store.list()).toHaveLength(1);
      expect(manager.getState(mysql.id)).toEqual({ status: 'disconnected' });
      expect(manager.connectedIds()).toEqual([]);
    });

    it('propagates a failing statement and still closes the session', async () => {
      const driver = drivers.driver('mysql');
      driver.executeError = new DbError('permission-denied', 'No SELECT right');
      await expect(
        manager.test({ name: 'probe', driver: 'mysql', host: 'h' }),
      ).rejects.toMatchObject({ code: 'permission-denied' });
      expect(driver.lastSession?.isClosed).toBe(true);
    });

    it('propagates a failing open', async () => {
      drivers.driver('mysql').openError = new DbError('auth-failed', 'Access denied');
      await expect(
        manager.test({ name: 'probe', driver: 'mysql', host: 'h' }),
      ).rejects.toMatchObject({ code: 'auth-failed' });
    });

    it('fails when the driver bundle cannot be loaded', async () => {
      drivers.loadError = new DbError('internal', 'bundle missing');
      await expect(
        manager.test({ name: 'probe', driver: 'mysql', host: 'h' }),
      ).rejects.toMatchObject({ code: 'internal' });
    });
  });

  describe('driverOf', () => {
    it('returns the driver of a saved connection', async () => {
      const driver = await manager.driverOf(mysql.id);
      expect(driver.id).toBe('mysql');
    });

    it('rejects an unknown connection', async () => {
      await expect(manager.driverOf('missing')).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('dispose', () => {
    it('closes every session and refuses further work', async () => {
      await manager.acquire('editor:a', { connectionId: mysql.id });
      await manager.acquire('editor:b', { connectionId: mysql.id });
      manager.dispose();
      expect(drivers.driver('mysql').sessions.every((s) => s.isClosed)).toBe(true);
      expect(manager.getState(mysql.id)).toEqual({ status: 'disconnected' });
      await expect(manager.acquire('editor:c', { connectionId: mysql.id })).rejects.toMatchObject({
        code: 'internal',
      });
    });

    it('is idempotent', async () => {
      await manager.connect(mysql.id);
      manager.dispose();
      expect(() => {
        manager.dispose();
      }).not.toThrow();
    });

    it('closes a session that finished opening after dispose', async () => {
      const driver = drivers.driver('mysql');
      const pending = manager.acquire('editor:a', { connectionId: mysql.id });
      manager.dispose();
      await expect(pending).rejects.toMatchObject({ code: 'internal' });
      expect(driver.sessions[0]?.isClosed).toBe(true);
    });
  });

  describe('treeOwner', () => {
    it('builds a stable owner key per connection', () => {
      expect(ConnectionManager.treeOwner('abc')).toBe('tree:abc');
      expect(ConnectionManager.treeOwner('abc')).not.toBe(ConnectionManager.treeOwner('def'));
    });
  });
});
