// Puts a SQLite file on a server into the hands of a session that may change it (V13.33): the
// pieces the connection manager knows (the copy, the tunnel chain, the driver) turned into the
// few calls the session needs. Kept out of the manager so that file stays about connecting.

import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { msg } from '../core/user-message';
import type { Session } from '../drivers/driver';
import type { RemoteFileSpec, SnapshotLease, SnapshotProvider } from './remote-snapshots';
import { RemoteWritableSession } from './remote-sqlite-session';
import { RemoteSqliteWriter } from './remote-sqlite-writer';
import type { ExecOpener } from './shell-types';

export interface WritableFileArgs {
  /** Names the copy of the file; the same key the first lease was taken with. */
  readonly key: string;
  readonly spec: RemoteFileSpec;
  /** The path of the file on the server. */
  readonly remotePath: string;
  readonly maxBytes: number;
  readonly snapshots: SnapshotProvider;
  /** Absent where there is no SSH (a changing statement then says so). */
  readonly execs: ExecOpener | undefined;
  /** Opens the SQLite driver's session over a copy. */
  readonly openLocal: (path: string) => Promise<Session>;
  /** What every new connection to the file runs first, e.g. `PRAGMA foreign_keys = ON`. */
  readonly init: readonly string[];
  readonly logger: Logger;
  /** The session over the first copy, the lease of that copy, and its generation. */
  readonly local: Session;
  readonly lease: SnapshotLease;
  readonly generation: number;
}

export function writableFileSession(args: WritableFileArgs): Session {
  return new RemoteWritableSession(
    {
      openLocal: args.openLocal,
      acquireCopy: () =>
        args.snapshots.acquire(args.key, args.spec, args.remotePath, args.maxBytes),
      generation: () => args.snapshots.generation(args.key),
      invalidate: () => {
        args.snapshots.invalidate(args.key);
      },
      openWriter: () => {
        if (args.execs === undefined) {
          return Promise.reject(
            new DbError('unsupported', msg('Changing files on a server is not available')),
          );
        }
        return RemoteSqliteWriter.open(args.execs, args.spec, args.remotePath, {
          init: args.init,
          logger: args.logger,
        });
      },
    },
    { local: args.local, lease: args.lease, generation: args.generation },
  );
}

/** Starts the helper on the server and opens the file for writing, then lets go: "Test connection". */
export async function checkRemoteWritable(
  execs: ExecOpener,
  spec: RemoteFileSpec,
  remotePath: string,
  logger: Logger,
): Promise<void> {
  const writer = await RemoteSqliteWriter.open(execs, spec, remotePath, { logger });
  await writer.close();
}
