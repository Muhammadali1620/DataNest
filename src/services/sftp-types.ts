// What the file browser (V13.16) needs of an SFTP connection. The implementation sits in the
// SSH bundle (services/ssh/sftp-session.ts, the only file that talks to ssh2); everything
// else — the operations, the tree, the editor file system — works against these types, so it
// is tested without a network.

import type { Readable, Writable } from 'node:stream';
import type { RemoteFileSpec } from './remote-snapshots';

export type SftpKind = 'file' | 'directory' | 'symlink' | 'other';

/** What a path is, as the server reports it. */
export interface SftpStat {
  /** What the path is after following links; `symlink` only for a link that leads nowhere. */
  readonly kind: SftpKind;
  readonly size: number;
  /** Last change, milliseconds since 1970. */
  readonly modified: number;
  /** Unix mode bits, including the file type. */
  readonly mode: number;
}

export interface SftpEntry extends SftpStat {
  readonly name: string;
  /** Full path on the server. */
  readonly path: string;
  /** True for a link; `kind` then says what it points at (`symlink` if it is broken). */
  readonly link: boolean;
}

export interface SftpSession {
  /** Settles once the connection is gone, closed on purpose or not. */
  readonly closed: Promise<void>;
  /** The login folder of the user, as an absolute path. */
  home(): Promise<string>;
  /** The absolute, link-free form of a path. */
  realpath(path: string): Promise<string>;
  /** The entries of a folder, in the server's order. */
  list(path: string): Promise<SftpEntry[]>;
  /** Follows links; undefined when the path does not exist. */
  stat(path: string): Promise<SftpStat | undefined>;
  /** Streams the file from the start; `size` is what the server said before reading. */
  openRead(path: string): Promise<{ readonly stream: Readable; readonly size: number }>;
  /** Streams into the file, created or emptied first. */
  openWrite(path: string, mode?: number): Promise<Writable>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  close(): void;
}

/** What the SSH bundle offers for the browser: a session over a chain of hops. */
export interface SftpOpener {
  openSftp(spec: RemoteFileSpec): Promise<SftpSession>;
}
