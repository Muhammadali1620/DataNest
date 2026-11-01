import { describe, expect, it } from 'vitest';
import { driver } from '../../../../src/drivers/libsql';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';

describe('libsql driver', () => {
  it('describes a libSQL server: SQLite SQL, no databases or schemas, transactions, cancel', () => {
    expect(driver.id).toBe('libsql');
    // The same SQL as SQLite's: quoting, DDL, dumps and pagination are shared.
    expect(driver.dialect).toBe(sqliteDialect);
    expect(driver.capabilities).toEqual({
      databases: false,
      schemas: false,
      databaseScopedSessions: false,
      cancel: true,
      transactions: true,
      objectKinds: [],
    });
    expect(typeof driver.openSession).toBe('function');
  });
});
