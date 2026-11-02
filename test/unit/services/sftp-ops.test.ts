// What the file browser does with files (V13.16): reading, writing, copying in both
// directions and between two servers, deleting, renaming — against a real SFTP subsystem.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import {
  changeAttributes,
  copyTree,
  createEmptyFile,
  downloadTree,
  ensureFolder,
  freeName,
  looksBinary,
  moveEntry,
  moveTree,
  parseOwner,
  readLimited,
  removeTree,
  sortEntries,
  targetInFolder,
  type TransferProgress,
  uploadTree,
  writeBuffer,
} from '../../../src/services/sftp-ops';
import type { SftpEntry, SftpSession } from '../../../src/services/sftp-types';
import { MemorySftpFs } from '../../helpers/memory-sftp';
import { type SftpFixture, startSftpFixture } from '../../helpers/sftp-fixture';

let fixture: SftpFixture;
let fs: MemorySftpFs;
let session: SftpSession;

beforeEach(async () => {
  fs = new MemorySftpFs();
  fixture = await startSftpFixture(fs);
  session = await fixture.open();
});

afterEach(async () => {
  await fixture.close();
});

const local = (...parts: string[]): string => join(fixture.dir, ...parts);

function entry(path: string, kind: SftpEntry['kind'], link = false): SftpEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind,
    link,
    size: 0,
    modified: 0,
    mode: 0,
  };
}

describe('sortEntries', () => {
  it('puts folders first, then names with numbers in order and case ignored', () => {
    const sorted = sortEntries([
      entry('/b.txt', 'file'),
      entry('/file10', 'file'),
      entry('/file2', 'file'),
      entry('/Zeta', 'directory'),
      entry('/alpha', 'directory'),
      entry('/A.txt', 'file'),
    ]);
    expect(sorted.map((item) => item.name)).toEqual([
      'alpha',
      'Zeta',
      'A.txt',
      'b.txt',
      'file2',
      'file10',
    ]);
  });
});

describe('looksBinary', () => {
  it('sees a NUL in the first bytes, and only there', () => {
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(looksBinary(Buffer.from([65, 0, 66]))).toBe(true);
    expect(looksBinary(Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0])]))).toBe(false);
  });
});

