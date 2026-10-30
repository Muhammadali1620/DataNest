// What the users and privileges page (V8.6) shows, free of `vscode`: the server and its
// account manager, accounts and grants, names to suggest, and changes as statements —
// shown with passwords hidden, run one after another on the page's own session.

import { DbError, errorMessage } from '../../core/errors';
import type { Dialect, Session } from '../../drivers/driver';
import { resultSets } from '../../services/explain/explain';
import {
  type MonitorServer,
  monitorServerOf,
  SERVER_NAMES,
} from '../../services/monitor/monitor-server';
import {
  type ChangeSql,
  type DbGrant,
  type DbUser,
  type GrantLevel,
  type UserAdmin,
  type UserRef,
} from '../../services/users/user-admin';
import { userAdminFor } from '../../services/users/user-admins';
import type { SqlDriverId } from '../../shared/connection';
import type {
  AdminChange,
  AdminGrant,
  AdminUser,
  UserAdminState,
} from '../../shared/protocols/user-admin';

export interface UserAdminModelDeps {
  readonly connectionName: string;
  /** The database the session works in, shown where privileges depend on it. */
  readonly database?: string;
  readonly driver: SqlDriverId;
  readonly dialect: Pick<Dialect, 'quoteIdentifier' | 'literal'>;
  readonly readOnly: boolean;
  readonly session: () => Promise<Session>;
}

/** The order the grant form offers levels in. */
const LEVEL_ORDER: readonly GrantLevel[] = [
  'server',
  'database',
  'schema',
  'allTables',
  'table',
  'sequence',
  'role',
];

