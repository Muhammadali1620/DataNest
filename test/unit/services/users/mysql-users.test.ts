import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { mysqlUserAdmin } from '../../../../src/services/users/mysql-users';
import { records, scriptedSession } from '../../../helpers/scripted-session';

const admin = mysqlUserAdmin('mysql', mysqlDialect);
const mariadb = mysqlUserAdmin('mariadb', mysqlDialect);
const app = { name: 'app', host: '%' };

describe('mysqlUserAdmin: reading', () => {
  it('reads accounts without the password hash, roles from role edges', async () => {
    const { session, executed } = scriptedSession((sql) => {
      if (sql.includes('information_schema.COLUMNS')) {
        return records(
          ['Host', 'User', 'authentication_string', 'account_locked', 'password_expired'].map(
            (name) => ({ COLUMN_NAME: name }),
          ),
        );
      }
      if (sql.includes('role_edges')) {
        return records([{ FROM_USER: 'reader', FROM_HOST: '%', TO_USER: 'app', TO_HOST: '%' }]);
      }
      return records([
        { user: 'app', host: '%', account_locked: 'N', password_expired: 'N' },
        { user: 'old', host: 'localhost', account_locked: 'Y', password_expired: 'Y' },
        { user: 'reader', host: '%', account_locked: 'Y', password_expired: 'Y' },
      ]);
    });
    const users = await admin.listUsers(session);
    expect(executed[1]).toBe(
      'SELECT `user`, `host`, `account_locked`, `password_expired` FROM mysql.user',
    );
    expect(executed.join('\n')).not.toContain('authentication_string');
    expect(users).toEqual([
      { name: 'app', host: '%', login: true, flags: [], memberOf: ['reader'] },
      { name: 'old', host: 'localhost', login: true, flags: ['locked', 'expired'], memberOf: [] },
      { name: 'reader', host: '%', login: false, role: true, flags: [], memberOf: [] },
    ]);
  });

  it('reads MariaDB roles by their empty host and locks from global_priv', async () => {
    const { session, executed } = scriptedSession((sql) => {
      if (sql.includes('information_schema.COLUMNS')) {
        return records(['User', 'Host', 'is_role'].map((name) => ({ COLUMN_NAME: name })));
      }
      if (sql.includes('roles_mapping')) {
        return records([{ User: 'app', Host: '%', Role: 'auditor' }]);
      }
      if (sql.includes('global_priv')) {
        return records([{ User: 'app', Host: '%' }]);
      }
      return records([
        { user: 'app', host: '%', is_role: 'N' },
        { user: 'auditor', host: '', is_role: 'Y' },
      ]);
    });
    expect(await mariadb.listUsers(session)).toEqual([
      { name: 'app', host: '%', login: true, flags: ['locked'], memberOf: ['auditor'] },
      { name: 'auditor', host: '', login: false, role: true, flags: [], memberOf: [] },
    ]);
    expect(executed.some((sql) => sql.includes('role_edges'))).toBe(false);
  });

  it('reads the grants of an account from SHOW GRANTS', async () => {
    const { session, executed } = scriptedSession(() => [
      {
        columns: ['Grants for app@%'],
        rows: [["GRANT USAGE ON *.* TO 'app'@'%'"], ['GRANT SELECT ON `shop`.* TO `app`@`%`']],
      },
    ]);
    expect(await admin.listGrants(session, { name: "o'neil", host: 'h' })).toEqual([
      { level: 'database', database: 'shop', privilege: 'SELECT', grantable: false },
    ]);
    expect(executed[0]).toBe("SHOW GRANTS FOR 'o''neil'@'h'");
  });
});

