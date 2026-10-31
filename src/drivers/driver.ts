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
  TableStats,
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

/** How an edited definition takes the place of the current one. */
export interface ReplacePlan {
  /**
   * Run before anything is dropped, and undone at once: proves that the new text is
   * accepted (syntax, privileges) where DDL cannot be rolled back (MySQL).
   */
  readonly check: readonly string[];
  readonly statements: readonly string[];
  /** Run when a statement fails: a rollback, or the old definition created again. */
  readonly recovery: readonly string[];
}

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
   * Changes can be grouped in a transaction and rolled back (all but ClickHouse). Where
   * not, an import stops at the first bad row but keeps what it inserted before.
   */
  readonly transactions: boolean;
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
  /**
   * Puts an edited definition (`statements`, as the user wrote them) in place of the
   * object; `original` is its definition before the edit. Throws `unsupported` for
   * kinds that are not edited this way (tables have the designer).
   */
  replaceObject(
    object: ObjectRef,
    statements: readonly string[],
    original: readonly string[],
  ): ReplacePlan;
}

/** How a dump (V5.2) is read and what its script says, per database. */
export interface DumpDialect {
  /** Run first on the session that reads, so values come out as the header writes them back. */
  readonly prepare: readonly string[];
  /** Starts a read-only snapshot, so every table of the dump is read at one moment. */
  readonly beginSnapshot: readonly string[];
  readonly endSnapshot: readonly string[];
  /** The top of a dump file (encoding, checks off) and the bottom that puts things back. */
  readonly header: readonly string[];
  readonly footer: readonly string[];
  /**
   * Functions and procedures go before the tables: column defaults and checks may
   * call them, and their bodies are not checked at creation (PostgreSQL).
   */
  readonly routinesFirst: boolean;
  /**
   * Foreign keys are added after the rows, because their checks cannot be switched
   * off for a load (PostgreSQL, without superuser rights). Elsewhere the header turns
   * the checks off and tables keep their keys inline.
   */
  readonly keysAfterData: boolean;
  /**
   * One INSERT of rows already written as `(…)` lists. `identity` is set when values
   * go into identity columns, which some databases refuse without a clause.
   */
  insert(
    quotedTable: string,
    quotedColumns: readonly string[],
    rows: readonly string[],
    identity: boolean,
  ): string;
  /**
   * The same INSERT with the rows of a query, run by the server itself: a copy of a
   * table inside one database (V10.2.3).
   */
  insertSelect(
    quotedTable: string,
    quotedColumns: readonly string[],
    select: string,
    identity: boolean,
  ): string;
  /**
   * After a table's rows: moves the sequence behind a column past the highest value,
   * so new rows do not collide. Absent where inserting does that by itself.
   */
  readonly resetSequence?: (table: TableRef, column: string) => string;
  /** DROP … IF EXISTS of tables or views, in as few statements as the database allows. */
  dropRelations(tables: readonly TableRef[], kind: RelationKind): string[];
  /** DROP … IF EXISTS of a routine, sequence, trigger or event. */
  dropObject(object: ObjectRef): string;
  /** CREATE SCHEMA IF NOT EXISTS, where names in the script carry their schema. */
  readonly createSchema?: (name: string) => string;
  /**
   * Rewrites a definition so it loads under another user on another server
   * (MySQL: without `DEFINER=…`, which only an administrator may set).
   */
  readonly portable?: (sql: string) => string;
}

/**
 * How a dialect spells transaction control (V4.8). Savepoint names are DataNest's own
 * constants, never user text.
 */
export interface TransactionSql {
  readonly begin: string;
  readonly commit: string;
  readonly rollback: string;
  savepoint(name: string): string;
  /** Lets a savepoint go; absent where savepoints live until the transaction ends. */
  readonly releaseSavepoint?: (name: string) => string;
  rollbackToSavepoint(name: string): string;
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
  /**
   * The statement that sets the session time zone (V4.9), e.g. `UTC` or `+03:00`;
   * absent where sessions have none (SQLite). The server judges the name.
   */
  readonly setTimeZone?: (zone: string) => string;
  /** True where `UPDATE … SET column = DEFAULT` works; SQLite has no such keyword. */
  readonly defaultKeyword: boolean;
  /** An INSERT that fills every column with its default; the table is already quoted. */
  insertDefaultRow(quotedTable: string): string;
  /** BEGIN, COMMIT, savepoints. */
  readonly transaction: TransactionSql;
  /** Structure changes: databases, schemas, tables and other objects. */
  readonly ddl: SchemaDdl;
  /** Dumps to a SQL script (V5.2). */
  readonly dump: DumpDialect;
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

/** A table's definition, split by where a dump (V5.2) has to put each part. */
export interface TableDump {
  /** Before the table: the sequences its columns draw from (PostgreSQL serial). */
  readonly before: readonly string[];
  /** The table itself, with its indexes and comments. */
  readonly create: readonly string[];
  /** Once every table is created and filled: foreign keys kept apart, then triggers. */
  readonly after: readonly string[];
  /** Objects the parts above already create, so a dump does not write them twice. */
  readonly owns: readonly ObjectRef[];
}

/** A user-defined type a dump creates before the tables (PostgreSQL enums and domains). */
export interface TypeDump {
  readonly name: string;
  readonly create: string;
  readonly drop: string;
}

/** Reads structure for the tree and completion; implementations go to the server. */
export interface MetadataReader {
  /** Databases visible to the session; empty for file databases. */
  listDatabases(): Promise<string[]>;
  /** Schemas of a database; only when `capabilities.schemas`. */
  listSchemas(database?: string): Promise<string[]>;
  listTables(scope: ObjectScope): Promise<TableInfo[]>;
  /**
   * Estimated rows, size and comment of the tables and views of a scope, from the
   * server's statistics (V10.2.3); absent where the database keeps none (SQLite).
   */
  tableStats?(scope: ObjectScope): Promise<TableStats[]>;
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
  /** A table's definition in the parts a dump writes at different places. */
  getTableDump(table: TableRef): Promise<TableDump>;
  /**
   * User-defined types of a scope, or only the ones the named tables use; empty
   * where the database has none of its own (types live in the columns).
   */
  listTypeDumps(scope: ObjectScope, tables?: readonly string[]): Promise<TypeDump[]>;
}

/**
 * Where a session stands with transactions: `idle` (every statement commits on its
 * own), `open` (changes wait for COMMIT or ROLLBACK), or `failed` (PostgreSQL: an
 * error spoiled the transaction, and only ROLLBACK helps).
 */
export type TransactionState = 'idle' | 'open' | 'failed';

/**
 * One live connection. Each SQL editor gets its own session, so a slow query in
 * one tab never blocks another. Statements run one at a time per session.
 */
export interface Session {
  execute(sql: string, options?: ExecuteOptions): AsyncIterable<ExecuteEvent>;
  /** Cancels the currently running statement, if any. Safe to call anytime. */
  cancel(): Promise<void>;
  /**
   * The transaction state as the server reported it after the last statement (V4.8).
   * Absent where the driver cannot tell; DataNest never guesses it from the SQL.
   */
  transactionState?(): TransactionState | undefined;
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
