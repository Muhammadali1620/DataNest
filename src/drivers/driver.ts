// The one interface every DBMS implements (ARCHITECTURE.md §5). UI and services
// know only these types; a new database means a new folder here, not UI changes.

import type { DriverId, ResolvedConnectionConfig } from '../shared/connection';
import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectInfo,
  ObjectRef,
  ObjectScope,
  RelationKind,
  TableInfo,
  TableRef,
  TableStructure,
} from '../core/model/objects';
import type { CellValue } from '../shared/cell-value';
import type { DesignerFeatures, TableBackground, TableDesign } from '../shared/table-design';

/** Something the user should know about an ALTER before running it. */
export type AlterNote =
  /** PostgreSQL cannot move columns: the new order on the page is not applied. */
  | 'order-ignored'
  /** SQLite copies the table into a new one: slower on big tables. */
  | 'rebuild';

export interface AlterPlan {
  /** Statements in order; transactional dialects wrap them in BEGIN … COMMIT. */
  readonly statements: readonly string[];
  readonly notes: readonly AlterNote[];
  /** Run, each on its own and ignoring failures, when a statement of the plan fails. */
  readonly recovery: readonly string[];
}

export const EMPTY_PLAN: AlterPlan = { statements: [], notes: [], recovery: [] };

/** What the DBMS supports; the UI adapts instead of special-casing driver ids. */
export interface DriverCapabilities {
  /** The server hosts several databases the session can see (MySQL, PostgreSQL). */
  readonly databases: boolean;
  /** Objects live inside schemas within a database (PostgreSQL). */
  readonly schemas: boolean;
  /**
   * A session sees only the database it connected to, so reading another one needs
   * its own session (PostgreSQL). False where one session can query across databases
   * by qualifying names (MySQL).
   */
  readonly databaseScopedSessions: boolean;
  /** A running statement can be cancelled from another connection or API. */
  readonly cancel: boolean;
  /**
   * Kinds of objects that live in a database or schema next to tables and views,
   * in the order the tree shows their folders. Triggers belong to tables instead.
   */
  readonly objectKinds: readonly ListedObjectKind[];
}

/**
 * Statements that change the structure. Names always go through quoting; a method
 * that is absent means the database has no such thing (a SQLite file has no
 * databases to create), and one that throws `unsupported` cannot do it for this
 * particular object.
 */
export interface SchemaDdl {
  readonly createDatabase?: (name: string) => string;
  readonly dropDatabase?: (name: string) => string;
  readonly createSchema?: (name: string) => string;
  readonly dropSchema?: (name: string, cascade: boolean) => string;
  /** What the table designer may offer for this database. */
  readonly designer: DesignerFeatures;
  /**
   * The statements that create a table as designed: CREATE TABLE, then whatever
   * the dialect keeps outside it (PostgreSQL comments). The design must be valid
   * (`designProblems` is empty); `table` gives the scope and the final name.
   */
  createTable(table: TableRef, design: TableDesign): string[];
  /**
   * The statements that turn an existing table (`before`, as loaded) into `after`.
   * `table` names the table as it is now. Empty when nothing changed. Throws
   * `unsupported` for a change this database cannot make.
   */
  alterTable(
    table: TableRef,
    before: TableDesign,
    after: TableDesign,
    background: TableBackground,
  ): AlterPlan;
  dropRelation(table: TableRef, kind: RelationKind): string;
  /** Renames within the same database or schema; `newName` is a bare name. */
  renameRelation(table: TableRef, kind: RelationKind, newName: string): string;
  /** Removes every row; where there is no TRUNCATE, a DELETE without WHERE. */
  truncateTable(table: TableRef): string;
  /** Drops a function, procedure, trigger, sequence or event. */
  dropObject(object: ObjectRef): string;
}

