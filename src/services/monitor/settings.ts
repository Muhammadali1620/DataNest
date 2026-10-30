// Server settings (V8.5): the variables of this session or of the whole server, with
// the unit, description and "changed from the default" where the server tells them.

import type { Session } from '../../drivers/driver';
import type { MonitorServer, SettingScope } from './monitor-server';
import { type NamedRow, namedRows, textOf } from './rows';

export interface ServerSetting {
  readonly name: string;
  readonly value: string;
  readonly unit?: string;
  readonly description?: string;
  /** Set to something other than the built-in default. */
  readonly changed?: boolean;
}

/** The pragmas a SQLite connection reads without changing anything. */
export const SQLITE_PRAGMAS = [
  'application_id',
  'auto_vacuum',
  'automatic_index',
  'busy_timeout',
  'cache_size',
  'cache_spill',
  'cell_size_check',
  'checkpoint_fullfsync',
  'defer_foreign_keys',
  'encoding',
  'foreign_keys',
  'freelist_count',
  'fullfsync',
  'hard_heap_limit',
  'ignore_check_constraints',
  'journal_mode',
  'journal_size_limit',
  'legacy_alter_table',
  'locking_mode',
  'max_page_count',
  'mmap_size',
  'page_count',
  'page_size',
  'query_only',
  'read_uncommitted',
  'recursive_triggers',
  'reverse_unordered_selects',
  'secure_delete',
  'soft_heap_limit',
  'synchronous',
  'temp_store',
  'threads',
  'trusted_schema',
  'user_version',
  'wal_autocheckpoint',
] as const;

export async function listSettings(
  session: Session,
  server: MonitorServer,
  scope: SettingScope,
): Promise<ServerSetting[]> {
  return byName(await read(session, server, scope));
}

async function read(
  session: Session,
  server: MonitorServer,
  scope: SettingScope,
): Promise<ServerSetting[]> {
  switch (server) {
    case 'mysql':
    case 'mariadb':
    case 'tidb': {
      const rows = await namedRows(
        session,
        `SHOW ${scope === 'server' ? 'GLOBAL' : 'SESSION'} VARIABLES`,
      );
      return rows.map((row) => setting(textOf(row, 'variable_name'), textOf(row, 'value')));
    }
    case 'postgres': {
      const rows = await namedRows(
        session,
        'SELECT name, setting, unit, short_desc, source FROM pg_settings',
      );
      return rows.map((row) =>
        setting(textOf(row, 'name'), textOf(row, 'setting'), {
          unit: textOf(row, 'unit'),
          description: textOf(row, 'short_desc'),
          // `override` is a default the server worked out for itself (initdb, build).
          changed: !['default', 'override'].includes(textOf(row, 'source') ?? 'default'),
        }),
      );
    }
    case 'cockroach': {
      if (scope === 'server') {
        const rows = await namedRows(
          session,
          'SELECT variable, value, description FROM [SHOW CLUSTER SETTINGS]',
        );
        return rows.map((row) =>
          setting(textOf(row, 'variable'), textOf(row, 'value'), {
            description: textOf(row, 'description'),
          }),
        );
      }
      const rows = await namedRows(session, 'SHOW ALL');
      return rows.map((row) => setting(textOf(row, 'variable'), textOf(row, 'value')));
    }
    case 'mssql': {
      if (scope === 'server') {
        const rows = await namedRows(
          session,
          `SELECT name, CAST(value_in_use AS nvarchar(100)) AS value_in_use,
             CAST(value AS nvarchar(100)) AS configured, description
           FROM sys.configurations`,
        );
        return rows.map((row) => {
          const value = textOf(row, 'value_in_use');
          const configured = textOf(row, 'configured');
          return setting(textOf(row, 'name'), value, {
            description: textOf(row, 'description'),
            // Configured but waiting for RECONFIGURE or a restart.
            ...(configured === value ? {} : { changed: true }),
          });
        });
      }
      const rows = await namedRows(session, 'DBCC USEROPTIONS');
      return rows.map((row) => setting(textOf(row, 'set option'), textOf(row, 'value')));
    }
    case 'clickhouse': {
      const table = scope === 'server' ? 'system.server_settings' : 'system.settings';
      const rows = await namedRows(
        session,
        `SELECT name, value, changed, description FROM ${table}`,
      );
      return rows.map((row) =>
        setting(textOf(row, 'name'), textOf(row, 'value'), {
          description: textOf(row, 'description'),
          changed: textOf(row, 'changed') === '1',
        }),
      );
    }
    case 'oracle': {
      const view = scope === 'server' ? 'v$system_parameter' : 'v$parameter';
      const rows = await namedRows(
        session,
        `SELECT name, value, isdefault, description FROM ${view}`,
      );
      return rows.map((row) =>
        setting(textOf(row, 'name'), textOf(row, 'value'), {
          description: textOf(row, 'description'),
          changed: textOf(row, 'isdefault') === 'FALSE',
        }),
      );
    }
    case 'sqlite':
      return await sqlitePragmas(session);
  }
}

/** Each pragma on its own: one the build of SQLite lacks answers nothing, not an error. */
async function sqlitePragmas(session: Session): Promise<ServerSetting[]> {
  const settings: ServerSetting[] = [];
  for (const name of SQLITE_PRAGMAS) {
    const [row] = await namedRows(session, `PRAGMA ${name}`);
    if (row !== undefined) {
      settings.push(setting(name, firstText(row)));
    }
  }
  return settings;
}

function firstText(row: NamedRow): string | undefined {
  for (const name of row.keys()) {
    return textOf(row, name);
  }
  return undefined;
}

function setting(
  name: string | undefined,
  value: string | undefined,
  extra: { unit?: string | undefined; description?: string | undefined; changed?: boolean } = {},
): ServerSetting {
  return {
    name: name ?? '',
    value: value ?? '',
    ...(extra.unit === undefined ? {} : { unit: extra.unit }),
    ...(extra.description === undefined ? {} : { description: extra.description }),
    ...(extra.changed === true ? { changed: true } : {}),
  };
}

function byName(settings: readonly ServerSetting[]): ServerSetting[] {
  return settings
    .filter((one) => one.name !== '')
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}
