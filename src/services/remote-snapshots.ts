// A SQLite file on a server, read through SSH (V12.8). The file is copied over SFTP into a
// private folder of this machine and opened there, read-only: SQLite needs a real file,
// and a copy cannot disturb the application that has the original open. Sessions of one
// connection share one copy; it is deleted with the last of them, and what a crash left
// behind is swept at the next start.

import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { msg } from '../core/user-message';
import type { HostKeyCheck, TunnelHop } from './tunnels';
import type { ProxySpec } from './proxy/proxy-client';

/**
 * On Windows a database file stays locked for a moment after its session closed, so
 * removing the copy retries (Node waits and tries again on EBUSY and EPERM).
 */
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

/** The SSH servers on the way to the file, with secrets resolved. */
export interface RemoteFileSpec {
  /** Connected in order: each later hop is reached through the one before it. */
  readonly hops: readonly TunnelHop[];
  readonly proxy?: ProxySpec;
  readonly checkHostKey: HostKeyCheck;
  /** Per hop: how long the SSH handshake and login may take. */
  readonly timeoutMs: number;
}

/** One file to bring over; a missing optional file is not an error. */
export interface DownloadRequest {
  readonly remote: string;
  readonly local: string;
  readonly optional?: boolean;
}

export interface DownloadReport {
  /** Bytes copied per file, in the order of the request; absent files are left out. */
  readonly copied: readonly { readonly remote: string; readonly bytes: number }[];
}

export interface DownloadLimits {
  /** The largest file taken; a bigger one stops the copy before it starts. */
  readonly maxBytes: number;
}

/** What the SSH bundle (dist/ssh.js) offers for files. */
export interface FileDownloader {
  downloadFiles(
    spec: RemoteFileSpec,
    requests: readonly DownloadRequest[],
    limits: DownloadLimits,
    logger: Logger,
  ): Promise<DownloadReport>;
}

/** A copy handed to one session; `release` is safe to call more than once. */
export interface SnapshotLease {
  /** The copy on this machine, ready for the SQLite driver. */
  readonly path: string;
  /** Bytes of the database file that were copied. */
  readonly bytes: number;
  release(): Promise<void>;
}

/** The slice of `RemoteSnapshots` the connection manager needs. */
export interface SnapshotProvider {
  acquire(
    key: string,
    spec: RemoteFileSpec,
    remotePath: string,
    maxBytes: number,
  ): Promise<SnapshotLease>;
}

export interface RemoteSnapshotsDeps {
  readonly downloader: FileDownloader;
  /** A folder of this extension's own, where the copies live. */
  readonly folder: string;
  readonly logger: Logger;
}

interface Shared {
  readonly copy: Promise<{ readonly path: string; readonly bytes: number; readonly dir: string }>;
  users: number;
}

/** What every SQLite file starts with. */
const HEADER = 'SQLite format 3\u0000';

/** A name that is safe as a local file, whatever the server calls the file. */
export function localNameOf(remotePath: string): string {
  const base = remotePath.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? 'database';
  const clean = base.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 80);
  return clean === '' || clean === '.' || clean === '..' ? 'database' : clean;
}

export class RemoteSnapshots implements SnapshotProvider {
  private readonly downloader: FileDownloader;
  private readonly folder: string;
  private readonly logger: Logger;
  private readonly shared = new Map<string, Shared>();

  constructor(deps: RemoteSnapshotsDeps) {
    this.downloader = deps.downloader;
    this.folder = deps.folder;
    this.logger = deps.logger.child('remote-sqlite');
  }

  /** Number of copies kept or being made; for tests and diagnostics. */
  get size(): number {
    return this.shared.size;
  }

  /** Removes what an earlier run left behind. Call once at start, before any copy. */
  async sweep(): Promise<void> {
    try {
      for (const entry of await readdir(this.folder)) {
        await rm(join(this.folder, entry), REMOVE_OPTIONS);
      }
    } catch {
      // No folder yet: nothing to sweep.
    }
  }

  async acquire(
    key: string,
    spec: RemoteFileSpec,
    remotePath: string,
    maxBytes: number,
  ): Promise<SnapshotLease> {
    let entry = this.shared.get(key);
    if (entry === undefined) {
      const created: Shared = { copy: this.copy(key, spec, remotePath, maxBytes), users: 0 };
      entry = created;
      this.shared.set(key, created);
    }
    entry.users += 1;
    const held = entry;
    let copied: { path: string; bytes: number; dir: string };
    try {
      copied = await held.copy;
    } catch (error) {
      held.users -= 1;
      if (this.shared.get(key) === held) {
        // A failed copy is forgotten, so the next attempt starts again.
        this.shared.delete(key);
      }
      throw error;
    }
    let released = false;
    return {
      path: copied.path,
      bytes: copied.bytes,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        held.users -= 1;
        if (held.users === 0 && this.shared.get(key) === held) {
          this.shared.delete(key);
          await rm(copied.dir, REMOVE_OPTIONS);
        }
      },
    };
  }

  /** Removes every copy now, e.g. when the extension shuts down. */
  async dispose(): Promise<void> {
    const entries = [...this.shared.values()];
    this.shared.clear();
    for (const entry of entries) {
      try {
        await rm((await entry.copy).dir, REMOVE_OPTIONS);
      } catch {
        // A copy that never finished has nothing to remove.
      }
    }
  }

  private async copy(
    key: string,
    spec: RemoteFileSpec,
    remotePath: string,
    maxBytes: number,
  ): Promise<{ path: string; bytes: number; dir: string }> {
    const dir = join(this.folder, createHash('sha256').update(key).digest('hex').slice(0, 24));
    const path = join(dir, localNameOf(remotePath));
    await rm(dir, REMOVE_OPTIONS);
    await mkdir(dir, { recursive: true });
    try {
      // The database first, then its log: a checkpoint in between leaves a copy that is old
      // but whole, while the other order could pair new pages with old log frames.
      const report = await this.downloader.downloadFiles(
        spec,
        [
          { remote: remotePath, local: path },
          { remote: `${remotePath}-wal`, local: `${path}-wal`, optional: true },
        ],
        { maxBytes },
        this.logger,
      );
      const bytes = report.copied.find((file) => file.remote === remotePath)?.bytes ?? 0;
      await checkHeader(path, bytes);
      this.logger.info(`Copied ${remotePath} (${bytes} bytes) to this machine`);
      return { path, bytes, dir };
    } catch (error) {
      await rm(dir, REMOVE_OPTIONS);
      throw error;
    }
  }
}

/** The copy must be a SQLite file; a half-copied or a wrong file says so here. */
export async function checkHeader(path: string, expectedBytes: number): Promise<void> {
  const size = (await stat(path)).size;
  if (size === 0) {
    throw new DbError('not-found', msg('The file on the server is empty'));
  }
  if (size !== expectedBytes) {
    throw new DbError(
      'internal',
      msg('The copy of the file is incomplete: {0} of {1} bytes', size, expectedBytes),
    );
  }
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEADER.length);
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.toString('latin1') !== HEADER) {
      throw new DbError('unsupported', msg('The file on the server is not a SQLite database'));
    }
  } finally {
    await handle.close();
  }
}
