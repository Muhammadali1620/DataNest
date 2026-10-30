import { describe, expect, it } from 'vitest';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import { mssqlUserAdmin } from '../../../../src/services/users/mssql-users';
import { records, scriptedSession } from '../../../helpers/scripted-session';

const app = { name: 'app' };

describe('mssqlUserAdmin', () => {
  const admin = mssqlUserAdmin(mssqlDialect);

  it('reads users with their logins, roles and memberships', async () => {
    const { session } = scriptedSession((sql) =>
      sql.includes('database_role_members')
        ? records([{ role_name: 'db_datareader', member_name: 'app' }])
        : records([
            { name: 'app', type: 'S', is_fixed_role: false, login_name: 'app', is_disabled: false },
            {
              name: 'svc',
              type: 'S',
              is_fixed_role: false,
              login_name: 'svc_login',
              is_disabled: true,
            },
            {
              name: 'orphan',
              type: 'S',
              is_fixed_role: false,
              login_name: null,
              is_disabled: null,
            },
            {
              name: 'db_datareader',
              type: 'R',
              is_fixed_role: true,
              login_name: null,
              is_disabled: null,
            },
            {
              name: 'auditors',
              type: 'R',
              is_fixed_role: false,
              login_name: null,
              is_disabled: null,
            },
          ]),
    );
    expect(await admin.listUsers(session)).toEqual([
      { name: 'app', login: true, flags: [], memberOf: ['db_datareader'] },
      { name: 'svc', login: true, flags: ['login svc_login', 'locked'], memberOf: [] },
      { name: 'orphan', login: true, flags: ['no login'], memberOf: [] },
      { name: 'db_datareader', login: false, role: true, flags: ['fixed role'], memberOf: [] },
      { name: 'auditors', login: false, role: true, flags: [], memberOf: [] },
    ]);
  });

  it('reads permissions: denials and columns fixed, roles as grants', async () => {
    const { session, executed } = scriptedSession((sql) =>
      sql.includes('database_permissions')
        ? records([
            {
              permission_name: 'CONNECT',
              state_desc: 'GRANT',
              class_desc: 'DATABASE',
              minor_id: 0,
              database_name: 'shop',
              schema_name: null,
              object_name: null,
            },
            {
              permission_name: 'SELECT',
              state_desc: 'GRANT_WITH_GRANT_OPTION',
              class_desc: 'SCHEMA',
              minor_id: 0,
              database_name: 'shop',
              schema_name: 'sales',
              object_name: null,
            },
            {
              permission_name: 'DELETE',
              state_desc: 'DENY',
              class_desc: 'OBJECT_OR_COLUMN',
              minor_id: 0,
              database_name: 'shop',
              schema_name: 'dbo',
              object_name: 'orders',
            },
            {
              permission_name: 'UPDATE',
              state_desc: 'GRANT',
              class_desc: 'OBJECT_OR_COLUMN',
              minor_id: 2,
              database_name: 'shop',
              schema_name: 'dbo',
              object_name: 'orders',
            },
          ])
        : records([{ role_name: 'db_datareader', member_name: 'app' }]),
    );
    const grants = await admin.listGrants(session, { name: "o'neil" });
    expect(executed[0]).toContain("dp.name = N'o''neil'");
    expect(grants).toEqual([
      { level: 'database', database: 'shop', privilege: 'CONNECT', grantable: false },
      { level: 'schema', database: 'shop', schema: 'sales', privilege: 'SELECT', grantable: true },
      {
        level: 'table',
        database: 'shop',
        schema: 'dbo',
        name: 'orders',
        privilege: 'DENY DELETE',
        grantable: false,
        fixed: true,
      },
      {
        level: 'table',
        database: 'shop',
        schema: 'dbo',
        name: 'orders',
        privilege: 'UPDATE',
        grantable: false,
        fixed: true,
      },
    ]);
  });

  it('creates a login and a user, and changes the login', () => {
    const create = admin.createUser({ name: 'a]b', password: "p'w", options: [] });
    expect(create.statements).toEqual([
      "CREATE LOGIN [a]]b] WITH PASSWORD = N'p''w'",
      'CREATE USER [a]]b] FOR LOGIN [a]]b]',
    ]);
    expect(create.preview[0]).toBe("CREATE LOGIN [a]]b] WITH PASSWORD = N'********'");
    expect(admin.setPassword(app, 'n').statements).toEqual([
      "ALTER LOGIN [app] WITH PASSWORD = N'n'",
    ]);
    expect(admin.setLocked?.(app, true)).toEqual(['ALTER LOGIN [app] DISABLE']);
    expect(admin.dropUser(app)).toEqual(['DROP USER [app]']);
    expect(admin.dropUser({ name: 'auditors', role: true })).toEqual(['DROP ROLE [auditors]']);
  });

  it('grants and revokes in the database, on a schema and on a table; roles by membership', () => {
    expect(
      admin.grant(app, { level: 'database', privileges: ['CREATE TABLE'], grantable: false }),
    ).toEqual(['GRANT CREATE TABLE TO [app]']);
    expect(
      admin.grant(app, {
        level: 'schema',
        schema: 'sales',
        privileges: ['SELECT'],
        grantable: true,
      }),
    ).toEqual(['GRANT SELECT ON SCHEMA::[sales] TO [app] WITH GRANT OPTION']);
    expect(
      admin.revoke(app, {
        level: 'table',
        schema: 'dbo',
        name: 'orders',
        privileges: ['SELECT'],
        grantable: true,
      }),
    ).toEqual(['REVOKE SELECT ON OBJECT::[dbo].[orders] FROM [app] CASCADE']);
    expect(
      admin.grant(app, { level: 'role', name: 'db_datareader', privileges: [], grantable: false }),
    ).toEqual(['ALTER ROLE [db_datareader] ADD MEMBER [app]']);
    expect(
      admin.revoke(app, { level: 'role', name: 'db_datareader', privileges: [], grantable: false }),
    ).toEqual(['ALTER ROLE [db_datareader] DROP MEMBER [app]']);
    expect(() =>
      admin.grant(app, { level: 'server', privileges: ['CONNECT'], grantable: false }),
    ).toThrow();
  });
});
