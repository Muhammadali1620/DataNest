// References to database objects, shared by the tree, metadata readers and SQL generation.

/** Where to look for objects: a database (MySQL) and/or a schema (PostgreSQL). */
export interface ObjectScope {
  readonly database?: string;
  readonly schema?: string;
}

/** A table or view inside a scope. */
export interface TableRef extends ObjectScope {
  readonly name: string;
}

export type TableKind = 'table' | 'view';

export interface TableInfo {
  readonly name: string;
  readonly kind: TableKind;
  /** A PostgreSQL materialized view: a view that DDL names with its own words. */
  readonly materialized?: boolean;
}

/** What DDL calls a table or a view. */
export type RelationKind = 'table' | 'view' | 'materialized-view';

export interface ColumnInfo {
  readonly name: string;
  /** Human-readable type as the database reports it, e.g. `varchar(255)`. */
  readonly dataType: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  /** Default expression as text, if any. */
  readonly defaultValue?: string;
}

/** A foreign key: columns of a table that point at columns of another (or the same) one. */
export interface ForeignKey {
  readonly name: string;
  /** Columns of the table that holds the key, in key order. */
  readonly columns: readonly string[];
  /** The table the key points at. */
  readonly target: TableRef;
  /** The referenced columns, in the same order as `columns`. */
  readonly targetColumns: readonly string[];
  /** Referential actions as SQL words (`CASCADE`, `SET NULL`, …), where the reader knows them. */
  readonly onDelete?: string;
  readonly onUpdate?: string;
}

/** Objects other than tables and views that a database can hold. */
export type RoutineKind = 'function' | 'procedure';

/** Every kind of object the tree lists and whose definition can be read. */
export type ObjectKind = TableKind | RoutineKind | 'trigger' | 'sequence' | 'event';

/** Kinds listed with `listObjects`; tables and views have `listTables`. */
export type ListedObjectKind = Exclude<ObjectKind, TableKind>;

/** One object of a listed kind. */
export interface ObjectInfo {
  readonly name: string;
  readonly kind: ListedObjectKind;
  /**
   * Argument types that tell overloads apart (PostgreSQL), e.g. `integer, text`.
   * Absent where a name alone identifies the routine.
   */
  readonly signature?: string;
  /** The table a trigger belongs to. */
  readonly table?: string;
}

/** Points at one object, e.g. to read its definition or drop it. */
export interface ObjectRef extends ObjectScope {
  readonly kind: ObjectKind;
  readonly name: string;
  /** See `ObjectInfo.signature`. */
  readonly signature?: string;
  /** See `ObjectInfo.table`. */
  readonly table?: string;
}

/** An index of a table, including the ones behind primary and unique keys. */
export interface IndexInfo {
  readonly name: string;
  /** Key parts in order: column names, or expressions for expression indexes. */
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly primary: boolean;
  /** Index method where the database has several: BTREE, HASH, FULLTEXT, gin, … */
  readonly method?: string;
  /** The condition of a partial index. */
  readonly where?: string;
  /** The index stands behind a UNIQUE constraint and is dropped with the constraint (PostgreSQL). */
  readonly constraint?: boolean;
}

/** A column as the table designer needs it, with what `ColumnInfo` leaves out. */
export interface ColumnDetail {
  readonly name: string;
  /** The full type as the server prints it: `varchar(255)`, `decimal(10,2) unsigned`. */
  readonly dataType: string;
  readonly nullable: boolean;
  /** The default as a SQL expression that can be written back after DEFAULT. */
  readonly defaultExpression?: string;
  readonly autoIncrement: boolean;
  readonly comment?: string;
  /** A computed column; the designer shows it but does not change it. */
  readonly generated: boolean;
}

/** An index or trigger that a table rebuild must create again, as its original SQL (SQLite). */
export interface TableDependent {
  readonly kind: 'index' | 'trigger';
  readonly name: string;
  readonly sql: string;
}

/** Everything the table designer reads about an existing table. */
export interface TableStructure {
  readonly comment?: string;
  readonly columns: readonly ColumnDetail[];
  /** Primary key columns in key order; empty for a table without one. */
  readonly primaryKey: readonly string[];
  /** Name of the primary key constraint, where the server names it (PostgreSQL). */
  readonly primaryKeyName?: string;
  /** Every index, the primary key included. */
  readonly indexes: readonly IndexInfo[];
  readonly foreignKeys: readonly ForeignKey[];
  /** SQLite: what disappears with the table and must be recreated after a rebuild. */
  readonly dependents?: readonly TableDependent[];
}
