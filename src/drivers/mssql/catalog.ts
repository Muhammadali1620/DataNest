// Catalog fragments shared by the SQL Server metadata readers. A session belongs to one
// database (D28), so every query reads the `sys` views of that database.

import type { TableRef } from '../../core/model/objects';
import { quoteTable } from './quote';
import { catalogText } from './values';

/** Runs one catalog query (`@p1`, `@p2`, … are its parameters) and returns its rows. */
export type MssqlRowReader = (
  sql: string,
  params?: readonly (string | number)[],
) => Promise<unknown[][]>;

export const DEFAULT_SCHEMA = 'dbo';

/** The schema of a reference, `dbo` when it has none. */
export function schemaOf(scope: { readonly schema?: string }): string {
  return scope.schema ?? DEFAULT_SCHEMA;
}

/** What OBJECT_ID() takes: the quoted two-part name. */
export function objectName(table: TableRef): string {
  return quoteTable({ schema: schemaOf(table), name: table.name });
}

/**
 * A column's type the way it is written in DDL: lengths in characters (`nvarchar(50)`,
 * not the 100 bytes the catalog stores), `max`, precision and scale, fraction digits.
 * Expects `c` for sys.columns and `t` for sys.types.
 */
export const TYPE_TEXT = `CASE
  WHEN t.is_user_defined = 1 THEN QUOTENAME(SCHEMA_NAME(t.schema_id)) + '.' + QUOTENAME(t.name)
  WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary')
    THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
  WHEN t.name IN ('nvarchar', 'nchar')
    THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
  WHEN t.name IN ('decimal', 'numeric')
    THEN t.name + '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
  WHEN t.name IN ('datetime2', 'time', 'datetimeoffset')
    THEN t.name + '(' + CAST(c.scale AS varchar(10)) + ')'
  ELSE t.name
END`;

/** Text of a catalog value; undefined for NULL. */
export function optionalText(value: unknown): string | undefined {
  return catalogText(value);
}

/** Text of a catalog value; empty for NULL. */
export function text(value: unknown): string {
  return catalogText(value) ?? '';
}

/** bit columns arrive as booleans, computed flags as numbers. */
export function flag(value: unknown): boolean {
  return value === true || value === 1;
}

/**
 * SQL Server stores a default wrapped in parentheses, often twice (`((0))`,
 * `('new')`, `(getdate())`). The outer pairs that wrap the whole text go, so the
 * designer shows what the user once wrote.
 */
export function unwrapDefault(definition: string): string {
  let current = definition.trim();
  while (current.startsWith('(') && current.endsWith(')') && closesAtEnd(current)) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

/** True when the `(` at 0 is closed by the last character, not earlier. */
function closesAtEnd(value: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote !== undefined) {
      if (char === quote) {
        if (value[index + 1] === quote) {
          index++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '[') {
      quote = char === '[' ? ']' : char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0 && index < value.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

/** The extended property the server's own tools use for descriptions. */
export const DESCRIPTION = 'MS_Description';
