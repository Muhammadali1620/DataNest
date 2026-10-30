// Users and roles of Oracle (V8.6) from the DBA_* views: system privileges, object
// privileges and roles, and the statements that change them. A simple new name is
// written in capitals, as Oracle does with names typed without quotes.

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

const PRIVILEGES: UserAdminFeatures['privileges'] = {
  server: [
    'CREATE SESSION',
    'CREATE TABLE',
    'CREATE VIEW',
    'CREATE SEQUENCE',
    'CREATE PROCEDURE',
    'CREATE TRIGGER',
    'CREATE SYNONYM',
    'CREATE TYPE',
    'UNLIMITED TABLESPACE',
    'SELECT ANY TABLE',
    'INSERT ANY TABLE',
    'UPDATE ANY TABLE',
    'DELETE ANY TABLE',
    'CREATE USER',
    'ALTER USER',
    'DROP USER',
    'CREATE ROLE',
  ],
  table: ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'INDEX', 'REFERENCES', 'READ'],
  role: [],
};

const USERS = `SELECT username, account_status FROM dba_users WHERE oracle_maintained = 'N'`;
const ROLES = `SELECT role FROM dba_roles WHERE oracle_maintained = 'N'`;
const MEMBERS = 'SELECT grantee, granted_role, admin_option FROM dba_role_privs';

/** `app` → `APP`: what Oracle makes of a simple name typed without quotes. */
export function oracleName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_$#]*$/u.test(name) ? name.toUpperCase() : name;
}

export function oracleUserAdmin(dialect: AdminDialect): UserAdmin {
  const features: UserAdminFeatures = {
    tablesIn: 'schema',
    passwordOptional: false,
    hosts: false,
    createOptions: ['login'],
    lock: true,
    privileges: PRIVILEGES,
  };
  const quote = (name: string | undefined, what: string): string =>
    dialect.quoteIdentifier(required(name, what));
  const account = (user: UserRef): string => quote(user.name, 'user name');
  /** Oracle writes a password as a quoted name, so it cannot hold a double quote. */
  const password = (text: string): string => {
    checkText(text, msg('password'));
    if (text.includes('"')) {
      throw new DbError('syntax', msg('An Oracle password cannot contain a double quote'));
    }
    return `"${text}"`;
  };

  return {
    features,

    async listUsers(session: Session): Promise<DbUser[]> {
      const memberOf = new Map<string, string[]>();
      for (const row of await namedRows(session, MEMBERS)) {
        const member = textOf(row, 'grantee') ?? '';
        memberOf.set(member, [...(memberOf.get(member) ?? []), textOf(row, 'granted_role') ?? '']);
      }
      const users = (await namedRows(session, USERS)).map((row): DbUser => {
        const name = textOf(row, 'username') ?? '';
        const status = textOf(row, 'account_status') ?? 'OPEN';
        return {
          name,
          login: true,
          flags: [
            ...(status.includes('LOCKED') ? ['locked'] : []),
            ...(status.includes('EXPIRED') ? ['expired'] : []),
          ],
          memberOf: memberOf.get(name) ?? [],
        };
      });
      const roles = (await namedRows(session, ROLES)).map((row): DbUser => {
        const name = textOf(row, 'role') ?? '';
        return { name, login: false, role: true, flags: [], memberOf: memberOf.get(name) ?? [] };
      });
      return [...users, ...roles];
    },

    async listGrants(session: Session, user: UserRef): Promise<DbGrant[]> {
      const name = dialect.literal(user.name);
      const system = (
        await namedRows(
          session,
          `SELECT privilege, admin_option FROM dba_sys_privs WHERE grantee = ${name}`,
        )
      ).map((row): DbGrant => ({
        level: 'server',
        privilege: textOf(row, 'privilege') ?? '',
        grantable: textOf(row, 'admin_option') === 'YES',
      }));
      const objects = (
        await namedRows(
          session,
          `SELECT owner, table_name, privilege, grantable, type FROM dba_tab_privs WHERE grantee = ${name}`,
        )
      ).map((row): DbGrant => {
        const type = textOf(row, 'type') ?? 'TABLE';
        const table = type === 'TABLE' || type === 'VIEW';
        return {
          level: table ? 'table' : 'routine',
          schema: textOf(row, 'owner') ?? '',
          name: textOf(row, 'table_name') ?? '',
          privilege: textOf(row, 'privilege') ?? '',
          grantable: textOf(row, 'grantable') === 'YES',
          // Packages, types, directories: REVOKE ... ON them is not built here.
          ...(table ? {} : { fixed: true }),
        };
      });
      const roles = (await namedRows(session, `${MEMBERS} WHERE grantee = ${name}`)).map(
        (row): DbGrant => ({
          level: 'role',
          name: textOf(row, 'granted_role') ?? '',
          privilege: 'ROLE',
          grantable: textOf(row, 'admin_option') === 'YES',
        }),
      );
      return [...system, ...objects, ...roles];
    },

    createUser: (user) => {
      const name = dialect.quoteIdentifier(oracleName(required(user.name, msg('user name'))));
      for (const option of user.options) {
        if (!features.createOptions.includes(option)) {
          throw new DbError('unsupported', msg('"{0}" is not an option of a new user', option));
        }
      }
      const login = user.options.includes('login');
      password(user.password);
      return withPassword(user.password, (text) => [
        `CREATE USER ${name} IDENTIFIED BY ${password(text)}`,
        ...(login ? [`GRANT CREATE SESSION TO ${name}`] : []),
      ]);
    },

    dropUser: (user) => [`${user.role === true ? 'DROP ROLE' : 'DROP USER'} ${account(user)}`],

    setPassword: (user, text) => {
      password(text);
      return withPassword(text, (shown) => [
        `ALTER USER ${account(user)} IDENTIFIED BY ${password(shown)}`,
      ]);
    },

    setLocked: (user, locked) => [
      `ALTER USER ${account(user)} ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'}`,
    ],

    grant: (user, change) => {
      if (change.level === 'role') {
        return [
          `GRANT ${quote(change.name, 'role')} TO ${account(user)}${change.grantable ? ' WITH ADMIN OPTION' : ''}`,
        ];
      }
      const list = privilegeList(features, change);
      return [
        change.level === 'server'
          ? `GRANT ${list} TO ${account(user)}${change.grantable ? ' WITH ADMIN OPTION' : ''}`
          : `GRANT ${list} ON ${objectName(change)} TO ${account(user)}${change.grantable ? ' WITH GRANT OPTION' : ''}`,
      ];
    },

    revoke: (user, change) => {
      if (change.level === 'role') {
        return [`REVOKE ${quote(change.name, 'role')} FROM ${account(user)}`];
      }
      change.privileges.forEach(checkPrivilege);
      if (change.privileges.length === 0) {
        return [];
      }
      const list = change.privileges.join(', ');
      return [
        change.level === 'server'
          ? `REVOKE ${list} FROM ${account(user)}`
          : `REVOKE ${list} ON ${objectName(change)} FROM ${account(user)}`,
      ];
    },
  };

  function objectName(change: GrantChange): string {
    if (change.level !== 'table') {
      throw new DbError(
        'unsupported',
        msg('Oracle grants nothing at the level "{0}" here', change.level),
      );
    }
    return `${quote(change.schema, 'schema')}.${quote(change.name, 'table')}`;
  }
}
