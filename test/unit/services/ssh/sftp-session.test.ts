// The SFTP session of the file browser (V13.16) against an SSH server inside the test
// process: real logins, a real SFTP subsystem with a read-write file system in memory.

import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { openSftpSession } from '../../../../src/services/ssh/sftp-session';
import type { SftpSession } from '../../../../src/services/sftp-types';
import { RecordingLogger } from '../../../helpers/fakes';
import { MemorySftpFs } from '../../../helpers/memory-sftp';
import { type SftpFixture, startSftpFixture } from '../../../helpers/sftp-fixture';

let fixture: SftpFixture;
let session: SftpSession;
let fs: MemorySftpFs;

beforeEach(async () => {
  fs = new MemorySftpFs();
  fs.file('/srv/a.txt', 'hello')
    .file('/srv/b.sh', '#!/bin/sh', 0o755)
    .folder('/srv/sub')
    .file('/srv/sub/deep.txt', 'deep')
    .link('/srv/to-a', '/srv/a.txt')
    .link('/srv/to-sub', '/srv/sub')
    .link('/srv/broken', '/srv/nothing')
    .file('/secret/key', 'k')
    .deny('/secret');
  fixture = await startSftpFixture(fs);
  session = await fixture.open();
});

afterEach(async () => {
  await fixture.close();
});

describe('SFTP session', () => {
  it('knows the login folder and resolves paths', async () => {
    expect(await session.home()).toBe('/home/deploy');
    expect(await session.realpath('/srv/../srv/sub')).toBe('/srv/sub');
  });

  it('lists a folder with kinds, sizes, modes and times', async () => {
    const entries = await session.list('/srv');
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(Object.keys(byName).sort()).toEqual(
      ['a.txt', 'b.sh', 'broken', 'sub', 'to-a', 'to-sub'].sort(),
    );
    expect(byName['a.txt']).toMatchObject({
      kind: 'file',
      size: 5,
      path: '/srv/a.txt',
      link: false,
      modified: 1_700_000_000_000,
    });
    expect((byName['a.txt']?.mode ?? 0) & 0o777).toBe(0o644);
    expect((byName['b.sh']?.mode ?? 0) & 0o777).toBe(0o755);
    expect(byName.sub).toMatchObject({ kind: 'directory', link: false });
  });

  it('shows a link as what it leads to, and a broken one as a link', async () => {
    const entries = await session.list('/srv');
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(byName['to-a']).toMatchObject({ kind: 'file', link: true, size: 5 });
    expect(byName['to-sub']).toMatchObject({ kind: 'directory', link: true });
    expect(byName.broken).toMatchObject({ kind: 'symlink', link: true });
  });

  it('lists an empty folder as nothing', async () => {
    fs.folder('/empty');
    expect(await session.list('/empty')).toEqual([]);
  });

  it('refuses a folder that does not exist or may not be read', async () => {
    await expect(session.list('/nope')).rejects.toMatchObject({ code: 'not-found' });
    await expect(session.list('/secret')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('stats a path, following links; a missing path is undefined', async () => {
    expect(await session.stat('/srv/a.txt')).toMatchObject({ kind: 'file', size: 5 });
    expect(await session.stat('/srv/to-sub')).toMatchObject({ kind: 'directory' });
    expect(await session.stat('/srv/nothing')).toBeUndefined();
    await expect(session.stat('/secret/key')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('streams a file out', async () => {
    const { stream, size } = await session.openRead('/srv/a.txt');
    expect(size).toBe(5);
    expect(await text(stream)).toBe('hello');
  });

  it('streams a file bigger than one packet out intact', async () => {
    const data = Buffer.from(Array.from({ length: 300_000 }, (_, index) => index % 251));
    fs.file('/big.bin', data);
    const { stream } = await session.openRead('/big.bin');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });

  it('refuses to read a folder as a file, or a missing file', async () => {
    await expect(session.openRead('/srv/sub')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(session.openRead('/srv/none')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('writes a file, creating or emptying it first', async () => {
    const out = await session.openWrite('/srv/new.txt');
    out.end('written');
    await new Promise((resolve) => out.once('close', resolve));
    expect(fs.text('/srv/new.txt')).toBe('written');
    const again = await session.openWrite('/srv/new.txt');
    again.end('x');
    await new Promise((resolve) => again.once('close', resolve));
    expect(fs.text('/srv/new.txt')).toBe('x');
  });

  it('says so before any data moves when a file cannot be written', async () => {
    await expect(session.openWrite('/missing/dir/file')).rejects.toBeInstanceOf(DbError);
    await expect(session.openWrite('/secret/new')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('makes and removes folders, and removes files', async () => {
    await session.mkdir('/srv/made');
    expect(fs.has('/srv/made')).toBe(true);
    await session.rmdir('/srv/made');
    expect(fs.has('/srv/made')).toBe(false);
    await session.unlink('/srv/a.txt');
    expect(fs.has('/srv/a.txt')).toBe(false);
    await expect(session.unlink('/srv/a.txt')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses to remove a folder that is not empty', async () => {
    await expect(session.rmdir('/srv/sub')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('renames a file and a folder with everything in it', async () => {
    await session.rename('/srv/a.txt', '/srv/z.txt');
    expect(fs.text('/srv/z.txt')).toBe('hello');
    await session.rename('/srv/sub', '/srv/moved');
    expect(fs.text('/srv/moved/deep.txt')).toBe('deep');
    expect(fs.has('/srv/sub')).toBe(false);
  });

  it('changes the permissions', async () => {
    await session.chmod('/srv/a.txt', 0o600);
    expect(fs.modeOf('/srv/a.txt')).toBe(0o600);
  });

  it('closes, and says when it is gone', async () => {
    const own = await openSftpSession(fixture.spec(), new RecordingLogger());
    own.close();
    await own.closed;
    await expect(own.list('/srv')).rejects.toBeInstanceOf(DbError);
  });

  it('knows the session is gone when the server drops it', async () => {
    fixture.server.kick();
    await session.closed;
    await expect(session.list('/srv')).rejects.toMatchObject({ code: 'connection-failed' });
  });

  it('is refused with a wrong password', async () => {
    await expect(
      openSftpSession(fixture.spec({ password: 'wrong' }), new RecordingLogger()),
    ).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('says a server without SFTP does not offer it', async () => {
    const { startSshServer } = await import('../../../helpers/ssh-server');
    const bare = await startSshServer({ users: [{ name: 'deploy', password: 'pw' }] });
    try {
      await expect(
        openSftpSession(
          {
            hops: [
              {
                host: '127.0.0.1',
                port: bare.port,
                user: 'deploy',
                auth: 'password',
                password: 'pw',
              },
            ],
            checkHostKey: () => Promise.resolve(true),
            timeoutMs: 5000,
          },
          new RecordingLogger(),
        ),
      ).rejects.toThrow(/SFTP/u);
    } finally {
      await bare.close();
    }
  });
});