/** Everything that differs between SQL dialects. UI builds SQL only through this. */
export interface Dialect {
  /** Keywords for completion and highlighting, uppercase. */
  readonly keywords: readonly string[];
  /** Quotes one identifier part, escaping quotes inside: `` `a``b` `` or `"a""b"`. */
  quoteIdentifier(name: string): string;
  /** Quotes a possibly qualified table reference. */
  quoteTable(table: TableRef): string;
  /** Renders a value as a SQL literal; used only where parameters cannot be. */
  literal(value: CellValue): string;
  /** Wraps or extends a SELECT so it returns `limit` rows starting at `offset`. */
  paginate(sql: string, limit: number, offset: number): string;
  /**
   * A case-insensitive match of a column's text against a LIKE pattern. Both are
   * already quoted; `!` is the escape character in the pattern. The column is cast
   * to text first, because PostgreSQL has no LIKE for numbers.
   */
  likeText(quotedColumn: string, quotedPattern: string): string;
  /**
   * A cheap query that returns the server's own estimate of a table's row count in
   * its first cell, or undefined where the database keeps no such statistic. The
   * number may be off, or absent (NULL, -1) for a table never analyzed.
   */
  readonly estimateRowsSql?: (table: TableRef) => string;
  /** True where `UPDATE … SET column = DEFAULT` works; SQLite has no such keyword. */
  readonly defaultKeyword: boolean;
  /** An INSERT that fills every column with its default; the table is already quoted. */
  insertDefaultRow(quotedTable: string): string;
  /** Structure changes: databases, schemas, tables and other objects. */
  readonly ddl: SchemaDdl;
}

export interface ResultColumn {
  readonly name: string;
  /** Type name as the driver reports it, when known. */
  readonly dataType?: string;
}

/**
 * `execute` yields a stream of these, so 10 rows and a million behave the same:
 * `columns` (for row-returning statements) → `rows` batches → one final `done`.
 */
export type ExecuteEvent =
  | { readonly kind: 'columns'; readonly columns: readonly ResultColumn[] }
  | { readonly kind: 'rows'; readonly rows: readonly (readonly CellValue[])[] }
  | {
      readonly kind: 'done';
      /** Rows affected by INSERT/UPDATE/DELETE, when the server reports it. */
      readonly affectedRows?: number;
      /** A non-error notice from the server, e.g. a warning count. */
      readonly notice?: string;
    };

export interface ExecuteOptions {
  /** Stop fetching after this many rows; `done` still arrives. */
  readonly rowLimit?: number;
}

/** Reads structure for the tree and completion; implementations go to the server. */
export interface MetadataReader {
  /** Databases visible to the session; empty for file databases. */
  listDatabases(): Promise<string[]>;
  /** Schemas of a database; only when `capabilities.schemas`. */
  listSchemas(database?: string): Promise<string[]>;
  listTables(scope: ObjectScope): Promise<TableInfo[]>;
  listColumns(table: TableRef): Promise<ColumnInfo[]>;
  /**
   * Unique indexes of a table other than the primary key, as column names in index
   * order. Partial and expression indexes are left out: they do not identify a row.
   */
  listUniqueKeys(table: TableRef): Promise<string[][]>;
  /** Foreign keys that start in this table, so a cell can lead to the row it points at. */
  listForeignKeys(table: TableRef): Promise<ForeignKey[]>;
  /**
   * Objects of one kind in a scope, by name. A kind the database does not have
   * lists nothing. Objects that belong to installed extensions are left out.
   */
  listObjects(scope: ObjectScope, kind: ListedObjectKind): Promise<ObjectInfo[]>;
  /** Every index of a table, the primary key first, then by name. */
  listIndexes(table: TableRef): Promise<IndexInfo[]>;
  /** The structure of an existing table, as the table designer edits it. */
  describeTable(table: TableRef): Promise<TableStructure>;
  /**
   * The statements that create an object as it is now, without trailing semicolons:
   * a table with its indexes, comments and triggers, a view, a routine, …
   * Throws `not-found` when the object does not exist and `permission-denied`
   * when the server hides its definition from this user.
   */
  getDefinition(object: ObjectRef): Promise<string[]>;
}

/**
 * One live connection. Each SQL editor gets its own session, so a slow query in
 * one tab never blocks another. Statements run one at a time per session.
 */
export interface Session {
  execute(sql: string, options?: ExecuteOptions): AsyncIterable<ExecuteEvent>;
  /** Cancels the currently running statement, if any. Safe to call anytime. */
  cancel(): Promise<void>;
  readonly metadata: MetadataReader;
  /** Closes the connection; the session is unusable afterwards. */
  close(): Promise<void>;
}

/** Describes a DBMS and opens sessions; holds no connections itself. */
export interface Driver {
  readonly id: DriverId;
  readonly dialect: Dialect;
  readonly capabilities: DriverCapabilities;
  openSession(config: ResolvedConnectionConfig): Promise<Session>;
}

/** The shape of a lazily loaded driver bundle: `export const driver: Driver`. */
export interface DriverModule {
  readonly driver: Driver;
}
