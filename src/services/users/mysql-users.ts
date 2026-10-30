// Accounts of MySQL, MariaDB and TiDB (V8.6): `user`@`host` from mysql.user, what each
// may do from SHOW GRANTS, and CREATE / ALTER / DROP USER, GRANT and REVOKE.

import { DbError } from '../../core/errors';
import type { Session } from '../../drivers/driver';
import type { MonitorServer } from '../monitor/monitor-server';
import { namedRows, textOf } from '../monitor/rows';
import { readGrantLine } from './mysql-grants';
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

const TABLE_PRIVILEGES = [
  'ALL PRIVILEGES',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'REFERENCES',
  'TRIGGER',
  'CREATE VIEW',
  'SHOW VIEW',
];

const DATABASE_PRIVILEGES = [
  ...TABLE_PRIVILEGES,
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'EXECUTE',
  'EVENT',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
];

const SERVER_PRIVILEGES = [
  ...DATABASE_PRIVILEGES,
  'PROCESS',
  'RELOAD',
  'SHUTDOWN',
  'FILE',
  'SHOW DATABASES',
  'REPLICATION CLIENT',
  'REPLICATION SLAVE',
  'CREATE USER',
];

/** The columns of mysql.user worth reading; never the password hash. */
const USER_COLUMNS = ['user', 'host', 'account_locked', 'password_expired', 'is_role'];

export function mysqlUserAdmin(server: MonitorServer, dialect: AdminDialect): UserAdmin {
  const features: UserAdminFeatures = {
    tablesIn: 'database',
    passwordOptional: false,
    hosts: true,
    createOptions: [],
    lock: true,
    privileges: {
      server: SERVER_PRIVILEGES,
      database: DATABASE_PRIVILEGES,
      table: TABLE_PRIVILEGES,
      role: [],
    },
  };
  const account = (user: UserRef): string => {
    checkText(user.name, 'user name');
    return `${dialect.literal(user.name)}@${dialect.literal(user.host ?? '%')}`;
  };
  const target = (change: GrantChange): string => {
    switch (change.level) {
      case 'server':
        return '*.*';
      case 'database':
        return `${dialect.quoteIdentifier(required(change.database, 'database'))}.*`;
      case 'table':
        return `${dialect.quoteIdentifier(required(change.database, 'database'))}.${dialect.quoteIdentifier(required(change.name, 'table'))}`;
      case 'allTables':
      case 'role':
      case 'routine':
      case 'schema':
      case 'sequence':
        throw new DbError('unsupported', `MySQL grants nothing at the level "${change.level}"`);
    }
  };
  const role = (change: GrantChange): string => {
    const name = required(change.name, 'role');
    // MariaDB roles have no host; MySQL and TiDB roles are accounts.
    return server === 'mariadb' && change.host === undefined
      ? dialect.literal(name)
      : `${dialect.literal(name)}@${dialect.literal(change.host ?? '%')}`;
  };

  return {
    features,

    async listUsers(session: Session): Promise<DbUser[]> {
      const present = (
        await namedRows(
          session,
          "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME = 'user'",
        )
      ).map((row) => (textOf(row, 'column_name') ?? '').toLowerCase());
      const columns = USER_COLUMNS.filter((name) => present.includes(name));
      const rows = await namedRows(
        session,
        `SELECT ${columns.map((name) => dialect.quoteIdentifier(name)).join(', ')} FROM mysql.user`,
      );
      const memberships = await roleEdges(session, server);
      // MariaDB keeps the lock in the JSON of mysql.global_priv, not in a column.
      const locked = new Set(
        server === 'mariadb'
          ? (
              await namedRows(
                session,
                "SELECT User, Host FROM mysql.global_priv WHERE JSON_VALUE(Priv, '$.account_locked') IN ('1', 'true')",
              )
            ).map((row) => `${textOf(row, 'user') ?? ''}@${textOf(row, 'host') ?? ''}`)
          : [],
      );
      return rows.map((row): DbUser => {
        const name = textOf(row, 'user') ?? '';
        // MariaDB keeps its roles with an empty host.
        const host = row.get('host') === '' ? '' : (textOf(row, 'host') ?? '%');
        const isRole = yes(textOf(row, 'is_role')) || memberships.roles.has(`${name}@${host}`);
        const flags = [
          ...((yes(textOf(row, 'account_locked')) || locked.has(`${name}@${host}`)) && !isRole
            ? ['locked']
            : []),
          ...(yes(textOf(row, 'password_expired')) && !isRole ? ['expired'] : []),
        ];
        return {
          name,
          host,
          login: !isRole,
          ...(isRole ? { role: true } : {}),
          flags,
          memberOf: memberships.of.get(`${name}@${host}`) ?? [],
        };
      });
    },

    async listGrants(session: Session, user: UserRef): Promise<DbGrant[]> {
      const rows = await namedRows(session, `SHOW GRANTS FOR ${account(user)}`);
      return rows.flatMap((row) => readGrantLine([...row.values()].map(String).join('')));
    },

    createUser: (user) => {
      checkText(user.password, 'password');
      return withPassword(user.password, (password) => [
        `CREATE USER ${account(user)} IDENTIFIED BY ${dialect.literal(password)}`,
      ]);
    },

    dropUser: (user) => [
      // A MariaDB role has no host and goes with DROP ROLE.
      server === 'mariadb' && user.role === true && user.host === ''
        ? `DROP ROLE ${dialect.literal(required(user.name, 'role'))}`
        : `DROP USER ${account(user)}`,
    ],

    setPassword: (user, password) => {
      checkText(password, 'password');
      return withPassword(password, (shown) => [
        `ALTER USER ${account(user)} IDENTIFIED BY ${dialect.literal(shown)}`,
      ]);
    },

    setLocked: (user, locked) => [
      `ALTER USER ${account(user)} ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'}`,
    ],

    grant: (user, change) => {
      if (change.level === 'role') {
        return [
          `GRANT ${role(change)} TO ${account(user)}${change.grantable ? ' WITH ADMIN OPTION' : ''}`,
        ];
      }
      return [
        `GRANT ${privilegeList(features, change)} ON ${target(change)} TO ${account(user)}${change.grantable ? ' WITH GRANT OPTION' : ''}`,
      ];
    },

    revoke: (user, change) => {
      if (change.level === 'role') {
        return [`REVOKE ${role(change)} FROM ${account(user)}`];
      }
      // What the server listed may be outside the form's list (dynamic privileges).
      change.privileges.forEach(checkPrivilege);
      if (change.privileges.length === 0) {
        return [];
      }
      return [`REVOKE ${change.privileges.join(', ')} ON ${target(change)} FROM ${account(user)}`];
    },
  };
}

