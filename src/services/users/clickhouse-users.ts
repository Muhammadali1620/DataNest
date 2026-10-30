// Users and roles of ClickHouse (V8.6) from system.users, system.roles and
// system.grants. Users of users.xml are shown but cannot be changed with SQL.

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
import { msg } from '../../core/user-message';

const TABLE = ['ALL', 'SELECT', 'INSERT', 'ALTER', 'DROP', 'TRUNCATE', 'OPTIMIZE', 'SHOW'];
const DATABASE = [...TABLE, 'CREATE'];

const PRIVILEGES: UserAdminFeatures['privileges'] = {
  server: [...DATABASE, 'KILL QUERY', 'SYSTEM', 'ACCESS MANAGEMENT'],
  database: DATABASE,
  table: TABLE,
  role: [],
};

/** Storages whose users and roles live in files, not in what SQL changes. */
const FILE_STORAGES = new Set(['users.xml', 'users_xml']);

export function clickhouseUserAdmin(dialect: AdminDialect): UserAdmin {
  const features: UserAdminFeatures = {
    tablesIn: 'database',
    passwordOptional: false,
    hosts: false,
    createOptions: [],
    lock: false,
    privileges: PRIVILEGES,
  };
  const quote = (name: string | undefined, what: string): string =>
    dialect.quoteIdentifier(required(name, what));
  const account = (user: UserRef): string => quote(user.name, 'user name');
  const target = (change: GrantChange): string => {
    switch (change.level) {
      case 'server':
        return '*.*';
      case 'database':
        return `${quote(change.database, 'database')}.*`;
      case 'table':
        return `${quote(change.database, 'database')}.${quote(change.name, 'table')}`;
      case 'allTables':
      case 'role':
      case 'routine':
      case 'schema':
      case 'sequence':
        throw new DbError(
          'unsupported',
          msg('ClickHouse grants nothing at the level "{0}"', change.level),
        );
    }
  };

  return {
    features,

    async listUsers(session: Session): Promise<DbUser[]> {
      const memberOf = new Map<string, string[]>();
      for (const row of await namedRows(
        session,
        'SELECT user_name, role_name, granted_role_name FROM system.role_grants',
      )) {
        const member = textOf(row, 'user_name') ?? textOf(row, 'role_name') ?? '';
        memberOf.set(member, [
          ...(memberOf.get(member) ?? []),
          textOf(row, 'granted_role_name') ?? '',
        ]);
      }
      const users = (
        await namedRows(
          session,
          'SELECT name, storage, toString(auth_type) AS auth FROM system.users',
        )
      ).map((row): DbUser => {
        const name = textOf(row, 'name') ?? '';
        const storage = textOf(row, 'storage') ?? '';
        const file = FILE_STORAGES.has(storage);
        return {
          name,
          login: true,
          flags: file ? ['users.xml'] : [],
          memberOf: memberOf.get(name) ?? [],
          ...(file ? { readOnly: true } : {}),
        };
      });
      const roles = (await namedRows(session, 'SELECT name, storage FROM system.roles')).map(
        (row): DbUser => {
          const name = textOf(row, 'name') ?? '';
          const file = FILE_STORAGES.has(textOf(row, 'storage') ?? '');
          return {
            name,
            login: false,
            role: true,
            flags: file ? ['users.xml'] : [],
            memberOf: memberOf.get(name) ?? [],
            ...(file ? { readOnly: true } : {}),
          };
        },
      );
      return [...users, ...roles];
    },

    async listGrants(session: Session, user: UserRef): Promise<DbGrant[]> {
      const name = dialect.literal(user.name);
      const grants = (
        await namedRows(
          session,
          `SELECT access_type, database, table, column, is_partial_revoke, grant_option
           FROM system.grants WHERE user_name = ${name} OR role_name = ${name}`,
        )
      ).map((row): DbGrant => {
        const database = textOf(row, 'database');
        const table = textOf(row, 'table');
        const column = textOf(row, 'column');
        const partial = textOf(row, 'is_partial_revoke') === '1';
        const access = textOf(row, 'access_type') ?? '';
        return {
          level: database === undefined ? 'server' : table === undefined ? 'database' : 'table',
          ...(database === undefined ? {} : { database }),
          ...(table === undefined ? {} : { name: table }),
          privilege: `${partial ? 'REVOKE ' : ''}${access}${column === undefined ? '' : ` (${column})`}`,
          grantable: textOf(row, 'grant_option') === '1',
          ...(partial || column !== undefined ? { fixed: true } : {}),
        };
      });
      const roles = (
        await namedRows(
          session,
          `SELECT granted_role_name, with_admin_option FROM system.role_grants
           WHERE user_name = ${name} OR role_name = ${name}`,
        )
      ).map((row): DbGrant => ({
        level: 'role',
        name: textOf(row, 'granted_role_name') ?? '',
        privilege: 'ROLE',
        grantable: textOf(row, 'with_admin_option') === '1',
      }));
      return [...grants, ...roles];
    },

    createUser: (user) => {
      checkText(user.password, msg('password'));
      return withPassword(user.password, (password) => [
        `CREATE USER ${account(user)} IDENTIFIED BY ${dialect.literal(password)}`,
      ]);
    },

    dropUser: (user) => [`${user.role === true ? 'DROP ROLE' : 'DROP USER'} ${account(user)}`],

    setPassword: (user, password) => {
      checkText(password, msg('password'));
      return withPassword(password, (shown) => [
        `ALTER USER ${account(user)} IDENTIFIED BY ${dialect.literal(shown)}`,
      ]);
    },

    grant: (user, change) => {
      if (change.level === 'role') {
        return [
          `GRANT ${quote(change.name, 'role')} TO ${account(user)}${change.grantable ? ' WITH ADMIN OPTION' : ''}`,
        ];
      }
      return [
        `GRANT ${privilegeList(features, change)} ON ${target(change)} TO ${account(user)}${change.grantable ? ' WITH GRANT OPTION' : ''}`,
      ];
    },

    revoke: (user, change) => {
      if (change.level === 'role') {
        return [`REVOKE ${quote(change.name, 'role')} FROM ${account(user)}`];
      }
      change.privileges.forEach(checkPrivilege);
      return change.privileges.length === 0
        ? []
        : [`REVOKE ${change.privileges.join(', ')} ON ${target(change)} FROM ${account(user)}`];
    },
  };
}
