// Pieces of CREATE TABLE every dialect writes the same way; the dialect files add
// what differs (auto numbering, comments, quoting).

import type { ColumnDesign, TableDesign } from '../../shared/table-design';
import { composeType } from '../../shared/table-design';

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
