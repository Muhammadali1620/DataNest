// Which language a statement of an InfluxDB connection is written in (V13.20): InfluxQL,
// which looks like SQL, or Flux, a pipeline language that no SQL tool should rewrite.

import { isTrivia, syntaxOf, textOf, tokenize } from './tokenizer';

/** The statements of the old query language; anything else is Flux. */
const INFLUXQL_VERBS = new Set([
  'SELECT',
  'SHOW',
  'CREATE',
  'DROP',
  'ALTER',
  'DELETE',
  'GRANT',
  'REVOKE',
  'KILL',
  'EXPLAIN',
]);

export type QueryLanguage = 'flux' | 'influxql';

/** Which language a statement is written in, by its first word (comments do not count). */
export function languageOf(sql: string): QueryLanguage {
  const syntax = syntaxOf('influxdb');
  for (const token of tokenize(sql, syntax)) {
    if (isTrivia(token)) {
      continue;
    }
    return token.kind === 'word' && INFLUXQL_VERBS.has(textOf(sql, token).toUpperCase())
      ? 'influxql'
      : 'flux';
  }
  return 'flux';
}
