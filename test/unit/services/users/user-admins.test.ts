import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { oracleDialect } from '../../../../src/drivers/oracle/dialect';
import { userAdminFor } from '../../../../src/services/users/user-admins';

describe('userAdminFor', () => {
  it('gives each server its manager and none to SQLite', () => {
    expect(userAdminFor('tidb', mysqlDialect).features.hosts).toBe(true);
    expect(userAdminFor('cockroach', mysqlDialect).features.createOptions).not.toContain(
      'superuser',
    );
    expect(userAdminFor('postgres', mysqlDialect).features.passwordOptional).toBe(true);
    expect(userAdminFor('oracle', oracleDialect).features.tablesIn).toBe('schema');
    expect(() => userAdminFor('sqlite', mysqlDialect)).toThrow('no users');
  });
});
