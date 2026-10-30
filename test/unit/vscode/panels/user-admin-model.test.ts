import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { Session } from '../../../../src/drivers/driver';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import type { AdminChange } from '../../../../src/shared/protocols/user-admin';
import type { SqlDriverId } from '../../../../src/shared/connection';
import {
  UserAdminModel,
  type UserAdminModelDeps,
} from '../../../../src/vscode/panels/user-admin-model';
import { FakeMetadata } from '../../../helpers/fake-driver';
import { records, type ScriptedReply, scriptedSession } from '../../../helpers/scripted-session';

function model(
  answer: (sql: string) => ScriptedReply | Promise<ScriptedReply>,
  overrides: Partial<UserAdminModelDeps> & { driver?: SqlDriverId } = {},
) {
  const scripted = scriptedSession(answer);
  const metadata = new FakeMetadata();
  const session: Session = { ...scripted.session, metadata };
  const users = new UserAdminModel({
    connectionName: 'Local',
    driver: 'postgres',
    dialect: postgresDialect,
    readOnly: false,
    session: async () => await Promise.resolve(session),
    ...overrides,
  });
  return { users, executed: scripted.executed, metadata };
}

function postgres(sql: string): ScriptedReply {
  if (sql === 'SELECT version()') {
    return records([{ version: 'PostgreSQL 17.6' }]);
  }
  if (sql.includes('aclexplode')) {
    return records([
      {
        level: 'table',
        database_name: 'shop',
        schema_name: 'public',
        object_name: 'orders',
        privilege_type: 'SELECT',
        is_grantable: false,
      },
    ]);
  }
  if (sql.includes('pg_auth_members')) {
    return records([{ role_name: 'readers', member_name: 'app' }]);
  }
  if (sql.includes('FROM pg_roles')) {
    return records([
      { rolname: 'readers', rolcanlogin: false },
      { rolname: 'zed', rolcanlogin: true },
      { rolname: 'App', rolcanlogin: true },
    ]);
  }
  return [];
}

const create: AdminChange = {
  kind: 'create',
  user: { name: 'app' },
  password: 'pw',
  options: ['login'],
};

