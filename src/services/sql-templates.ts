// Statement templates for a table: SELECT, INSERT, UPDATE and DELETE written out
// with its real columns. They come as editor snippets, so Tab walks through the
// values to fill in. Names go through the dialect's quoting.

import type { TableRef } from '../core/model/objects';
import type { Dialect } from '../drivers/driver';

export type TemplateKind = 'select' | 'insert' | 'update' | 'delete';

export const TEMPLATE_KINDS: readonly TemplateKind[] = ['select', 'insert', 'update', 'delete'];

export interface TemplateColumn {
  readonly name: string;
  readonly primaryKey: boolean;
  /** Filled by the server (auto numbering, computed): left out of INSERT and SET. */
  readonly generated: boolean;
}

/** Rows a generated SELECT asks for, so running it as is never floods the grid. */
export const SELECT_LIMIT = 100;

/** Snippet syntax gives `$`, `}` and `\` a meaning; in names they must be plain. */
function plain(text: string): string {
  return text.replace(/[\\$}]/g, '\\$&');
}

function placeholder(index: number, name: string): string {
  return `\${${index}:${plain(name)}}`;
}

/** `"id" = ${3:id} AND …` for the key, or a placeholder for a condition. */
function keyCondition(columns: readonly TemplateColumn[], dialect: Dialect, first: number): string {
  const key = columns.filter((column) => column.primaryKey);
  if (key.length === 0) {
    return placeholder(first, 'condition');
  }
  return key
    .map(
      (column, index) =>
        `${plain(dialect.quoteIdentifier(column.name))} = ${placeholder(first + index, column.name)}`,
    )
    .join(' AND ');
}

export function sqlTemplate(
  kind: TemplateKind,
  table: TableRef,
  columns: readonly TemplateColumn[],
  dialect: Dialect,
): string {
  const target = plain(dialect.quoteTable(table));
  const quoted = (column: TemplateColumn) => plain(dialect.quoteIdentifier(column.name));
  switch (kind) {
    case 'select': {
      const list = columns.length === 0 ? '*' : `\n  ${columns.map(quoted).join(',\n  ')}\n`;
      const select = `SELECT${columns.length === 0 ? ' ' : ''}${list}${columns.length === 0 ? ' ' : ''}FROM ${target}`;
      return `${dialect.paginate(select, SELECT_LIMIT, 0)};`;
    }
    case 'insert': {
      const written = columns.filter((column) => !column.generated);
      if (written.length === 0) {
        return `${plain(dialect.insertDefaultRow(dialect.quoteTable(table)))};`;
      }
      return [
        `INSERT INTO ${target} (${written.map(quoted).join(', ')})`,
        `VALUES (${written.map((column, index) => placeholder(index + 1, column.name)).join(', ')});`,
      ].join('\n');
    }
    case 'update': {
      const set = columns.filter((column) => !column.primaryKey && !column.generated);
      const assignments = (set.length === 0 ? columns.filter((c) => !c.generated) : set).map(
        (column, index) => `  ${quoted(column)} = ${placeholder(index + 1, column.name)}`,
      );
      return [
        `UPDATE ${target}`,
        'SET',
        assignments.join(',\n'),
        `WHERE ${keyCondition(columns, dialect, assignments.length + 1)};`,
      ].join('\n');
    }
    case 'delete':
      return `DELETE FROM ${target}\nWHERE ${keyCondition(columns, dialect, 1)};`;
  }
}
