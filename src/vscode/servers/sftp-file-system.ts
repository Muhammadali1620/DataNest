import * as vscode from 'vscode';
import { DbError } from '../../core/errors';
import type { SftpHub } from '../../services/sftp-hub';
import {
  entryAt,
  exists,
  moveEntry,
  readLimited,
  removeTree,
  writeBuffer,
} from '../../services/sftp-ops';
import type { ServerStore } from '../../services/server-store';
import type { SftpKind, SftpSession } from '../../services/sftp-types';

export interface SftpFileSystemDeps {
  readonly hub: SftpHub;
  readonly store: Pick<ServerStore, 'get'>;
  /** The largest file that opens in the editor, in bytes. */
  readonly maxOpenBytes: () => number;
}

function typeOf(kind: SftpKind, link = false): vscode.FileType {
  const base: number =
    kind === 'directory'
      ? vscode.FileType.Directory
      : kind === 'file'
        ? vscode.FileType.File
        : vscode.FileType.Unknown;
  // The editor's flags are combined with `|`, as its documentation says.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- flags, combined with |
  return link ? base | vscode.FileType.SymbolicLink : base;
}

/** The editor's own errors, which it knows how to show, for ours. */
function asFileError(error: unknown, uri: vscode.Uri): Error {
  if (error instanceof vscode.FileSystemError) {
    return error;
  }
  if (error instanceof DbError) {
    if (error.code === 'not-found') {
      return vscode.FileSystemError.FileNotFound(uri);
    }
    if (error.code === 'permission-denied') {
      return vscode.FileSystemError.NoPermissions(error.message);
    }
    return vscode.FileSystemError.Unavailable(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Files of a server as the editor's own: `datanest-sftp://<server id>/<path>`. Opening one
 * reads it over SFTP; saving writes it back. The editor compares the time and size it saw
 * with what `stat` says now before it saves, so a file changed on the server meanwhile is
 * offered as a conflict instead of being overwritten.
 */
export class SftpFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  constructor(private readonly deps: SftpFileSystemDeps) {}

  watch(): vscode.Disposable {
    // Nothing is watched: a server does not tell us what changed on it.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return await this.guarded(uri, async (session) => {
      const found = await session.stat(uri.path);
      if (found === undefined) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      return {
        type: typeOf(found.kind),
        ctime: found.modified,
        mtime: found.modified,
        size: found.size,
        ...(this.deps.store.get(uri.authority)?.readOnly === true
          ? { permissions: vscode.FilePermission.Readonly }
          : {}),
      };
    });
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return await this.guarded(uri, async (session) =>
      (await session.list(uri.path)).map((entry): [string, vscode.FileType] => [
        entry.name,
        typeOf(entry.kind, entry.link),
      ]),
    );
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return await this.guarded(uri, (session) =>
      readLimited(session, uri.path, this.deps.maxOpenBytes()),
    );
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    this.requireWritable(uri);
    await this.guarded(uri, async (session) => {
      const there = await exists(session, uri.path);
      if (!there && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (there && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }
      await writeBuffer(session, uri.path, content);
    });
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    this.requireWritable(uri);
    await this.guarded(uri, (session) => session.mkdir(uri.path));
    this.changed.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    this.requireWritable(uri);
    await this.guarded(uri, async (session) => {
      const entry = await entryAt(session, uri.path);
      if (entry === undefined) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      await removeTree(session, entry);
    });
    this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(
    from: vscode.Uri,
    to: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    if (from.authority !== to.authority) {
      throw vscode.FileSystemError.NoPermissions('Files cannot be moved between servers here');
    }
    this.requireWritable(from);
    await this.guarded(from, async (session) => {
      const entry = await entryAt(session, from.path);
      if (entry === undefined) {
        throw vscode.FileSystemError.FileNotFound(from);
      }
      if (options.overwrite) {
        const target = await entryAt(session, to.path);
        if (target !== undefined) {
          await removeTree(session, target);
        }
      }
      await moveEntry(session, entry, to.path);
    });
    this.changed.fire([
      { type: vscode.FileChangeType.Deleted, uri: from },
      { type: vscode.FileChangeType.Created, uri: to },
    ]);
  }

  dispose(): void {
    this.changed.dispose();
  }

  private requireWritable(uri: vscode.Uri): void {
    if (this.deps.store.get(uri.authority)?.readOnly === true) {
      throw vscode.FileSystemError.NoPermissions(
        vscode.l10n.t('The server is read-only: nothing on it may change'),
      );
    }
  }

  private async guarded<T>(
    uri: vscode.Uri,
    work: (session: SftpSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.deps.hub.run(uri.authority, work);
    } catch (error) {
      throw asFileError(error, uri);
    }
  }
}
