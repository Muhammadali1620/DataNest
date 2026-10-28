// Where in a statement the server's complaint points, read from the message when
// the driver gives no position of its own: MySQL says `near '…' at line N`, SQLite
// says `near "…": syntax error` or `no such column: …`.

import type { DriverId } from '../../shared/connection';
import { syntaxOf, textOf, tokenize } from './tokenizer';

/** Offset of the start of 1-based `line` in `text`. */
function lineStart(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) {
      return offset;
    }
    offset = next + 1;
  }
  return offset;
}

/** The first token of the statement whose text (or unquoted text) is `word`. */
function tokenOffset(sql: string, word: string, driver: DriverId | undefined): number | undefined {
  const wanted = word.toLowerCase();
  for (const token of tokenize(sql, syntaxOf(driver))) {
    if (token.kind !== 'word' && token.kind !== 'quoted-identifier') {
      continue;
    }
    const text = textOf(sql, token);
    const bare = token.kind === 'quoted-identifier' ? text.slice(1, -1) : text;
    if (bare.toLowerCase() === wanted) {
      return token.start;
    }
  }
  return undefined;
}

/** A 0-based offset into `sql`, or undefined when the message says nothing usable. */
export function guessErrorPosition(
  message: string,
  sql: string,
  driver: DriverId | undefined,
): number | undefined {
  const mysql = /near '([\s\S]*)' at line (\d+)\s*$/.exec(message);
  if (mysql !== null) {
    const fragment = mysql[1] ?? '';
    const from = lineStart(sql, Number(mysql[2]));
    if (fragment === '') {
      // `near ''` means the statement ended where more was expected.
      return sql.trimEnd().length;
    }
    // MySQL cuts long fragments short; the beginning is enough to find it.
    const found = sql.indexOf(fragment.slice(0, 40), from);
    return found === -1 ? undefined : found;
  }
  const near = /near "([^"]*)": syntax error/.exec(message);
  if (near !== null) {
    const fragment = near[1] ?? '';
    return fragment === '' ? sql.trimEnd().length : tokenOffset(sql, fragment, driver);
  }
  const missing =
    /no such (?:column|table|function): (?:[\w$]+\.)*([\w$]+)/.exec(message) ??
    /(?:column|table|relation|function) "(?:[^"]+\.)?([^".]+)" does not exist/.exec(message) ??
    /Unknown (?:column|table) '(?:[^'.]+\.)*([^'.]+)'/.exec(message) ??
    /Table '(?:[^'.]+\.)*([^'.]+)' doesn't exist/.exec(message);
  if (missing !== null) {
    return tokenOffset(sql, missing[1] ?? '', driver);
  }
  return undefined;
}
