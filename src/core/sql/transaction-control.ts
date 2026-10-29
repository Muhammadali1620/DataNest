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

/** What follows BEGIN when it starts a transaction in T-SQL; alone it opens a block. */
const TSQL_BEGIN_FOLLOWERS = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED']);

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
  if (driver === 'mssql') {
    return tsqlControl(first, second, third);
  }
  if (driver === 'oracle') {
    return oracleControl(first, second, third);
  }
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

/**
 * T-SQL: `BEGIN TRAN`, `COMMIT [TRAN]`, `ROLLBACK [TRAN]`, `SAVE TRAN s`, and
 * `ROLLBACK TRAN s`, which goes back to the savepoint `s`. `BEGIN` and `END` alone
 * are a block.
 */
function tsqlControl(
  first: string | undefined,
  second: string | undefined,
  third: string | undefined,
): TransactionControl {
  const tran = second === 'TRAN' || second === 'TRANSACTION';
  switch (first ?? '') {
    case 'BEGIN':
      return second !== undefined && TSQL_BEGIN_FOLLOWERS.has(second) ? 'begin' : 'none';
    case 'COMMIT':
      return 'commit';
    case 'ROLLBACK':
      return tran && third !== undefined ? 'savepoint' : 'rollback';
    case 'SAVE':
      return tran ? 'savepoint' : 'none';
    default:
      return 'none';
  }
}

/**
 * Oracle: a transaction starts with the first change or with `SET TRANSACTION`; `BEGIN`
 * and `END` belong to PL/SQL blocks. `ROLLBACK [WORK] TO [SAVEPOINT] s` goes back to `s`.
 */
function oracleControl(
  first: string | undefined,
  second: string | undefined,
  third: string | undefined,
): TransactionControl {
  switch (first ?? '') {
    case 'SET':
      return second === 'TRANSACTION' ? 'begin' : 'none';
    case 'COMMIT':
      return 'commit';
    case 'ROLLBACK':
      return second === 'TO' || (second === 'WORK' && third === 'TO') ? 'savepoint' : 'rollback';
    case 'SAVEPOINT':
      return 'savepoint';
    default:
      return 'none';
  }
}

/** DDL and account statements, after which Oracle commits an open transaction itself. */
const ORACLE_COMMITTING = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'RENAME',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'COMMENT',
  'ANALYZE',
  'AUDIT',
  'NOAUDIT',
  'PURGE',
  'FLASHBACK',
]);

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
 * Temporary tables are the exception. Oracle commits before DDL too (except ALTER
 * SESSION and ALTER SYSTEM); PostgreSQL, SQLite and SQL Server never do this.
 */
export function commitsImplicitly(sql: string, driver: DriverId | undefined): boolean {
  if (driver === 'oracle') {
    const [first, second] = leadingWords(sql, driver, 2);
    // ALTER SESSION and ALTER SYSTEM only change settings; every other DDL commits first.
    return (
      first !== undefined &&
      ORACLE_COMMITTING.has(first) &&
      !(first === 'ALTER' && (second === 'SESSION' || second === 'SYSTEM'))
    );
  }
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
