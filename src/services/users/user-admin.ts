// Users and privileges (V8.6): what every server's account manager answers in the same
// shape — the accounts, what each may do, and the statements that change that. Each
// server gets its own implementation; statements are built, never run, here.

import { DbError } from '../../core/errors';
import type { Dialect, Session } from '../../drivers/driver';
import { msg } from '../../core/user-message';

/** An account: a name, and for MySQL the host it may connect from. */
export interface UserRef {
  readonly name: string;
  readonly host?: string;
}

/** An account or a role to drop: some servers drop roles with a statement of their own. */
export interface DropTarget extends UserRef {
  readonly role?: boolean;
}

export interface DbUser extends UserRef {
  /** It may log in (a PostgreSQL role without LOGIN is a group). */
  readonly login: boolean;
  /** A role, not an account (MariaDB roles, ClickHouse and Oracle roles). */
  readonly role?: boolean;
  /** Short facts worth a column: `superuser`, `locked`, `expired`, `users.xml`. */
  readonly flags: readonly string[];
  /** The roles it is a member of. */
  readonly memberOf: readonly string[];
  /** Defined outside SQL (ClickHouse users.xml): it cannot be changed from here. */
  readonly readOnly?: boolean;
}

/** Where a privilege applies, from the whole server down to one object. */
export type GrantLevel =
  'server' | 'database' | 'schema' | 'table' | 'allTables' | 'sequence' | 'routine' | 'role';

export interface GrantTarget {
  readonly level: GrantLevel;
  readonly database?: string;
  readonly schema?: string;
  /** A table, sequence or routine; the role itself for `role`. */
  readonly name?: string;
  /** The host of a MySQL role granted as `role`@`host`. */
  readonly host?: string;
}

/** One privilege the account holds on one target. */
export interface DbGrant extends GrantTarget {
  readonly privilege: string;
  /** It may pass the privilege on (WITH GRANT / ADMIN OPTION). */
  readonly grantable: boolean;
  /** Read from the server but not something a REVOKE here can take back (column grants). */
  readonly fixed?: boolean;
}

export interface GrantChange extends GrantTarget {
  readonly privileges: readonly string[];
  readonly grantable: boolean;
}

export interface NewUser extends UserRef {
  readonly password: string;
  /** Options the server knows: `login`, `superuser`, `createdb`, `createrole`. */
  readonly options: readonly string[];
}

export interface UserAdminFeatures {
  /** Accounts have a host part (MySQL). */
  readonly hosts: boolean;
  /** Tables are named by database (MySQL, ClickHouse) or by schema. */
  readonly tablesIn: 'database' | 'schema';
  /** A new account may have no password (PostgreSQL trust or certificate logins). */
  readonly passwordOptional: boolean;
  /** Options a new account may get, in the order the form shows them. */
  readonly createOptions: readonly string[];
  /** Accounts can be locked and unlocked. */
  readonly lock: boolean;
  /** The levels the grant form offers, and the privileges of each. */
  readonly privileges: Readonly<Partial<Record<GrantLevel, readonly string[]>>>;
}

/** The statements a change takes, and the same with the password hidden for the preview. */
export interface ChangeSql {
  readonly statements: readonly string[];
  readonly preview: readonly string[];
}

export interface UserAdmin {
  readonly features: UserAdminFeatures;
  listUsers(session: Session): Promise<DbUser[]>;
  listGrants(session: Session, user: UserRef): Promise<DbGrant[]>;
  createUser(user: NewUser): ChangeSql;
  dropUser(user: DropTarget): string[];
  setPassword(user: UserRef, password: string): ChangeSql;
  /** Absent where `features.lock` is false. */
  readonly setLocked?: (user: UserRef, locked: boolean) => string[];
  grant(user: UserRef, change: GrantChange): string[];
  revoke(user: UserRef, change: GrantChange): string[];
}

export type AdminDialect = Pick<Dialect, 'quoteIdentifier' | 'literal'>;

/** What the preview shows instead of a password. */
export const PASSWORD_MASK = '********';

/** Builds a change twice: once to run, once to show. */
export function withPassword(
  password: string,
  build: (password: string) => readonly string[],
): ChangeSql {
  return { statements: build(password), preview: build(PASSWORD_MASK) };
}

/** A privilege word as servers print them: letters, digits, `_` and spaces. */
export function checkPrivilege(privilege: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_ ]{0,63}$/u.test(privilege)) {
    throw new DbError('syntax', msg('"{0}" is not a privilege', privilege));
  }
}

/** Rejects names and passwords that no server would take as typed. */
export function checkText(text: string, what: string): void {
  if (text.trim() === '') {
    throw new DbError('syntax', msg('The {0} is empty', what));
  }
  // A NUL or a line break in a name or password is a paste gone wrong, never intended.
  if (text.includes('\u0000') || /[\r\n]/u.test(text)) {
    throw new DbError('syntax', msg('The {0} has a line break or a NUL character', what));
  }
}

/** A name a statement needs, present and sane. */
export function required(value: string | undefined, what: string): string {
  if (value === undefined) {
    throw new DbError('syntax', msg('The {0} is missing', what));
  }
  checkText(value, what);
  return value;
}

/** The privileges of a change as the server spells them, checked against its list. */
export function privilegeList(features: UserAdminFeatures, change: GrantChange): string {
  const known = features.privileges[change.level];
  if (known === undefined) {
    throw new DbError(
      'unsupported',
      msg('Privileges cannot be granted at the level "{0}"', change.level),
    );
  }
  if (change.privileges.length === 0) {
    throw new DbError('syntax', msg('Pick at least one privilege'));
  }
  for (const privilege of change.privileges) {
    if (!known.includes(privilege)) {
      throw new DbError('unsupported', msg('"{0}" is not a privilege of this level', privilege));
    }
  }
  return change.privileges.join(', ');
}