/** Who is a member of which role: MySQL and TiDB keep role edges, MariaDB a mapping. */
async function roleEdges(
  session: Session,
  server: MonitorServer,
): Promise<{ of: Map<string, string[]>; roles: Set<string> }> {
  const of = new Map<string, string[]>();
  const roles = new Set<string>();
  const add = (member: string, role: string, roleKey: string): void => {
    of.set(member, [...(of.get(member) ?? []), role]);
    roles.add(roleKey);
  };
  if (server === 'mariadb') {
    for (const row of await namedRows(
      session,
      'SELECT User, Host, Role FROM mysql.roles_mapping',
    )) {
      const role = textOf(row, 'role') ?? '';
      add(`${textOf(row, 'user') ?? ''}@${textOf(row, 'host') ?? ''}`, role, `${role}@`);
    }
    return { of, roles };
  }
  for (const row of await namedRows(
    session,
    'SELECT FROM_USER, FROM_HOST, TO_USER, TO_HOST FROM mysql.role_edges',
  )) {
    const role = textOf(row, 'from_user') ?? '';
    const roleHost = textOf(row, 'from_host') ?? '%';
    add(
      `${textOf(row, 'to_user') ?? ''}@${textOf(row, 'to_host') ?? '%'}`,
      role,
      `${role}@${roleHost}`,
    );
  }
  return { of, roles };
}

function yes(text: string | undefined): boolean {
  return text === 'Y' || text === 'y' || text === '1';
}
