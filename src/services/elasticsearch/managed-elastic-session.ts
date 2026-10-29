// An Elasticsearch session handed out by ConnectionManager (V7.8). It behaves like the
// driver's session but tells the manager when the link is gone, so the dead session is
// dropped and the next acquireElastic() opens a fresh one (D26), and it asks `HEAD /`
// after a quiet spell (V4.9).

import { toDbError } from '../../core/errors';
import type {
  ElasticRequest,
  ElasticResponse,
  ElasticServerInfo,
  ElasticSession,
} from '../../drivers/elastic-driver';

export interface ManagedElasticSessionHooks {
  readonly onLinkLost: (error: unknown) => void;
  readonly onClosed?: () => Promise<void>;
  /** Quiet milliseconds before a ping; 0 or absent: never. */
  readonly keepAliveMs?: number;
}

export class ManagedElasticSession implements ElasticSession {
  private readonly onLinkLost: (error: unknown) => void;
  private readonly onClosed: () => Promise<void>;
  private readonly keepAliveMs: number;
  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = 0;
  private closed = false;

  constructor(
    private readonly inner: ElasticSession,
    hooks: ManagedElasticSessionHooks,
  ) {
    this.onLinkLost = hooks.onLinkLost;
    this.onClosed = hooks.onClosed ?? (() => Promise.resolve());
    this.keepAliveMs = hooks.keepAliveMs ?? 0;
  }

  get server(): ElasticServerInfo {
    return this.inner.server;
  }

  async request(request: ElasticRequest): Promise<ElasticResponse> {
    this.busy += 1;
    this.stopKeepAlive();
    try {
      return await this.inner.request(request);
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
      await this.inner.request({ method: 'HEAD', path: '/' });
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
