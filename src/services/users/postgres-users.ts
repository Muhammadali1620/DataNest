// Roles of PostgreSQL, YugabyteDB and CockroachDB (V8.6): pg_roles with memberships,
// privileges from the access lists of the current database (CockroachDB: SHOW GRANTS),
// and CREATE / ALTER / DROP ROLE, GRANT and REVOKE.

import { DbError } from '../../core/errors';
import type { Session } from '../../drivers/driver';
import { namedRows, textOf } from '../monitor/rows';
import {
  type AdminDialect,
  checkPrivilege,
  checkText,
  type DbGrant,
  type DbUser,
  type GrantChange,
  type GrantLevel,
  privilegeList,
  required,
  type UserAdmin,
  type UserAdminFeatures,
  type UserRef,
  withPassword,
} from './user-admin';

const POSTGRES_TABLE = [
  'ALL PRIVILEGES',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];

const POSTGRES_PRIVILEGES: UserAdminFeatures['privileges'] = {
  database: ['ALL PRIVILEGES', 'CONNECT', 'CREATE', 'TEMPORARY'],
  schema: ['ALL PRIVILEGES', 'USAGE', 'CREATE'],
  table: POSTGRES_TABLE,
  allTables: POSTGRES_TABLE,
  sequence: ['ALL PRIVILEGES', 'USAGE', 'SELECT', 'UPDATE'],
  role: [],
};

// CockroachDB has privileges of its own and none of TRUNCATE, TRIGGER, TEMPORARY.
const COCKROACH_TABLE = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DROP'];

const COCKROACH_PRIVILEGES: UserAdminFeatures['privileges'] = {
  database: ['ALL', 'CONNECT', 'CREATE', 'DROP'],
  schema: ['ALL', 'USAGE', 'CREATE'],
  table: COCKROACH_TABLE,
  allTables: COCKROACH_TABLE,
  sequence: ['ALL', 'USAGE', 'SELECT', 'UPDATE'],
  role: [],
};

const ROLES = `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
  rolvaliduntil
FROM pg_roles
WHERE rolname !~ '^pg_'`;

const MEMBERSHIPS = `SELECT r.rolname AS role_name, m.rolname AS member_name
FROM pg_auth_members a
JOIN pg_roles r ON r.oid = a.roleid
JOIN pg_roles m ON m.oid = a.member`;

/** What a role holds in the current database, from the access lists of its objects. */
function postgresGrants(role: string): string {
  const me = `(SELECT oid FROM pg_roles WHERE rolname = ${role})`;
  const system = "('pg_catalog', 'information_schema')";
  return `SELECT 'database' AS level, d.datname AS database_name, NULL AS schema_name,
  NULL AS object_name, a.privilege_type, a.is_grantable
FROM pg_database d, aclexplode(d.datacl) a WHERE a.grantee = ${me}
UNION ALL
SELECT 'schema', current_database(), n.nspname, NULL, a.privilege_type, a.is_grantable
FROM pg_namespace n, aclexplode(n.nspacl) a
WHERE a.grantee = ${me} AND n.nspname NOT IN ${system}
UNION ALL
SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'table' END, current_database(),
  n.nspname, c.relname, a.privilege_type, a.is_grantable
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
WHERE a.grantee = ${me} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  AND n.nspname NOT IN ${system}
UNION ALL
SELECT 'routine', current_database(), n.nspname,
  p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', a.privilege_type,
  a.is_grantable
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
WHERE a.grantee = ${me} AND n.nspname NOT IN ${system}`;
}

