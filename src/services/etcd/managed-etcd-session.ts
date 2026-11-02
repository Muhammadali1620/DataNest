// An etcd session handed out by ConnectionManager (V13.19). It behaves like the driver's
// session but tells the manager when the link is gone, so the dead session is dropped and
// the next acquireEtcd() opens a fresh one (D26), and it asks the cluster for its status
// after a quiet spell (V4.9) to keep the link and the sign-in token alive.

import { toDbError } from '../../core/errors';
import type { EtcdCallOptions, EtcdServerInfo, EtcdSession } from '../../drivers/etcd-driver';

export interface ManagedEtcdSessionHooks {
  readonly onLinkLost: (error: unknown) => void;
  readonly onClosed?: () => Promise<void>;
  /** Quiet milliseconds before a ping; 0 or absent: never. */
  readonly keepAliveMs?: number;
}

export class ManagedEtcdSession implements EtcdSession {
  private readonly onLinkLost: (error: unknown) => void;
  private readonly onClosed: () => Promise<void>;
  private readonly keepAliveMs: number;
  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = 0;
  private closed = false;

  constructor(
    private readonly inner: EtcdSession,
    hooks: ManagedEtcdSessionHooks,
  ) {
    this.onLinkLost = hooks.onLinkLost;
    this.onClosed = hooks.onClosed ?? (() => Promise.resolve());
    this.keepAliveMs = hooks.keepAliveMs ?? 0;
  }

  get server(): EtcdServerInfo {
    return this.inner.server;
  }

  async call(
    path: string,
    body: Readonly<Record<string, unknown>>,
    options?: EtcdCallOptions,
  ): Promise<unknown> {
    this.busy += 1;
    this.stopKeepAlive();
    try {
      return await this.inner.call(path, body, options);
    } catch (error) {
      this.report(error);
      throw toDbError(error);
    } finally {
      this.busy -= 1;
      this.scheduleKeepAlive();
    }
  }

  /** A stream counts as busy for as long as it runs: the link is not quiet, so no ping. */
  async watch(
    path: string,
    body: Readonly<Record<string, unknown>>,
    onMessage: (message: unknown) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.busy += 1;
    this.stopKeepAlive();
    try {
      await this.inner.watch(path, body, onMessage, signal);
    } catch (error) {
      this.report(error);
      throw toDbError(error);
    } finally {
      this.busy -= 1;
      this.scheduleKeepAlive();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopKeepAlive();
    try {
      await this.inner.close();
    } finally {
      await this.onClosed();
    }
  }

  /** Arms the keep-alive for the next stretch of quiet; the session starts quiet. */
  scheduleKeepAlive(): void {
    this.stopKeepAlive();
    if (this.keepAliveMs <= 0 || this.closed || this.busy > 0) {
      return;
    }
    this.keepAliveTimer = setTimeout(() => {
      void this.ping();
    }, this.keepAliveMs);
    this.keepAliveTimer.unref();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== undefined) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private async ping(): Promise<void> {
    this.keepAliveTimer = undefined;
    if (this.closed || this.busy > 0) {
      return;
    }
    try {
      await this.inner.call('maintenance/status', {});
    } catch (error) {
      this.report(error);
    }
    this.scheduleKeepAlive();
  }

  private report(error: unknown): void {
    if (toDbError(error).code === 'connection-failed') {
      this.onLinkLost(error);
    }
  }
}
