// A driver that records what it was asked to do, for testing services without a
// real database. Failures are injected by setting the `*Error` fields.

import { DbError } from '../../src/core/errors';
import type { DriverId, ResolvedConnectionConfig } from '../../src/shared/connection';
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
  TableStats,
  TableStructure,
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
  TableDump,
  TransactionState,
  TypeDump,
} from '../../src/drivers/driver';
import { STANDARD_TRANSACTION } from '../../src/drivers/common/transaction';
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
  transaction: STANDARD_TRANSACTION,
  ddl: {
    createDatabase: (name) => `CREATE DATABASE "${name}"`,
    dropDatabase: (name) => `DROP DATABASE "${name}"`,
    createSchema: (name) => `CREATE SCHEMA "${name}"`,
    dropSchema: (name, cascade) => `DROP SCHEMA "${name}"${cascade ? ' CASCADE' : ''}`,
    designer: {
      columnComments: true,
      tableComment: true,
      types: ['integer', 'text'],
      reorder: true,
      autoIncrement: true,
      foreignKeys: true,
      uniqueIndexes: true,
    },
    alterTable: (table, before, after) => ({
      statements:
        before.name === after.name && before.columns.length === after.columns.length
          ? []
          : [`ALTER "${table.name}"`],
      notes: [],
      recovery: ['ROLLBACK'],
    }),
    createTable: (table, design) => [
      `CREATE TABLE "${design.name}" (${design.columns.map((c) => c.name).join(', ')})`,
      ...(table.schema === undefined ? [] : [`-- in ${table.schema}`]),
    ],
    dropRelation: (table, kind) => `DROP ${kind.toUpperCase()} "${table.name}"`,
    renameRelation: (table, _kind, newName) => `RENAME "${table.name}" TO "${newName}"`,
    truncateTable: (table) => `TRUNCATE "${table.name}"`,
    dropObject: (object) => `DROP ${object.kind.toUpperCase()} "${object.name}"`,
    replaceObject: (object, statements, original) => ({
      check: object.kind === 'procedure' ? [`CHECK ${object.name}`, `UNCHECK ${object.name}`] : [],
      statements: [`DROP ${object.kind.toUpperCase()} "${object.name}"`, ...statements],
      recovery: [`DROP ${object.kind.toUpperCase()} "${object.name}"`, ...original],
    }),
  },
  dump: {
    prepare: ['PREPARE READ'],
    beginSnapshot: ['BEGIN SNAPSHOT'],
    endSnapshot: ['END SNAPSHOT'],
    header: ['HEADER 1', 'HEADER 2'],
    footer: ['FOOTER'],
    routinesFirst: false,
    keysAfterData: false,
    insert: (table, columns, rows, identity) =>
      `INSERT INTO ${table} (${columns.join(', ')})${identity ? ' IDENTITY' : ''} VALUES ${rows.join(', ')}`,
    insertSelect: (table, columns, select, identity) =>
      `INSERT INTO ${table} (${columns.join(', ')})${identity ? ' IDENTITY' : ''} ${select}`,
    resetSequence: (table, column) => `RESET ${table.name}.${column}`,
    dropRelations: (tables, kind) =>
      tables.length === 0
        ? []
        : [`DROP ${kind.toUpperCase()} IF EXISTS ${tables.map((t) => `"${t.name}"`).join(', ')}`],
    dropObject: (object) => `DROP ${object.kind.toUpperCase()} IF EXISTS "${object.name}"`,
  },
};

export class FakeMetadata implements MetadataReader {
  databases: string[] = ['main'];
  schemas: string[] = ['public'];
  tables: TableInfo[] = [{ name: 'customers', kind: 'table' }];
  columns: ColumnInfo[] = [{ name: 'id', dataType: 'int', nullable: false, primaryKey: true }];
  uniqueKeys: string[][] = [];
  foreignKeys: ForeignKey[] = [];
  /** Objects listed by `listObjects`, filtered by kind. */
  objects: ObjectInfo[] = [];
  indexes: IndexInfo[] = [];
  /** What describeTable answers; undefined means the table does not exist. */
  structure: TableStructure | undefined;
  /** Definitions by `kind:name`; a missing one is reported as not found. */
  definitions = new Map<string, string[]>();
  /** Dump parts by table name; a missing one is reported as not found. */
  tableDumps = new Map<string, TableDump>();
  /** What listTypeDumps answers, whatever the scope. */
  typeDumps: TypeDump[] = [];
  /** Thrown by every reader when set. */
  error: Error | undefined;
  readonly calls: string[] = [];
  /** Set by a test to give the fake server statistics (V10.2.3); absent like SQLite's. */
  tableStats?: (scope: ObjectScope) => Promise<TableStats[]>;

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

  listObjects(scope: ObjectScope, kind: ListedObjectKind): Promise<ObjectInfo[]> {
    return this.answer(
      `listObjects:${scope.database ?? ''}/${scope.schema ?? ''}:${kind}`,
      this.objects.filter((object) => object.kind === kind),
    );
  }

