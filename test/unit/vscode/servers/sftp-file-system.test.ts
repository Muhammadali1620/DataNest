// Files of a server as the editor's own (V13.16): reading, saving back, renaming, deleting,
// and the errors the editor knows how to show — over a real SFTP session.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpFileSystem } from '../../../../src/vscode/servers/sftp-file-system';
import { MemorySftpFs } from '../../../helpers/memory-sftp';
import { type ServerWorld, startServerWorld } from '../../../helpers/sftp-fixture';
import * as stub from '../../../helpers/vscode-stub';

vi.mock('vscode', () => import('../../../helpers/vscode-stub'));

let world: ServerWorld;
let fs: MemorySftpFs;
let files: SftpFileSystem;
let maxOpen: number;

const uri = (serverId: string, path: string): ReturnType<typeof stub.Uri.from> =>
  stub.Uri.from({ scheme: 'datanest-sftp', authority: serverId, path });
const asUri = (value: unknown): never => value as never;

beforeEach(async () => {
  fs = new MemorySftpFs();
  fs.file('/srv/a.txt', 'hello', 0o644, 1_700_000_000)
    .file('/srv/sub/b.txt', 'bee')
    .link('/srv/ln', '/srv/a.txt')
    .folder('/srv/dir');
  world = await startServerWorld(fs);
  maxOpen = 1024;
  files = new SftpFileSystem({ hub: world.hub, store: world.store, maxOpenBytes: () => maxOpen });
});

afterEach(async () => {
  files.dispose();
  await world.shutdown();
});

describe('reading', () => {
  it('stats a file with its time and size, which the editor compares on save', async () => {
    const found = await files.stat(asUri(uri(world.serverId, '/srv/a.txt')));
    expect(found).toMatchObject({
      type: stub.FileType.File,
      size: 5,
      mtime: 1_700_000_000_000,
      ctime: 1_700_000_000_000,
    });
    expect(found).not.toHaveProperty('permissions');
  });

  it('stats a folder', async () => {
    const found = await files.stat(asUri(uri(world.serverId, '/srv/sub')));
    expect(found.type).toBe(stub.FileType.Directory);
  });

  it('marks everything on a read-only server as read-only', async () => {
    const found = await files.stat(asUri(uri(world.readOnlyId, '/srv/a.txt')));
    expect(found.permissions).toBe(stub.FilePermission.Readonly);
  });

  it('says "not found" for what is not there', async () => {
    await expect(files.stat(asUri(uri(world.serverId, '/srv/none')))).rejects.toMatchObject({
      code: 'FileNotFound',
    });
    await expect(files.readFile(asUri(uri(world.serverId, '/srv/none')))).rejects.toMatchObject({
      code: 'FileNotFound',
    });
  });

  it('says "not found" for a server that is not saved', async () => {
    await expect(files.stat(asUri(uri('ghost', '/srv')))).rejects.toMatchObject({
      code: 'FileNotFound',
    });
  });

  it('lists a folder, telling files, folders and links', async () => {
    const entries = await files.readDirectory(asUri(uri(world.serverId, '/srv')));
    const byName = Object.fromEntries(entries);
    expect(byName['a.txt']).toBe(stub.FileType.File);
    expect(byName.sub).toBe(stub.FileType.Directory);
    expect(byName.ln).toBe(stub.FileType.File | stub.FileType.SymbolicLink);
  });

  it('reads a file', async () => {
    const data = await files.readFile(asUri(uri(world.serverId, '/srv/a.txt')));
    expect(Buffer.from(data).toString()).toBe('hello');
  });

  it('refuses a file larger than the limit with a message that says so', async () => {
    maxOpen = 4;
    await expect(files.readFile(asUri(uri(world.serverId, '/srv/a.txt')))).rejects.toMatchObject({
      code: 'Unavailable',
    });
  });

  it('says "no permission" where the server refuses', async () => {
    fs.file('/locked/f', 'x').deny('/locked');
    await expect(files.readFile(asUri(uri(world.serverId, '/locked/f')))).rejects.toMatchObject({
      code: 'NoPermissions',
    });
  });
});

