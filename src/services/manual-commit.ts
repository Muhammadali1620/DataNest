// Manual commit mode (V4.8): DataNest opens a transaction before the first statement
// that changes something, and the user ends it with Commit or Rollback. Reading
// statements do not open one, so a SELECT never leaves a session idle in a transaction.

import { isReadOnlyStatement } from '../core/sql/read-only';
import { syntaxOf } from '../core/sql/tokenizer';
import { commitsImplicitly, transactionControl } from '../core/sql/transaction-control';
import type { TransactionState } from '../drivers/driver';
import type { DriverId } from '../shared/connection';

/** Opens a transaction in MySQL/MariaDB, PostgreSQL and SQLite alike. */
export const BEGIN_STATEMENT = 'BEGIN';

/**
 * True when manual mode must run BEGIN before `sql`: the session is idle (not when
 * the driver cannot tell), the statement changes data, it does not manage the
 * transaction itself, and it is not one MySQL would commit at once anyway.
 */
export function needsBegin(
  sql: string,
  driver: DriverId | undefined,
  state: TransactionState | undefined,
): boolean {
  if (state !== 'idle') {
    return false;
  }
  if (transactionControl(sql, driver) !== 'none' || commitsImplicitly(sql, driver)) {
    return false;
  }
  return !isReadOnlyStatement(sql, syntaxOf(driver));
}