export class UserAdminModel {
  private server: MonitorServer | undefined;
  private admin: UserAdmin | undefined;
  private error: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: UserAdminModelDeps) {}

  get started(): boolean {
    return this.admin !== undefined || this.error !== undefined;
  }

  /** Finds out the server; a failure, or a server without accounts, shows on the page. */
  async start(): Promise<void> {
    try {
      const server = await this.exclusive(async () =>
        monitorServerOf(await this.deps.session(), this.deps.driver),
      );
      this.server = server;
      this.admin = userAdminFor(server, this.deps.dialect);
      this.error = undefined;
    } catch (error) {
      this.error = errorMessage(error);
    }
  }

  state(): UserAdminState {
    const admin = this.admin;
    const server = this.server;
    return {
      connectionName: this.deps.connectionName,
      readOnly: this.deps.readOnly,
      ...(server === undefined ? {} : { server: SERVER_NAMES[server] }),
      ...(this.deps.database === undefined ? {} : { database: this.deps.database }),
      ...(admin === undefined
        ? {}
        : {
            features: {
              hosts: admin.features.hosts,
              tablesIn: admin.features.tablesIn,
              passwordOptional: admin.features.passwordOptional,
              createOptions: [...admin.features.createOptions],
              lock: admin.features.lock,
              levels: LEVEL_ORDER.flatMap((level) => {
                const privileges = admin.features.privileges[level];
                return privileges === undefined ? [] : [{ level, privileges: [...privileges] }];
              }),
            },
          }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  async users(): Promise<AdminUser[]> {
    const admin = this.known();
    const users = await this.exclusive(async () => admin.listUsers(await this.deps.session()));
    return [...users].sort(byName).map((user) => toAdminUser(user));
  }

  async grants(user: UserRef): Promise<AdminGrant[]> {
    const admin = this.known();
    return (
      await this.exclusive(async () => admin.listGrants(await this.deps.session(), user))
    ).map((grant) => toAdminGrant(grant));
  }

  /** Names for the grant form: databases, schemas of one, tables of one schema. */
  async objects(
    kind: 'database' | 'schema' | 'table',
    database?: string,
    schema?: string,
  ): Promise<string[]> {
    this.known();
    return await this.exclusive(async () => {
      const { metadata } = await this.deps.session();
      switch (kind) {
        case 'database':
          return await metadata.listDatabases();
        case 'schema':
          return await metadata.listSchemas(database);
        case 'table':
          return (
            await metadata.listTables({
              ...(database === undefined ? {} : { database }),
              ...(schema === undefined ? {} : { schema }),
            })
          ).map((table) => table.name);
      }
    });
  }

  /** The statements of a change, and the same with passwords hidden. */
  statements(change: AdminChange): ChangeSql {
    const admin = this.known();
    const user: UserRef = {
      name: change.user.name,
      ...(change.user.host === undefined ? {} : { host: change.user.host }),
    };
    const plain = (statements: readonly string[]): ChangeSql => ({
      statements,
      preview: statements,
    });
    switch (change.kind) {
      case 'create':
        return admin.createUser({
          ...user,
          password: change.password ?? '',
          options: change.options ?? [],
        });
      case 'drop':
        return plain(admin.dropUser({ ...user, ...(change.role === true ? { role: true } : {}) }));
      case 'password':
        return admin.setPassword(user, change.password ?? '');
      case 'lock':
      case 'unlock': {
        const setLocked = admin.setLocked;
        if (!admin.features.lock || setLocked === undefined) {
          throw new DbError('unsupported', 'Accounts of this server cannot be locked');
        }
        return plain(setLocked(user, change.kind === 'lock'));
      }
      case 'grant':
      case 'revoke': {
        const target = change.target;
        if (target === undefined) {
          throw new DbError('syntax', 'The grant has no target');
        }
        const grant = {
          level: target.level,
          ...(target.database === undefined || target.database === ''
            ? {}
            : { database: target.database }),
          ...(target.schema === undefined || target.schema === '' ? {} : { schema: target.schema }),
          ...(target.name === undefined || target.name === '' ? {} : { name: target.name }),
          ...(target.host === undefined || target.host === '' ? {} : { host: target.host }),
          privileges: change.privileges ?? [],
          grantable: change.grantable === true,
        };
        return plain(
          change.kind === 'grant' ? admin.grant(user, grant) : admin.revoke(user, grant),
        );
      }
    }
  }

  /** The change holds a password, so it must not be written to an editor. */
  static hasPassword(change: AdminChange): boolean {
    return change.kind === 'create' || change.kind === 'password'
      ? (change.password ?? '') !== ''
      : false;
  }

  /**
   * Runs the statements of a change one after another; the caller has asked the user.
   * A failure names the statement it stopped at, as the ones before it did run.
   */
  async run(change: AdminChange): Promise<number> {
    if (this.deps.readOnly) {
      throw new DbError(
        'permission-denied',
        'The connection is read-only, so DataNest changes no account on it',
      );
    }
    const { statements } = this.statements(change);
    if (statements.length === 0) {
      throw new DbError('syntax', 'There is nothing to run');
    }
    return await this.exclusive(async () => {
      const session = await this.deps.session();
      for (const [index, sql] of statements.entries()) {
        try {
          await resultSets(session, sql);
        } catch (error) {
          if (index === 0) {
            throw error;
          }
          throw new DbError(
            isDbErrorCode(error),
            `${errorMessage(error)} (statement ${index + 1} of ${statements.length}; the ones before it ran)`,
            { cause: error },
          );
        }
      }
      return statements.length;
    });
  }

  private known(): UserAdmin {
    if (this.admin === undefined) {
      throw new DbError('busy', this.error ?? 'The page is still connecting');
    }
    return this.admin;
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return await run;
  }
}

function isDbErrorCode(error: unknown): DbError['code'] {
  return error instanceof DbError ? error.code : 'internal';
}

function byName(a: DbUser, b: DbUser): number {
  return (
    Number(a.role === true) - Number(b.role === true) ||
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    (a.host ?? '').localeCompare(b.host ?? '')
  );
}

function toAdminUser(user: DbUser): AdminUser {
  return {
    name: user.name,
    ...(user.host === undefined ? {} : { host: user.host }),
    login: user.login,
    ...(user.role === true ? { role: true } : {}),
    flags: [...user.flags],
    memberOf: [...user.memberOf],
    ...(user.readOnly === true ? { readOnly: true } : {}),
  };
}

function toAdminGrant(grant: DbGrant): AdminGrant {
  return {
    level: grant.level,
    ...(grant.database === undefined ? {} : { database: grant.database }),
    ...(grant.schema === undefined ? {} : { schema: grant.schema }),
    ...(grant.name === undefined ? {} : { name: grant.name }),
    ...(grant.host === undefined ? {} : { host: grant.host }),
    privilege: grant.privilege,
    grantable: grant.grantable,
    ...(grant.fixed === true ? { fixed: true } : {}),
  };
}
