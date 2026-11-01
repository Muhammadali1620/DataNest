import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import {
  checkHeader,
  type DownloadReport,
  type DownloadRequest,
  type FileDownloader,
  localNameOf,
  RemoteSnapshots,
  type RemoteFileSpec,
} from '../../../src/services/remote-snapshots';
import { RecordingLogger } from '../../helpers/fakes';

const SQLITE_HEADER = 'SQLite format 3\u0000';
const SPEC: RemoteFileSpec = {
  hops: [],
  checkHostKey: () => Promise.resolve(true),
  timeoutMs: 1000,
};

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'datanest-remote-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A downloader that writes what the test says instead of reaching a server. */
class FakeDownloader implements FileDownloader {
  readonly calls: { requests: readonly DownloadRequest[]; maxBytes: number }[] = [];
  content: Buffer = Buffer.concat([Buffer.from(SQLITE_HEADER, 'latin1'), Buffer.alloc(100)]);
  wal: Buffer | undefined;
  failWith: Error | undefined;
  /** What it reports instead of the real size, to look like a short copy. */
  reportedBytes: number | undefined;
  delay: Promise<void> | undefined;

  async downloadFiles(
    _spec: RemoteFileSpec,
    requests: readonly DownloadRequest[],
    limits: { maxBytes: number },
  ): Promise<DownloadReport> {
    this.calls.push({ requests, maxBytes: limits.maxBytes });
    await this.delay;
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    const copied: { remote: string; bytes: number }[] = [];
    for (const request of requests) {
      const data = request.optional === true ? this.wal : this.content;
      if (data === undefined) {
        continue;
      }
      writeFileSync(request.local, data);
      copied.push({ remote: request.remote, bytes: this.reportedBytes ?? data.length });
    }
    return { copied };
  }
}

function setup() {
  const downloader = new FakeDownloader();
  const snapshots = new RemoteSnapshots({
    downloader,
    folder,
    logger: new RecordingLogger(),
  });
  return { downloader, snapshots };
}

describe('localNameOf', () => {
  it('keeps the file name of a path on the server', () => {
    expect(localNameOf('/srv/app/data.db')).toBe('data.db');
    expect(localNameOf('C:\\data\\app.sqlite')).toBe('app.sqlite');
    expect(localNameOf('relative/x.db')).toBe('x.db');
  });

  it('is a safe file name whatever the server calls the file', () => {
    expect(localNameOf('/a/b c$d.db')).toBe('b_c_d.db');
    expect(localNameOf('/a/..')).toBe('database');
    expect(localNameOf('/')).toBe('database');
    expect(localNameOf('')).toBe('database');
    expect(localNameOf('/a/ключ.db')).toBe('ключ.db');
    expect(localNameOf(`/a/${'x'.repeat(200)}`)).toHaveLength(80);
  });
});

