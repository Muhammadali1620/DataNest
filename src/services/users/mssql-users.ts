// Users of a SQL Server database (V8.6): database users and roles with the logins they
// map to, database permissions and role members, and the statements that change them.
// A new user gets a login of the same name; dropping a user leaves its login, which
// other databases may map to.

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
  privilegeList,
  required,
  type UserAdmin,
  type UserAdminFeatures,
  type UserRef,
  withPassword,
} from './user-admin';

const OBJECT_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REFERENCES',
  'ALTER',
  'VIEW DEFINITION',
  'CONTROL',
];

const PRIVILEGES: UserAdminFeatures['privileges'] = {
  database: [
    'CONNECT',
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'EXECUTE',
    'CREATE TABLE',
    'CREATE VIEW',
    'CREATE PROCEDURE',
    'CREATE FUNCTION',
    'CREATE SCHEMA',
    'ALTER',
    'SHOWPLAN',
    'VIEW DEFINITION',
    'BACKUP DATABASE',
    'CONTROL',
  ],
  schema: [...OBJECT_PRIVILEGES, 'EXECUTE'],
  table: OBJECT_PRIVILEGES,
  role: [],
};

const PRINCIPALS = `SELECT dp.name, dp.type, dp.is_fixed_role, sp.name AS login_name, sp.is_disabled
FROM sys.database_principals AS dp
LEFT JOIN sys.server_principals AS sp ON sp.sid = dp.sid
WHERE dp.type IN ('S', 'U', 'G', 'E', 'X', 'R')
  AND dp.name NOT IN ('guest', 'INFORMATION_SCHEMA', 'sys', 'public')`;

const MEMBERS = `SELECT r.name AS role_name, m.name AS member_name
FROM sys.database_role_members AS rm
JOIN sys.database_principals AS r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals AS m ON m.principal_id = rm.member_principal_id`;

function permissions(user: string): string {
  return `SELECT p.permission_name, p.state_desc, p.class_desc, p.minor_id, DB_NAME() AS database_name,
  CASE p.class_desc WHEN 'SCHEMA' THEN SCHEMA_NAME(p.major_id)
    WHEN 'OBJECT_OR_COLUMN' THEN OBJECT_SCHEMA_NAME(p.major_id) END AS schema_name,
  CASE WHEN p.class_desc = 'OBJECT_OR_COLUMN' THEN OBJECT_NAME(p.major_id) END AS object_name
FROM sys.database_permissions AS p
JOIN sys.database_principals AS dp ON dp.principal_id = p.grantee_principal_id
WHERE dp.name = ${user} AND p.class_desc IN ('DATABASE', 'SCHEMA', 'OBJECT_OR_COLUMN')`;
}

