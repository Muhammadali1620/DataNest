// SQLite quoting: identifiers in double quotes, strings with ' doubled.

import type { TableRef } from '../../core/model/objects';
import { msg } from '../../core/user-message';

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error(msg('Identifier must not be empty'));
  }
  if (name.includes('\u0000')) {
    throw new Error(msg('Identifier must not contain NUL'));
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteTable(table: TableRef): string {
  // SQLite scopes come from ATTACH names; the main database needs no prefix.
  const parts: string[] = [];
  if (table.database !== undefined) {
    parts.push(quoteIdentifier(table.database));
  }
  parts.push(quoteIdentifier(table.name));
  return parts.join('.');
}

/** SQLite never interprets backslashes: doubling quotes is enough. */
export function quoteString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}
