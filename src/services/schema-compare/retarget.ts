// Definitions read from one schema name that schema in their text (PostgreSQL writes
// `public.order_total`); compared with, or created in, another schema they must name
// that one instead (V8.3). Only a name followed by a dot is a qualifier; strings,
// comments and the rest of the text stay as they are.

import { unquoteIdentifier } from '../../core/sql/identifiers';
import { stripLeadingNoise } from '../../core/sql/statement-kind';
import { syntaxOf, tokenize } from '../../core/sql/tokenizer';
import type { DriverId } from '../../shared/connection';

export function retargetScope(
  sql: string,
  from: string | undefined,
  to: string | undefined,
  driver: DriverId,
  quote: (name: string) => string,
): string {
  if (from === undefined || to === undefined || from === to) {
    return sql;
  }
  const tokens = tokenize(sql, syntaxOf(driver));
  let out = '';
  let at = 0;
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const isName = token.kind === 'word' || token.kind === 'quoted-identifier';
    if (!isName || next?.kind !== 'punctuation' || sql[next.start] !== '.') {
      continue;
    }
    const text = sql.slice(token.start, token.end);
    const name = token.kind === 'word' ? text : unquoteIdentifier(text);
    // Unquoted names fold case on most servers; quoted ones must match exactly.
    const same = token.kind === 'word' ? name.toLowerCase() === from.toLowerCase() : name === from;
    if (!same) {
      continue;
    }
    // The previous token must not be a dot: in `db.public.t` only `db` is a database.
    const previous = tokens[index - 1];
    if (previous?.kind === 'punctuation' && sql[previous.start] === '.') {
      continue;
    }
    out +=
      sql.slice(at, token.start) +
      (token.kind === 'word' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(to) ? to : quote(to));
    at = token.end;
  }
  return out + sql.slice(at);
}

/**
 * Whitespace does not make two definitions different, nor comments in front of them:
 * SQL Server keeps the comments that stood before CREATE in the same batch.
 */
export function normalizeDefinition(statements: readonly string[]): string {
  return statements
    .map((statement) =>
      stripLeadingNoise(statement).trim().replace(/;+$/u, '').replace(/\s+/gu, ' '),
    )
    .join(';\n');
}
