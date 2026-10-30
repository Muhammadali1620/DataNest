// ClickHouse quoting: identifiers in backticks, strings in single quotes, both with
// C-style backslash escapes, which ClickHouse reads inside every quoted token.

import type { TableRef } from '../../core/model/objects';
import { msg } from '../../core/user-message';

function escaped(text: string, quote: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`);
}

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error(msg('Identifier must not be empty'));
  }
  if (name.includes('\u0000')) {
    throw new Error(msg('Identifier must not contain NUL'));
  }
  return `\`${escaped(name, '`')}\``;
}

/** `` `db`.`table` ``: one session reads every database, so names carry theirs. */
export function quoteTable(table: TableRef): string {
  return table.database === undefined
    ? quoteIdentifier(table.name)
    : `${quoteIdentifier(table.database)}.${quoteIdentifier(table.name)}`;
}

export function quoteString(text: string): string {
  return `'${escaped(text, "'")}'`;
}
