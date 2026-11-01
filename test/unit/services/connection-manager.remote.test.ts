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
import type { ConnectionConfig } from '../../../src/shared/connection';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

class FakeSnapshots implements SnapshotProvider {
  readonly acquired: { key: string; spec: RemoteFileSpec; remotePath: string; maxBytes: number }[] =
    [];
  released = 0;
  failWith: Error | undefined;

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
});
