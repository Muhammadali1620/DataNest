// A ZooKeeper session handed out by ConnectionManager (V13.24). It behaves like the driver's
// session but tells the manager when the link is gone, so the dead session is dropped and
// the next acquireZookeeper() opens a fresh one (D26). The driver pings the server on its
// own to keep the session alive, so no keep-alive is armed here.

import { toDbError } from '../../core/errors';
import type {
  ZookeeperAcl,
  ZookeeperCreateMode,
  ZookeeperServerInfo,
  ZookeeperSession,
  ZookeeperStat,
} from '../../drivers/zookeeper-driver';

export interface ManagedZookeeperSessionHooks {
  readonly onLinkLost: (error: unknown) => void;
  readonly onClosed?: () => Promise<void>;
  /** Unused: the driver pings by itself. Accepted so the manager treats all families alike. */
  readonly keepAliveMs?: number;
}

export class ManagedZookeeperSession implements ZookeeperSession {
  private readonly onLinkLost: (error: unknown) => void;
  private readonly onClosed: () => Promise<void>;

  constructor(
    private readonly inner: ZookeeperSession,
    hooks: ManagedZookeeperSessionHooks,
  ) {
    this.onLinkLost = hooks.onLinkLost;
    this.onClosed = hooks.onClosed ?? (() => Promise.resolve());
  }

  get server(): ZookeeperServerInfo {
    return this.inner.server;
  }

  async children(
    path: string,
  ): Promise<{ readonly names: readonly string[]; readonly stat: ZookeeperStat }> {
    return await this.guard(() => this.inner.children(path));
  }

  async getData(
    path: string,
  ): Promise<{ readonly data: Uint8Array; readonly stat: ZookeeperStat }> {
    return await this.guard(() => this.inner.getData(path));
  }

  async exists(path: string): Promise<ZookeeperStat | undefined> {
    return await this.guard(() => this.inner.exists(path));
  }

  async getAcl(
    path: string,
  ): Promise<{ readonly acl: readonly ZookeeperAcl[]; readonly stat: ZookeeperStat }> {
    return await this.guard(() => this.inner.getAcl(path));
  }

  async setAcl(
    path: string,
    acl: readonly ZookeeperAcl[],
    version: number,
  ): Promise<ZookeeperStat> {
    return await this.guard(() => this.inner.setAcl(path, acl, version));
  }

  serverVersion(): Promise<string | undefined> {
    // Best effort on a second socket: a failure here says nothing about the session.
    return this.inner.serverVersion().catch(() => undefined);
  }

  async create(path: string, data: Uint8Array, mode: ZookeeperCreateMode): Promise<string> {
    return await this.guard(() => this.inner.create(path, data, mode));
  }

  async setData(path: string, data: Uint8Array, version: number): Promise<ZookeeperStat> {
    return await this.guard(() => this.inner.setData(path, data, version));
  }

  async remove(path: string, version: number): Promise<void> {
    await this.guard(() => this.inner.remove(path, version));
  }

  async close(): Promise<void> {
    try {
      await this.inner.close();
    } finally {
      await this.onClosed();
    }
  }

  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const failure = toDbError(error);
      if (failure.code === 'connection-failed') {
        this.onLinkLost(error);
      }
      throw failure;
    }
  }
}
