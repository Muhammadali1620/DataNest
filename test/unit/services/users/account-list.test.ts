import { describe, expect, it } from 'vitest';
import { hasAccounts } from '../../../../src/services/users/account-list';
import { DRIVER_IDS } from '../../../../src/shared/connection';
import { inSecurityGroup } from '../../../../src/vscode/tree/tree-model';

describe('hasAccounts', () => {
  it('is true for every SQL server and false for a file and the other families', () => {
    expect(DRIVER_IDS.filter((id) => hasAccounts(id))).toEqual([
      'mysql',
      'postgres',
      'mssql',
      'clickhouse',
      'oracle',
    ]);
  });
});

describe('inSecurityGroup', () => {
  const user = { name: 'u', login: true, role: false, flags: [] };
  it('puts accounts that log in under Users', () => {
    expect(inSecurityGroup(user, 'users')).toBe(true);
    expect(inSecurityGroup(user, 'roles')).toBe(false);
  });
  it('puts roles, and accounts that cannot log in, under Roles', () => {
    for (const role of [
      { ...user, role: true },
      { ...user, login: false },
      { ...user, login: false, role: true },
    ]) {
      expect(inSecurityGroup(role, 'roles')).toBe(true);
      expect(inSecurityGroup(role, 'users')).toBe(false);
    }
  });
});