  listIndexes(table: TableRef): Promise<IndexInfo[]> {
    return this.answer(`listIndexes:${table.name}`, this.indexes);
  }

  describeTable(table: TableRef): Promise<TableStructure> {
    if (this.structure === undefined && this.error === undefined) {
      this.calls.push(`describeTable:${table.name}`);
      return Promise.reject(new DbError('not-found', `${table.name} does not exist`));
    }
    return this.answer(
      `describeTable:${table.name}`,
      this.structure ?? { columns: [], primaryKey: [], indexes: [], foreignKeys: [] },
    );
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

  getTableDump(table: TableRef): Promise<TableDump> {
    const found = this.tableDumps.get(table.name);
    if (found === undefined && this.error === undefined) {
      this.calls.push(`getTableDump:${table.name}`);
      return Promise.reject(new DbError('not-found', `${table.name} does not exist`));
    }
    return this.answer(
      `getTableDump:${table.name}`,
      found ?? { before: [], create: [], after: [], owns: [] },
    );
  }

  listTypeDumps(scope: ObjectScope, tables?: readonly string[]): Promise<TypeDump[]> {
    return this.answer(
      `listTypeDumps:${scope.database ?? ''}/${scope.schema ?? ''}:${tables?.join(',') ?? '*'}`,
      this.typeDumps,
    );
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
  /** Rows a statement changed; set, the statement returns no result set (an UPDATE). */
  affectedFor: ((sql: string) => number | undefined) | undefined;
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
  /**
   * When set, transactionState() answers like a server: BEGIN opens a transaction,
   * COMMIT and ROLLBACK end it, and an error inside one spoils it (as PostgreSQL does).
   */
  tracksTransactions = false;
  private transaction: TransactionState = 'idle';

  constructor(readonly config: ResolvedConnectionConfig) {}

  transactionState(): TransactionState | undefined {
    return this.tracksTransactions ? this.transaction : undefined;
  }

  private noteTransaction(sql: string, failed: boolean): void {
    const verb = sql.trim().split(/\s+/)[0]?.toUpperCase();
    if (failed) {
      this.transaction = this.transaction === 'idle' ? 'idle' : 'failed';
    } else if (verb === 'BEGIN') {
      this.transaction = 'open';
    } else if (verb === 'COMMIT' || verb === 'ROLLBACK') {
      this.transaction = 'idle';
    }
  }

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
      this.noteTransaction(sql, true);
      throw this.executeError;
    }
    if (this.failExecuteWhen?.(sql) === true) {
      this.noteTransaction(sql, true);
      throw new DbError('permission-denied', `Not allowed: ${sql}`);
    }
    this.noteTransaction(sql, false);
    const affected = this.affectedFor?.(sql);
    // A statement that changes rows returns no result set, only how many it changed.
    if (affected === undefined) {
      yield { kind: 'columns', columns: this.columns };
      yield { kind: 'rows', rows: this.rowsFor?.(sql) ?? this.rows };
      yield { kind: 'done' };
    } else {
      yield { kind: 'done', affectedRows: affected };
    }
  }
}

export class FakeDriver implements Driver {
  /** Replaceable, for tests that need what a real dialect builds. */
  dialect: Dialect = fakeDialect;
  capabilities: DriverCapabilities = {
    databases: true,
    schemas: false,
    databaseScopedSessions: false,
    cancel: true,
    transactions: true,
    objectKinds: [],
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
  /** Copied to every session: rows a statement changed, for statements without rows. */
  sessionAffectedFor: ((sql: string) => number | undefined) | undefined;
  /** While true, every statement waits for `releaseExecute()`. */
  holdExecute = false;
  /** Copied onto every session: it reports transactions like a server. */
  tracksTransactions = false;

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
    session.affectedFor = this.sessionAffectedFor;
    session.tracksTransactions = this.tracksTransactions;
    session.gate = () => this.waitGate();
    session.metadata.databases = [...this.sessionMetadata.databases];
    session.metadata.schemas = [...this.sessionMetadata.schemas];
    session.metadata.tables = [...this.sessionMetadata.tables];
    session.metadata.columns = [...this.sessionMetadata.columns];
    session.metadata.uniqueKeys = [...this.sessionMetadata.uniqueKeys];
    session.metadata.foreignKeys = [...this.sessionMetadata.foreignKeys];
    session.metadata.definitions = new Map(this.sessionMetadata.definitions);
    session.metadata.tableDumps = new Map(this.sessionMetadata.tableDumps);
    session.metadata.typeDumps = [...this.sessionMetadata.typeDumps];
    session.metadata.objects = [...this.sessionMetadata.objects];
    session.metadata.indexes = [...this.sessionMetadata.indexes];
    session.metadata.structure = this.sessionMetadata.structure;
    if (this.sessionMetadata.tableStats !== undefined) {
      session.metadata.tableStats = this.sessionMetadata.tableStats;
    }
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
