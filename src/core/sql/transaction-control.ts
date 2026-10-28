// What a statement does to the transaction of its session, read from tokens, so a
// `COMMIT` in a comment or string never counts. Whether a transaction is open is
// always asked from the server (V4.8); this only tells DataNest what a statement
// means before it runs: manual mode must not wrap a `COMMIT` in `BEGIN`, and the
// user should hear that MySQL commits an open transaction before a `CREATE`.

import type { DriverId } from '../../shared/connection';
import { isTrivia, syntaxOf, textOf, tokenize } from './tokenizer';

export type TransactionControl =
  /** BEGIN, START TRANSACTION. */
  | 'begin'
  /** COMMIT, END, PREPARE TRANSACTION. */
  | 'commit'
  /** ROLLBACK, ABORT — the whole transaction. */
  | 'rollback'
  /** SAVEPOINT, RELEASE, ROLLBACK TO: the transaction stays open. */
  | 'savepoint'
  | 'none';

const BEGIN_FOLLOWERS = new Set([
  'TRANSACTION',
  'WORK',
  'DEFERRED',
  'IMMEDIATE',
  'EXCLUSIVE',
  'ISOLATION',
  'READ',
  'NOT',
]);

/** The first `count` words of a statement, uppercased; comments and strings skipped. */
function leadingWords(sql: string, driver: DriverId | undefined, count: number): string[] {
  const words: string[] = [];
  for (const token of tokenize(sql, syntaxOf(driver))) {
    if (isTrivia(token)) {
      continue;
    }
    if (token.kind !== 'word') {
      break;
    }
    words.push(textOf(sql, token).toUpperCase());
    if (words.length === count) {
      break;
    }
  }
  return words;
}

export function transactionControl(sql: string, driver?: DriverId): TransactionControl {
  const [first, second, third] = leadingWords(sql, driver, 3);
  switch (first ?? '') {
    case 'BEGIN':
      // `BEGIN;`, `BEGIN WORK`, `BEGIN IMMEDIATE`, `BEGIN ISOLATION LEVEL …`.
      return second === undefined || BEGIN_FOLLOWERS.has(second) ? 'begin' : 'none';
    case 'START':
      return second === 'TRANSACTION' ? 'begin' : 'none';
    case 'COMMIT':
    case 'END':
      // PostgreSQL's `COMMIT PREPARED 'x'` finishes another, prepared transaction.
      return second === 'PREPARED' ? 'none' : 'commit';
    case 'PREPARE':
      return second === 'TRANSACTION' ? 'commit' : 'none';
    case 'ROLLBACK':
    case 'ABORT':
      if (second === 'TO' || (second !== undefined && third === 'TO')) {
        return 'savepoint';
      }
      return second === 'PREPARED' ? 'none' : 'rollback';
    case 'SAVEPOINT':
    case 'RELEASE':
      return 'savepoint';
    default:
      return 'none';
  }
}

/** Statements after which MySQL commits by itself, as its manual lists them. */
const MYSQL_COMMITTING = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'RENAME',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'LOCK',
  'UNLOCK',
  'ANALYZE',
  'OPTIMIZE',
  'REPAIR',
  'CHECK',
  'CACHE',
  'FLUSH',
  'RESET',
  'INSTALL',
  'UNINSTALL',
]);

/**
 * True when MySQL or MariaDB commit an open transaction before running this
 * statement: DDL, account changes, table locks, maintenance, and `BEGIN` itself.
 * Temporary tables are the exception. PostgreSQL and SQLite never do this.
 */
export function commitsImplicitly(sql: string, driver: DriverId | undefined): boolean {
  if (driver !== 'mysql') {
    return false;
  }
  const [first, second] = leadingWords(sql, driver, 2);
  if (first === undefined) {
    return false;
  }
  if ((first === 'CREATE' || first === 'DROP') && second === 'TEMPORARY') {
    return false;
  }
  return MYSQL_COMMITTING.has(first) || transactionControl(sql, driver) === 'begin';
}
