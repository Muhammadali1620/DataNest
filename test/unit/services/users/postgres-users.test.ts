import { describe, expect, it } from 'vitest';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { postgresUserAdmin } from '../../../../src/services/users/postgres-users';
import { records, scriptedSession } from '../../../helpers/scripted-session';

const admin = postgresUserAdmin(false, postgresDialect);
const cockroach = postgresUserAdmin(true, postgresDialect);
const app = { name: 'app' };

const MEMBERS = records([
  { role_name: 'readers', member_name: 'app' },
  { role_name: 'writers', member_name: 'app' },
]);

describe('postgresUserAdmin: reading', () => {
  it('reads roles with their attributes and memberships', async () => {
    const { session, executed } = scriptedSession((sql) =>
      sql.includes('pg_auth_members')
        ? MEMBERS
        : records([
            {
              rolname: 'app',
              rolcanlogin: true,
              rolsuper: false,
              rolcreatedb: true,
              rolcreaterole: false,
              rolreplication: false,
              rolvaliduntil: { kind: 'datetime', text: '2027-01-01 00:00:00+00' },
            },
            {
              rolname: 'readers',
              rolcanlogin: false,
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolreplication: false,
              rolvaliduntil: null,
            },
            {
              rolname: 'postgres',
              rolcanlogin: true,
              rolsuper: true,
              rolcreatedb: true,
              rolcreaterole: true,
              rolreplication: true,
              rolvaliduntil: { kind: 'datetime', text: 'infinity' },
            },
          ]),
    );
    const users = await admin.listUsers(session);
    expect(executed[1]).toContain("rolname !~ '^pg_'");
    expect(users).toEqual([
      {
        name: 'app',
        login: true,
        flags: ['createdb', 'until 2027-01-01 00:00:00+00'],
        memberOf: ['readers', 'writers'],
      },
      { name: 'readers', login: false, flags: [], memberOf: [] },
      {
        name: 'postgres',
        login: true,
        flags: ['superuser', 'createdb', 'createrole', 'replication'],
        memberOf: [],
      },
    ]);
  });

  it('reads privileges from the access lists, routines as fixed, and memberships', async () => {
    const { session, executed } = scriptedSession((sql) =>
      sql.includes('aclexplode')
        ? records([
            {
              level: 'database',
              database_name: 'shop',
              schema_name: null,
              object_name: null,
              privilege_type: 'CONNECT',
              is_grantable: false,
            },
            {
              level: 'table',
              database_name: 'shop',
              schema_name: 'public',
              object_name: 'orders',
              privilege_type: 'SELECT',
              is_grantable: true,
            },
            {
              level: 'routine',
              database_name: 'shop',
              schema_name: 'public',
              object_name: 'total(integer)',
              privilege_type: 'EXECUTE',
              is_grantable: false,
            },
          ])
        : MEMBERS,
    );
    const grants = await admin.listGrants(session, { name: "o'neil" });
    expect(executed[0]).toContain("rolname = 'o''neil'");
    expect(grants).toEqual([
      { level: 'database', database: 'shop', privilege: 'CONNECT', grantable: false },
      {
        level: 'table',
        database: 'shop',
        schema: 'public',
        name: 'orders',
        privilege: 'SELECT',
        grantable: true,
      },
      {
        level: 'routine',
        database: 'shop',
        schema: 'public',
        name: 'total(integer)',
        privilege: 'EXECUTE',
        grantable: false,
        fixed: true,
      },
    ]);
    const member = await admin.listGrants(
      scriptedSession((sql) => (sql.includes('aclexplode') ? [] : MEMBERS)).session,
      app,
    );
    expect(member.map((grant) => grant.name)).toEqual(['readers', 'writers']);
  });

  it('reads CockroachDB grants from SHOW GRANTS FOR', async () => {
    const { session, executed } = scriptedSession((sql) =>
      sql.includes('SHOW GRANTS')
        ? records([
            {
              database_name: 'shop',
              schema_name: null,
              object_name: 'shop',
              object_type: 'database',
              privilege_type: 'CONNECT',
              is_grantable: false,
            },
            {
              database_name: 'shop',
              schema_name: 'public',
              object_name: 'orders',
              object_type: 'table',
              privilege_type: 'SELECT',
              is_grantable: true,
            },
            {
              database_name: 'shop',
              schema_name: 'public',
              object_name: 'mood',
              object_type: 'type',
              privilege_type: 'USAGE',
              is_grantable: false,
            },
          ])
        : [],
    );
    expect(await cockroach.listGrants(session, app)).toEqual([
      { level: 'database', database: 'shop', privilege: 'CONNECT', grantable: false },
      {
        level: 'table',
        database: 'shop',
        schema: 'public',
        name: 'orders',
        privilege: 'SELECT',
        grantable: true,
      },
    ]);
    expect(executed[0]).toBe('SELECT * FROM [SHOW GRANTS FOR "app"]');
  });
});