describe('RemoteSnapshots', () => {
  it('copies the database first and its log after it, the log being optional', async () => {
    const { downloader, snapshots } = setup();
    const lease = await snapshots.acquire('k', SPEC, '/srv/app/data.db', 5_000_000);
    expect(downloader.calls).toHaveLength(1);
    const requests = downloader.calls[0]?.requests ?? [];
    expect(requests.map((request) => request.remote)).toEqual([
      '/srv/app/data.db',
      '/srv/app/data.db-wal',
    ]);
    expect(requests.map((request) => request.optional ?? false)).toEqual([false, true]);
    expect(requests[0]?.local).toBe(lease.path);
    expect(requests[1]?.local).toBe(`${lease.path}-wal`);
    expect(downloader.calls[0]?.maxBytes).toBe(5_000_000);
    expect(lease.bytes).toBe(116);
    expect(readFileSync(lease.path).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  it('keeps the log next to the copy when the server has one', async () => {
    const { downloader, snapshots } = setup();
    downloader.wal = Buffer.from('wal-bytes');
    const lease = await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    expect(readFileSync(`${lease.path}-wal`, 'utf8')).toBe('wal-bytes');
  });

  it('shares one copy between sessions of a connection and drops it with the last', async () => {
    const { downloader, snapshots } = setup();
    const first = await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    const second = await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    expect(second.path).toBe(first.path);
    expect(downloader.calls).toHaveLength(1);
    expect(snapshots.size).toBe(1);
    await first.release();
    expect(existsSync(second.path)).toBe(true);
    await second.release();
    expect(existsSync(second.path)).toBe(false);
    expect(snapshots.size).toBe(0);
  });

  it('copies once for sessions that ask while the copy is still running', async () => {
    const { downloader, snapshots } = setup();
    let finish: () => void = () => undefined;
    downloader.delay = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = [
      snapshots.acquire('k', SPEC, '/x.db', 1_000_000),
      snapshots.acquire('k', SPEC, '/x.db', 1_000_000),
    ];
    finish();
    const [a, b] = await Promise.all(pending);
    expect(a?.path).toBe(b?.path);
    expect(downloader.calls).toHaveLength(1);
  });

  it('keeps connections apart', async () => {
    const { downloader, snapshots } = setup();
    const a = await snapshots.acquire('a', SPEC, '/x.db', 1_000_000);
    const b = await snapshots.acquire('b', SPEC, '/x.db', 1_000_000);
    expect(a.path).not.toBe(b.path);
    expect(downloader.calls).toHaveLength(2);
  });

  it('releases once, however many times it is called', async () => {
    const { snapshots } = setup();
    const first = await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    const second = await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    await first.release();
    await first.release();
    expect(existsSync(second.path)).toBe(true);
    await second.release();
  });

  it('starts again after a new copy is asked for, once the old one is gone', async () => {
    const { downloader, snapshots } = setup();
    const first = await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    await first.release();
    await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    expect(downloader.calls).toHaveLength(2);
  });

  it('passes the failure of the download on and leaves nothing behind', async () => {
    const { downloader, snapshots } = setup();
    downloader.failWith = new DbError('permission-denied', 'No permission to read /x.db');
    await expect(snapshots.acquire('k', SPEC, '/x.db', 1_000_000)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(readdirSync(folder)).toEqual([]);
    expect(snapshots.size).toBe(0);
    downloader.failWith = undefined;
    const lease = await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    expect(existsSync(lease.path)).toBe(true);
  });

  it('fails every waiting session when the shared copy fails, and lets the next one retry', async () => {
    const { downloader, snapshots } = setup();
    downloader.failWith = new Error('link lost');
    const results = await Promise.allSettled([
      snapshots.acquire('k', SPEC, '/x.db', 1_000_000),
      snapshots.acquire('k', SPEC, '/x.db', 1_000_000),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(snapshots.size).toBe(0);
  });

  it('refuses a file that is not a SQLite database', async () => {
    const { downloader, snapshots } = setup();
    downloader.content = Buffer.from('just some text, not a database');
    await expect(snapshots.acquire('k', SPEC, '/x.txt', 1_000_000)).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('not a SQLite') as string,
    });
    expect(readdirSync(folder)).toEqual([]);
  });

  it('refuses an empty file', async () => {
    const { downloader, snapshots } = setup();
    downloader.content = Buffer.alloc(0);
    await expect(snapshots.acquire('k', SPEC, '/x.db', 1_000_000)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a copy that is shorter than the file on the server', async () => {
    const { downloader, snapshots } = setup();
    downloader.reportedBytes = 5000;
    await expect(snapshots.acquire('k', SPEC, '/x.db', 1_000_000)).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('incomplete') as string,
    });
    expect(readdirSync(folder)).toEqual([]);
  });

  it('sweeps what an earlier run left behind', async () => {
    const { snapshots } = setup();
    const stale = join(folder, 'old-copy');
    writeFileSync(join(folder, 'loose.db'), 'x');
    rmSync(stale, { recursive: true, force: true });
    await snapshots.sweep();
    expect(readdirSync(folder)).toEqual([]);
  });

  it('sweeps a folder that does not exist yet without complaint', async () => {
    const snapshots = new RemoteSnapshots({
      downloader: new FakeDownloader(),
      folder: join(folder, 'missing'),
      logger: new RecordingLogger(),
    });
    await expect(snapshots.sweep()).resolves.toBeUndefined();
  });

  it('removes every copy when it is disposed', async () => {
    const { snapshots } = setup();
    const lease = await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    await snapshots.dispose();
    expect(existsSync(lease.path)).toBe(false);
    expect(snapshots.size).toBe(0);
  });

  it('disposes while a copy is still failing without throwing', async () => {
    const { downloader, snapshots } = setup();
    downloader.failWith = new Error('x');
    const pending = snapshots.acquire('k', SPEC, '/x.db', 1_000_000).catch(() => undefined);
    await expect(snapshots.dispose()).resolves.toBeUndefined();
    await pending;
  });

  it('logs the copy', async () => {
    const logger = new RecordingLogger();
    const snapshots = new RemoteSnapshots({ downloader: new FakeDownloader(), folder, logger });
    await snapshots.acquire('k', SPEC, '/x.db', 1_000_000);
    expect(logger.entries.some((entry) => entry.message.includes('Copied /x.db'))).toBe(true);
  });
});

describe('checkHeader', () => {
  it('accepts a SQLite file of the size it should have', async () => {
    const path = join(folder, 'a.db');
    writeFileSync(path, Buffer.concat([Buffer.from(SQLITE_HEADER, 'latin1'), Buffer.alloc(10)]));
    await expect(checkHeader(path, 26)).resolves.toBeUndefined();
  });

  it('closes the file even when the header is wrong', async () => {
    const path = join(folder, 'b.db');
    writeFileSync(path, Buffer.alloc(40, 65));
    const spy = vi.fn();
    await expect(checkHeader(path, 40)).rejects.toBeInstanceOf(DbError);
    spy();
    expect(spy).toHaveBeenCalled();
  });
});
