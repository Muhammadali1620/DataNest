// The account manager of each server (V8.6); a SQLite file has no accounts.

import { DbError } from '../../core/errors';
import type { MonitorServer } from '../monitor/monitor-server';
import { clickhouseUserAdmin } from './clickhouse-users';
import { mssqlUserAdmin } from './mssql-users';
import { mysqlUserAdmin } from './mysql-users';
import { oracleUserAdmin } from './oracle-users';
import { postgresUserAdmin } from './postgres-users';
import type { AdminDialect, UserAdmin } from './user-admin';
import { msg } from '../../core/user-message';

export function userAdminFor(server: MonitorServer, dialect: AdminDialect): UserAdmin {
  switch (server) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
      return mysqlUserAdmin(server, dialect);
    case 'postgres':
      return postgresUserAdmin(false, dialect);
    case 'cockroach':
      return postgresUserAdmin(true, dialect);
    case 'mssql':
      return mssqlUserAdmin(dialect);
    case 'clickhouse':
      return clickhouseUserAdmin(dialect);
    case 'oracle':
      return oracleUserAdmin(dialect);
    case 'sqlite':
      throw new DbError('unsupported', msg('A SQLite file has no users'));
  }
}
