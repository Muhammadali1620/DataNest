// Copying files over SFTP (V12.8) against an SSH server inside the test process: real
// logins, a real SFTP subsystem, no Docker.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { DownloadRequest, RemoteFileSpec } from '../../../../src/services/remote-snapshots';
import { downloadFiles } from '../../../../src/services/ssh/sftp';
import type { HostKeyCheck, TunnelHop } from '../../../../src/services/tunnels';
import { RecordingLogger } from '../../../helpers/fakes';
import { startSshServer, type TestSshFile, type TestSshServer } from '../../../helpers/ssh-server';

const TRUST_ALL: HostKeyCheck = () => Promise.resolve(true);
const MB = 1_048_576;

let dir: string;
const servers: TestSshServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'datanest-sftp-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

async function serve(files?: Map<string, TestSshFile>): Promise<TestSshServer> {
  const server = await startSshServer({
    users: [{ name: 'deploy', password: 'pw' }],
    ...(files === undefined ? {} : { files }),
  });
  servers.push(server);
  return server;
}

function hop(server: TestSshServer, overrides: Partial<TunnelHop> = {}): TunnelHop {
  return {
    host: '127.0.0.1',
    port: server.port,
    user: 'deploy',
    auth: 'password',
    password: 'pw',
    ...overrides,
  };
}

function spec(hops: TunnelHop[], check: HostKeyCheck = TRUST_ALL): RemoteFileSpec {
  return { hops, checkHostKey: check, timeoutMs: 5000 };
}

const local = (name: string): string => join(dir, name);

function request(remote: string, name: string, optional = false): DownloadRequest {
  return { remote, local: local(name), ...(optional ? { optional } : {}) };
}

