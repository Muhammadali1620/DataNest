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
}

export interface ColumnInfo {
  readonly name: string;
  /** Human-readable type as the database reports it, e.g. `varchar(255)`. */
  readonly dataType: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  /** Default expression as text, if any. */
  readonly defaultValue?: string;
}
