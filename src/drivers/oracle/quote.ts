// Oracle quoting: identifiers in double quotes (which also keeps their case), strings
// in single quotes with ' doubled; N'…' keeps text outside the database character set.

import type { TableRef } from '../../core/model/objects';

/** The longest identifier Oracle 12.2 and newer accept, in bytes. */
export const MAX_IDENTIFIER_BYTES = 128;

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error('Identifier must not be empty');
  }
  if (name.includes('\u0000') || name.includes('"')) {
    // Oracle has no escape for a double quote inside a quoted identifier.
    throw new Error('Identifier must not contain NUL or a double quote');
  }
  return `"${name}"`;
}

/** `"SCHEMA"."TABLE"`: the session reads every schema of its database by naming it. */
export function quoteTable(table: TableRef): string {
  return table.schema === undefined
    ? quoteIdentifier(table.name)
    : `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
}

/** A string literal; N'…' only when the text needs it, so plain text stays plain. */
export function quoteString(text: string): string {
  const quoted = `'${text.replaceAll("'", "''")}'`;
  // eslint-disable-next-line no-control-regex
  return /^[\u0000-\u007f]*$/u.test(text) ? quoted : `N${quoted}`;
}

/**
 * Characters per piece of a long text value. A literal holds 4000 bytes at most, in SQL
 * and in PL/SQL alike; 1000 characters fit even when every one takes four bytes.
 */
export const TEXT_PIECE = 1000;

/**
 * A text value of any length: a plain literal while it fits, else CLOB pieces joined
 * with `||`, which a VARCHAR2 column takes as well while the whole fits there.
 */
export function quoteText(text: string): string {
  if (text.length <= TEXT_PIECE) {
    return quoteString(text);
  }
  const pieces: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + TEXT_PIECE, text.length);
    // A surrogate pair stays in one piece.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    pieces.push(`TO_CLOB(${quoteString(text.slice(start, end))})`);
    start = end;
  }
  return pieces.join(' || ');
}
