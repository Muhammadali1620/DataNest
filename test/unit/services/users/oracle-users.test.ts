import { describe, expect, it } from 'vitest';
import { oracleDialect } from '../../../../src/drivers/oracle/dialect';
import { oracleName, oracleUserAdmin } from '../../../../src/services/users/oracle-users';
import { records, scriptedSession } from '../../../helpers/scripted-session';

describe('oracleUserAdmin', () => {
  const admin = oracleUserAdmin(oracleDialect);

  it('writes simple new names in capitals, as Oracle does', () => {
    expect(oracleName('app_1')).toBe('APP_1');
    expect(oracleName('Mixed Case')).toBe('Mixed Case');
    const create = admin.createUser({ name: 'app', password: 'Pw1', options: ['login'] });
    expect(create.statements).toEqual([
      'CREATE USER "APP" IDENTIFIED BY "Pw1"',
      'GRANT CREATE SESSION TO "APP"',
    ]);
    expect(create.preview[0]).toBe('CREATE USER "APP" IDENTIFIED BY "********"');
  });

  it('refuses a password with a double quote', () => {
    expect(() => admin.createUser({ name: 'a', password: 'p"w', options: [] })).toThrow(
      'double quote',
    );
    expect(() => admin.setPassword({ name: 'A' }, 'p"w')).toThrow('double quote');
  });

  it('reads users, roles, system and object privileges', async () => {
    const { session } = scriptedSession((sql) => {
      if (sql.includes('dba_role_privs')) {
        return records([{ GRANTEE: 'APP', GRANTED_ROLE: 'READERS', ADMIN_OPTION: 'NO' }]);
      }
      if (sql.includes('dba_users')) {
        return records([{ USERNAME: 'APP', ACCOUNT_STATUS: 'EXPIRED & LOCKED' }]);
      }
      if (sql.includes('dba_roles')) {
        return records([{ ROLE: 'READERS' }]);
      }
      if (sql.includes('dba_sys_privs')) {
        return records([{ PRIVILEGE: 'CREATE SESSION', ADMIN_OPTION: 'YES' }]);
      }
      return records([
        {
          OWNER: 'SHOP',
          TABLE_NAME: 'ORDERS',
          PRIVILEGE: 'SELECT',
          GRANTABLE: 'NO',
          TYPE: 'TABLE',
        },
        {
          OWNER: 'SHOP',
          TABLE_NAME: 'PKG',
          PRIVILEGE: 'EXECUTE',
          GRANTABLE: 'NO',
          TYPE: 'PACKAGE',
        },
      ]);
    });
    expect(await admin.listUsers(session)).toEqual([
      { name: 'APP', login: true, flags: ['locked', 'expired'], memberOf: ['READERS'] },
      { name: 'READERS', login: false, role: true, flags: [], memberOf: [] },
    ]);
    expect(await admin.listGrants(session, { name: 'APP' })).toEqual([
      { level: 'server', privilege: 'CREATE SESSION', grantable: true },
      { level: 'table', schema: 'SHOP', name: 'ORDERS', privilege: 'SELECT', grantable: false },
      {
        level: 'routine',
        schema: 'SHOP',
        name: 'PKG',
        privilege: 'EXECUTE',
        grantable: false,
        fixed: true,
      },
      { level: 'role', name: 'READERS', privilege: 'ROLE', grantable: false },
    ]);
  });

  it('grants and revokes system and object privileges and roles', () => {
    const user = { name: 'APP' };
    expect(
      admin.grant(user, { level: 'server', privileges: ['CREATE TABLE'], grantable: true }),
    ).toEqual(['GRANT CREATE TABLE TO "APP" WITH ADMIN OPTION']);
    expect(
      admin.grant(user, {
        level: 'table',
        schema: 'SHOP',
        name: 'ORDERS',
        privileges: ['SELECT'],
        grantable: true,
      }),
    ).toEqual(['GRANT SELECT ON "SHOP"."ORDERS" TO "APP" WITH GRANT OPTION']);
    expect(
      admin.revoke(user, { level: 'server', privileges: ['CREATE TABLE'], grantable: false }),
    ).toEqual(['REVOKE CREATE TABLE FROM "APP"']);
    expect(
      admin.revoke(user, { level: 'role', name: 'READERS', privileges: [], grantable: false }),
    ).toEqual(['REVOKE "READERS" FROM "APP"']);
    expect(admin.setLocked?.(user, false)).toEqual(['ALTER USER "APP" ACCOUNT UNLOCK']);
    expect(admin.dropUser({ name: 'READERS', role: true })).toEqual(['DROP ROLE "READERS"']);
  });
});
