// A session handed out by ConnectionManager. It behaves exactly like the driver's
// session but tells the manager when the link is gone, so the dead connection is
// dropped and the next acquire() opens a fresh one.

import { toDbError } from '../core/errors';
import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectInfo,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
  TableStructure,
} from '../core/model/objects';
import type {
  ExecuteEvent,
  ExecuteOptions,
  MetadataReader,
  Session,
  TableDump,
  TransactionState,
  TypeDump,
} from '../drivers/driver';

/** Errors that mean the connection itself is unusable, not just this statement. */
function isLinkLost(code: string): boolean {
  return code === 'connection-failed';
}

export interface ManagedSessionHooks {
  /** Called once when a call fails because the link is gone. */
  readonly onLinkLost: (error: unknown) => void;
  /** Called after the session closed, e.g. to let go of its SSH tunnel. */
  readonly onClosed?: () => Promise<void>;
  /** Called when a statement left the transaction in another state (V4.8). */
  readonly onTransaction?: (state: TransactionState) => void;
  /**
   * After this many quiet milliseconds the session sends `SELECT 1` (V4.9), so a
   * server or firewall that drops idle links keeps it, and a dead link is noticed
   * before the user's next statement rather than by it.
   */
  readonly keepAliveMs?: number;
}

/** What the keep-alive sends; every supported database answers it. */
export const KEEP_ALIVE_STATEMENT = 'SELECT 1';

export class ManagedSession implements Session {
  readonly metadata: MetadataReader;
  private readonly onLinkLost: (error: unknown) => void;
  private readonly onClosed: () => Promise<void>;
  private readonly onTransaction: (state: TransactionState) => void;
  private lastTransaction: TransactionState = 'idle';
  private readonly keepAliveMs: number;
  private keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Statements in flight; the keep-alive waits for quiet. */
  private busy = 0;
  private closed = false;

  constructor(
    private readonly inner: Session,
    hooks: ManagedSessionHooks,
  ) {
    this.onLinkLost = hooks.onLinkLost;
    this.onClosed = hooks.onClosed ?? (() => Promise.resolve());
    this.onTransaction = hooks.onTransaction ?? (() => undefined);
    this.keepAliveMs = hooks.keepAliveMs ?? 0;
    this.metadata = new ManagedMetadata(inner.metadata, (error) => {
      this.report(error);
    });
  }

  execute(sql: string, options?: ExecuteOptions): AsyncIterable<ExecuteEvent> {
    return this.watch(this.inner.execute(sql, options));
  }

  /** What the driver says, or undefined where it cannot tell. */
  transactionState(): TransactionState | undefined {
    return this.inner.transactionState?.();
  }

  async cancel(): Promise<void> {
    try {
      await this.inner.cancel();
    } catch (error) {
      this.report(error);
      throw toDbError(error);
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

  private async *watch(events: AsyncIterable<ExecuteEvent>): AsyncGenerator<ExecuteEvent> {
    this.busy += 1;
    this.stopKeepAlive();
    try {
      for await (const event of events) {
        yield event;
      }
    } catch (error) {
      this.report(error);
      throw toDbError(error);
    } finally {
      this.busy -= 1;
      this.checkTransaction();
      this.scheduleKeepAlive();
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
      for await (const _event of this.inner.execute(KEEP_ALIVE_STATEMENT, { rowLimit: 1 })) {
        // The answer does not matter, only that there is one.
      }
    } catch (error) {
      // A dead link is reported and the session dropped; other errors (a failed
      // PostgreSQL transaction refuses even SELECT 1) leave it be.
      this.report(error);
    }
    // A session the report closed stays quiet: scheduling checks for that.
    this.scheduleKeepAlive();
  }

  /** Tells the owner when a statement opened, ended or spoiled a transaction. */
  private checkTransaction(): void {
    const state = this.inner.transactionState?.();
    if (state !== undefined && state !== this.lastTransaction) {
      this.lastTransaction = state;
      this.onTransaction(state);
    }
  }

  private report(error: unknown): void {
    if (isLinkLost(toDbError(error).code)) {
      this.onLinkLost(error);
    }
  }
}

class ManagedMetadata implements MetadataReader {
  constructor(
    private readonly inner: MetadataReader,
    private readonly report: (error: unknown) => void,
  ) {}

  async listDatabases(): Promise<string[]> {
    return await this.guard(() => this.inner.listDatabases());
  }

  async listSchemas(database?: string): Promise<string[]> {
    return await this.guard(() => this.inner.listSchemas(database));
  }

  async listTables(scope: ObjectScope): Promise<TableInfo[]> {
    return await this.guard(() => this.inner.listTables(scope));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    return await this.guard(() => this.inner.listColumns(table));
  }

  async listUniqueKeys(table: TableRef): Promise<string[][]> {
    return await this.guard(() => this.inner.listUniqueKeys(table));
  }

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    return await this.guard(() => this.inner.listForeignKeys(table));
  }

  async listObjects(scope: ObjectScope, kind: ListedObjectKind): Promise<ObjectInfo[]> {
    return await this.guard(() => this.inner.listObjects(scope, kind));
  }

  async listIndexes(table: TableRef): Promise<IndexInfo[]> {
    return await this.guard(() => this.inner.listIndexes(table));
  }

  async describeTable(table: TableRef): Promise<TableStructure> {
    return await this.guard(() => this.inner.describeTable(table));
  }

  async getDefinition(object: ObjectRef): Promise<string[]> {
    return await this.guard(() => this.inner.getDefinition(object));
  }

  async getTableDump(table: TableRef): Promise<TableDump> {
    return await this.guard(() => this.inner.getTableDump(table));
  }

  async listTypeDumps(scope: ObjectScope, tables?: readonly string[]): Promise<TypeDump[]> {
    return await this.guard(() => this.inner.listTypeDumps(scope, tables));
  }

  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.report(error);
      throw toDbError(error);
    }
  }
}