describe('UserAdminModel', () => {
  it('finds out the server and shows what its manager can do, levels in order', async () => {
    const { users } = model(postgres, { database: 'shop' });
    expect(users.started).toBe(false);
    await users.start();
    expect(users.state()).toMatchObject({
      connectionName: 'Local',
      server: 'PostgreSQL',
      database: 'shop',
      readOnly: false,
      features: {
        hosts: false,
        tablesIn: 'schema',
        passwordOptional: true,
        createOptions: ['login', 'superuser', 'createdb', 'createrole'],
        lock: false,
      },
    });
    expect(users.state().features?.levels.map((entry) => entry.level)).toEqual([
      'database',
      'schema',
      'allTables',
      'table',
      'sequence',
      'role',
    ]);
  });

  it('shows why it could not start, and for a SQLite file that it has no users', async () => {
    const failing = model(() => new DbError('auth-failed', 'no entry in pg_hba.conf')).users;
    await failing.start();
    expect(failing.state().error).toBe('no entry in pg_hba.conf');
    await expect(failing.users()).rejects.toMatchObject({ code: 'busy' });
    const sqlite = model(() => [], { driver: 'sqlite' }).users;
    await sqlite.start();
    expect(sqlite.state().error).toBe('A SQLite file has no users');
  });

  it('lists accounts by name, roles last', async () => {
    const { users } = model(postgres);
    await users.start();
    // PostgreSQL groups are roles without login, listed among the rest.
    expect((await users.users()).map((user) => user.name)).toEqual(['App', 'readers', 'zed']);
    const [app] = await users.users();
    expect(app).toEqual({ name: 'App', login: true, flags: [], memberOf: [] });
  });

  it('lists the grants of an account', async () => {
    const { users } = model(postgres);
    await users.start();
    expect(await users.grants({ name: 'app' })).toEqual([
      {
        level: 'table',
        database: 'shop',
        schema: 'public',
        name: 'orders',
        privilege: 'SELECT',
        grantable: false,
      },
      { level: 'role', name: 'readers', privilege: 'ROLE', grantable: false },
    ]);
  });

  it('suggests databases, schemas and tables from the metadata', async () => {
    const { users, metadata } = model(postgres);
    metadata.databases = ['shop', 'crm'];
    metadata.schemas = ['public', 'sales'];
    metadata.tables = [
      { name: 'orders', kind: 'table' },
      { name: 'totals', kind: 'view' },
    ];
    await users.start();
    expect(await users.objects('database')).toEqual(['shop', 'crm']);
    expect(await users.objects('schema', 'shop')).toEqual(['public', 'sales']);
    expect(await users.objects('table', 'shop', 'public')).toEqual(['orders', 'totals']);
  });

  it('builds every kind of change, the password hidden only in the preview', async () => {
    const { users } = model(postgres);
    await users.start();
    expect(users.statements(create)).toEqual({
      statements: [`CREATE ROLE "app" WITH LOGIN PASSWORD 'pw'`],
      preview: [`CREATE ROLE "app" WITH LOGIN PASSWORD '********'`],
    });
    expect(
      users.statements({ kind: 'drop', user: { name: 'readers' }, role: true }).statements,
    ).toEqual(['DROP ROLE "readers"']);
    expect(
      users.statements({ kind: 'password', user: { name: 'app' }, password: 'n' }).preview,
    ).toEqual([`ALTER ROLE "app" WITH PASSWORD '********'`]);
    expect(
      users.statements({
        kind: 'grant',
        user: { name: 'app' },
        target: { level: 'table', database: '', schema: 'public', name: 'orders', host: '' },
        privileges: ['SELECT'],
        grantable: true,
      }).statements,
    ).toEqual(['GRANT SELECT ON TABLE "public"."orders" TO "app" WITH GRANT OPTION']);
    expect(
      users.statements({
        kind: 'revoke',
        user: { name: 'app' },
        target: { level: 'role', name: 'readers' },
      }).statements,
    ).toEqual(['REVOKE "readers" FROM "app"']);
  });

  it('refuses changes that cannot be built', async () => {
    const { users } = model(postgres);
    await users.start();
    expect(() => users.statements({ kind: 'lock', user: { name: 'app' } })).toThrow(
      'cannot be locked',
    );
    expect(() =>
      users.statements({ kind: 'grant', user: { name: 'app' }, privileges: [] }),
    ).toThrow('no target');
  });

  it('knows which changes carry a password', () => {
    expect(UserAdminModel.hasPassword(create)).toBe(true);
    expect(UserAdminModel.hasPassword({ ...create, password: '' })).toBe(false);
    expect(
      UserAdminModel.hasPassword({ kind: 'password', user: { name: 'a' }, password: 'x' }),
    ).toBe(true);
    expect(UserAdminModel.hasPassword({ kind: 'drop', user: { name: 'a' } })).toBe(false);
  });

  it('runs the statements of a change one after another', async () => {
    const { users, executed } = model(postgres, { driver: 'mssql', dialect: mssqlDialect });
    await users.start();
    expect(
      await users.run({ kind: 'create', user: { name: 'app' }, password: 'pw', options: [] }),
    ).toBe(2);
    expect(executed.slice(-2)).toEqual([
      "CREATE LOGIN [app] WITH PASSWORD = N'pw'",
      'CREATE USER [app] FOR LOGIN [app]',
    ]);
  });

  it('says which statement failed when the ones before it ran', async () => {
    const { users } = model(
      (sql) => (sql.startsWith('CREATE USER') ? new DbError('constraint', 'user exists') : []),
      { driver: 'mssql', dialect: mssqlDialect },
    );
    await users.start();
    await expect(
      users.run({ kind: 'create', user: { name: 'app' }, password: 'pw', options: [] }),
    ).rejects.toMatchObject({
      code: 'constraint',
      message: 'user exists (statement 2 of 2; the ones before it ran)',
    });
  });

  it('passes the first failure on as it is', async () => {
    const { users } = model(
      (sql) =>
        sql.startsWith('CREATE LOGIN') ? new DbError('permission-denied', 'no rights') : [],
      { driver: 'mssql', dialect: mssqlDialect },
    );
    await users.start();
    await expect(
      users.run({ kind: 'create', user: { name: 'app' }, password: 'pw', options: [] }),
    ).rejects.toThrow(/^no rights$/u);
  });

  it('runs nothing on a read-only connection', async () => {
    const { users, executed } = model(postgres, { readOnly: true });
    await users.start();
    expect(users.state().readOnly).toBe(true);
    const before = executed.length;
    await expect(users.run(create)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(executed).toHaveLength(before);
  });

  it('runs nothing when a change makes no statements', async () => {
    const { users } = model(postgres);
    await users.start();
    await expect(
      users.run({
        kind: 'revoke',
        user: { name: 'app' },
        target: { level: 'table', schema: 'public', name: 'orders' },
        privileges: [],
      }),
    ).rejects.toThrow('nothing to run');
  });
});
