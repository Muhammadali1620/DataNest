// PostgreSQL quoting: identifiers in double quotes, strings with ' doubled.

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
  const parts: string[] = [];
  if (table.schema !== undefined) {
    parts.push(quoteIdentifier(table.schema));
  }
  parts.push(quoteIdentifier(table.name));
  return parts.join('.');
}

/** standard_conforming_strings is on by default: doubling quotes is enough. */
export function quoteString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}
