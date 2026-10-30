import { describe, expect, it } from 'vitest';
import { clickhouseDialect } from '../../../../src/drivers/clickhouse/dialect';
import { clickhouseUserAdmin } from '../../../../src/services/users/clickhouse-users';
import { records, scriptedSession } from '../../../helpers/scripted-session';

const app = { name: 'app' };

describe('clickhouseUserAdmin', () => {
  const admin = clickhouseUserAdmin(clickhouseDialect);

  it('reads users and roles; those of users.xml cannot change', async () => {
    const { session } = scriptedSession((sql) => {
      if (sql.includes('role_grants')) {
        return records([{ user_name: 'app', role_name: null, granted_role_name: 'readers' }]);
      }
      if (sql.includes('system.users')) {
        return records([
          { name: 'default', storage: 'users_xml', auth: "['no_password']" },
          { name: 'app', storage: 'local_directory', auth: "['sha256_password']" },
        ]);
      }
      return records([{ name: 'readers', storage: 'local_directory' }]);
    });
    expect(await admin.listUsers(session)).toEqual([
      { name: 'default', login: true, flags: ['users.xml'], memberOf: [], readOnly: true },
      { name: 'app', login: true, flags: [], memberOf: ['readers'] },
      { name: 'readers', login: false, role: true, flags: [], memberOf: [] },
    ]);
  });

  it('reads grants: levels by what is NULL, partial revokes and columns fixed', async () => {
    const { session } = scriptedSession((sql) =>
      sql.includes('system.grants')
        ? records([
            {
              access_type: 'SHOW DATABASES',
              database: null,
              table: null,
              column: null,
              is_partial_revoke: 0,
              grant_option: 0,
            },
            {
              access_type: 'SELECT',
              database: 'shop',
              table: null,
              column: null,
              is_partial_revoke: 0,
              grant_option: 1,
            },
            {
              access_type: 'SELECT',
              database: 'shop',
              table: 'secrets',
              column: null,
              is_partial_revoke: 1,
              grant_option: 0,
            },
            {
              access_type: 'INSERT',
              database: 'shop',
              table: 'orders',
              column: 'total',
              is_partial_revoke: 0,
              grant_option: 0,
            },
          ])
        : records([{ granted_role_name: 'readers', with_admin_option: 1 }]),
    );
    expect(await admin.listGrants(session, app)).toEqual([
      { level: 'server', privilege: 'SHOW DATABASES', grantable: false },
      { level: 'database', database: 'shop', privilege: 'SELECT', grantable: true },
      {
        level: 'table',
        database: 'shop',
        name: 'secrets',
        privilege: 'REVOKE SELECT',
        grantable: false,
        fixed: true,
      },
      {
        level: 'table',
        database: 'shop',
        name: 'orders',
        privilege: 'INSERT (total)',
        grantable: false,
        fixed: true,
      },
      { level: 'role', name: 'readers', privilege: 'ROLE', grantable: true },
    ]);
  });

  it('builds its statements', () => {
    const create = admin.createUser({ name: 'app', password: 's3', options: [] });
    expect(create.statements).toEqual(["CREATE USER `app` IDENTIFIED BY 's3'"]);
    expect(create.preview).toEqual(["CREATE USER `app` IDENTIFIED BY '********'"]);
    expect(admin.dropUser({ name: 'readers', role: true })).toEqual(['DROP ROLE `readers`']);
    expect(
      admin.grant(app, {
        level: 'table',
        database: 'shop',
        name: 'orders',
        privileges: ['SELECT', 'INSERT'],
        grantable: true,
      }),
    ).toEqual(['GRANT SELECT, INSERT ON `shop`.`orders` TO `app` WITH GRANT OPTION']);
    expect(
      admin.revoke(app, { level: 'server', privileges: ['SHOW DATABASES'], grantable: false }),
    ).toEqual(['REVOKE SHOW DATABASES ON *.* FROM `app`']);
    expect(admin.features.lock).toBe(false);
  });
});
