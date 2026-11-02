// A SQLite file on a server (V12.8) as the connection manager sees it: the copy is leased
// before the driver opens, the driver is pointed at it read-only, and the lease goes back
// whatever happens to the session.

import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import {
  ConnectionManager,
  DEFAULT_REMOTE_MAX_BYTES,
} from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import type {
  RemoteFileSpec,
  SnapshotLease,
  SnapshotProvider,
} from '../../../src/services/remote-snapshots';
import type { ExecChannel, ExecEnd, ExecOpener } from '../../../src/services/shell-types';
import type { Session } from '../../../src/drivers/driver';
import type { ConnectionConfig } from '../../../src/shared/connection';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

class FakeSnapshots implements SnapshotProvider {
  readonly acquired: { key: string; spec: RemoteFileSpec; remotePath: string; maxBytes: number }[] =
    [];
  released = 0;
  failWith: Error | undefined;
  readonly invalidated: string[] = [];
  private readonly generations = new Map<string, number>();

  invalidate(key: string): void {
    this.invalidated.push(key);
    this.generations.set(key, this.generation(key) + 1);
  }

  generation(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  acquire(
    key: string,
    spec: RemoteFileSpec,
    remotePath: string,
    maxBytes: number,
  ): Promise<SnapshotLease> {
    this.acquired.push({ key, spec, remotePath, maxBytes });
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    return Promise.resolve({
      path: `/local/copy-${this.acquired.length}/data.db`,
      bytes: 100,
      release: () => {
        this.released += 1;
        return Promise.resolve();
      },
    });
  }
}

/** A helper on the "server" that answers like the real one, and remembers what it was asked. */
class FakeExecs implements ExecOpener {
  readonly requests: Record<string, unknown>[] = [];
  readonly commands: string[] = [];
  channels = 0;
  closedChannels = 0;
  /** Makes the helper die at once with this status and message, like a server without python3. */
  dieWith: { code: number; stderr: string } | undefined;
  /** The answer to a statement; undefined: one row changed. */
  answer: ((sql: string) => Record<string, unknown>) | undefined;

