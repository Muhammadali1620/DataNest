// A RabbitMQ session handed out by ConnectionManager (V13.26). It behaves like the driver's
// session but tells the manager when the link is gone, so the dead session is dropped and
// the next acquireRabbit() opens a fresh one (D26), and it lists the virtual hosts after a
// quiet spell (V4.9) to keep the connection from being closed when idle.

import { toDbError } from '../../core/errors';
import type {
  RabbitBinding,
  RabbitExchangeDeclaration,
  RabbitExchangeInfo,
  RabbitMessage,
  RabbitPage,
  RabbitPeekRequest,
  RabbitPublishRequest,
  RabbitQueueDeclaration,
  RabbitQueueInfo,
  RabbitServerInfo,
  RabbitSession,
  RabbitVhostInfo,
} from '../../drivers/rabbitmq-driver';

export interface ManagedRabbitSessionHooks {
  readonly onLinkLost: (error: unknown) => void;
  readonly onClosed?: () => Promise<void>;
  /** Quiet milliseconds before a ping; 0 or absent: never. */
  readonly keepAliveMs?: number;
}

export class ManagedRabbitSession implements RabbitSession {
  private readonly onLinkLost: (error: unknown) => void;
  private readonly onClosed: () => Promise<void>;
  private readonly keepAliveMs: number;
  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = 0;
  private closed = false;

  constructor(
    private readonly inner: RabbitSession,
    hooks: ManagedRabbitSessionHooks,
  ) {
    this.onLinkLost = hooks.onLinkLost;
    this.onClosed = hooks.onClosed ?? (() => Promise.resolve());
    this.keepAliveMs = hooks.keepAliveMs ?? 0;
  }

  get server(): RabbitServerInfo {
    return this.inner.server;
  }

  listVhosts(): Promise<readonly RabbitVhostInfo[]> {
    return this.call(() => this.inner.listVhosts());
  }

  listQueues(vhost: string): Promise<RabbitPage<RabbitQueueInfo>> {
    return this.call(() => this.inner.listQueues(vhost));
  }

  listExchanges(vhost: string): Promise<RabbitPage<RabbitExchangeInfo>> {
    return this.call(() => this.inner.listExchanges(vhost));
  }

  getQueue(vhost: string, name: string): Promise<RabbitQueueInfo> {
    return this.call(() => this.inner.getQueue(vhost, name));
  }

  getExchange(vhost: string, name: string): Promise<RabbitExchangeInfo> {
    return this.call(() => this.inner.getExchange(vhost, name));
  }

  listBindings(
    vhost: string,
    target: { readonly queue: string } | { readonly exchange: string },
  ): Promise<readonly RabbitBinding[]> {
    return this.call(() => this.inner.listBindings(vhost, target));
  }

  peekMessages(request: RabbitPeekRequest): Promise<readonly RabbitMessage[]> {
    return this.call(() => this.inner.peekMessages(request));
  }

  publish(request: RabbitPublishRequest): Promise<boolean> {
    return this.call(() => this.inner.publish(request));
  }

  declareQueue(declaration: RabbitQueueDeclaration): Promise<void> {
    return this.call(() => this.inner.declareQueue(declaration));
  }

  deleteQueue(vhost: string, name: string): Promise<void> {
    return this.call(() => this.inner.deleteQueue(vhost, name));
  }

  purgeQueue(vhost: string, name: string): Promise<void> {
    return this.call(() => this.inner.purgeQueue(vhost, name));
  }

  declareExchange(declaration: RabbitExchangeDeclaration): Promise<void> {
    return this.call(() => this.inner.declareExchange(declaration));
  }

  deleteExchange(vhost: string, name: string): Promise<void> {
    return this.call(() => this.inner.deleteExchange(vhost, name));
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

  private async call<T>(run: () => Promise<T>): Promise<T> {
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
      await this.inner.listVhosts();
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
