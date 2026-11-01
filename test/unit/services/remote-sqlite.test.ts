// A SQLite file on a server (V12.8), end to end: an SSH server inside the test process
// serves the files over SFTP, the real SSH bundle copies them, and the real SQLite driver
// opens the copy. Nothing here needs Docker.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { RemoteSnapshots } from '../../../src/services/remote-snapshots';
import { ssh } from '../../../src/services/ssh';
import { TunnelPool } from '../../../src/services/tunnels';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { runAll } from '../../helpers/driver-run';
import { startSshServer, type TestSshFile, type TestSshServer } from '../../helpers/ssh-server';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

const REMOTE = '/srv/app/data.db';

describe('SQLite file on a server', () => {
  let worker: BuiltWorker;
  let dir: string;
  let plain: Buffer;
  let withLog: { db: Buffer; wal: Buffer };
  let server: TestSshServer | undefined;
  let pool: TunnelPool | undefined;

  const driver = (): ReturnType<typeof createSqliteDriver> =>
    createSqliteDriver({ workerPath: worker.workerPath });

  async function makeFile(name: string, walMode: boolean): Promise<Session> {
    const session = await driver().openSession({
      id: 'maker',
      name: 'maker',
      driver: 'sqlite',
      file: join(dir, name),
    });
    if (walMode) {
      await runAll(session, 'PRAGMA journal_mode = WAL');
    }
    await runAll(session, 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    await runAll(session, "INSERT INTO notes (id, body) VALUES (1, 'one'), (2, 'два')");
    return session;
  }

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-remote-int-'));
    const first = await makeFile('plain.db', false);
    await first.close();
    plain = readFileSync(join(dir, 'plain.db'));
    // Left open on purpose: the newest rows are still in the log file next to the database.
    const second = await makeFile('wal.db', true);
    await runAll(second, "INSERT INTO notes (id, body) VALUES (3, 'only in the log')");
    withLog = { db: readFileSync(join(dir, 'wal.db')), wal: readFileSync(join(dir, 'wal.db-wal')) };
    await second.close();
  });

  afterEach(async () => {
    pool?.dispose();
    pool = undefined;
    await server?.close();
    server = undefined;
  });

  afterAll(() => {
    worker.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup(files: Map<string, TestSshFile>, maxBytes = 50 * 1_048_576) {
    server = await startSshServer({ users: [{ name: 'deploy', password: 'pw' }], files });
    const logger = new RecordingLogger();
    pool = new TunnelPool({ load: () => Promise.resolve(ssh), logger });
    const folder = join(dir, `copies-${Math.random().toString(16).slice(2)}`);
    const snapshots = new RemoteSnapshots({ downloader: pool, folder, logger });
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const manager = new ConnectionManager({
      store,
      drivers: { get: () => Promise.resolve(driver()) },
      logger,
      tunnels: pool,
      checkHostKey: () => Promise.resolve(true),
      snapshots,
      remoteMaxBytes: () => maxBytes,
    });
    const config = await store.add(
      {
        name: 'Remote',
        driver: 'sqlite',
        file: REMOTE,
        ssh: { id: 'main', host: '127.0.0.1', port: server.port, user: 'deploy', auth: 'password' },
      },
      undefined,
      { main: { password: 'pw' } },
    );
    return { manager, config, snapshots, folder, store };
  }

  it('reads the tables of a file that lives on the server', async () => {
    const { manager, config } = await setup(new Map([[REMOTE, plain]]));
    const session = await manager.acquire('editor:a', { connectionId: config.id });
    const result = await runAll(session, 'SELECT id, body FROM notes ORDER BY id');
    expect(result.rows).toEqual([
      [1, 'one'],
      [2, 'два'],
    ]);
    await manager.disconnect(config.id);
  });

  it('reads the changes that are still in the log next to the database', async () => {
    const { manager, config } = await setup(
      new Map([
        [REMOTE, withLog.db],
        [`${REMOTE}-wal`, withLog.wal],
      ]),
    );
    const session = await manager.acquire('editor:a', { connectionId: config.id });
    const result = await runAll(session, 'SELECT count(*) FROM notes');
    expect(result.rows[0]?.[0]).toBe(3);
    await manager.disconnect(config.id);
  });

  it('refuses every change: the copy is a snapshot', async () => {
    const { manager, config } = await setup(new Map([[REMOTE, plain]]));
    const session = await manager.acquire('editor:a', { connectionId: config.id });
    await expect(runAll(session, "INSERT INTO notes (id, body) VALUES (9, 'x')")).rejects.toThrow(
      /readonly|read-only|read only/iu,
    );
    await manager.disconnect(config.id);
  });

  it('shares one copy between the sessions of a connection and removes it at the end', async () => {
    const { manager, config, snapshots, folder } = await setup(new Map([[REMOTE, plain]]));
    await manager.acquire('editor:a', { connectionId: config.id });
    await manager.acquire('editor:b', { connectionId: config.id });
    expect(server?.opened).toEqual([REMOTE]);
    expect(snapshots.size).toBe(1);
    expect(readdirSync(folder)).toHaveLength(1);
    await manager.release('editor:a');
    expect(readdirSync(folder)).toHaveLength(1);
    await manager.release('editor:b');
    expect(snapshots.size).toBe(0);
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  });

  it('says the file is not there', async () => {
    const { manager, config } = await setup(new Map());
    await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining(REMOTE) as string,
    });
    expect(manager.getState(config.id).status).toBe('error');
  });

  it('refuses a file that is not a SQLite database, and leaves no copy', async () => {
    const { manager, config, folder } = await setup(
      new Map([[REMOTE, Buffer.from('this is a text file, not a database')]]),
    );
    await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  });

  it('refuses a file over the limit and names the setting', async () => {
    const { manager, config } = await setup(new Map([[REMOTE, plain]]), 1);
    await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('remoteMaxSizeMb') as string,
    });
  });

  it('tests the connection with a throwaway copy', async () => {
    const { manager, config, snapshots, folder } = await setup(new Map([[REMOTE, plain]]));
    const { id: _id, ...input } = config;
    await manager.test(input, undefined, { main: { password: 'pw' } });
    expect(snapshots.size).toBe(0);
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
    expect(server?.logins).toEqual(['deploy']);
  });

  it('connects again to see what changed on the server', async () => {
    const files = new Map<string, TestSshFile>([[REMOTE, plain]]);
    const { manager, config } = await setup(files);
    const first = await manager.acquire('editor:a', { connectionId: config.id });
    expect((await runAll(first, 'SELECT count(*) FROM notes')).rows[0]?.[0]).toBe(2);
    // The snapshot does not move while the connection is open.
    files.set(REMOTE, withLog.db);
    files.set(`${REMOTE}-wal`, withLog.wal);
    expect((await runAll(first, 'SELECT count(*) FROM notes')).rows[0]?.[0]).toBe(2);
    await manager.disconnect(config.id);
    const second = await manager.acquire('editor:b', { connectionId: config.id });
    expect((await runAll(second, 'SELECT count(*) FROM notes')).rows[0]?.[0]).toBe(3);
    await manager.disconnect(config.id);
  });
});
