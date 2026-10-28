// The one interface every DBMS implements (ARCHITECTURE.md §5). UI and services
// know only these types; a new database means a new folder here, not UI changes.

import type { DriverId, ResolvedConnectionConfig } from '../shared/connection';
import type { ColumnInfo, ObjectScope, TableInfo, TableRef } from '../core/model/objects';
import type { CellValue } from '../shared/cell-value';

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
