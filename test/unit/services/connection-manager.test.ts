import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ConnectionConfig } from '../../../src/shared/connection';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { FakeDriverProvider, linkLostError } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { FakeTunnels, unreachable } from '../../helpers/fake-tunnels';
import type { HostKeyCheck } from '../../../src/services/tunnels';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { redisDatabaseOf } from '../../../src/services/connection-manager';
import { bulk, FakeRedisDriver } from '../../helpers/fake-redis';

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

  describe('SSH tunnels', () => {
    let tunnels: FakeTunnels;
    let checkHostKey: HostKeyCheck;

    const viaSsh = {
      name: 'Prod',
      driver: 'mysql' as const,
      host: 'db.internal',
      port: 3306,
      user: 'app',
      ssh: { id: 'main', host: 'bastion', user: 'deploy', auth: 'password' as const },
    };

    beforeEach(() => {
      tunnels = new FakeTunnels();
      checkHostKey = () => Promise.resolve(true);
      manager = new ConnectionManager({ store, drivers, logger, tunnels, checkHostKey });
    });

    it('connects the driver to the local tunnel port, checking TLS against the real host', async () => {
      const config = await store.add(viaSsh, 'dbpw', { main: { password: 'sshpw' } });
      await manager.acquire('editor:a', { connectionId: config.id });
      expect(drivers.driver('mysql').opened[0]).toMatchObject({
        host: '127.0.0.1',
        port: 40_000,
        tlsServerName: 'db.internal',
        password: 'dbpw',
      });
      const [first] = tunnels.acquired;
      expect(first?.spec).toMatchObject({
        hops: [{ host: 'bastion', port: 22, user: 'deploy', auth: 'password', password: 'sshpw' }],
        target: { host: 'db.internal', port: 3306 },
        checkHostKey,
      });
    });

    it('asks for one lease per session and gives it back when the session closes', async () => {
      const config = await store.add(viaSsh);
      await manager.acquire('editor:a', { connectionId: config.id });
      await manager.acquire('editor:b', { connectionId: config.id });
      expect(tunnels.acquired.map((entry) => entry.key)).toHaveLength(2);
      expect(new Set(tunnels.acquired.map((entry) => entry.key)).size).toBe(1);
      await manager.release('editor:a');
      expect(tunnels.released).toHaveLength(1);
      await manager.disconnect(config.id);
      expect(tunnels.released).toHaveLength(2);
    });

    it('lets go of the tunnel when the link drops', async () => {
      const config = await store.add(viaSsh);
      drivers.driver('mysql').executeError = linkLostError();
      const session = await manager.acquire('editor:a', { connectionId: config.id });
      await expect(drain(session.execute('SELECT 1'))).rejects.toThrow();
      await vi.waitFor(() => {
        expect(tunnels.released).toHaveLength(1);
      });
    });

    it('uses another tunnel key once the SSH settings change', async () => {
      const config = await store.add(viaSsh);
      await manager.acquire('editor:a', { connectionId: config.id });
      await manager.disconnect(config.id);
      await store.update(config.id, { ...viaSsh, ssh: { ...viaSsh.ssh, host: 'bastion2' } });
      await manager.acquire('editor:a', { connectionId: config.id });
      const [before, after] = tunnels.acquired.map((entry) => entry.key);
      expect(before).not.toBe(after);
    });

    it('explains a failed open with the SSH reason and gives the lease back', async () => {
      const config = await store.add(viaSsh);
      tunnels.forwardFailure = unreachable();
      drivers.driver('mysql').openError = new DbError('connection-failed', 'Connection lost');
      await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
        message: expect.stringContaining('cannot reach db:3306') as unknown,
      });
      expect(tunnels.released).toHaveLength(1);
      expect(manager.getState(config.id).status).toBe('error');
    });

    it('keeps the driver error when the tunnel itself had no trouble', async () => {
      const config = await store.add(viaSsh);
      drivers.driver('mysql').openError = new DbError('auth-failed', 'Access denied');
      await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
        code: 'auth-failed',
      });
    });

    it('fails the connection when the tunnel cannot open', async () => {
      const config = await store.add(viaSsh);
      tunnels.openError = new DbError('auth-failed', 'SSH login failed');
      await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
        code: 'auth-failed',
      });
      expect(drivers.driver('mysql').opened).toHaveLength(0);
      expect(manager.getState(config.id)).toEqual({ status: 'error', error: 'SSH login failed' });
    });

    it('opens no tunnel for direct connections', async () => {
      await manager.acquire('editor:a', { connectionId: mysql.id });
      expect(tunnels.acquired).toHaveLength(0);
      expect(drivers.driver('mysql').opened[0]).not.toHaveProperty('tlsServerName');
    });

    it('refuses SSH connections when no tunnel provider is wired in', async () => {
      manager = new ConnectionManager({ store, drivers, logger });
      const config = await store.add(viaSsh);
      await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
        code: 'unsupported',
      });
    });

    it('tests through a private tunnel with the given secrets and closes it', async () => {
      await manager.test(viaSsh, 'dbpw', { main: { password: 'typed' } });
      const [tunnel] = tunnels.privates;
      expect(tunnel?.spec.hops[0]?.password).toBe('typed');
      expect(tunnel?.closeCount).toBe(1);
      expect(drivers.driver('mysql').opened[0]).toMatchObject({ host: '127.0.0.1', port: 40_000 });
      expect(tunnels.acquired).toHaveLength(0);
    });

    it('closes the private tunnel when the test fails, with the SSH reason', async () => {
      tunnels.forwardFailure = unreachable();
      drivers.driver('mysql').openError = new DbError('connection-failed', 'reset');
      await expect(manager.test(viaSsh)).rejects.toMatchObject({
        message: expect.stringContaining('cannot reach') as unknown,
      });
      expect(tunnels.privates[0]?.closeCount).toBe(1);
    });

    it('refuses every host key when no check is wired in', async () => {
      manager = new ConnectionManager({ store, drivers, logger, tunnels });
      const config = await store.add(viaSsh);
      await manager.acquire('editor:a', { connectionId: config.id });
      const check = tunnels.acquired[0]?.spec.checkHostKey;
      expect(
        await check?.({ host: 'h', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x' }),
      ).toBe(false);
    });
  });

  describe('isReadOnly', () => {
    it('follows the saved flag', async () => {
      expect(manager.isReadOnly(mysql.id)).toBe(false);
      await store.update(mysql.id, { ...mysql, readOnly: true });
      expect(manager.isReadOnly(mysql.id)).toBe(true);
      expect(manager.isReadOnly('missing')).toBe(false);
    });

    it('passes the flag to the driver, which opens the session read-only', async () => {
      await store.update(mysql.id, { ...mysql, readOnly: true });
      await manager.acquire('editor:a', { connectionId: mysql.id });
      expect(drivers.driver('mysql').opened[0]?.readOnly).toBe(true);
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

  describe('transactions (V4.8)', () => {
    beforeEach(() => {
      drivers.driver('mysql').tracksTransactions = true;
    });

    it('reports the state of an owner and every change', async () => {
      const changes: unknown[] = [];
      manager.onDidChangeTransaction((change) => changes.push(change));
      expect(manager.transactionState('editor:a')).toBeUndefined();
      const session = await manager.acquire('editor:a', { connectionId: mysql.id });
      expect(manager.transactionState('editor:a')).toBe('idle');
      await drain(session.execute('BEGIN'));
      expect(manager.transactionState('editor:a')).toBe('open');
      await drain(session.execute('ROLLBACK'));
      expect(changes).toEqual([
        { owner: 'editor:a', connectionId: mysql.id, state: 'open' },
        { owner: 'editor:a', connectionId: mysql.id, state: 'idle' },
      ]);
    });

    it('says the transaction ended when its session is closed', async () => {
      const changes: unknown[] = [];
      manager.onDidChangeTransaction((change) => changes.push(change));
      const session = await manager.acquire('editor:a', { connectionId: mysql.id });
      await drain(session.execute('BEGIN'));
      await manager.release('editor:a');
      expect(changes.at(-1)).toEqual({
        owner: 'editor:a',
        connectionId: mysql.id,
        state: 'idle',
        ended: 'closed',
      });
    });

    it('says the transaction was lost with the link', async () => {
      const changes: { ended?: string }[] = [];
      manager.onDidChangeTransaction((change) => changes.push(change));
      const session = await manager.acquire('editor:a', { connectionId: mysql.id });
      await drain(session.execute('BEGIN'));
      const inner = drivers.driver('mysql').lastSession;
      if (inner !== undefined) {
        inner.executeError = linkLostError();
      }
      await expect(drain(session.execute('SELECT 1'))).rejects.toThrow();
      expect(changes.map((change) => change.ended)).toContain('lost');
    });

    it('lists the owners of a connection that have a transaction to end', async () => {
      const a = await manager.acquire('editor:a', { connectionId: mysql.id });
      await manager.acquire('editor:b', { connectionId: mysql.id });
      expect(manager.ownersInTransaction(mysql.id)).toEqual([]);
      await drain(a.execute('BEGIN'));
      expect(manager.ownersInTransaction(mysql.id)).toEqual(['editor:a']);
      expect(manager.ownersInTransaction('other')).toEqual([]);
    });

    it('stays quiet when an idle session closes, and survives a failing listener', async () => {
      const seen = vi.fn();
      manager.onDidChangeTransaction(() => {
        throw new Error('boom');
      });
      manager.onDidChangeTransaction(seen);
      await manager.acquire('editor:a', { connectionId: mysql.id });
      await manager.release('editor:a');
      expect(seen).not.toHaveBeenCalled();
      const session = await manager.acquire('editor:b', { connectionId: mysql.id });
      await drain(session.execute('BEGIN'));
      expect(seen).toHaveBeenCalledTimes(1);
    });
  });

  describe('session setup (V4.9)', () => {
    beforeEach(() => {
      drivers.driver('mysql').dialect = mysqlDialect;
    });

    async function withOptions(options: object, extra: object = {}) {
      return await store.add({
        name: 'Opt',
        driver: 'mysql',
        host: 'h',
        ...extra,
        options,
      });
    }

    it('runs the time zone and init SQL on every new session before handing it out', async () => {
      const config = await withOptions({ timeZone: 'UTC', initSql: 'SET a = 1; SET b = 2' });
      await manager.acquire('editor:a', { connectionId: config.id });
      await manager.acquire('editor:b', { connectionId: config.id });
      for (const session of drivers.driver('mysql').sessions) {
        expect(session.executed).toEqual(["SET time_zone = 'UTC'", 'SET a = 1', 'SET b = 2']);
      }
    });

    it('fails the connect, closes the session and says which statement failed', async () => {
      const config = await withOptions({ initSql: 'SET broken = 1' });
      drivers.driver('mysql').failExecuteWhen = (sql) => sql.includes('broken');
      await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toThrow(
        'Init SQL failed at "SET broken = 1"',
      );
      expect(drivers.driver('mysql').lastSession?.isClosed).toBe(true);
      expect(manager.getState(config.id).status).toBe('error');
      expect(manager.sessionOf('editor:a')).toBeUndefined();
    });

    it('refuses init SQL that would lift read-only', async () => {
      const config = await withOptions(
        { initSql: 'SET SESSION TRANSACTION READ WRITE' },
        { readOnly: true },
      );
      await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toThrow(
        'may not change anything',
      );
    });

    it('checks the setup in Test too', async () => {
      drivers.driver('mysql').failExecuteWhen = (sql) => sql.startsWith('SET time_zone');
      await expect(
        manager.test({ name: 't', driver: 'mysql', host: 'h', options: { timeZone: 'Mars' } }),
      ).rejects.toThrow('refused the time zone "Mars"');
    });

    it('keeps idle sessions alive when the connection asks', async () => {
      vi.useFakeTimers();
      try {
        const config = await withOptions({ keepAlive: 30 });
        await manager.acquire('editor:a', { connectionId: config.id });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(drivers.driver('mysql').lastSession?.executed).toEqual(['SELECT 1']);
        await manager.release('editor:a');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(drivers.driver('mysql').lastSession?.executed).toEqual(['SELECT 1']);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('ConnectionManager with Redis (V7.1)', () => {
  let store: ConnectionStore;
  let drivers: FakeDriverProvider & { getRedis(): Promise<FakeRedisDriver> };
  let redis: FakeRedisDriver;
  let manager: ConnectionManager;
  let tunnels: FakeTunnels;
  let cache: ConnectionConfig;

  beforeEach(async () => {
    const logger = new RecordingLogger();
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    redis = new FakeRedisDriver();
    drivers = Object.assign(new FakeDriverProvider(), { getRedis: () => Promise.resolve(redis) });
    tunnels = new FakeTunnels();
    manager = new ConnectionManager({
      store,
      drivers,
      logger,
      tunnels,
      checkHostKey: () => Promise.resolve(true),
    });
    cache = await store.add({ name: 'Cache', driver: 'redis', host: 'h', database: '2' }, 'pw');
  });

  it('opens a Redis session with the stored password and the database the target names', async () => {
    const session = await manager.acquireRedis('tree:x', { connectionId: cache.id });
    expect(redis.opened[0]).toMatchObject({ host: 'h', password: 'pw', database: '2' });
    expect(await session.call(['GET', 'k'])).toEqual(bulk('OK'));
    expect(manager.getState(cache.id)).toEqual({ status: 'connected' });
    expect(manager.redisSessionOf('tree:x')).toBe(session);
    expect(manager.sessionOf('tree:x')).toBeUndefined();
    await manager.acquireRedis('tree:y', { connectionId: cache.id, database: '5' });
    expect(redis.opened[1]?.database).toBe('5');
  });

  it('adds the Sentinel password to what the driver gets', async () => {
    const sentinel = await store.add(
      { name: 'S', driver: 'redis', host: 's', redis: { mode: 'sentinel', masterName: 'm' } },
      undefined,
      {},
      { sentinelPassword: 'spw' },
    );
    await manager.acquireRedis('a', { connectionId: sentinel.id });
    expect(redis.opened[0]).toMatchObject({ sentinelPassword: 'spw' });
    expect(redis.opened[0]).not.toHaveProperty('password');
  });

  it('runs the init commands before handing the session out', async () => {
    const withInit = await store.add({
      name: 'I',
      driver: 'redis',
      host: 'h',
      options: { initSql: 'CLIENT SETNAME app' },
    });
    await manager.acquireRedis('a', { connectionId: withInit.id });
    expect(redis.sessions[0]?.calls).toEqual([['CLIENT', 'SETNAME', 'app']]);
  });

  it('closes the session when an init command fails, and reports the connection failed', async () => {
    redis = new FakeRedisDriver((words) =>
      words[0] === 'CLIENT' ? new DbError('permission-denied', 'NOPERM') : bulk('OK'),
    );
    const withInit = await store.add({
      name: 'I',
      driver: 'redis',
      host: 'h',
      options: { initSql: 'CLIENT SETNAME app' },
    });
    await expect(manager.acquireRedis('a', { connectionId: withInit.id })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(redis.sessions[0]?.closed).toBe(true);
    expect(manager.getState(withInit.id).status).toBe('error');
  });

  it('keeps SQL and Redis apart, in both directions', async () => {
    const sql = await store.add({ name: 'Db', driver: 'mysql', host: 'h' });
    await expect(manager.acquire('a', { connectionId: cache.id })).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('Redis connection') as unknown,
    });
    await expect(manager.acquireRedis('b', { connectionId: sql.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(manager.driverOf(cache.id)).rejects.toMatchObject({ code: 'unsupported' });
    expect(manager.familyOf(cache.id)).toBe('redis');
    expect(manager.familyOf(sql.id)).toBe('sql');
    expect(redis.opened).toEqual([]);
  });

  it('connects the tree on the database the connection names', async () => {
    await manager.connectAny(cache.id);
    expect(manager.redisSessionOf(ConnectionManager.treeOwner(cache.id, '2'))).toBeDefined();
    const sql = await store.add({ name: 'Db', driver: 'mysql', host: 'h' });
    await manager.connectAny(sql.id);
    expect(manager.sessionOf(ConnectionManager.treeOwner(sql.id))).toBeDefined();
  });

  it('closes every Redis session on disconnect', async () => {
    await manager.acquireRedis('a', { connectionId: cache.id });
    await manager.acquireRedis('b', { connectionId: cache.id });
    await manager.disconnect(cache.id);
    expect(redis.sessions.every((session) => session.closed)).toBe(true);
    expect(manager.getState(cache.id)).toEqual({ status: 'disconnected' });
    expect(manager.connectedIds()).toEqual([]);
  });

  it('drops a session whose link is gone, and opens a new one next time', async () => {
    const first = await manager.acquireRedis('a', { connectionId: cache.id });
    await redis.sessions[0]?.close();
    await expect(first.call(['PING'])).rejects.toMatchObject({ code: 'connection-failed' });
    expect(manager.redisSessionOf('a')).toBeUndefined();
    expect(manager.getState(cache.id).status).toBe('error');
    const second = await manager.acquireRedis('a', { connectionId: cache.id });
    expect(second).not.toBe(first);
    expect(redis.opened).toHaveLength(2);
  });

  it('goes through an SSH tunnel to one server', async () => {
    const tunnelled = await store.add({
      name: 'T',
      driver: 'redis',
      host: 'cache.internal',
      ssh: { id: 'b', host: 'bastion', user: 'u', auth: 'agent' },
    });
    await manager.acquireRedis('a', { connectionId: tunnelled.id });
    expect(redis.opened[0]).toMatchObject({
      host: '127.0.0.1',
      port: 40_000,
      tlsServerName: 'cache.internal',
    });
    await manager.disconnect(tunnelled.id);
    expect(tunnels.released).toHaveLength(1);
  });

  it('releases the tunnel when the driver cannot open', async () => {
    redis.openError = new DbError('auth-failed', 'WRONGPASS');
    const tunnelled = await store.add({
      name: 'T',
      driver: 'redis',
      host: 'cache.internal',
      ssh: { id: 'b', host: 'bastion', user: 'u', auth: 'agent' },
    });
    await expect(manager.acquireRedis('a', { connectionId: tunnelled.id })).rejects.toMatchObject({
      code: 'auth-failed',
    });
    expect(tunnels.released).toHaveLength(1);
  });

  it('tests settings with PING and closes the throwaway session', async () => {
    await manager.test(
      { name: 'p', driver: 'redis', host: 'h', redis: { mode: 'sentinel', masterName: 'm' } },
      'pw',
      {},
      'spw',
    );
    expect(redis.opened[0]).toMatchObject({ password: 'pw', sentinelPassword: 'spw' });
    expect(redis.sessions[0]?.calls).toEqual([['PING']]);
    expect(redis.sessions[0]?.closed).toBe(true);
    expect(manager.connectedIds()).toEqual([]);
  });

  it('fails a test whose init commands fail, still closing the session', async () => {
    redis = new FakeRedisDriver((words) =>
      words[0] === 'SET' ? new DbError('permission-denied', 'NOPERM') : bulk('OK'),
    );
    await expect(
      manager.test({ name: 'p', driver: 'redis', host: 'h', options: { initSql: 'SET a b' } }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(redis.sessions[0]?.closed).toBe(true);
  });

  it('says Redis is not available without the driver', async () => {
    const plain = new ConnectionManager({
      store,
      drivers: new FakeDriverProvider(),
      logger: new RecordingLogger(),
    });
    await expect(plain.acquireRedis('a', { connectionId: cache.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('redisDatabaseOf', () => {
  it('is the number the connection names, 0 without one', () => {
    expect(redisDatabaseOf({})).toBe('0');
    expect(redisDatabaseOf({ database: ' ' })).toBe('0');
    expect(redisDatabaseOf({ database: '03' })).toBe('3');
  });
});
