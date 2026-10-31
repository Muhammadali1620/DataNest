// The accounts and roles of a server for the "Security" folder of the tree (V11.12),
// read with the same account manager as the users page.

import { browseSession } from '../browse-session';
import type { ConnectionManager } from '../connection-manager';
import { monitorServerOf } from '../monitor/monitor-server';
import { type DriverId, isSqlDriver } from '../../shared/connection';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import { userAdminFor } from './user-admins';

export interface AccountSummary {
  readonly name: string;
  readonly host?: string;
  readonly login: boolean;
  readonly role: boolean;
  readonly flags: readonly string[];
}

/** True where the server has accounts a client can list (everything SQL but a SQLite file). */
export function hasAccounts(driver: DriverId): boolean {
  return isSqlDriver(driver) && driver !== 'sqlite';
}

export async function listAccounts(
  manager: Pick<ConnectionManager, 'acquire' | 'driverOf'>,
  connectionId: string,
): Promise<AccountSummary[]> {
  const driver = await manager.driverOf(connectionId);
  if (!isSqlDriver(driver.id)) {
    throw new DbError('unsupported', msg('This connection has no accounts'));
  }
  const session = await browseSession(manager, connectionId);
  const server = await monitorServerOf(session, driver.id);
  const users = await userAdminFor(server, driver.dialect).listUsers(session);
  return users.map((user) => ({
    name: user.name,
    ...(user.host === undefined ? {} : { host: user.host }),
    login: user.login,
    role: user.role === true,
    flags: user.flags,
  }));
}
