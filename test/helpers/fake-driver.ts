// A driver that records what it was asked to do, for testing services without a
// real database. Failures are injected by setting the `*Error` fields.

import { DbError } from '../../src/core/errors';
import type { DriverId, ResolvedConnectionConfig } from '../../src/shared/connection';
import type {
  ColumnInfo,
  ForeignKey,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
} from '../../src/core/model/objects';
import type {
  Dialect,
  Driver,
  DriverCapabilities,
  ExecuteEvent,
  ExecuteOptions,
  MetadataReader,
  ResultColumn,
  Session,
} from '../../src/drivers/driver';
import type { CellValue } from '../../src/shared/cell-value';

export const fakeDialect: Dialect = {
  keywords: ['SELECT'],
  quoteIdentifier: (name) => `"${name}"`,
  quoteTable: (table) => `"${table.name}"`,
  literal: () => 'NULL',
  estimateRowsSql: (table) => `ESTIMATE ${table.name}`,
  likeText: (column, pattern) => `${column} LIKE ${pattern} ESCAPE '!'`,
  paginate: (sql, limit, offset) => `${sql} LIMIT ${limit} OFFSET ${offset}`,
  defaultKeyword: true,
  insertDefaultRow: (quotedTable) => `INSERT INTO ${quotedTable} DEFAULT VALUES`,
};

export class FakeMetadata implements MetadataReader {
  databases: string[] = ['main'];
  schemas: string[] = ['public'];
  tables: TableInfo[] = [{ name: 'customers', kind: 'table' }];
  columns: ColumnInfo[] = [{ name: 'id', dataType: 'int', nullable: false, primaryKey: true }];
  uniqueKeys: string[][] = [];
  foreignKeys: ForeignKey[] = [];
  /** Definitions by `kind:name`; a missing one is reported as not found. */
  definitions = new Map<string, string[]>();
  /** Thrown by every reader when set. */
  error: Error | undefined;
  readonly calls: string[] = [];

  listDatabases(): Promise<string[]> {
    return this.answer('listDatabases', this.databases);
  }

  listSchemas(database?: string): Promise<string[]> {
    return this.answer(`listSchemas:${database ?? ''}`, this.schemas);
  }

  listTables(scope: ObjectScope): Promise<TableInfo[]> {
    return this.answer(`listTables:${scope.database ?? ''}/${scope.schema ?? ''}`, this.tables);
  }

  listColumns(table: TableRef): Promise<ColumnInfo[]> {
    return this.answer(`listColumns:${table.name}`, this.columns);
  }

  listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    return this.answer(`listForeignKeys:${table.name}`, this.foreignKeys);
  }

  listUniqueKeys(table: TableRef): Promise<string[][]> {
    return this.answer(`listUniqueKeys:${table.name}`, this.uniqueKeys);
  }

  getDefinition(object: ObjectRef): Promise<string[]> {
    const key = `${object.kind}:${object.name}`;
    const found = this.definitions.get(key);
    if (found === undefined && this.error === undefined) {
      this.calls.push(`getDefinition:${key}`);
      return Promise.reject(new DbError('not-found', `${object.name} does not exist`));
    }
    return this.answer(`getDefinition:${key}`, found ?? []);
  }

  private answer<T>(call: string, value: T): Promise<T> {
    this.calls.push(call);
    return this.error === undefined ? Promise.resolve(value) : Promise.reject(this.error);
  }
}

export class FakeSession implements Session {
  readonly metadata = new FakeMetadata();
  readonly executed: string[] = [];
  closeCount = 0;
  cancelCount = 0;
  /** Thrown while iterating execute() when set. */
  executeError: Error | undefined;
  /** When it returns true for a statement, that statement fails. */
  failExecuteWhen: ((sql: string) => boolean) | undefined;
  /**
   * Like a real server: cancelling interrupts the statement in flight, so the
   * stream ends with a `cancelled` error rather than with rows.
   */
  failOnCancel = true;
  /** Rows every execute() yields. */
  rows: CellValue[][] = [[1]];
  /** Rows for particular statements; falls back to `rows`. */
  rowsFor: ((sql: string) => CellValue[][] | undefined) | undefined;
  /** Columns every execute() reports. */
  columns: ResultColumn[] = [{ name: 'one' }];
  /** Awaited before the first event, so a test can keep a statement running. */
  gate: (() => Promise<void>) | undefined;

  constructor(readonly config: ResolvedConnectionConfig) {}

  get isClosed(): boolean {
    return this.closeCount > 0;
  }

  execute(sql: string, _options?: ExecuteOptions): AsyncIterable<ExecuteEvent> {
    this.executed.push(sql);
    return this.stream(sql);
  }

