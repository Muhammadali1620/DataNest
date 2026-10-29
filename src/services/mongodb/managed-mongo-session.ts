// A MongoDB session handed out by ConnectionManager (V7.5). It behaves like the driver's
// session but tells the manager when the link is gone, so the dead client is dropped and
// the next acquireMongo() opens a fresh one (D26), and it sends `ping` after a quiet
// spell (V4.9). Cursors it opens report a lost link the same way.

import { toDbError } from '../../core/errors';
import { doc, int32, type MongoDocument } from '../../core/mongo/value';
import type {
  MongoCollectionInfo,
  MongoCursor,
  MongoCursorRequest,
  MongoDatabaseInfo,
  MongoRawDocument,
  MongoServerInfo,
  MongoSession,
} from '../../drivers/mongo-driver';
import type { MongoMode } from '../../shared/connection';

export interface ManagedMongoSessionHooks {
  /** Called once when a call fails because the link is gone. */
  readonly onLinkLost: (error: unknown) => void;
  /** Called after the session closed, e.g. to let go of its SSH tunnel. */
  readonly onClosed?: () => Promise<void>;
  /** Quiet milliseconds before a ping; 0 or absent: never. */
  readonly keepAliveMs?: number;
}

const PING = doc([['ping', int32(1)]]);

export class ManagedMongoSession implements MongoSession {
  private readonly onLinkLost: (error: unknown) => void;
  private readonly onClosed: () => Promise<void>;
  private readonly keepAliveMs: number;
  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Calls in flight; the keep-alive waits for quiet. */
  private busy = 0;
  private closed = false;

  constructor(
    private readonly inner: MongoSession,
    hooks: ManagedMongoSessionHooks,
  ) {
    this.onLinkLost = hooks.onLinkLost;
    this.onClosed = hooks.onClosed ?? (() => Promise.resolve());
    this.keepAliveMs = hooks.keepAliveMs ?? 0;
  }

  get mode(): MongoMode {
    return this.inner.mode;
  }

  get server(): MongoServerInfo {
    return this.inner.server;
  }

  async listDatabases(): Promise<MongoDatabaseInfo[]> {
    return await this.watch(() => this.inner.listDatabases());
  }

  async listCollections(database: string): Promise<MongoCollectionInfo[]> {
    return await this.watch(() => this.inner.listCollections(database));
  }

  async listIndexes(database: string, collection: string): Promise<MongoDocument[]> {
    return await this.watch(() => this.inner.listIndexes(database, collection));
  }

  async command(database: string, command: MongoDocument): Promise<MongoDocument> {
    return await this.watch(() => this.inner.command(database, command));
  }

  async openCursor(database: string, request: MongoCursorRequest): Promise<MongoCursor> {
    const cursor = await this.watch(() => this.inner.openCursor(database, request));
    return {
      next: async (count: number): Promise<{ documents: MongoRawDocument[]; done: boolean }> =>
        await this.watch(() => cursor.next(count)),
      close: async (): Promise<void> => {
        await this.watch(() => cursor.close());
      },
    };
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
      await this.inner.command('admin', PING);
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