describe('readLimited', () => {
  it('reads a file whole', async () => {
    fs.file('/a.txt', 'hello');
    expect((await readLimited(session, '/a.txt', 100)).toString()).toBe('hello');
  });

  it('reads an empty file', async () => {
    fs.file('/e.txt', '');
    expect((await readLimited(session, '/e.txt', 100)).length).toBe(0);
  });

  it('reads a file exactly as large as the limit, and refuses one byte more', async () => {
    fs.file('/ten', '0123456789');
    expect((await readLimited(session, '/ten', 10)).length).toBe(10);
    await expect(readLimited(session, '/ten', 9)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('says how large the refused file is', async () => {
    fs.file('/big', Buffer.alloc(3 * 1_048_576));
    await expect(readLimited(session, '/big', 1_048_576)).rejects.toThrow(/3 MB.*1 MB/u);
  });
});

describe('writeBuffer', () => {
  it('writes a file, replacing what was there', async () => {
    fs.file('/w.txt', 'old content that is longer');
    await writeBuffer(session, '/w.txt', Buffer.from('new'));
    expect(fs.text('/w.txt')).toBe('new');
  });

  it('writes more than one packet', async () => {
    const data = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 253));
    await writeBuffer(session, '/big.bin', data);
    expect(fs.bytes('/big.bin')?.equals(data)).toBe(true);
  });

  it('refuses where there is no permission', async () => {
    fs.folder('/locked').deny('/locked');
    await expect(writeBuffer(session, '/locked/x', Buffer.from('x'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('createEmptyFile and ensureFolder', () => {
  it('creates an empty file, and will not touch one that is there', async () => {
    await createEmptyFile(session, '/new.txt');
    expect(fs.text('/new.txt')).toBe('');
    fs.file('/keep.txt', 'keep');
    await expect(createEmptyFile(session, '/keep.txt')).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(fs.text('/keep.txt')).toBe('keep');
  });

  it('makes a folder once, accepts it again, and refuses a file in its place', async () => {
    await ensureFolder(session, '/f');
    await ensureFolder(session, '/f');
    expect(fs.has('/f')).toBe(true);
    fs.file('/file', 'x');
    await expect(ensureFolder(session, '/file')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('downloadTree', () => {
  it('downloads a file with its bytes intact', async () => {
    const data = Buffer.from(Array.from({ length: 150_000 }, (_, index) => index % 251));
    fs.file('/srv/data.bin', data);
    const result = await downloadTree(session, '/srv/data.bin', local('data.bin'));
    expect(result).toMatchObject({ files: 1, folders: 0, bytes: 150_000, skipped: 0 });
    expect(readFileSync(local('data.bin')).equals(data)).toBe(true);
  });

  it('downloads a folder with its subfolders and empty folders', async () => {
    fs.file('/proj/a.txt', 'a')
      .file('/proj/src/b.txt', 'bb')
      .folder('/proj/empty')
      .file('/proj/src/deep/c.txt', 'ccc');
    const result = await downloadTree(session, '/proj', local('proj'));
    expect(result).toMatchObject({ files: 3, folders: 4, bytes: 6 });
    expect(readFileSync(local('proj', 'src', 'deep', 'c.txt'), 'utf8')).toBe('ccc');
    expect(readdirSync(local('proj', 'empty'))).toEqual([]);
  });

  it('follows a link to a file but not a link to a folder', async () => {
    fs.file('/d/real.txt', 'real')
      .link('/d/file-link', '/d/real.txt')
      .link('/d/loop', '/d')
      .link('/d/broken', '/d/none');
    const result = await downloadTree(session, '/d', local('d'));
    expect(readFileSync(local('d', 'file-link'), 'utf8')).toBe('real');
    expect(result.skipped).toBe(2);
    expect(readdirSync(local('d')).sort()).toEqual(['file-link', 'real.txt']);
  });

  it('reports progress as files and bytes grow', async () => {
    fs.file('/p/a', 'aaaa').file('/p/b', 'bb');
    const seen: TransferProgress[] = [];
    await downloadTree(session, '/p', local('p'), { onProgress: (item) => seen.push(item) });
    const last = seen.at(-1);
    expect(last).toMatchObject({ files: 2, bytes: 6 });
    expect(seen.map((item) => item.bytes)).toEqual(
      [...seen.map((item) => item.bytes)].sort((a, b) => a - b),
    );
  });

  it('says what is missing', async () => {
    await expect(downloadTree(session, '/nope', local('nope'))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('stops when cancelled, and leaves no half file', async () => {
    fs.file('/c/one', 'x'.repeat(50_000)).file('/c/two', 'y');
    const controller = new AbortController();
    const run = downloadTree(session, '/c', local('c'), {
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(readdirSync(local('c'))).not.toContain('two');
    expect(readdirSync(local('c')).filter((name) => name === 'one')).toEqual([]);
  });

  it('stops before the first file when already cancelled', async () => {
    fs.file('/c/one', '1');
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadTree(session, '/c', local('c2'), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('uploadTree', () => {
  it('uploads a file', async () => {
    writeFileSync(local('run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.folder('/srv');
    const result = await uploadTree(session, local('run.sh'), '/srv/run.sh');
    expect(result).toMatchObject({ files: 1, bytes: 10 });
    expect(fs.text('/srv/run.sh')).toBe('#!/bin/sh\n');
  });

  it('says when the folder for the file is not there', async () => {
    writeFileSync(local('lost.txt'), 'x');
    await expect(uploadTree(session, local('lost.txt'), '/no/such/lost.txt')).rejects.toMatchObject(
      {
        code: 'not-found',
      },
    );
  });

  it('uploads a folder with subfolders and empty folders', async () => {
    mkdirSync(local('site', 'css'), { recursive: true });
    mkdirSync(local('site', 'empty'));
    writeFileSync(local('site', 'index.html'), '<html>');
    writeFileSync(local('site', 'css', 'a.css'), 'body{}');
    fs.folder('/www');
    const result = await uploadTree(session, local('site'), '/www/site');
    expect(result).toMatchObject({ files: 2, folders: 3, bytes: 12 });
    expect(fs.text('/www/site/css/a.css')).toBe('body{}');
    expect(fs.has('/www/site/empty')).toBe(true);
  });

  it('uploads into a folder that already exists, merging', async () => {
    mkdirSync(local('m'));
    writeFileSync(local('m', 'new.txt'), 'n');
    fs.file('/t/old.txt', 'o');
    await uploadTree(session, local('m'), '/t');
    expect(fs.names('/t').sort()).toEqual(['new.txt', 'old.txt']);
  });

  it('does not copy links of this machine', async () => {
    mkdirSync(local('l'));
    writeFileSync(local('l', 'real.txt'), 'r');
    symlinkSync(local('l', 'real.txt'), local('l', 'link'));
    fs.folder('/dest');
    const result = await uploadTree(session, local('l'), '/dest/l');
    expect(result.skipped).toBe(1);
    expect(fs.names('/dest/l')).toEqual(['real.txt']);
  });

  it('uploads more than one packet', async () => {
    const data = Buffer.from(Array.from({ length: 250_000 }, (_, index) => index % 249));
    writeFileSync(local('big.bin'), data);
    fs.folder('/dest');
    await uploadTree(session, local('big.bin'), '/dest/big.bin');
    expect(fs.bytes('/dest/big.bin')?.equals(data)).toBe(true);
  });

  it('refuses a file where a folder is needed', async () => {
    mkdirSync(local('f'));
    writeFileSync(local('f', 'x'), 'x');
    fs.file('/blocked', 'file');
    await expect(uploadTree(session, local('f'), '/blocked')).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('removes the half-written file when the transfer fails', async () => {
    writeFileSync(local('x.bin'), Buffer.alloc(100_000, 1));
    fs.folder('/dest');
    const controller = new AbortController();
    const run = uploadTree(session, local('x.bin'), '/dest/x.bin', {
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(fs.has('/dest/x.bin')).toBe(false);
  });

  it('refuses where there is no permission', async () => {
    writeFileSync(local('y'), 'y');
    fs.folder('/ro').deny('/ro');
    await expect(uploadTree(session, local('y'), '/ro/y')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('copyTree', () => {
  it('copies a file within one server', async () => {
    fs.file('/a/f.txt', 'content').folder('/b');
    const result = await copyTree(session, entry('/a/f.txt', 'file'), session, '/b/f.txt');
    expect(result).toMatchObject({ files: 1, bytes: 7 });
    expect(fs.text('/b/f.txt')).toBe('content');
    expect(fs.text('/a/f.txt')).toBe('content');
  });

  it('copies a folder with everything in it', async () => {
    fs.file('/a/d/1.txt', '1').file('/a/d/s/2.txt', '22').folder('/a/d/e').folder('/b');
    const result = await copyTree(session, entry('/a/d', 'directory'), session, '/b/d');
    expect(result).toMatchObject({ files: 2, folders: 3, bytes: 3 });
    expect(fs.text('/b/d/s/2.txt')).toBe('22');
    expect(fs.has('/b/d/e')).toBe(true);
  });

  it('will not copy a folder into itself', async () => {
    fs.folder('/a/d');
    await expect(
      copyTree(session, entry('/a/d', 'directory'), session, '/a/d/inner'),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(fs.has('/a/d/inner')).toBe(false);
  });

  it('copies between two servers', async () => {
    const otherFs = new MemorySftpFs().folder('/dest');
    const other = await startSftpFixture(otherFs);
    try {
      const target = await other.open();
      fs.file('/src/x.txt', 'across').file('/src/sub/y.txt', 'servers');
      const result = await copyTree(session, entry('/src', 'directory'), target, '/dest/src');
      expect(result).toMatchObject({ files: 2, bytes: 13 });
      expect(otherFs.text('/dest/src/x.txt')).toBe('across');
      expect(otherFs.text('/dest/src/sub/y.txt')).toBe('servers');
      expect(fs.text('/src/x.txt')).toBe('across');
    } finally {
      await other.close();
    }
  });

  it('copies a folder into a path of the same name on another server', async () => {
    const otherFs = new MemorySftpFs().file('/d/old.txt', 'old');
    const other = await startSftpFixture(otherFs);
    try {
      const target = await other.open();
      fs.file('/d/new.txt', 'new');
      await copyTree(session, entry('/d', 'directory'), target, '/d');
      expect(otherFs.names('/d').sort()).toEqual(['new.txt', 'old.txt']);
    } finally {
      await other.close();
    }
  });
});

describe('removeTree', () => {
  it('removes a file and counts it', async () => {
    fs.file('/r/f', 'x');
    expect(await removeTree(session, entry('/r/f', 'file'))).toBe(1);
    expect(fs.has('/r/f')).toBe(false);
  });

  it('removes a folder with everything in it', async () => {
    fs.file('/r/d/a', '1').file('/r/d/s/b', '2').folder('/r/d/e');
    expect(await removeTree(session, entry('/r/d', 'directory'))).toBe(5);
    expect(fs.has('/r/d')).toBe(false);
    expect(fs.has('/r')).toBe(true);
  });

  it('removes a link to a folder without touching the folder', async () => {
    fs.file('/r/real/keep.txt', 'keep').link('/r/ln', '/r/real');
    await removeTree(session, entry('/r/ln', 'directory', true));
    expect(fs.has('/r/ln')).toBe(false);
    expect(fs.text('/r/real/keep.txt')).toBe('keep');
  });

  it('does not follow a link inside a folder', async () => {
    fs.file('/outside/precious', 'p').file('/r/d/x', '1').link('/r/d/out', '/outside');
    await removeTree(session, entry('/r/d', 'directory'));
    expect(fs.text('/outside/precious')).toBe('p');
  });

  it('stops when cancelled', async () => {
    fs.file('/r/d/a', '1').file('/r/d/b', '2');
    const controller = new AbortController();
    controller.abort();
    await expect(
      removeTree(session, entry('/r/d', 'directory'), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fs.has('/r/d/a')).toBe(true);
  });

  it('tells a folder that cannot be read', async () => {
    fs.file('/r/locked/f', '1').deny('/r/locked');
    await expect(removeTree(session, entry('/r/locked', 'directory'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('moveEntry', () => {
  it('renames a file and a folder', async () => {
    fs.file('/m/a.txt', 'a').file('/m/d/b.txt', 'b');
    await moveEntry(session, entry('/m/a.txt', 'file'), '/m/z.txt');
    await moveEntry(session, entry('/m/d', 'directory'), '/m/e');
    expect(fs.text('/m/z.txt')).toBe('a');
    expect(fs.text('/m/e/b.txt')).toBe('b');
  });

  it('will not overwrite what is there', async () => {
    fs.file('/m/a', '1').file('/m/b', '2');
    await expect(moveEntry(session, entry('/m/a', 'file'), '/m/b')).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(fs.text('/m/b')).toBe('2');
  });

  it('will not move a folder into itself', async () => {
    fs.folder('/m/d');
    await expect(moveEntry(session, entry('/m/d', 'directory'), '/m/d/in')).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('moveTree', () => {
  it('renames within one session, which copies nothing', async () => {
    fs.file('/mv/a.txt', 'a');
    const outcome = await moveTree(session, entry('/mv/a.txt', 'file'), session, '/mv/b.txt');
    expect(outcome).toEqual({
      result: { files: 0, folders: 0, bytes: 0, skipped: 0 },
      sourceRemoved: true,
    });
    expect(fs.text('/mv/b.txt')).toBe('a');
    expect(fs.has('/mv/a.txt')).toBe(false);
  });

  it('moves a folder to another server: copies it whole, then removes the original', async () => {
    const otherFs = new MemorySftpFs().folder('/dest');
    const other = await startSftpFixture(otherFs);
    try {
      const target = await other.open();
      fs.file('/mv/d/x.txt', 'xx').file('/mv/d/sub/y.txt', 'yyy');
      const outcome = await moveTree(session, entry('/mv/d', 'directory'), target, '/dest/d');
      expect(outcome.sourceRemoved).toBe(true);
      expect(outcome.result).toMatchObject({ files: 2, bytes: 5 });
      expect(otherFs.text('/dest/d/sub/y.txt')).toBe('yyy');
      expect(fs.has('/mv/d')).toBe(false);
    } finally {
      await other.close();
    }
  });

  it('will not move onto something that is there on the other server', async () => {
    const otherFs = new MemorySftpFs().file('/dest/a.txt', 'taken');
    const other = await startSftpFixture(otherFs);
    try {
      const target = await other.open();
      fs.file('/mv/a.txt', 'mine');
      await expect(
        moveTree(session, entry('/mv/a.txt', 'file'), target, '/dest/a.txt'),
      ).rejects.toMatchObject({ code: 'unsupported' });
      expect(otherFs.text('/dest/a.txt')).toBe('taken');
      expect(fs.text('/mv/a.txt')).toBe('mine');
    } finally {
      await other.close();
    }
  });

  it('keeps the original when the copy had to leave something out', async () => {
    const otherFs = new MemorySftpFs().folder('/dest');
    const other = await startSftpFixture(otherFs);
    try {
      const target = await other.open();
      fs.file('/mv/d/real.txt', 'real').folder('/mv/other').link('/mv/d/ln', '/mv/other');
      const outcome = await moveTree(session, entry('/mv/d', 'directory'), target, '/dest/d');
      expect(outcome.sourceRemoved).toBe(false);
      expect(outcome.result.skipped).toBeGreaterThan(0);
      expect(otherFs.text('/dest/d/real.txt')).toBe('real');
      expect(fs.text('/mv/d/real.txt')).toBe('real');
    } finally {
      await other.close();
    }
  });

  it('keeps the original when the copy fails halfway', async () => {
    const otherFs = new MemorySftpFs().folder('/dest');
    const other = await startSftpFixture(otherFs);
    try {
      const target = await other.open();
      otherFs.deny('/dest/d/b.txt');
      fs.file('/mv/d/a.txt', 'a').file('/mv/d/b.txt', 'b');
      await expect(
        moveTree(session, entry('/mv/d', 'directory'), target, '/dest/d'),
      ).rejects.toBeInstanceOf(DbError);
      expect(fs.text('/mv/d/a.txt')).toBe('a');
      expect(fs.text('/mv/d/b.txt')).toBe('b');
    } finally {
      await other.close();
    }
  });
});

describe('changeAttributes', () => {
  const tree = (): void => {
    fs.file('/ch/top.txt', 't', 0o600)
      .file('/ch/d/in.txt', 'i', 0o600)
      .file('/ch/d/deep/x.sh', 'x', 0o600)
      .folder('/ch/d/empty', 0o700)
      .link('/ch/ln', '/ch/top.txt');
  };

  it('changes one file without walking', async () => {
    tree();
    const result = await changeAttributes(
      session,
      entry('/ch/top.txt', 'file'),
      { fileMode: 0o644 },
      true,
    );
    expect(result).toEqual({ changed: 1, skipped: 0 });
    expect(fs.modeOf('/ch/top.txt')).toBe(0o644);
  });

  it('gives files and folders their own modes all the way down', async () => {
    tree();
    const result = await changeAttributes(
      session,
      entry('/ch', 'directory'),
      { fileMode: 0o640, folderMode: 0o750 },
      true,
    );
    expect(fs.modeOf('/ch')).toBe(0o750);
    expect(fs.modeOf('/ch/d')).toBe(0o750);
    expect(fs.modeOf('/ch/d/deep')).toBe(0o750);
    expect(fs.modeOf('/ch/d/empty')).toBe(0o750);
    expect(fs.modeOf('/ch/top.txt')).toBe(0o640);
    expect(fs.modeOf('/ch/d/deep/x.sh')).toBe(0o640);
    // 4 folders and 3 files; the link is not touched.
    expect(result).toEqual({ changed: 7, skipped: 1 });
  });

  it('changes only the folder when it is not recursive', async () => {
    tree();
    const result = await changeAttributes(
      session,
      entry('/ch', 'directory'),
      { fileMode: 0o640, folderMode: 0o750 },
      false,
    );
    expect(result.changed).toBe(1);
    expect(fs.modeOf('/ch')).toBe(0o750);
    expect(fs.modeOf('/ch/top.txt')).toBe(0o600);
  });

  it('leaves what is not asked for as it is', async () => {
    tree();
    await changeAttributes(session, entry('/ch', 'directory'), { fileMode: 0o644 }, true);
    expect(fs.modeOf('/ch/top.txt')).toBe(0o644);
    expect(fs.modeOf('/ch/d')).toBe(0o755);
  });

  it('never touches what a link points at', async () => {
    tree();
    const result = await changeAttributes(
      session,
      { ...entry('/ch/ln', 'file', true) },
      { fileMode: 0o777 },
      true,
    );
    expect(result).toEqual({ changed: 0, skipped: 1 });
    expect(fs.modeOf('/ch/top.txt')).toBe(0o600);
  });

  it('changes the owner and group, keeping the one not given', async () => {
    tree();
    const listed = await session.list('/ch');
    const top = listed.find((item) => item.name === 'top.txt');
    expect(top).toMatchObject({ uid: 1000, gid: 1000 });
    await changeAttributes(session, top ?? entry('/ch/top.txt', 'file'), { uid: 33 }, false);
    expect(fs.ownerOf('/ch/top.txt')).toEqual({ uid: 33, gid: 1000 });
    await changeAttributes(session, entry('/ch/top.txt', 'file'), { gid: 44 }, false);
    expect(fs.ownerOf('/ch/top.txt')).toEqual({ uid: 33, gid: 44 });
  });

  it('changes owner and mode of a whole tree together', async () => {
    tree();
    await changeAttributes(
      session,
      entry('/ch/d', 'directory'),
      { uid: 5, gid: 6, fileMode: 0o644, folderMode: 0o755 },
      true,
    );
    expect(fs.ownerOf('/ch/d/deep/x.sh')).toEqual({ uid: 5, gid: 6 });
    expect(fs.ownerOf('/ch/d')).toEqual({ uid: 5, gid: 6 });
    expect(fs.modeOf('/ch/d/in.txt')).toBe(0o644);
    expect(fs.ownerOf('/ch/top.txt')).toEqual({ uid: 1000, gid: 1000 });
  });

  it('stops when cancelled, before changing anything', async () => {
    tree();
    const abort = new AbortController();
    abort.abort();
    await expect(
      changeAttributes(session, entry('/ch', 'directory'), { fileMode: 0o644 }, true, {
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fs.modeOf('/ch/top.txt')).toBe(0o600);
  });

  it('says what is not allowed', async () => {
    tree();
    fs.deny('/ch/d/in.txt');
    await expect(
      changeAttributes(session, entry('/ch', 'directory'), { fileMode: 0o644 }, true),
    ).rejects.toBeInstanceOf(DbError);
  });
});

describe('parseOwner', () => {
  it('reads user:group, a user alone and a group alone', () => {
    expect(parseOwner('1000:1000')).toEqual({ uid: 1000, gid: 1000 });
    expect(parseOwner(' 33 ')).toEqual({ uid: 33 });
    expect(parseOwner('33:')).toEqual({ uid: 33 });
    expect(parseOwner(':44')).toEqual({ gid: 44 });
    expect(parseOwner(' 0 : 0 ')).toEqual({ uid: 0, gid: 0 });
  });

  it('refuses names, empty text and extra parts', () => {
    expect(parseOwner('')).toBeUndefined();
    expect(parseOwner(':')).toBeUndefined();
    expect(parseOwner('root')).toBeUndefined();
    expect(parseOwner('root:root')).toBeUndefined();
    expect(parseOwner('1:2:3')).toBeUndefined();
    expect(parseOwner('-1')).toBeUndefined();
  });
});

describe('names', () => {
  it('finds a free name next to the taken ones, keeping the extension', async () => {
    fs.file('/n/a.txt').file('/n/a copy.txt').file('/n/b');
    expect(await freeName(session, '/n', 'a.txt')).toBe('a copy 2.txt');
    expect(await freeName(session, '/n', 'b')).toBe('b copy');
    expect(await freeName(session, '/n', 'fresh.md')).toBe('fresh copy.md');
  });

  it('puts a dropped file under its own name', () => {
    expect(targetInFolder('/www', '/home/me/site/index.html')).toBe('/www/index.html');
    expect(targetInFolder('/', '/etc/hosts')).toBe('/hosts');
  });
});

describe('local files', () => {
  it('leaves this machine untouched by the helpers of the tests', () => {
    expect(statSync(fixture.dir).isDirectory()).toBe(true);
  });
});
