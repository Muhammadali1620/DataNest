// Telling statements that only read from those that may change the database, for
// production connections (confirm every change) and read-only ones (refuse it). It
// reads tokens, so words inside strings and comments never count. Anything it does
// not know is a change: asking once too often is cheap, letting a write through on
// production is not. A function with side effects inside a SELECT cannot be seen
// here; on read-only connections the server itself refuses those (V4.6).

import { isTrivia, syntaxOf, textOf, tokenize, type SqlSyntax } from './tokenizer';

interface Word {
  readonly text: string;
  readonly depth: number;
}

interface Scan {
  readonly words: readonly Word[];
  /** Punctuation outside parentheses, e.g. `=` in `PRAGMA x = 1`. */
  readonly topPunctuation: readonly string[];
  readonly hasParentheses: boolean;
}

function scan(sql: string, syntax: SqlSyntax): Scan {
  const words: Word[] = [];
  const topPunctuation: string[] = [];
  let depth = 0;
  let hasParentheses = false;
  for (const token of tokenize(sql, syntax)) {
    if (isTrivia(token)) {
      continue;
    }
    const text = textOf(sql, token);
    if (token.kind === 'punctuation') {
      if (text === '(') {
        depth += 1;
        hasParentheses = true;
      } else if (text === ')') {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0) {
        topPunctuation.push(text);
      }
    } else if (token.kind === 'word') {
      words.push({ text: text.toUpperCase(), depth });
    }
  }
  return { words, topPunctuation, hasParentheses };
}

/** Verbs that start the statement proper after WITH or EXPLAIN. */
const MAIN_VERBS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'REPLACE',
  'VALUES',
  'TABLE',
  'CREATE',
  'COPY',
]);

/** Verbs that write wherever they appear, e.g. in a data-modifying CTE of PostgreSQL. */
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE']);

/** Session settings that would lift the read-only guard or reach past the session. */
const GUARDED_SETTINGS = new Set([
  'GLOBAL',
  'PERSIST',
  'PERSIST_ONLY',
  'TRANSACTION',
  'CHARACTERISTICS',
  'DEFAULT_TRANSACTION_READ_ONLY',
  'TRANSACTION_READ_ONLY',
  'TX_READ_ONLY',
  'SESSION_REPLICATION_ROLE',
  'QUERY_ONLY',
]);

/** SQLite pragmas that take an argument and still only read. */
const READ_PRAGMAS = new Set([
  'TABLE_INFO',
  'TABLE_XINFO',
  'TABLE_LIST',
  'INDEX_LIST',
  'INDEX_INFO',
  'INDEX_XINFO',
  'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
]);

/** SQLite pragmas without an argument that still do something. */
const ACTING_PRAGMAS = new Set([
  'OPTIMIZE',
  'SHRINK_MEMORY',
  'WAL_CHECKPOINT',
  'INCREMENTAL_VACUUM',
]);

/** A SELECT that writes a table or a file, or locks rows for a later write. */
function selectReads(words: readonly Word[], from: number): boolean {
  const own = words.slice(from);
  for (const [index, word] of own.entries()) {
    if (WRITE_VERBS.has(word.text)) {
      return false;
    }
    if (word.text === 'INTO' && word.depth === (own[0]?.depth ?? 0)) {
      return false;
    }
    const next = own[index + 1]?.text;
    if (
      word.text === 'FOR' &&
      (next === 'UPDATE' || next === 'SHARE' || next === 'NO' || next === 'KEY')
    ) {
      return false;
    }
    if (word.text === 'LOCK' && next === 'IN') {
      return false;
    }
  }
  return true;
}

function mainVerbIndex(words: readonly Word[]): number {
  return words.findIndex(
    (word, index) => index > 0 && word.depth === 0 && MAIN_VERBS.has(word.text),
  );
}

/** True when running the statement can only read; false when it may change anything. */
export function isReadOnlyStatement(sql: string, syntax: SqlSyntax = syntaxOf()): boolean {
  const { words, topPunctuation, hasParentheses } = scan(sql, syntax);
  const first = words[0];
  if (first === undefined) {
    // Only comments or blanks: nothing runs.
    return true;
  }
  switch (first.text) {
    case 'SELECT':
      return selectReads(words, 0);
    case 'VALUES':
    case 'TABLE':
    case 'SHOW':
    case 'DESCRIBE':
    case 'DESC':
    case 'USE':
    case 'BEGIN':
    case 'COMMIT':
    case 'END':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE':
      return true;
    case 'START':
      // START TRANSACTION READ WRITE asks for the very thing read-only forbids.
      return !words.some((word) => word.text === 'WRITE');
    case 'WITH': {
      if (words.some((word) => WRITE_VERBS.has(word.text))) {
        return false;
      }
      const verb = mainVerbIndex(words);
      const main = words[verb]?.text;
      return (
        (main === 'SELECT' || main === 'VALUES' || main === 'TABLE') && selectReads(words, verb)
      );
    }
    case 'EXPLAIN': {
      const verb = words.findIndex((word, index) => index > 0 && MAIN_VERBS.has(word.text));
      const analyzed = words
        .slice(1, verb === -1 ? words.length : verb)
        .some((word) => word.text === 'ANALYZE' || word.text === 'ANALYSE');
      // Without ANALYZE only the plan is made; with it the statement really runs.
      return (
        !analyzed ||
        (verb !== -1 &&
          !words.slice(verb).some((word) => WRITE_VERBS.has(word.text) || word.text === 'CREATE'))
      );
    }
    case 'SET':
      return !words.some((word) => GUARDED_SETTINGS.has(word.text));
    case 'PRAGMA': {
      // `schema.pragma`: the name is the last word outside the argument.
      const pragma = words.filter((word) => word.depth === 0).at(-1)?.text ?? '';
      if (topPunctuation.includes('=')) {
        return false;
      }
      if (hasParentheses) {
        return READ_PRAGMAS.has(pragma);
      }
      return !ACTING_PRAGMAS.has(pragma);
    }
    default:
      return false;
  }
}

/** The statements of a run that may change something, in order. */
export function changingStatements<T extends { readonly text: string }>(
  statements: readonly T[],
  syntax: SqlSyntax = syntaxOf(),
): T[] {
  return statements.filter((statement) => !isReadOnlyStatement(statement.text, syntax));
}
