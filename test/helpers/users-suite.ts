// The checks of users and privileges (V8.6) every real server goes through, as its
// administrator: a new account that logs in with its password, a privilege on a table
// granted and revoked, a role given and taken, locking, a new password, and dropping.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../src/drivers/driver';
import type { MonitorServer } from '../../src/services/monitor/monitor-server';
import type { DbGrant, GrantChange, UserAdmin, UserRef } from '../../src/services/users/user-admin';
import { userAdminFor } from '../../src/services/users/user-admins';
import type { ResolvedConnectionConfig } from '../../src/shared/connection';
import { runAll } from './driver-run';

export interface UsersSuiteOptions {
  readonly label: string;
  readonly driver: () => Driver;
  /** The administrator's connection. */
  readonly config: () => ResolvedConnectionConfig;
  readonly server: MonitorServer;
  /** An account the server starts with, to find in the list. */
  readonly known: string;
  /** Where the seed table `customers` is, as a grant target of the level `table`. */
  readonly table: Pick<GrantChange, 'database' | 'schema' | 'name'>;
  /** A role the suite creates and drops with SQL of its own. */
  readonly role: {
    readonly create: (name: string) => string;
    readonly drop: (name: string) => string;
  };
  /** The new account can log in (CockroachDB in insecure mode takes no passwords). */
  readonly login?: boolean;
  /** The server checks passwords (the YugabyteDB test server trusts every login). */
  readonly passwords?: boolean;
  /** A statement the new account runs once it may read the table. */
  readonly read?: string;
}

async function runEach(session: Session, statements: readonly string[]): Promise<void> {
  for (const sql of statements) {
    await runAll(session, sql);
  }
}

function hasTableGrant(grants: readonly DbGrant[], name: string): boolean {
  return grants.some(
    (grant) =>
      grant.level === 'table' &&
      grant.privilege === 'SELECT' &&
      grant.name?.toLowerCase() === name.toLowerCase(),
  );
}

export function usersSuite(options: UsersSuiteOptions): void {
  describe(`users and privileges on ${options.label}`, () => {
    let session: Session;
    let admin: UserAdmin;
    const suffix = Date.now().toString(36);
    // Oracle writes simple names in capitals.
    const name =
      options.server === 'oracle' ? `DN_USER_${suffix}`.toUpperCase() : `dn_user_${suffix}`;
    const roleName =
      options.server === 'oracle' ? `DN_ROLE_${suffix}`.toUpperCase() : `dn_role_${suffix}`;
    const user: UserRef =
      options.server === 'mysql' || options.server === 'mariadb' || options.server === 'tidb'
        ? { name, host: '%' }
        : { name };
    const login = options.login ?? true;
    const password = 'Dn-Secret-1x';

    const asUser = async (secret: string): Promise<Session> =>
      await options.driver().openSession({
        ...options.config(),
        id: `users-${suffix}`,
        user: name,
        password: secret,
        // A new MySQL account may not open the database before it has a privilege there.
        ...(user.host === undefined ? {} : { database: undefined }),
      });

    beforeAll(async () => {
      session = await options.driver().openSession(options.config());
      admin = userAdminFor(options.server, options.driver().dialect);
      await runAll(session, options.role.create(roleName));
    }, 60_000);

    afterAll(async () => {
      for (const sql of [...admin.dropUser(user), options.role.drop(roleName)]) {
        await runAll(session, sql).catch(() => undefined);
      }
      await session.close();
    });

    it('lists the accounts the server starts with', async () => {
      const users = await admin.listUsers(session);
      expect(users.map((one) => one.name.toLowerCase())).toContain(options.known.toLowerCase());
      expect(users.find((one) => one.name === roleName)?.login).toBe(
        options.server === 'mysql' || options.server === 'tidb' ? true : false,
      );
    });

    it('creates an account that logs in with its password', async () => {
      const create = admin.createUser({
        ...user,
        password: login ? password : '',
        options: admin.features.createOptions.includes('login') ? ['login'] : [],
      });
      expect(create.preview.join('\n')).not.toContain(password);
      await runEach(session, create.statements);
      const listed = (await admin.listUsers(session)).find((one) => one.name === name);
      expect(listed?.login).toBe(true);
      if (login) {
        const own = await asUser(password);
        await own.close();
      }
    });

    it('grants a privilege on a table and revokes it', async () => {
      const change: GrantChange = {
        level: 'table',
        ...options.table,
        privileges: ['SELECT'],
        grantable: false,
      };
      await runEach(session, admin.grant(user, change));
      expect(hasTableGrant(await admin.listGrants(session, user), options.table.name ?? '')).toBe(
        true,
      );
      if (login && options.read !== undefined) {
        const own = await asUser(password);
        try {
          expect((await runAll(own, options.read)).rows.length).toBeGreaterThan(0);
        } finally {
          await own.close();
        }
      }
      await runEach(session, admin.revoke(user, change));
      expect(hasTableGrant(await admin.listGrants(session, user), options.table.name ?? '')).toBe(
        false,
      );
    });

    it('gives a role and takes it back', async () => {
      // MySQL and TiDB roles are accounts with a host; MariaDB roles have none.
      const change: GrantChange = {
        level: 'role',
        name: roleName,
        ...(options.server === 'mysql' || options.server === 'tidb' ? { host: '%' } : {}),
        privileges: [],
        grantable: false,
      };
      await runEach(session, admin.grant(user, change));
      const member = (await admin.listUsers(session)).find((one) => one.name === name);
      expect(member?.memberOf).toContain(roleName);
      expect(
        (await admin.listGrants(session, user)).some(
          (grant) => grant.level === 'role' && grant.name === roleName,
        ),
      ).toBe(true);
      await runEach(session, admin.revoke(user, change));
      expect(
        (await admin.listUsers(session)).find((one) => one.name === name)?.memberOf,
      ).not.toContain(roleName);
    });

    it.runIf(login)('changes the password', async () => {
      const next = 'Dn-Other-2y';
      await runEach(session, admin.setPassword(user, next).statements);
      const own = await asUser(next);
      await own.close();
      if (options.passwords ?? true) {
        await expect(asUser(password)).rejects.toThrow();
      }
    });

    it.runIf(login)('locks and unlocks the account', async () => {
      const setLocked = admin.setLocked;
      if (!admin.features.lock || setLocked === undefined) {
        return;
      }
      await runEach(session, setLocked(user, true));
      expect((await admin.listUsers(session)).find((one) => one.name === name)?.flags).toContain(
        'locked',
      );
      await expect(asUser('Dn-Other-2y')).rejects.toThrow();
      await runEach(session, setLocked(user, false));
      const own = await asUser('Dn-Other-2y');
      await own.close();
    });

    it('drops the account', async () => {
      await runEach(session, admin.dropUser(user));
      expect((await admin.listUsers(session)).some((one) => one.name === name)).toBe(false);
    });
  });
}
