// SQL Server quoting: identifiers in brackets with `]` doubled, strings as N'…' so
// text outside the database's code page survives.

import type { TableRef } from '../../core/model/objects';
import { msg } from '../../core/user-message';

/** The longest identifier SQL Server accepts (sysname). */
export const MAX_IDENTIFIER_LENGTH = 128;

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error(msg('Identifier must not be empty'));
  }
  if (name.includes('\u0000')) {
    throw new Error(msg('Identifier must not contain NUL'));
  }
  return `[${name.replaceAll(']', ']]')}]`;
}

/**
 * `[schema].[name]`. Sessions are opened per database (D28), so the database is
 * never part of the name: generated SQL runs in the database it was made for.
 */
export function quoteTable(table: TableRef): string {
  const parts: string[] = [];
  if (table.schema !== undefined) {
    parts.push(quoteIdentifier(table.schema));
  }
  parts.push(quoteIdentifier(table.name));
  return parts.join('.');
}

/** A Unicode string literal; only `'` needs doubling. */
export function quoteString(text: string): string {
  return `N'${text.replaceAll("'", "''")}'`;
}