describe('saving', () => {
  it('writes a file back, and tells the editor it changed', async () => {
    const changes: unknown[] = [];
    files.onDidChangeFile((events) => changes.push(...events));
    await files.writeFile(asUri(uri(world.serverId, '/srv/a.txt')), Buffer.from('changed'), {
      create: false,
      overwrite: true,
    });
    expect(fs.text('/srv/a.txt')).toBe('changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: stub.FileChangeType.Changed });
  });

  it('shows a new time and size after a save, so the editor does not see a conflict with itself', async () => {
    fs.clock = 1_800_000_000;
    const target = asUri(uri(world.serverId, '/srv/a.txt'));
    await files.writeFile(target, Buffer.from('a longer text'), { create: false, overwrite: true });
    const found = await files.stat(target);
    expect(found.size).toBe(13);
    expect(found.mtime).toBe(1_800_000_000_000);
  });

  it('shows a change made on the server meanwhile as a different time', async () => {
    const target = asUri(uri(world.serverId, '/srv/a.txt'));
    const before = await files.stat(target);
    fs.touch('/srv/a.txt', 1_900_000_000);
    const after = await files.stat(target);
    expect(after.mtime).not.toBe(before.mtime);
  });

  it('creates a file only when asked to', async () => {
    const target = asUri(uri(world.serverId, '/srv/new.txt'));
    await expect(
      files.writeFile(target, Buffer.from('n'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ code: 'FileNotFound' });
    await files.writeFile(target, Buffer.from('n'), { create: true, overwrite: false });
    expect(fs.text('/srv/new.txt')).toBe('n');
  });

  it('will not overwrite when not allowed to', async () => {
    await expect(
      files.writeFile(asUri(uri(world.serverId, '/srv/a.txt')), Buffer.from('x'), {
        create: true,
        overwrite: false,
      }),
    ).rejects.toMatchObject({ code: 'FileExists' });
    expect(fs.text('/srv/a.txt')).toBe('hello');
  });

  it('refuses every change on a read-only server', async () => {
    const target = asUri(uri(world.readOnlyId, '/srv/a.txt'));
    await expect(
      files.writeFile(target, Buffer.from('x'), { create: true, overwrite: true }),
    ).rejects.toMatchObject({ code: 'NoPermissions' });
    await expect(files.delete(target)).rejects.toMatchObject({ code: 'NoPermissions' });
    await expect(
      files.rename(target, asUri(uri(world.readOnlyId, '/srv/z.txt')), { overwrite: false }),
    ).rejects.toMatchObject({ code: 'NoPermissions' });
    await expect(
      files.createDirectory(asUri(uri(world.readOnlyId, '/srv/newdir'))),
    ).rejects.toMatchObject({ code: 'NoPermissions' });
    expect(fs.text('/srv/a.txt')).toBe('hello');
    expect(fs.has('/srv/newdir')).toBe(false);
  });
});

describe('folders, renames and deletes', () => {
  it('makes a folder', async () => {
    await files.createDirectory(asUri(uri(world.serverId, '/srv/made')));
    expect(fs.has('/srv/made')).toBe(true);
  });

  it('deletes a file, and a folder with everything in it', async () => {
    await files.delete(asUri(uri(world.serverId, '/srv/a.txt')));
    expect(fs.has('/srv/a.txt')).toBe(false);
    await files.delete(asUri(uri(world.serverId, '/srv/sub')));
    expect(fs.has('/srv/sub')).toBe(false);
  });

  it('deletes a link without touching its target', async () => {
    fs.link('/srv/dirlink', '/srv/sub');
    await files.delete(asUri(uri(world.serverId, '/srv/dirlink')));
    expect(fs.has('/srv/dirlink')).toBe(false);
    expect(fs.text('/srv/sub/b.txt')).toBe('bee');
  });

  it('says "not found" when deleting what is not there', async () => {
    await expect(files.delete(asUri(uri(world.serverId, '/srv/none')))).rejects.toMatchObject({
      code: 'FileNotFound',
    });
  });

  it('renames within a server, and tells the editor', async () => {
    const changes: { type: number }[] = [];
    files.onDidChangeFile((events) => changes.push(...events));
    await files.rename(
      asUri(uri(world.serverId, '/srv/a.txt')),
      asUri(uri(world.serverId, '/srv/z.txt')),
      { overwrite: false },
    );
    expect(fs.text('/srv/z.txt')).toBe('hello');
    expect(changes.map((change) => change.type)).toEqual([
      stub.FileChangeType.Deleted,
      stub.FileChangeType.Created,
    ]);
  });

  it('will not rename onto a file unless allowed, and then replaces it', async () => {
    fs.file('/srv/other.txt', 'other');
    const from = asUri(uri(world.serverId, '/srv/a.txt'));
    const to = asUri(uri(world.serverId, '/srv/other.txt'));
    await expect(files.rename(from, to, { overwrite: false })).rejects.toBeInstanceOf(Error);
    expect(fs.text('/srv/a.txt')).toBe('hello');
    await files.rename(from, to, { overwrite: true });
    expect(fs.text('/srv/other.txt')).toBe('hello');
    expect(fs.has('/srv/a.txt')).toBe(false);
  });

  it('will not move a file from one server to another here', async () => {
    await expect(
      files.rename(
        asUri(uri(world.serverId, '/srv/a.txt')),
        asUri(uri(world.readOnlyId, '/srv/a.txt')),
        { overwrite: false },
      ),
    ).rejects.toMatchObject({ code: 'NoPermissions' });
  });

  it('watches nothing, and says so by returning something it can dispose', () => {
    expect(() => {
      files.watch().dispose();
    }).not.toThrow();
  });
});
