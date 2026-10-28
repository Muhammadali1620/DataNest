// PostgreSQL quoting: double quotes, doubled inside.

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
  const parts: string[] = [];
  if (table.schema !== undefined) {
    parts.push(quoteIdentifier(table.schema));
  }
  parts.push(quoteIdentifier(table.name));
  return parts.join('.');
}
