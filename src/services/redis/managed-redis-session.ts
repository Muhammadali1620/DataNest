// A Redis session handed out by ConnectionManager (V7.1). It behaves like the driver's
// session but tells the manager when the link is gone, so the dead connection is
// dropped and the next acquireRedis() opens a fresh one (D26), and it sends PING after
// a quiet spell (V4.9) — `SELECT 1` would switch the database in Redis.

import { toDbError } from '../../core/errors';
import type { RedisCommand, RedisReply, RedisSession } from '../../drivers/redis-driver';
import type { RedisMode } from '../../shared/connection';

export interface ManagedRedisSessionHooks {
  /** Called once when a call fails because the link is gone. */
  readonly onLinkLost: (error: unknown) => void;
  /** Called after the session closed, e.g. to let go of its SSH tunnel. */
  readonly onClosed?: () => Promise<void>;
  /** Quiet milliseconds before a PING; 0 or absent: never. */
  readonly keepAliveMs?: number;
}

export class ManagedRedisSession implements RedisSession {
  private readonly onLinkLost: (error: unknown) => void;
  private readonly onClosed: () => Promise<void>;
  private readonly keepAliveMs: number;
  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Calls in flight; the keep-alive waits for quiet. */
  private busy = 0;
  private closed = false;

  constructor(
    private readonly inner: RedisSession,
    hooks: ManagedRedisSessionHooks,
  ) {
    this.onLinkLost = hooks.onLinkLost;
    this.onClosed = hooks.onClosed ?? (() => Promise.resolve());
    this.keepAliveMs = hooks.keepAliveMs ?? 0;
  }

  get mode(): RedisMode {
    return this.inner.mode;
  }

  get database(): number {
    return this.inner.database;
  }

  async call(command: RedisCommand): Promise<RedisReply> {
    return await this.watch(() => this.inner.call(command));
  }

  async pipeline(commands: readonly RedisCommand[]): Promise<RedisReply[]> {
    return await this.watch(() => this.inner.pipeline(commands));
  }

  async onMasters(command: RedisCommand): Promise<RedisReply[]> {
    return await this.watch(() => this.inner.onMasters(command));
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
    // A pending ping must not keep the extension host alive on shutdown.
    this.keepAliveTimer.unref();
  }

  private async watch<T>(run: () => Promise<T>): Promise<T> {
    this.busy += 1;
    this.stopKeepAlive();
    try {
      return await run();
    } catch (error) {
      this.report(error);
      throw toDbError(error);
    } finally {
      this.busy -= 1;
      this.scheduleKeepAlive();
    }
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
      await this.inner.call(['PING']);
    } catch (error) {
      // A dead link is reported and the session dropped; other errors leave it be.
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