describe('mysqlUserAdmin: statements', () => {
  it('creates an account and hides the password in the preview', () => {
    const create = admin.createUser({ ...app, password: "p'w", options: [] });
    expect(create.statements).toEqual(["CREATE USER 'app'@'%' IDENTIFIED BY 'p''w'"]);
    expect(create.preview).toEqual(["CREATE USER 'app'@'%' IDENTIFIED BY '********'"]);
  });

  it('drops, re-passwords, locks and unlocks', () => {
    expect(admin.dropUser({ name: 'app' })).toEqual(["DROP USER 'app'@'%'"]);
    expect(mariadb.dropUser({ name: 'auditor', host: '', role: true })).toEqual([
      "DROP ROLE 'auditor'",
    ]);
    expect(admin.setPassword(app, 'x').statements).toEqual([
      "ALTER USER 'app'@'%' IDENTIFIED BY 'x'",
    ]);
    expect(admin.setLocked?.(app, true)).toEqual(["ALTER USER 'app'@'%' ACCOUNT LOCK"]);
    expect(admin.setLocked?.(app, false)).toEqual(["ALTER USER 'app'@'%' ACCOUNT UNLOCK"]);
  });

  it('grants on the server, a database and a table', () => {
    expect(
      admin.grant(app, { level: 'server', privileges: ['PROCESS'], grantable: false }),
    ).toEqual(["GRANT PROCESS ON *.* TO 'app'@'%'"]);
    expect(
      admin.grant(app, {
        level: 'database',
        database: 'sh`op',
        privileges: ['SELECT', 'INSERT'],
        grantable: true,
      }),
    ).toEqual(["GRANT SELECT, INSERT ON `sh``op`.* TO 'app'@'%' WITH GRANT OPTION"]);
    expect(
      admin.grant(app, {
        level: 'table',
        database: 'shop',
        name: 'orders',
        privileges: ['UPDATE'],
        grantable: false,
      }),
    ).toEqual(["GRANT UPDATE ON `shop`.`orders` TO 'app'@'%'"]);
  });

  it('gives and takes roles, with a host on MySQL and without one on MariaDB', () => {
    const role = { level: 'role' as const, name: 'reader', privileges: [], grantable: true };
    expect(admin.grant(app, { ...role, host: '%' })).toEqual([
      "GRANT 'reader'@'%' TO 'app'@'%' WITH ADMIN OPTION",
    ]);
    expect(mariadb.grant(app, role)).toEqual(["GRANT 'reader' TO 'app'@'%' WITH ADMIN OPTION"]);
    expect(mariadb.revoke(app, role)).toEqual(["REVOKE 'reader' FROM 'app'@'%'"]);
  });

  it('revokes what the server listed, the grant option and dynamic privileges too', () => {
    expect(
      admin.revoke(app, {
        level: 'database',
        database: 'shop',
        privileges: ['GRANT OPTION'],
        grantable: false,
      }),
    ).toEqual(["REVOKE GRANT OPTION ON `shop`.* FROM 'app'@'%'"]);
    expect(
      admin.revoke(app, { level: 'server', privileges: ['AUDIT_ADMIN'], grantable: false }),
    ).toEqual(["REVOKE AUDIT_ADMIN ON *.* FROM 'app'@'%'"]);
    expect(admin.revoke(app, { level: 'server', privileges: [], grantable: false })).toEqual([]);
  });

  it('refuses what would not be a sane statement', () => {
    expect(() => admin.createUser({ name: ' ', password: 'x', options: [] })).toThrow('empty');
    expect(() => admin.createUser({ ...app, password: '', options: [] })).toThrow('password');
    expect(() => admin.dropUser({ name: 'a\nb' })).toThrow('line break');
    expect(() =>
      admin.grant(app, { level: 'server', privileges: ['SELECT; DROP'], grantable: false }),
    ).toThrow('not a privilege of this level');
    expect(() => admin.grant(app, { level: 'server', privileges: [], grantable: false })).toThrow(
      'at least one',
    );
    expect(() =>
      admin.grant(app, { level: 'schema', schema: 's', privileges: ['SELECT'], grantable: false }),
    ).toThrow('level');
    expect(() =>
      admin.revoke(app, { level: 'server', privileges: ["X' OR '1"], grantable: false }),
    ).toThrow('not a privilege');
    expect(() =>
      admin.grant(app, {
        level: 'table',
        database: 'shop',
        privileges: ['SELECT'],
        grantable: false,
      }),
    ).toThrow('table is missing');
  });

  it('offers privileges by level, server ones only at the server', () => {
    expect(admin.features.privileges.server).toContain('PROCESS');
    expect(admin.features.privileges.database).not.toContain('PROCESS');
    expect(admin.features.privileges.table).not.toContain('EXECUTE');
    expect(admin.features).toMatchObject({ hosts: true, lock: true, tablesIn: 'database' });
  });
});