  cancel(): Promise<void> {
    this.cancelCount += 1;
    if (this.failOnCancel) {
      this.executeError ??= new DbError('cancelled', 'Query was interrupted');
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }

  private async *stream(sql: string): AsyncGenerator<ExecuteEvent> {
    // A real driver always crosses an async boundary before the first event.
    await Promise.resolve();
    await this.gate?.();
    if (this.executeError !== undefined) {
      throw this.executeError;
    }
    if (this.failExecuteWhen?.(sql) === true) {
      throw new DbError('permission-denied', `Not allowed: ${sql}`);
    }
    yield { kind: 'columns', columns: this.columns };
    yield { kind: 'rows', rows: this.rowsFor?.(sql) ?? this.rows };
    yield { kind: 'done' };
  }
}

export class FakeDriver implements Driver {
  readonly dialect = fakeDialect;
  capabilities: DriverCapabilities = {
    databases: true,
    schemas: false,
    databaseScopedSessions: false,
    cancel: true,
  };
  readonly sessions: FakeSession[] = [];
  readonly opened: ResolvedConnectionConfig[] = [];
  /** Thrown by openSession() when set. */
  openError: Error | undefined;
  /** Copied onto every session this driver opens, so failures can be set up ahead. */
  executeError: Error | undefined;
  /** Copied onto every session: statements it matches fail. */
  failExecuteWhen: ((sql: string) => boolean) | undefined;
  /** Thrown by every metadata reader of every session this driver opens. */
  metadataError: Error | undefined;
  /** What the metadata of each new session answers; set it before expanding a tree. */
  readonly sessionMetadata = new FakeMetadata();
  /** Rows each new session yields from execute(). */
  sessionRows: CellValue[][] = [[1]];
  /** Rows for particular statements in each new session. */
  sessionRowsFor: ((sql: string) => CellValue[][] | undefined) | undefined;
  /** Columns each new session reports from execute(). */
  sessionColumns: ResultColumn[] = [{ name: 'one' }];
  /** While true, every statement waits for `releaseExecute()`. */
  holdExecute = false;

  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;

  constructor(readonly id: DriverId = 'mysql') {}

  get lastSession(): FakeSession | undefined {
    return this.sessions.at(-1);
  }

  /** Lets every held statement finish. */
  releaseExecute(): void {
    this.holdExecute = false;
    const open = this.openGate;
    this.gate = undefined;
    this.openGate = undefined;
    open?.();
  }

  private waitGate(): Promise<void> {
    if (!this.holdExecute) {
      return Promise.resolve();
    }
    this.gate ??= new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
    return this.gate;
  }

  openSession(config: ResolvedConnectionConfig): Promise<Session> {
    this.opened.push(config);
    if (this.openError !== undefined) {
      return Promise.reject(this.openError);
    }
    const session = new FakeSession(config);
    session.executeError = this.executeError;
    session.failExecuteWhen = this.failExecuteWhen;
    session.rows = [...this.sessionRows];
    session.columns = [...this.sessionColumns];
    session.rowsFor = this.sessionRowsFor;
    session.gate = () => this.waitGate();
    session.metadata.databases = [...this.sessionMetadata.databases];
    session.metadata.schemas = [...this.sessionMetadata.schemas];
    session.metadata.tables = [...this.sessionMetadata.tables];
    session.metadata.columns = [...this.sessionMetadata.columns];
    session.metadata.uniqueKeys = [...this.sessionMetadata.uniqueKeys];
    session.metadata.foreignKeys = [...this.sessionMetadata.foreignKeys];
    session.metadata.definitions = new Map(this.sessionMetadata.definitions);
    session.metadata.error = this.metadataError;
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

/** Serves fake drivers by id, like DriverRegistry does for real ones. */
export class FakeDriverProvider {
  readonly requested: DriverId[] = [];
  /** Thrown by get() when set. */
  loadError: Error | undefined;

  constructor(private readonly drivers = new Map<DriverId, FakeDriver>()) {}

  /** Registers (and returns) a driver for an id. */
  add(id: DriverId): FakeDriver {
    const driver = new FakeDriver(id);
    this.drivers.set(id, driver);
    return driver;
  }

  driver(id: DriverId): FakeDriver {
    const existing = this.drivers.get(id);
    return existing ?? this.add(id);
  }

  get(id: DriverId): Promise<Driver> {
    this.requested.push(id);
    if (this.loadError !== undefined) {
      return Promise.reject(this.loadError);
    }
    return Promise.resolve(this.driver(id));
  }
}

/** A connection-failed DbError, the one code that means "the link is gone". */
export function linkLostError(message = 'Connection lost'): DbError {
  return new DbError('connection-failed', message);
}
