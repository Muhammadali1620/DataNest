// A session handed out by ConnectionManager. It behaves exactly like the driver's
// session but tells the manager when the link is gone, so the dead connection is
// dropped and the next acquire() opens a fresh one.

import { toDbError } from '../core/errors';
import type {
  ColumnInfo,
  ForeignKey,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
} from '../core/model/objects';
import type { ExecuteEvent, ExecuteOptions, MetadataReader, Session } from '../drivers/driver';

/** Errors that mean the connection itself is unusable, not just this statement. */
function isLinkLost(code: string): boolean {
  return code === 'connection-failed';
}

export class ManagedSession implements Session {
  readonly metadata: MetadataReader;

  constructor(
    private readonly inner: Session,
    /** Called once when a call fails because the link is gone. */
    private readonly onLinkLost: (error: unknown) => void,
  ) {
    this.metadata = new ManagedMetadata(inner.metadata, (error) => {
      this.report(error);
    });
  }

  execute(sql: string, options?: ExecuteOptions): AsyncIterable<ExecuteEvent> {
    return this.watch(this.inner.execute(sql, options));
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
    await this.inner.close();
  }

  private async *watch(events: AsyncIterable<ExecuteEvent>): AsyncGenerator<ExecuteEvent> {
    try {
      for await (const event of events) {
        yield event;
      }
    } catch (error) {
      this.report(error);
      throw toDbError(error);
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

  async getDefinition(object: ObjectRef): Promise<string[]> {
    return await this.guard(() => this.inner.getDefinition(object));
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
