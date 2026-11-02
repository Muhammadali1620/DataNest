// An SFTP session for the file browser (V13.16): the same chain of SSH hops a tunnel uses,
// then the SFTP subsystem of the last server. Only this file, sftp.ts and tunnel.ts import
// ssh2 (ARCHITECTURE.md §7).

import type { Readable, Writable } from 'node:stream';
import { DbError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { msg } from '../../core/user-message';
import type { RemoteFileSpec } from '../remote-snapshots';
import type { SftpEntry, SftpKind, SftpSession, SftpStat } from '../sftp-types';
import { joinRemote } from '../../shared/remote-path';
import { connectChain } from './tunnel';
import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';

const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function codeOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** The error a user reads for a failed SFTP request on `path`. */
export function sftpError(error: unknown, path: string): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const code = codeOf(error);
  if (code === undefined) {
    // No status code: the link itself failed (closed, timed out), not one request.
    return new DbError(
      'connection-failed',
      msg('The connection to the server was lost: {0}', errorMessage(error)),
      { cause: error },
    );
  }
  switch (code) {
    case NO_SUCH_FILE:
      return new DbError('not-found', msg('{0} does not exist on the server', path), {
        cause: error,
      });
    case PERMISSION_DENIED:
      return new DbError('permission-denied', msg('No permission for {0} on the server', path), {
        cause: error,
      });
    default:
      return new DbError(
        'unsupported',
        msg('The server could not handle {0}: {1}', path, errorMessage(error)),
        { cause: error },
      );
  }
}

function kindOf(mode: number): SftpKind {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'directory';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'other';
  }
}

function statOf(stats: Stats): SftpStat {
  return {
    kind: kindOf(stats.mode),
    size: stats.size,
    modified: stats.mtime * 1000,
    mode: stats.mode,
    ...(typeof stats.uid === 'number' ? { uid: stats.uid } : {}),
    ...(typeof stats.gid === 'number' ? { gid: stats.gid } : {}),
  };
}

function call<T>(
  path: string,
  run: (done: (error: Error | null | undefined, value?: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      run((error, value) => {
        if (error) {
          reject(sftpError(error, path));
        } else {
          resolve(value as T);
        }
      });
    } catch (error) {
      reject(sftpError(error, path));
    }
  });
}

