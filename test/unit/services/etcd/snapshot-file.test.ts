import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSnapshotFile, partialName } from '../../../../src/services/etcd/snapshot-file';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'datanest-snap-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('openSnapshotFile', () => {
  it('writes under a temporary name and takes the real one when kept', async () => {
    const path = join(dir, 'a.db');
    const sink = await openSnapshotFile(path);
    await sink.write(Uint8Array.of(1, 2, 3));
    await sink.write(Uint8Array.of(4));
    expect(existsSync(path)).toBe(false);
    expect(existsSync(partialName(path))).toBe(true);
    await sink.close(true);
    expect(existsSync(partialName(path))).toBe(false);
    expect([...(await readFile(path))]).toEqual([1, 2, 3, 4]);
  });

  it('leaves an older backup alone when the snapshot is dropped', async () => {
    const path = join(dir, 'a.db');
    await writeFile(path, 'old backup');
    const sink = await openSnapshotFile(path);
    await sink.write(Uint8Array.of(9));
    await sink.close(false);
    expect(existsSync(partialName(path))).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('old backup');
  });

  it('replaces an older backup when the new one is kept', async () => {
    const path = join(dir, 'a.db');
    await writeFile(path, 'old backup');
    const sink = await openSnapshotFile(path);
    await sink.write(Uint8Array.of(7));
    await sink.close(true);
    expect([...(await readFile(path))]).toEqual([7]);
  });

  it('may be closed twice: the second close does nothing', async () => {
    const path = join(dir, 'a.db');
    const sink = await openSnapshotFile(path);
    await sink.close(true);
    await sink.close(false);
    expect(existsSync(path)).toBe(true);
  });

  it('fails when the folder is not there', async () => {
    await expect(openSnapshotFile(join(dir, 'missing', 'a.db'))).rejects.toThrow();
  });
});
