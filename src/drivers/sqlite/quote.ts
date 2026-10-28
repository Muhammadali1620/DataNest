// SQLite quoting: double quotes, doubled inside.

import type { TableRef } from '../../core/model/objects';

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error('Identifier must not be empty');
  }
  if (name.includes('\u0000')) {
    throw new Error('Identifier must not contain NUL');
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
