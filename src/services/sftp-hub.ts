// The SFTP sessions of the file browser (V13.16): one per saved server, opened when it is
// first needed, shared by everything that works with that server, closed after a quiet
// while and replaced when the link drops. The service never imports vscode or ssh2.

import { type Disposable } from '../core/disposable';
import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { msg } from '../core/user-message';
import { serverFileSpecOf } from './tunnels';
import type { HostKeyCheck } from './tunnels';
import type { RemoteFileSpec } from './remote-snapshots';
import type { ServerStore } from './server-store';
import { loadOwnerNames, type OwnerNames } from './sftp-owners';
import type { SftpSession } from './sftp-types';

export interface SftpHubDeps {
  readonly store: Pick<ServerStore, 'get' | 'getSshSecrets' | 'getProxyPassword'>;
  /** Opens a session over a chain of hops; the SSH bundle behind the tunnel pool. */
  readonly opener: { openSftp(spec: RemoteFileSpec): Promise<SftpSession> };
  readonly checkHostKey: HostKeyCheck;
  readonly logger: Logger;
  /** A session nobody used for this long is closed; it opens again when needed. */
  readonly idleMs?: number;
}

/** Five minutes: long enough to browse, short enough not to leave logins open all day. */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

interface Entry {
  readonly session: Promise<SftpSession>;
  dead: boolean;
  /** True once the session has been opened, i.e. a later failure may be a dropped link. */
  opened: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Work running on the session; it is not closed for idleness meanwhile. */
  busy: number;
  /** The names of owners and groups of the server, read once per session (V13.36). */
  owners: Promise<OwnerNames> | undefined;
  ownerNames: OwnerNames | undefined;
}

type StateListener = (serverId: string) => void;

export class SftpHub implements Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<StateListener>();
  private readonly idleMs: number;
  private readonly logger: Logger;
  private disposed = false;

  constructor(private readonly deps: SftpHubDeps) {
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.logger = deps.logger.child('sftp');
  }

  /** True while a session of the server is open or opening. */
  isOpen(serverId: string): boolean {
    const entry = this.entries.get(serverId);
    return entry !== undefined && !entry.dead;
  }

  /** Called when a server's session opens or closes, so the tree can redraw it. */
  onDidChangeState(listener: StateListener): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * Runs `work` on the server's session. A session that turned out to be dead (the link
   * dropped while idle) is replaced and the work tried once more — only when it failed
   * before doing anything the user could notice, i.e. when the error is a lost link.
   */
  async run<T>(serverId: string, work: (session: SftpSession) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const entry = this.entry(serverId);
      entry.busy += 1;
      this.clearTimer(entry);
      try {
        return await work(await entry.session);
      } catch (error) {
        // Only a session that had been working can have dropped; a first connect that
        // fails is the user's to read, not to repeat (it would ask about the host key twice).
        if (attempt > 0 || !entry.opened || !isLostLink(error)) {
          throw error;
        }
        this.logger.debug(`The SFTP link to ${serverId} was lost; opening it again`);
        this.disconnect(serverId);
      } finally {
        entry.busy -= 1;
        this.armTimer(serverId, entry);
      }
    }
  }

  /**
   * The names of the server's users and groups, read from `/etc/passwd` and `/etc/group` once
   * per session (none when the server has no such files or does not let them be read).
   */
  async ownerNames(serverId: string): Promise<OwnerNames> {
    const entry = this.entry(serverId);
    entry.owners ??= this.run(serverId, async (session) => {
      const names = await loadOwnerNames(session);
      entry.ownerNames = names;
      return names;
    });
    try {
      return await entry.owners;
    } catch (error) {
      // A failed try (the link dropped) is made again next time, not remembered.
      entry.owners = undefined;
      throw error;
    }
  }

  /** What `ownerNames` read, if it has by now; never opens or waits for anything. */
  peekOwnerNames(serverId: string): OwnerNames | undefined {
    return this.entries.get(serverId)?.ownerNames;
  }

  /** The session itself, for a long task that holds it across several calls. */
  async session(serverId: string): Promise<SftpSession> {
    const entry = this.entry(serverId);
    this.armTimer(serverId, entry);
    return await entry.session;
  }

  /** Closes the server's session now (Disconnect, or the server was edited or removed). */
  disconnect(serverId: string): void {
    const entry = this.entries.get(serverId);
    if (entry === undefined) {
      return;
    }
    this.forget(serverId, entry);
    void entry.session.then(
      (session) => {
        session.close();
      },
      () => undefined,
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.entries.keys()]) {
      this.disconnect(id);
    }
    this.listeners.clear();
  }

  private entry(serverId: string): Entry {
    if (this.disposed) {
      throw new DbError('internal', msg('The file browser is closed'));
    }
    const existing = this.entries.get(serverId);
    if (existing !== undefined && !existing.dead) {
      return existing;
    }
    const entry: Entry = {
      session: this.open(serverId),
      dead: false,
      opened: false,
      timer: undefined,
      busy: 0,
      owners: undefined,
      ownerNames: undefined,
    };
    this.entries.set(serverId, entry);
    entry.session.then(
      (session) => {
        entry.opened = true;
        this.emit(serverId);
        void session.closed.then(() => {
          if (this.entries.get(serverId) === entry) {
            this.forget(serverId, entry);
          } else {
            entry.dead = true;
          }
        });
      },
      () => {
        // A session that never opened is not kept: the next try starts again.
        if (this.entries.get(serverId) === entry) {
          this.forget(serverId, entry);
        } else {
          entry.dead = true;
        }
      },
    );
    return entry;
  }

  private async open(serverId: string): Promise<SftpSession> {
    const server = this.deps.store.get(serverId);
    if (server === undefined) {
      throw new DbError('not-found', msg('The server "{0}" does not exist', serverId));
    }
    const spec = serverFileSpecOf(
      server,
      await this.deps.store.getSshSecrets(serverId),
      this.deps.checkHostKey,
      await this.deps.store.getProxyPassword(serverId),
    );
    return await this.deps.opener.openSftp(spec);
  }

  private forget(serverId: string, entry: Entry): void {
    entry.dead = true;
    this.clearTimer(entry);
    if (this.entries.get(serverId) === entry) {
      this.entries.delete(serverId);
    }
    this.emit(serverId);
  }

  private armTimer(serverId: string, entry: Entry): void {
    this.clearTimer(entry);
    if (entry.dead || entry.busy > 0 || this.idleMs <= 0) {
      return;
    }
    entry.timer = setTimeout(() => {
      this.logger.debug(`Closing the idle SFTP session of ${serverId}`);
      this.disconnect(serverId);
    }, this.idleMs);
    entry.timer.unref();
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private emit(serverId: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(serverId);
      } catch (error) {
        this.logger.warn('A file browser listener failed', error);
      }
    }
  }
}

/** True for the errors a dropped link produces. */
function isLostLink(error: unknown): boolean {
  return error instanceof DbError && error.code === 'connection-failed';
}
