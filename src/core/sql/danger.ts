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

/**
 * A T-SQL batch runs as one statement up to `GO` (a procedure body, a script that
 * declares variables), so each of its parts is looked at: a DROP after a DECLARE
 * is as dangerous as one alone.
 */
function batchParts(sql: string, syntax: SqlSyntax): string[] {
  const parts: string[] = [];
  let from = 0;
  let depth = 0;
  for (const token of tokenize(sql, syntax)) {
    const text = textOf(sql, token);
    if (token.kind !== 'punctuation') {
      continue;
    }
    if (text === '(') {
      depth += 1;
    } else if (text === ')') {
      depth = Math.max(0, depth - 1);
    } else if (text === ';' && depth === 0) {
      parts.push(sql.slice(from, token.start));
      from = token.end;
    }
  }
  parts.push(sql.slice(from));
  return parts;
}

/** What is dangerous about one statement; empty for a harmless one. */
export function dangersOf(sql: string, syntax: SqlSyntax = syntaxOf()): Danger[] {
  const leading = wordsOf(sql, syntax)[0]?.text;
  // Creating a procedure or trigger runs none of its body.
  if (
    (syntax.batchSeparator || syntax.slashTerminator) &&
    leading !== 'CREATE' &&
    leading !== 'ALTER'
  ) {
    const plain = { ...syntax, batchSeparator: false, slashTerminator: false };
    const found = new Set(
      batchParts(sql, syntax).flatMap((part) => statementDangers(part, plain, true)),
    );
    return DANGERS.filter((danger) => found.has(danger));
  }
  return statementDangers(sql, syntax, false);
}

/**
 * Words that start a statement after IF …, WHILE … (T-SQL) or FOR … LOOP, ELSIF … THEN,
 * WHEN … THEN (PL/SQL), at the condition's depth.
 */
const TSQL_STATEMENTS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'SET',
  'PRINT',
  'RETURN',
  'THROW',
  'RAISERROR',
  'BEGIN',
  'CREATE',
  'ALTER',
  'DECLARE',
  'WITH',
  'BREAK',
  'CONTINUE',
]);

/** Control words that come right before a statement in a PL/SQL block. */
const PLSQL_LEADS = new Set(['LOOP', 'EXCEPTION', 'THEN', 'CASE']);

/** Control words followed by a condition, then the statement. */
const CONDITIONS = new Set(['IF', 'WHILE', 'ELSIF', 'FOR', 'WHEN']);

/**
 * Where the statement proper starts in a part of a T-SQL batch or PL/SQL block: past the
 * control flow around it (`BEGIN`, `BEGIN TRY`, `END`, `ELSE`, `LOOP`, `EXCEPTION`, and
 * the condition of `IF`/`WHILE`/`ELSIF`/`FOR`/`WHEN`).
 */
function statementStart(words: readonly Word[]): number {
  let index = 0;
  for (;;) {
    const word = words[index];
    const next = words[index + 1]?.text;
    if (word === undefined) {
      return index;
    }
    if (
      (word.text === 'BEGIN' && next !== 'TRAN' && next !== 'TRANSACTION') ||
      word.text === 'ELSE' ||
      word.text === 'END' ||
      PLSQL_LEADS.has(word.text)
    ) {
      index += next === 'TRY' || next === 'CATCH' ? 2 : 1;
      continue;
    }
    if (CONDITIONS.has(word.text)) {
      const found = words.findIndex(
        (candidate, at) =>
          at > index && candidate.depth === word.depth && TSQL_STATEMENTS.has(candidate.text),
      );
      if (found === -1) {
        return words.length;
      }
      index = found;
      continue;
    }
    return index;
  }
}

function statementDangers(sql: string, syntax: SqlSyntax, controlFlow: boolean): Danger[] {
  const all = wordsOf(sql, syntax);
  const words = controlFlow ? all.slice(statementStart(all)) : all;
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