class Session implements SftpSession {
  readonly closed: Promise<void>;
  private gone = false;

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly clients: readonly Client[],
  ) {
    const last = clients.at(-1);
    this.closed = new Promise<void>((resolveClosed) => {
      const resolve = (): void => {
        this.gone = true;
        resolveClosed();
      };
      // Errors after the login (a dropped link, a request cut short) end the session; without
      // a listener ssh2 would throw them from inside its socket handler and the 'close'
      // events would never come.
      sftp.on('error', () => {
        resolve();
      });
      sftp.once('close', () => {
        resolve();
      });
      for (const client of clients) {
        client.on('error', () => {
          resolve();
        });
      }
      last?.once('close', () => {
        resolve();
      });
    });
  }

  /** A request on a session that is gone would wait for an answer that never comes. */
  private alive(path: string): void {
    if (this.gone) {
      throw sftpError(new Error('the session is closed'), path);
    }
  }

  async home(): Promise<string> {
    return await this.realpath('.');
  }

  async realpath(path: string): Promise<string> {
    this.alive(path);
    return await call<string>(path, (done) => {
      this.sftp.realpath(path, done);
    });
  }

  async list(path: string): Promise<SftpEntry[]> {
    this.alive(path);
    const items = await call<FileEntryWithStats[]>(path, (done) => {
      this.sftp.readdir(path, done);
    });
    const entries: SftpEntry[] = [];
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') {
        continue;
      }
      const full = joinRemote(path, item.filename);
      const own = statOf(item.attrs);
      if (own.kind !== 'symlink') {
        entries.push({ ...own, name: item.filename, path: full, link: false });
        continue;
      }
      // A link shows what it leads to; a broken one stays a link.
      const target = await this.stat(full).catch(() => undefined);
      entries.push({
        ...(target ?? own),
        kind: target?.kind ?? 'symlink',
        name: item.filename,
        path: full,
        link: true,
      });
    }
    return entries;
  }

  async stat(path: string): Promise<SftpStat | undefined> {
    this.alive(path);
    try {
      return statOf(
        await call<Stats>(path, (done) => {
          this.sftp.stat(path, done);
        }),
      );
    } catch (error) {
      if (error instanceof DbError && error.code === 'not-found') {
        return undefined;
      }
      throw error;
    }
  }

  async openRead(path: string): Promise<{ stream: Readable; size: number }> {
    const stats = await this.stat(path);
    if (stats === undefined) {
      throw sftpError({ code: NO_SUCH_FILE }, path);
    }
    if (stats.kind === 'directory') {
      throw new DbError('unsupported', msg('{0} on the server is a folder, not a file', path));
    }
    const stream = this.sftp.createReadStream(path);
    // ssh2 reads ahead; if the link closes while those reads are out, the stream reports
    // an error nobody is waiting for any more, and an unheard 'error' would be thrown.
    stream.on('error', () => undefined);
    return { stream, size: stats.size };
  }

  async openWrite(path: string, mode?: number): Promise<Writable> {
    this.alive(path);
    // A write stream reports a refusal only on its first write; asking for the handle
    // first makes "no permission" and "no such folder" fail here, before any data moves.
    await call<undefined>(path, (done) => {
      this.sftp.open(path, 'w', mode ?? 0o644, (error, handle) => {
        if (error) {
          done(error);
        } else {
          this.sftp.close(handle, (closeError) => {
            done(closeError);
          });
        }
      });
    });
    const stream = this.sftp.createWriteStream(path, { flags: 'w', mode: mode ?? 0o644 });
    stream.on('error', () => undefined);
    return stream;
  }

  async mkdir(path: string): Promise<void> {
    this.alive(path);
    await call<undefined>(path, (done) => {
      this.sftp.mkdir(path, done);
    });
  }

  async rmdir(path: string): Promise<void> {
    this.alive(path);
    await call<undefined>(path, (done) => {
      this.sftp.rmdir(path, done);
    });
  }

  async unlink(path: string): Promise<void> {
    this.alive(path);
    await call<undefined>(path, (done) => {
      this.sftp.unlink(path, done);
    });
  }

  async rename(from: string, to: string): Promise<void> {
    this.alive(from);
    await call<undefined>(from, (done) => {
      this.sftp.rename(from, to, done);
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.alive(path);
    await call<undefined>(path, (done) => {
      this.sftp.chmod(path, mode, done);
    });
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    this.alive(path);
    await call<undefined>(path, (done) => {
      this.sftp.chown(path, uid, gid, done);
    });
  }

  close(): void {
    this.gone = true;
    this.sftp.end();
    for (const client of [...this.clients].reverse()) {
      client.end();
    }
  }
}

/** Logs in through every hop of the chain and opens the SFTP subsystem of the last one. */
export async function openSftpSession(spec: RemoteFileSpec, logger: Logger): Promise<SftpSession> {
  const clients = await connectChain(spec, logger);
  const last = clients.at(-1);
  try {
    if (last === undefined) {
      throw new DbError('internal', msg('The SSH chain is empty'));
    }
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      last.sftp((error, opened) => {
        if (error) {
          reject(
            new DbError(
              'connection-failed',
              msg('The SSH server does not offer file transfer (SFTP): {0}', errorMessage(error)),
              { cause: error },
            ),
          );
        } else {
          resolve(opened);
        }
      });
    });
    return new Session(sftp, clients);
  } catch (error) {
    for (const client of [...clients].reverse()) {
      client.end();
    }
    throw error;
  }
}