describe('postgresUserAdmin: statements', () => {
  it('creates login roles and group roles, a password only where given', () => {
    const login = admin.createUser({
      name: 'App',
      password: "p'w",
      options: ['login', 'createdb'],
    });
    expect(login.statements).toEqual([`CREATE ROLE "App" WITH LOGIN CREATEDB PASSWORD 'p''w'`]);
    expect(login.preview).toEqual([`CREATE ROLE "App" WITH LOGIN CREATEDB PASSWORD '********'`]);
    expect(admin.createUser({ name: 'readers', password: '', options: [] }).statements).toEqual([
      'CREATE ROLE "readers" WITH NOLOGIN',
    ]);
    expect(
      admin.createUser({ name: 'boss', password: 'x', options: ['superuser', 'createrole'] })
        .statements,
    ).toEqual([`CREATE ROLE "boss" WITH NOLOGIN SUPERUSER CREATEROLE PASSWORD 'x'`]);
  });

  it('knows no SUPERUSER on CockroachDB', () => {
    expect(() =>
      cockroach.createUser({ name: 'x', password: '', options: ['login', 'superuser'] }),
    ).toThrow('"superuser" is not an option');
    expect(cockroach.features.createOptions).not.toContain('superuser');
    expect(cockroach.features.privileges.table).not.toContain('TRUNCATE');
  });

  it('drops roles and changes passwords', () => {
    expect(admin.dropUser({ name: 'a"b' })).toEqual(['DROP ROLE "a""b"']);
    expect(admin.setPassword(app, 'n').statements).toEqual([`ALTER ROLE "app" WITH PASSWORD 'n'`]);
    expect(admin.setPassword(app, 'n').preview).toEqual([
      `ALTER ROLE "app" WITH PASSWORD '********'`,
    ]);
    expect(admin.features.lock).toBe(false);
    expect(admin.setLocked).toBeUndefined();
  });

  it('grants at each level', () => {
    const grant = (change: Parameters<typeof admin.grant>[1]) => admin.grant(app, change)[0];
    expect(
      grant({ level: 'database', database: 'shop', privileges: ['CONNECT'], grantable: false }),
    ).toBe('GRANT CONNECT ON DATABASE "shop" TO "app"');
    expect(
      grant({ level: 'schema', schema: 'sales', privileges: ['USAGE'], grantable: true }),
    ).toBe('GRANT USAGE ON SCHEMA "sales" TO "app" WITH GRANT OPTION');
    expect(
      grant({
        level: 'table',
        schema: 'public',
        name: 'orders',
        privileges: ['SELECT', 'UPDATE'],
        grantable: false,
      }),
    ).toBe('GRANT SELECT, UPDATE ON TABLE "public"."orders" TO "app"');
    expect(
      grant({ level: 'allTables', schema: 'public', privileges: ['SELECT'], grantable: false }),
    ).toBe('GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "app"');
    expect(
      grant({
        level: 'sequence',
        schema: 'public',
        name: 'orders_id_seq',
        privileges: ['USAGE'],
        grantable: false,
      }),
    ).toBe('GRANT USAGE ON SEQUENCE "public"."orders_id_seq" TO "app"');
    expect(grant({ level: 'role', name: 'readers', privileges: [], grantable: true })).toBe(
      'GRANT "readers" TO "app" WITH ADMIN OPTION',
    );
  });

  it('revokes, and refuses levels it has no words for', () => {
    expect(
      admin.revoke(app, {
        level: 'table',
        schema: 'public',
        name: 'orders',
        privileges: ['SELECT'],
        grantable: true,
      }),
    ).toEqual(['REVOKE SELECT ON TABLE "public"."orders" FROM "app"']);
    expect(
      admin.revoke(app, { level: 'role', name: 'readers', privileges: [], grantable: false }),
    ).toEqual(['REVOKE "readers" FROM "app"']);
    expect(() =>
      admin.grant(app, { level: 'server', privileges: ['ALL PRIVILEGES'], grantable: false }),
    ).toThrow('level');
    expect(() =>
      admin.revoke(app, {
        level: 'routine',
        schema: 's',
        name: 'f()',
        privileges: ['EXECUTE'],
        grantable: false,
      }),
    ).toThrow('level');
    expect(() =>
      admin.grant(app, {
        level: 'table',
        schema: 'public',
        privileges: ['SELECT'],
        grantable: false,
      }),
    ).toThrow('table is missing');
  });
});
