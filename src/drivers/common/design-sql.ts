// Pieces of CREATE TABLE every dialect writes the same way; the dialect files add
// what differs (auto numbering, comments, quoting).

import type {
  ColumnDesign,
  ForeignKeyDesign,
  IndexDesign,
  TableDesign,
} from '../../shared/table-design';
import { columnNames, composeType } from '../../shared/table-design';

export interface ColumnSqlParts {
  /** `"id"` or `` `id` ``. */
  readonly quote: (name: string) => string;
  /** The words for auto numbering, placed after the type and before NOT NULL. */
  readonly autoIncrement: (column: ColumnDesign) => string;
  /** Text after DEFAULT, e.g. a comment clause; empty when the dialect keeps none inline. */
  readonly trailer: (column: ColumnDesign) => string;
}

/** `"name" type(len) [auto] [NOT NULL] [DEFAULT …] [trailer]`. */
export function columnSql(column: ColumnDesign, parts: ColumnSqlParts): string {
  const pieces = [parts.quote(column.name.trim()), composeType(column.type, column.length)];
  const auto = column.autoIncrement ? parts.autoIncrement(column) : '';
  if (auto !== '') {
    pieces.push(auto);
  }
  // Key columns are NOT NULL whatever the checkbox said: every server demands it.
  if (!column.nullable || column.primaryKey) {
    pieces.push('NOT NULL');
  }
  if (column.defaultValue.trim() !== '') {
    pieces.push(`DEFAULT ${column.defaultValue.trim()}`);
  }
  const trailer = parts.trailer(column);
  if (trailer !== '') {
    pieces.push(trailer);
  }
  return pieces.join(' ');
}

/** The primary key clause, or nothing for a table without one. */
export function primaryKeySql(design: TableDesign, quote: (name: string) => string): string[] {
  const keys = design.columns.filter((column) => column.primaryKey);
  return keys.length === 0
    ? []
    : [`PRIMARY KEY (${keys.map((column) => quote(column.name.trim())).join(', ')})`];
}

/** `CREATE TABLE x (\n  a,\n  b\n)` with one item per line. */
export function createTableSql(
  quotedTable: string,
  items: readonly string[],
  options = '',
): string {
  return `CREATE TABLE ${quotedTable} (\n${items.map((item) => `  ${item}`).join(',\n')}\n)${options}`;
}

/** `("a", "b")`: the columns of an index or key by their current names. */
export function columnList(
  design: TableDesign,
  ids: readonly string[],
  quote: (name: string) => string,
): string {
  return `(${columnNames(design, ids)
    .map((name) => quote(name))
    .join(', ')})`;
}

/** ON DELETE / ON UPDATE, leaving out the default NO ACTION. */
export function referentialActions(key: ForeignKeyDesign): string {
  const parts: string[] = [];
  if (key.onDelete !== 'NO ACTION') {
    parts.push(`ON DELETE ${key.onDelete}`);
  }
  if (key.onUpdate !== 'NO ACTION') {
    parts.push(`ON UPDATE ${key.onUpdate}`);
  }
  return parts.join(' ');
}

/** `CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES <target> ("id") [actions]`. */
export function foreignKeySql(
  design: TableDesign,
  key: ForeignKeyDesign,
  quote: (name: string) => string,
  quotedTarget: string,
): string {
  const actions = referentialActions(key);
  return [
    `CONSTRAINT ${quote(key.name.trim())} FOREIGN KEY ${columnList(design, key.columns, quote)}`,
    `REFERENCES ${quotedTarget} (${key.targetColumns.map((column) => quote(column.trim())).join(', ')})`,
    ...(actions === '' ? [] : [actions]),
  ].join(' ');
}

/** `CREATE [UNIQUE] INDEX "name" ON <table> ("a", "b")` for dialects that keep indexes apart. */
export function createIndexSql(
  design: TableDesign,
  index: IndexDesign,
  quote: (name: string) => string,
  quotedTable: string,
  quotedName: string = quote(index.name.trim()),
): string {
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quotedName} ON ${quotedTable} ${columnList(design, index.columns, quote)}`;
}