  openExec(_spec: RemoteFileSpec, command: string): Promise<ExecChannel> {
    this.commands.push(command);
    this.channels += 1;
    const listeners: ((chunk: Buffer, error: boolean) => void)[] = [];
    let finish: (end: ExecEnd) => void = () => undefined;
    const closed = new Promise<ExecEnd>((resolve) => {
      finish = resolve;
    });
    const say = (text: string, error = false): void => {
      for (const listener of listeners) {
        listener(Buffer.from(text), error);
      }
    };
    const channel: ExecChannel = {
      closed,
      onData: (listener) => {
        listeners.push(listener);
      },
      write: (data) => {
        const request = JSON.parse(data) as Record<string, unknown>;
        this.requests.push(request);
        if (this.dieWith !== undefined) {
          say(this.dieWith.stderr, true);
          finish({ reason: 'exit', code: this.dieWith.code });
          return;
        }
        if (request.op === 'exec') {
          const reply = this.answer?.(String(request.sql)) ?? { changes: 1, tx: false };
          say(`${JSON.stringify({ id: request.id, ok: true, ...reply })}\n`);
        } else {
          say(`${JSON.stringify({ id: request.id, ok: true })}\n`);
        }
      },
      close: () => {
        this.closedChannels += 1;
        finish({ reason: 'closed' });
      },
    };
    return Promise.resolve(channel);
  }
}

const SSH = { id: 'main', host: 'bastion', user: 'deploy', auth: 'password' } as const;

describe('ConnectionManager with a SQLite file on a server', () => {
  let store: ConnectionStore;
  let drivers: FakeDriverProvider;
  let snapshots: FakeSnapshots;
  let manager: ConnectionManager;
  let remote: ConnectionConfig;

  const build = (extra: { remoteMaxBytes?: () => number; withSnapshots?: boolean } = {}) =>
    new ConnectionManager({
      store,
      drivers,
      logger: new RecordingLogger(),
      ...(extra.withSnapshots === false ? {} : { snapshots }),
      ...(extra.remoteMaxBytes === undefined ? {} : { remoteMaxBytes: extra.remoteMaxBytes }),
    });

  beforeEach(async () => {
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
    drivers = new FakeDriverProvider();
    snapshots = new FakeSnapshots();
    manager = build();
    remote = await store.add(
      { name: 'Remote', driver: 'sqlite', file: '/srv/app/data.db', ssh: SSH },
      undefined,
      { main: { password: 'pw' } },
    );
  });

  it('copies the file first and opens the copy read-only', async () => {
    await manager.acquire('editor:a', { connectionId: remote.id });
    expect(snapshots.acquired).toHaveLength(1);
    expect(snapshots.acquired[0]).toMatchObject({ remotePath: '/srv/app/data.db' });
    expect(drivers.driver('sqlite').opened[0]).toMatchObject({
      file: '/local/copy-1/data.db',
      readOnly: true,
    });
  });

  it('opens the copy read-only even when the connection is not marked read-only', async () => {
    expect(remote.readOnly).toBeUndefined();
    await manager.acquire('editor:a', { connectionId: remote.id });
    expect(drivers.driver('sqlite').opened[0]?.readOnly).toBe(true);
  });

  it('reaches the server with the stored SSH secrets', async () => {
    await manager.acquire('editor:a', { connectionId: remote.id });
    expect(snapshots.acquired[0]?.spec.hops).toEqual([
      { host: 'bastion', port: 22, user: 'deploy', auth: 'password', password: 'pw' },
    ]);
  });

  it('asks for a copy of the size the setting allows, read when the connection opens', async () => {
    let megabytes = 1;
    manager = build({ remoteMaxBytes: () => megabytes * 1_048_576 });
    await manager.acquire('editor:a', { connectionId: remote.id });
    megabytes = 5;
    await manager.acquire('editor:b', { connectionId: remote.id });
    expect(snapshots.acquired.map((request) => request.maxBytes)).toEqual([1_048_576, 5_242_880]);
  });

  it('allows 512 MB when nothing says otherwise', async () => {
    await manager.acquire('editor:a', { connectionId: remote.id });
    expect(snapshots.acquired[0]?.maxBytes).toBe(DEFAULT_REMOTE_MAX_BYTES);
    expect(DEFAULT_REMOTE_MAX_BYTES).toBe(512 * 1_048_576);
  });

  it('names the copy by connection, so its sessions share one, and others do not', async () => {
    const other = await store.add({
      name: 'Other',
      driver: 'sqlite',
      file: '/srv/app/data.db',
      ssh: SSH,
    });
    await manager.acquire('editor:a', { connectionId: remote.id });
    await manager.acquire('editor:b', { connectionId: remote.id });
    await manager.acquire('editor:c', { connectionId: other.id });
    const keys = snapshots.acquired.map((request) => request.key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('names the copy anew when the file or the server changes', async () => {
    await manager.acquire('editor:a', { connectionId: remote.id });
    const { id: _id, ...input } = remote;
    await store.update(remote.id, { ...input, file: '/srv/app/other.db' });
    await manager.disconnect(remote.id);
    await manager.acquire('editor:a', { connectionId: remote.id });
    await store.update(remote.id, { ...input, ssh: { ...SSH, host: 'elsewhere' } });
    await manager.disconnect(remote.id);
    await manager.acquire('editor:a', { connectionId: remote.id });
    expect(new Set(snapshots.acquired.map((request) => request.key)).size).toBe(3);
  });

  it('gives the copy back when the session closes', async () => {
    await manager.acquire('editor:a', { connectionId: remote.id });
    expect(snapshots.released).toBe(0);
    await manager.disconnect(remote.id);
    expect(snapshots.released).toBe(1);
  });

  it('gives the copy back when the driver cannot open it', async () => {
    drivers.driver('sqlite').openError = new DbError(
      'internal',
      'database disk image is malformed',
    );
    await expect(manager.acquire('editor:a', { connectionId: remote.id })).rejects.toMatchObject({
      message: 'database disk image is malformed',
    });
    expect(snapshots.released).toBe(1);
    expect(manager.getState(remote.id).status).toBe('error');
  });

  it('reports why the copy failed and opens no session', async () => {
    snapshots.failWith = new DbError('permission-denied', 'No permission to read /srv/app/data.db');
    await expect(manager.acquire('editor:a', { connectionId: remote.id })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(drivers.driver('sqlite').opened).toEqual([]);
    expect(manager.getState(remote.id)).toMatchObject({ status: 'error' });
  });

  it('leaves an ordinary SQLite file alone', async () => {
    const local = await store.add({ name: 'Local', driver: 'sqlite', file: '/home/me/x.db' });
    await manager.acquire('editor:a', { connectionId: local.id });
    expect(snapshots.acquired).toEqual([]);
    expect(drivers.driver('sqlite').opened[0]).toMatchObject({ file: '/home/me/x.db' });
    expect(drivers.driver('sqlite').opened[0]?.readOnly).toBeUndefined();
  });

  it('leaves network databases alone', async () => {
    const mysql = await store.add({ name: 'My', driver: 'mysql', host: 'h' });
    await manager.acquire('editor:a', { connectionId: mysql.id });
    expect(snapshots.acquired).toEqual([]);
  });

  it('says it cannot when there is nothing to copy with', async () => {
    manager = build({ withSnapshots: false });
    await expect(manager.acquire('editor:a', { connectionId: remote.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('copies the file for a test and gives it back', async () => {
    await manager.test(
      { name: 'probe', driver: 'sqlite', file: '/srv/x.db', ssh: SSH },
      undefined,
      { main: { password: 'pw' } },
    );
    expect(snapshots.acquired).toHaveLength(1);
    expect(snapshots.acquired[0]?.key.startsWith('["test:')).toBe(true);
    expect(drivers.driver('sqlite').opened[0]).toMatchObject({
      file: '/local/copy-1/data.db',
      readOnly: true,
    });
    expect(drivers.driver('sqlite').lastSession?.executed).toEqual(['SELECT 1']);
    expect(snapshots.released).toBe(1);
  });

  it('gives the copy of a test back when it fails', async () => {
    drivers.driver('sqlite').executeError = new DbError('internal', 'file is not a database');
    await expect(
      manager.test({ name: 'probe', driver: 'sqlite', file: '/srv/x.db', ssh: SSH }),
    ).rejects.toMatchObject({ message: 'file is not a database' });
    expect(snapshots.released).toBe(1);
  });

  it('does not copy anything for the test of a local file', async () => {
    await manager.test({ name: 'probe', driver: 'sqlite', file: '/x.db' });
    expect(snapshots.acquired).toEqual([]);
  });

  describe('changing the file on the server (V13.33)', () => {
    let execs: FakeExecs;
    let writable: ConnectionConfig;
    let m: ConnectionManager;

    const buildWith = (withExecs = true) =>
      new ConnectionManager({
        store,
        drivers,
        logger: new RecordingLogger(),
        snapshots,
        ...(withExecs ? { execs } : {}),
      });

    beforeEach(async () => {
      execs = new FakeExecs();
      m = buildWith();
      writable = await store.add(
        { name: 'W', driver: 'sqlite', file: '/srv/app/data.db', ssh: SSH, remoteWrite: true },
        undefined,
        { main: { password: 'pw' } },
      );
    });

    const run = async (session: Session, sql: string): Promise<void> => {
      for await (const _event of session.execute(sql)) {
        // Only the effect matters.
      }
    };

    it('sends a change to the server instead of the copy', async () => {
      const session = await m.acquire('editor:a', { connectionId: writable.id });
      await run(session, "INSERT INTO t VALUES ('a')");
      expect(execs.requests.map((request) => request.op)).toEqual(['open', 'exec']);
      expect(execs.requests[0]).toMatchObject({ op: 'open', path: '/srv/app/data.db' });
      expect(execs.requests[1]).toMatchObject({ sql: "INSERT INTO t VALUES ('a')" });
      expect(drivers.driver('sqlite').lastSession?.executed).toEqual([]);
      // The command line holds the helper only: the path and the statement are not in it.
      expect(execs.commands[0]).not.toContain('/srv/app/data.db');
      expect(execs.commands[0]).not.toContain('INSERT');
    });

    it('still reads from the copy, and makes it again after a change', async () => {
      const session = await m.acquire('editor:a', { connectionId: writable.id });
      await run(session, 'SELECT 1');
      expect(drivers.driver('sqlite').lastSession?.executed).toEqual(['SELECT 1']);
      expect(snapshots.acquired).toHaveLength(1);
      await run(session, 'DELETE FROM t');
      expect(snapshots.invalidated).toHaveLength(1);
      await run(session, 'SELECT 2');
      expect(snapshots.acquired).toHaveLength(2);
      expect(drivers.driver('sqlite').opened[1]).toMatchObject({
        file: '/local/copy-2/data.db',
        readOnly: true,
      });
      // One key names the copy for reading and for declaring it old.
      expect(snapshots.invalidated[0]).toBe(snapshots.acquired[0]?.key);
    });

    it('hands the connection’s own init statements to the helper', async () => {
      const withInit = await store.add(
        {
          name: 'Init',
          driver: 'sqlite',
          file: '/srv/i.db',
          ssh: SSH,
          remoteWrite: true,
          options: { initSql: 'PRAGMA foreign_keys = ON;' },
        },
        undefined,
        { main: { password: 'pw' } },
      );
      const session = await m.acquire('editor:a', { connectionId: withInit.id });
      await run(session, 'DELETE FROM t');
      expect(execs.requests[0]?.init).toEqual(['PRAGMA foreign_keys = ON']);
    });

    it('reports a transaction the way the server does', async () => {
      execs.answer = (sql) => ({ changes: null, tx: sql === 'BEGIN' });
      const session = await m.acquire('editor:a', { connectionId: writable.id });
      expect(session.transactionState?.()).toBe('idle');
      await run(session, 'BEGIN');
      expect(session.transactionState?.()).toBe('open');
    });

    it('closes the helper and gives the copy back when the connection closes', async () => {
      const session = await m.acquire('editor:a', { connectionId: writable.id });
      await run(session, 'DELETE FROM t');
      await m.disconnect(writable.id);
      expect(execs.closedChannels).toBe(1);
      expect(snapshots.released).toBeGreaterThanOrEqual(1);
    });

    it('says python3 is missing when a change is asked for on a server without it', async () => {
      execs.dieWith = { code: 127, stderr: 'sh: python3: not found\n' };
      const session = await m.acquire('editor:a', { connectionId: writable.id });
      await expect(run(session, 'DELETE FROM t')).rejects.toMatchObject({ code: 'unsupported' });
      // Reading goes on.
      await run(session, 'SELECT 1');
      expect(drivers.driver('sqlite').lastSession?.executed).toEqual(['SELECT 1']);
    });

    it('says changing is not available when there is no SSH to do it with', async () => {
      m = buildWith(false);
      const session = await m.acquire('editor:a', { connectionId: writable.id });
      await expect(run(session, 'DELETE FROM t')).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('leaves the session as it was without the switch', async () => {
      const session = await m.acquire('editor:a', { connectionId: remote.id });
      await run(session, 'DELETE FROM t');
      expect(execs.channels).toBe(0);
      expect(drivers.driver('sqlite').lastSession?.executed).toEqual(['DELETE FROM t']);
    });

    it('does not offer to change a read-only connection, whatever was saved', async () => {
      const readOnly = await store.add(
        {
          name: 'RO',
          driver: 'sqlite',
          file: '/srv/ro.db',
          ssh: SSH,
          remoteWrite: true,
          readOnly: true,
        },
        undefined,
        { main: { password: 'pw' } },
      );
      expect(readOnly.remoteWrite).toBeUndefined();
      const session = await m.acquire('editor:a', { connectionId: readOnly.id });
      await run(session, 'SELECT 1');
      expect(execs.channels).toBe(0);
    });

    it('checks the helper when the connection is tested', async () => {
      await m.test(
        { name: 'probe', driver: 'sqlite', file: '/srv/x.db', ssh: SSH, remoteWrite: true },
        undefined,
        { main: { password: 'pw' } },
      );
      expect(execs.requests[0]).toMatchObject({ op: 'open', path: '/srv/x.db' });
      expect(execs.closedChannels).toBe(1);
    });

    it('fails the test when the server cannot run the helper', async () => {
      execs.dieWith = { code: 127, stderr: 'python3: command not found\n' };
      await expect(
        m.test(
          { name: 'probe', driver: 'sqlite', file: '/srv/x.db', ssh: SSH, remoteWrite: true },
          undefined,
          { main: { password: 'pw' } },
        ),
      ).rejects.toMatchObject({ code: 'unsupported' });
      expect(snapshots.released).toBe(1);
    });

    it('does not start the helper for the test of a connection that only reads', async () => {
      await m.test({ name: 'probe', driver: 'sqlite', file: '/srv/x.db', ssh: SSH }, undefined, {
        main: { password: 'pw' },
      });
      expect(execs.channels).toBe(0);
    });

    it('says the test cannot change a file without SSH to do it with', async () => {
      m = buildWith(false);
      await expect(
        m.test(
          { name: 'probe', driver: 'sqlite', file: '/srv/x.db', ssh: SSH, remoteWrite: true },
          undefined,
          { main: { password: 'pw' } },
        ),
      ).rejects.toMatchObject({ code: 'unsupported' });
    });
  });
});