describe('downloadFiles', () => {
  it('copies a file exactly, bigger than one SFTP packet', async () => {
    const data = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251));
    const server = await serve(new Map([['/srv/app/data.db', data]]));
    const report = await downloadFiles(
      spec([hop(server)]),
      [request('/srv/app/data.db', 'data.db')],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    expect(report.copied).toEqual([{ remote: '/srv/app/data.db', bytes: 200_000 }]);
    expect(readFileSync(local('data.db')).equals(data)).toBe(true);
  });

  it('copies an empty file', async () => {
    const server = await serve(new Map([['/e.db', Buffer.alloc(0)]]));
    const report = await downloadFiles(
      spec([hop(server)]),
      [request('/e.db', 'e.db')],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    expect(report.copied).toEqual([{ remote: '/e.db', bytes: 0 }]);
  });

  it('copies the database and its log, in the order asked', async () => {
    const server = await serve(
      new Map([
        ['/d.db', Buffer.from('main')],
        ['/d.db-wal', Buffer.from('log')],
      ]),
    );
    const report = await downloadFiles(
      spec([hop(server)]),
      [request('/d.db', 'd.db'), request('/d.db-wal', 'd.db-wal', true)],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    expect(report.copied.map((file) => file.remote)).toEqual(['/d.db', '/d.db-wal']);
    expect(server.opened).toEqual(['/d.db', '/d.db-wal']);
    expect(readFileSync(local('d.db-wal'), 'utf8')).toBe('log');
  });

  it('skips an optional file that is not there', async () => {
    const server = await serve(new Map([['/d.db', Buffer.from('main')]]));
    const report = await downloadFiles(
      spec([hop(server)]),
      [request('/d.db', 'd.db'), request('/d.db-wal', 'd.db-wal', true)],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    expect(report.copied).toEqual([{ remote: '/d.db', bytes: 4 }]);
    expect(existsSync(local('d.db-wal'))).toBe(false);
  });

  it('says a required file is missing, and copies nothing after it', async () => {
    const server = await serve(new Map([['/other.db', Buffer.from('x')]]));
    await expect(
      downloadFiles(
        spec([hop(server)]),
        [request('/missing.db', 'm.db'), request('/other.db', 'o.db')],
        { maxBytes: MB },
        new RecordingLogger(),
      ),
    ).rejects.toMatchObject({
      name: 'DbError',
      code: 'not-found',
      message: expect.stringContaining('/missing.db') as string,
    });
    expect(existsSync(local('o.db'))).toBe(false);
  });

  it('refuses a file over the limit before it copies a byte', async () => {
    const server = await serve(new Map([['/big.db', Buffer.alloc(3 * MB)]]));
    const failure = downloadFiles(
      spec([hop(server)]),
      [request('/big.db', 'big.db')],
      { maxBytes: 2 * MB },
      new RecordingLogger(),
    );
    await expect(failure).rejects.toMatchObject({ code: 'unsupported' });
    await expect(failure).rejects.toThrow(/3 MB.*2 MB.*remoteMaxSizeMb/u);
    expect(server.opened).toEqual([]);
    expect(existsSync(local('big.db'))).toBe(false);
  });

  it('takes a file of exactly the limit', async () => {
    const server = await serve(new Map([['/x.db', Buffer.alloc(MB)]]));
    const report = await downloadFiles(
      spec([hop(server)]),
      [request('/x.db', 'x.db')],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    expect(report.copied[0]?.bytes).toBe(MB);
  });

  it('refuses a directory', async () => {
    const server = await serve(new Map([['/data', 'directory']]));
    await expect(
      downloadFiles(
        spec([hop(server)]),
        [request('/data', 'data')],
        { maxBytes: MB },
        new RecordingLogger(),
      ),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('not a file') as string,
    });
  });

  it('reports a file the user may not read', async () => {
    const server = await serve(new Map([['/secret.db', 'denied']]));
    await expect(
      downloadFiles(
        spec([hop(server)]),
        [request('/secret.db', 's.db')],
        { maxBytes: MB },
        new RecordingLogger(),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('says so when the server has no SFTP', async () => {
    const server = await serve();
    await expect(
      downloadFiles(
        spec([hop(server)]),
        [request('/d.db', 'd.db')],
        { maxBytes: MB },
        new RecordingLogger(),
      ),
    ).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('SFTP') as string,
    });
  });

  it('fails with the login error when the password is wrong', async () => {
    const server = await serve(new Map());
    await expect(
      downloadFiles(
        spec([hop(server, { password: 'wrong' })]),
        [request('/d.db', 'd.db')],
        { maxBytes: MB },
        new RecordingLogger(),
      ),
    ).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('fails when the host key is not trusted', async () => {
    const server = await serve(new Map());
    await expect(
      downloadFiles(
        spec([hop(server)], () => Promise.resolve(false)),
        [request('/d.db', 'd.db')],
        { maxBytes: MB },
        new RecordingLogger(),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('shows the fingerprint to the host-key check', async () => {
    const server = await serve(new Map([['/d.db', Buffer.from('x')]]));
    let seen: string | undefined;
    await downloadFiles(
      spec([hop(server)], (key) => {
        seen = key.fingerprint;
        return Promise.resolve(true);
      }),
      [request('/d.db', 'd.db')],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    expect(seen).toBe(server.fingerprint);
  });

  it('goes through a jump host', async () => {
    const files = new Map<string, TestSshFile>([['/d.db', Buffer.from('behind')]]);
    const inner = await serve(files);
    const jump = await serve();
    const report = await downloadFiles(
      spec([hop(jump), hop(inner, { host: '127.0.0.1' })]),
      [request('/d.db', 'd.db')],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    expect(report.copied).toEqual([{ remote: '/d.db', bytes: 6 }]);
    expect(jump.forwards).toEqual([`127.0.0.1:${inner.port}`]);
    expect(readFileSync(local('d.db'), 'utf8')).toBe('behind');
  });

  it('copies from an old server once its method is allowed (V13.10)', async () => {
    const server = await startSshServer({
      users: [{ name: 'deploy', password: 'pw' }],
      files: new Map([['/old.db', Buffer.from('legacy')]]),
      algorithms: { kex: ['diffie-hellman-group14-sha1'] },
    });
    servers.push(server);
    await expect(
      downloadFiles(
        spec([hop(server)]),
        [request('/old.db', 'old.db')],
        { maxBytes: MB },
        new RecordingLogger(),
      ),
    ).rejects.toMatchObject({ code: 'connection-failed' });
    await downloadFiles(
      spec([hop(server, { algorithms: { kex: '+diffie-hellman-group14-sha1' } })]),
      [request('/old.db', 'old.db')],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    expect(readFileSync(local('old.db'), 'utf8')).toBe('legacy');
  });

  it('refuses a chain with no server', async () => {
    await expect(
      downloadFiles(spec([]), [request('/d.db', 'd.db')], { maxBytes: MB }, new RecordingLogger()),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('closes the connection when it is done, and when it fails', async () => {
    const server = await serve(new Map([['/d.db', Buffer.from('x')]]));
    await downloadFiles(
      spec([hop(server)]),
      [request('/d.db', 'd.db')],
      { maxBytes: MB },
      new RecordingLogger(),
    );
    await expect(
      downloadFiles(
        spec([hop(server)]),
        [request('/none.db', 'n.db')],
        { maxBytes: MB },
        new RecordingLogger(),
      ),
    ).rejects.toBeInstanceOf(DbError);
    // The server closes without waiting for connections that are still open.
    await server.close();
    servers.splice(servers.indexOf(server), 1);
  });
});
