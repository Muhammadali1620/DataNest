// Transaction words most SQL databases share: MySQL, MariaDB, PostgreSQL and SQLite.

import type { TransactionSql } from '../driver';

export const STANDARD_TRANSACTION: TransactionSql = {
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  savepoint: (name) => `SAVEPOINT ${name}`,
  releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
  rollbackToSavepoint: (name) => `ROLLBACK TO SAVEPOINT ${name}`,
};