export function postgresUserAdmin(cockroach: boolean, dialect: AdminDialect): UserAdmin {
  const features: UserAdminFeatures = {
    tablesIn: 'schema',
    passwordOptional: true,
    hosts: false,
    createOptions: cockroach
      ? ['login', 'createdb', 'createrole']
      : ['login', 'superuser', 'createdb', 'createrole'],
    lock: false,
    privileges: cockroach ? COCKROACH_PRIVILEGES : POSTGRES_PRIVILEGES,
  };
  const quote = (name: string | undefined, what: string): string =>
    dialect.quoteIdentifier(required(name, what));
  const roleName = (user: UserRef): string => quote(user.name, 'role name');
  const target = (change: GrantChange): string => {
    switch (change.level) {
      case 'database':
        return `DATABASE ${quote(change.database, 'database')}`;
      case 'schema':
        return `SCHEMA ${quote(change.schema, 'schema')}`;
      case 'table':
        return `TABLE ${quote(change.schema, 'schema')}.${quote(change.name, 'table')}`;
      case 'allTables':
        return `ALL TABLES IN SCHEMA ${quote(change.schema, 'schema')}`;
      case 'sequence':
        return `SEQUENCE ${quote(change.schema, 'schema')}.${quote(change.name, 'sequence')}`;
      case 'server':
      case 'routine':
      case 'role':
        throw new DbError('unsupported', `Roles get nothing at the level "${change.level}" here`);
    }
  };

  return {
    features,

    async listUsers(session: Session): Promise<DbUser[]> {
      const memberOf = new Map<string, string[]>();
      for (const row of await namedRows(session, MEMBERSHIPS)) {
        const member = textOf(row, 'member_name') ?? '';
        memberOf.set(member, [...(memberOf.get(member) ?? []), textOf(row, 'role_name') ?? '']);
      }
      return (await namedRows(session, ROLES)).map((row): DbUser => {
        const name = textOf(row, 'rolname') ?? '';
        const until = textOf(row, 'rolvaliduntil');
        const flags = [
          ...(yes(row, 'rolsuper') ? ['superuser'] : []),
          ...(yes(row, 'rolcreatedb') ? ['createdb'] : []),
          ...(yes(row, 'rolcreaterole') ? ['createrole'] : []),
          ...(yes(row, 'rolreplication') ? ['replication'] : []),
          ...(until === undefined || until.startsWith('infinity') ? [] : [`until ${until}`]),
        ];
        return { name, login: yes(row, 'rolcanlogin'), flags, memberOf: memberOf.get(name) ?? [] };
      });
    },

    async listGrants(session: Session, user: UserRef): Promise<DbGrant[]> {
      if (cockroach) {
        return await cockroachGrants(session, dialect, user);
      }
      const grants = (await namedRows(session, postgresGrants(dialect.literal(user.name)))).map(
        (row): DbGrant => {
          const level = (textOf(row, 'level') ?? 'table') as GrantLevel;
          const schema = textOf(row, 'schema_name');
          const name = textOf(row, 'object_name');
          return {
            level,
            database: textOf(row, 'database_name') ?? '',
            ...(schema === undefined ? {} : { schema }),
            ...(name === undefined ? {} : { name }),
            privilege: textOf(row, 'privilege_type') ?? '',
            grantable: yes(row, 'is_grantable'),
            // A routine is named with its argument types, which REVOKE needs as written.
            ...(level === 'routine' ? { fixed: true } : {}),
          };
        },
      );
      return [...grants, ...(await roleGrants(session, user))];
    },

    createUser: (user) => {
      const login = user.options.includes('login');
      if (user.password !== '') {
        checkText(user.password, 'password');
      }
      for (const option of user.options) {
        if (!features.createOptions.includes(option)) {
          throw new DbError('unsupported', `"${option}" is not an option of a new role`);
        }
      }
      const options = [
        login ? 'LOGIN' : 'NOLOGIN',
        ...['superuser', 'createdb', 'createrole']
          .filter((option) => user.options.includes(option))
          .map((option) => option.toUpperCase()),
      ];
      return withPassword(user.password, (password) => [
        `CREATE ROLE ${roleName(user)} WITH ${options.join(' ')}${user.password === '' ? '' : ` PASSWORD ${dialect.literal(password)}`}`,
      ]);
    },

    dropUser: (user) => [`DROP ROLE ${roleName(user)}`],

    setPassword: (user, password) => {
      checkText(password, 'password');
      return withPassword(password, (shown) => [
        `ALTER ROLE ${roleName(user)} WITH PASSWORD ${dialect.literal(shown)}`,
      ]);
    },

    grant: (user, change) => {
      if (change.level === 'role') {
        return [
          `GRANT ${quote(change.name, 'role')} TO ${roleName(user)}${change.grantable ? ' WITH ADMIN OPTION' : ''}`,
        ];
      }
      return [
        `GRANT ${privilegeList(features, change)} ON ${target(change)} TO ${roleName(user)}${change.grantable ? ' WITH GRANT OPTION' : ''}`,
      ];
    },

    revoke: (user, change) => {
      if (change.level === 'role') {
        return [`REVOKE ${quote(change.name, 'role')} FROM ${roleName(user)}`];
      }
      change.privileges.forEach(checkPrivilege);
      return change.privileges.length === 0
        ? []
        : [`REVOKE ${change.privileges.join(', ')} ON ${target(change)} FROM ${roleName(user)}`];
    },
  };
}

/** The roles a role is a member of, as grants of the level `role`. */
async function roleGrants(session: Session, user: UserRef): Promise<DbGrant[]> {
  return (await namedRows(session, MEMBERSHIPS))
    .filter((row) => textOf(row, 'member_name') === user.name)
    .map((row) => ({
      level: 'role',
      name: textOf(row, 'role_name') ?? '',
      privilege: 'ROLE',
      grantable: false,
    }));
}

const COCKROACH_LEVELS: Readonly<Record<string, GrantLevel>> = {
  database: 'database',
  schema: 'schema',
  table: 'table',
  sequence: 'sequence',
  function: 'routine',
  routine: 'routine',
};

async function cockroachGrants(
  session: Session,
  dialect: AdminDialect,
  user: UserRef,
): Promise<DbGrant[]> {
  const rows = await namedRows(
    session,
    `SELECT * FROM [SHOW GRANTS FOR ${dialect.quoteIdentifier(user.name)}]`,
  );
  const grants = rows.flatMap((row): DbGrant[] => {
    const level = COCKROACH_LEVELS[(textOf(row, 'object_type') ?? '').toLowerCase()];
    if (level === undefined) {
      return [];
    }
    const database = textOf(row, 'database_name');
    const schema = textOf(row, 'schema_name');
    const name = textOf(row, 'object_name');
    return [
      {
        level,
        ...(database === undefined ? {} : { database }),
        ...(schema === undefined || level === 'database' ? {} : { schema }),
        ...(name === undefined || level === 'database' || level === 'schema' ? {} : { name }),
        privilege: textOf(row, 'privilege_type') ?? '',
        grantable: yes(row, 'is_grantable'),
        ...(level === 'routine' ? { fixed: true } : {}),
      },
    ];
  });
  return [...grants, ...(await roleGrants(session, user))];
}

function yes(row: ReadonlyMap<string, unknown>, name: string): boolean {
  const value = row.get(name);
  return value === true || value === 't' || value === 'true' || value === 1 || value === 'YES';
}