export function mssqlUserAdmin(dialect: AdminDialect): UserAdmin {
  const features: UserAdminFeatures = {
    tablesIn: 'schema',
    passwordOptional: false,
    hosts: false,
    createOptions: [],
    lock: true,
    privileges: PRIVILEGES,
  };
  const quote = (name: string | undefined, what: string): string =>
    dialect.quoteIdentifier(required(name, what));
  const principal = (user: UserRef): string => quote(user.name, 'user name');
  const on = (change: GrantChange): string => {
    switch (change.level) {
      case 'database':
        return '';
      case 'schema':
        return ` ON SCHEMA::${quote(change.schema, 'schema')}`;
      case 'table':
        return ` ON OBJECT::${quote(change.schema, 'schema')}.${quote(change.name, 'table')}`;
      case 'server':
      case 'allTables':
      case 'sequence':
      case 'routine':
      case 'role':
        throw new DbError(
          'unsupported',
          `SQL Server grants nothing at the level "${change.level}" here`,
        );
    }
  };

  return {
    features,

    async listUsers(session: Session): Promise<DbUser[]> {
      const memberOf = new Map<string, string[]>();
      for (const row of await namedRows(session, MEMBERS)) {
        const member = textOf(row, 'member_name') ?? '';
        memberOf.set(member, [...(memberOf.get(member) ?? []), textOf(row, 'role_name') ?? '']);
      }
      return (await namedRows(session, PRINCIPALS)).map((row): DbUser => {
        const name = textOf(row, 'name') ?? '';
        const role = textOf(row, 'type') === 'R';
        const login = textOf(row, 'login_name');
        const flags = role
          ? textOf(row, 'is_fixed_role') === 'true' || textOf(row, 'is_fixed_role') === '1'
            ? ['fixed role']
            : []
          : [
              ...(login === undefined ? ['no login'] : login === name ? [] : [`login ${login}`]),
              ...(textOf(row, 'is_disabled') === 'true' || textOf(row, 'is_disabled') === '1'
                ? ['locked']
                : []),
            ];
        return {
          name,
          login: !role,
          ...(role ? { role: true } : {}),
          flags,
          memberOf: memberOf.get(name) ?? [],
        };
      });
    },

    async listGrants(session: Session, user: UserRef): Promise<DbGrant[]> {
      const grants = (await namedRows(session, permissions(dialect.literal(user.name)))).map(
        (row): DbGrant => {
          const kind = textOf(row, 'class_desc');
          const state = textOf(row, 'state_desc') ?? 'GRANT';
          const name = textOf(row, 'permission_name') ?? '';
          const schema = textOf(row, 'schema_name');
          const object = textOf(row, 'object_name');
          const column = textOf(row, 'minor_id') !== undefined && textOf(row, 'minor_id') !== '0';
          return {
            level: kind === 'DATABASE' ? 'database' : kind === 'SCHEMA' ? 'schema' : 'table',
            database: textOf(row, 'database_name') ?? '',
            ...(schema === undefined ? {} : { schema }),
            ...(object === undefined ? {} : { name: object }),
            privilege: state === 'DENY' ? `DENY ${name}` : name,
            grantable: state === 'GRANT_WITH_GRANT_OPTION',
            ...(state === 'DENY' || column ? { fixed: true } : {}),
          };
        },
      );
      const roles = (await namedRows(session, MEMBERS))
        .filter((row) => textOf(row, 'member_name') === user.name)
        .map((row): DbGrant => ({
          level: 'role',
          name: textOf(row, 'role_name') ?? '',
          privilege: 'ROLE',
          grantable: false,
        }));
      return [...grants, ...roles];
    },

    createUser: (user) => {
      checkText(user.password, 'password');
      const name = principal(user);
      return withPassword(user.password, (password) => [
        `CREATE LOGIN ${name} WITH PASSWORD = ${dialect.literal(password)}`,
        `CREATE USER ${name} FOR LOGIN ${name}`,
      ]);
    },

    dropUser: (user) => [`${user.role === true ? 'DROP ROLE' : 'DROP USER'} ${principal(user)}`],

    setPassword: (user, password) => {
      checkText(password, 'password');
      return withPassword(password, (shown) => [
        `ALTER LOGIN ${principal(user)} WITH PASSWORD = ${dialect.literal(shown)}`,
      ]);
    },

    setLocked: (user, locked) => [
      `ALTER LOGIN ${principal(user)} ${locked ? 'DISABLE' : 'ENABLE'}`,
    ],

    grant: (user, change) => {
      if (change.level === 'role') {
        return [`ALTER ROLE ${quote(change.name, 'role')} ADD MEMBER ${principal(user)}`];
      }
      return [
        `GRANT ${privilegeList(features, change)}${on(change)} TO ${principal(user)}${change.grantable ? ' WITH GRANT OPTION' : ''}`,
      ];
    },

    revoke: (user, change) => {
      if (change.level === 'role') {
        return [`ALTER ROLE ${quote(change.name, 'role')} DROP MEMBER ${principal(user)}`];
      }
      change.privileges.forEach(checkPrivilege);
      // CASCADE also takes back what the user passed on, which SQL Server demands then.
      return change.privileges.length === 0
        ? []
        : [
            `REVOKE ${change.privileges.join(', ')}${on(change)} FROM ${principal(user)}${change.grantable ? ' CASCADE' : ''}`,
          ];
    },
  };
}
