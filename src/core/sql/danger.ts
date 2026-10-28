// Spotting statements that can destroy a lot of data in one go: a DELETE or UPDATE
// with no WHERE, DROP, TRUNCATE. It reads tokens, not text, so a "WHERE" inside a
// string, a comment or a subquery is never mistaken for the statement's own.
// The check errs on the side of asking: a needless confirmation costs a click, a
// missed one costs a table.

import { isTrivia, syntaxOf, textOf, tokenize, type SqlSyntax } from './tokenizer';

export const DANGERS = [
  'delete-without-where',
  'update-without-where',
  'drop',
  'truncate',
] as const;
export type Danger = (typeof DANGERS)[number];

/** Verbs that start the statement proper, after any WITH clause. */
const MAIN_VERBS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'REPLACE',
  'VALUES',
  'TABLE',
]);

interface Word {
  readonly text: string;
  readonly depth: number;
}

/** The words of a statement at any depth, uppercased, with their parenthesis depth. */
function wordsOf(sql: string, syntax: SqlSyntax): Word[] {
  const words: Word[] = [];
  let depth = 0;
  for (const token of tokenize(sql, syntax)) {
    if (isTrivia(token)) {
      continue;
    }
    const text = textOf(sql, token);
    if (token.kind === 'punctuation') {
      if (text === '(') {
        depth += 1;
      } else if (text === ')') {
        depth = Math.max(0, depth - 1);
      }
    } else if (token.kind === 'word') {
      words.push({ text: text.toUpperCase(), depth });
    }
  }
  return words;
}

/** What is dangerous about one statement; empty for a harmless one. */
export function dangersOf(sql: string, syntax: SqlSyntax = syntaxOf()): Danger[] {
  const words = wordsOf(sql, syntax);
  const first = words[0];
  if (first === undefined) {
    return [];
  }
  switch (first.text) {
    case 'DROP':
      return ['drop'];
    case 'TRUNCATE':
      return ['truncate'];
    case 'WITH':
      return dataChange(
        words,
        words.findIndex((word, i) => i > 0 && word.depth === 0 && MAIN_VERBS.has(word.text)),
      );
    case 'EXPLAIN': {
      // EXPLAIN alone only plans; with ANALYZE the statement really runs.
      const verb = words.findIndex((word) => MAIN_VERBS.has(word.text));
      const analyzed = words
        .slice(0, Math.max(0, verb))
        .some((word) => word.text === 'ANALYZE' || word.text === 'ANALYSE');
      return analyzed ? dataChange(words, verb) : [];
    }
    default:
      return dataChange(words, 0);
  }
}

/** DELETE or UPDATE at `verbIndex` without a WHERE of its own. */
function dataChange(words: readonly Word[], verbIndex: number): Danger[] {
  const verb = words[verbIndex];
  if (verb === undefined || (verb.text !== 'DELETE' && verb.text !== 'UPDATE')) {
    return [];
  }
  const filtered = words
    .slice(verbIndex + 1)
    .some((word) => word.depth === verb.depth && word.text === 'WHERE');
  if (filtered) {
    return [];
  }
  return [verb.text === 'DELETE' ? 'delete-without-where' : 'update-without-where'];
}
