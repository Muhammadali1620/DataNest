// A real SSH server with an in-memory SFTP file system, and sessions opened on it through
// the same code the extension uses (V13.16).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteFileSpec } from '../../src/services/remote-snapshots';
import { openSftpSession } from '../../src/services/ssh/sftp-session';
import type { SftpSession } from '../../src/services/sftp-types';
import type { HostKeyCheck, TunnelHop } from '../../src/services/tunnels';
import { ServerStore } from '../../src/services/server-store';
import { SftpHub } from '../../src/services/sftp-hub';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from './fakes';
import { MemorySftpFs } from './memory-sftp';
import { startSshServer, type TestSshServer } from './ssh-server';

export const TRUST_ALL: HostKeyCheck = () => Promise.resolve(true);

export interface SftpFixture {
  readonly fs: MemorySftpFs;
  readonly server: TestSshServer;
  /** A folder on this machine, removed at the end. */
  readonly dir: string;
  spec(overrides?: Partial<TunnelHop>): RemoteFileSpec;
  open(): Promise<SftpSession>;
  close(): Promise<void>;
}

export async function startSftpFixture(fs = new MemorySftpFs()): Promise<SftpFixture> {
  const server = await startSshServer({
    users: [{ name: 'deploy', password: 'pw' }],
    sftp: fs.serve,
  });
  const dir = mkdtempSync(join(tmpdir(), 'datanest-sftp-ops-'));
  const sessions: SftpSession[] = [];
  const spec = (overrides: Partial<TunnelHop> = {}): RemoteFileSpec => ({
    hops: [
      {
        host: '127.0.0.1',
        port: server.port,
        user: 'deploy',
        auth: 'password',
        password: 'pw',
        ...overrides,
      },
    ],
    checkHostKey: TRUST_ALL,
    timeoutMs: 5000,
  });
  return {
    fs,
    server,
    dir,
    spec,
    open: async () => {
      const session = await openSftpSession(spec(), new RecordingLogger());
      sessions.push(session);
      return session;
    },
    close: async () => {
      for (const session of sessions.splice(0)) {
        session.close();
      }
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ServerWorld extends SftpFixture {
  readonly store: ServerStore;
  readonly hub: SftpHub;
  /** A saved server that leads to the fixture. */
  readonly serverId: string;
  /** The same fixture, saved a second time as a read-only server. */
  readonly readOnlyId: string;
  shutdown(): Promise<void>;
}

/** A saved server (and a read-only twin) over the fixture, and a hub that opens it for real. */
export async function startServerWorld(fs = new MemorySftpFs()): Promise<ServerWorld> {
  const fixture = await startSftpFixture(fs);
  const store = new ServerStore({
    state: new FakeMemento(),
    secrets: new FakeSecretStorage(),
    logger: new RecordingLogger(),
  });
  const ssh = {
    id: 'main',
    host: '127.0.0.1',
    port: fixture.server.port,
    user: 'deploy',
    auth: 'password' as const,
  };
  const serverId = (await store.add({ name: 'Web', ssh }, { main: { password: 'pw' } })).id;
  const readOnlyId = (
    await store.add({ name: 'Web (read-only)', ssh, readOnly: true }, { main: { password: 'pw' } })
  ).id;
  const hub = new SftpHub({
    store,
    opener: { openSftp: (spec) => openSftpSession(spec, new RecordingLogger()) },
    checkHostKey: TRUST_ALL,
    logger: new RecordingLogger(),
    idleMs: 0,
  });
  return {
    ...fixture,
    store,
    hub,
    serverId,
    readOnlyId,
    shutdown: async () => {
      hub.dispose();
      await fixture.close();
    },
  };
}
