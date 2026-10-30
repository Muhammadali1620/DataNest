import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { listSettings, SQLITE_PRAGMAS } from '../../../../src/services/monitor/settings';
import { records, scriptedSession } from '../../../helpers/scripted-session';

describe('listSettings', () => {
  it('reads MySQL session or global variables, sorted by name in any case', async () => {
    const { session, executed } = scriptedSession(() =>
      records([
        { Variable_name: 'wait_timeout', Value: '28800' },
        { Variable_name: 'Autocommit', Value: 'ON' },
        { Variable_name: 'block_encryption_mode', Value: '' },
      ]),
    );
    expect(await listSettings(session, 'mysql', 'session')).toEqual([
      { name: 'Autocommit', value: 'ON' },
      { name: 'block_encryption_mode', value: '' },
      { name: 'wait_timeout', value: '28800' },
    ]);
    await listSettings(session, 'tidb', 'server');
    expect(executed).toEqual(['SHOW SESSION VARIABLES', 'SHOW GLOBAL VARIABLES']);
  });

  it('reads pg_settings with units, descriptions and what was changed', async () => {
    const { session } = scriptedSession(() =>
      records([
        {
          name: 'work_mem',
          setting: '4096',
          unit: 'kB',
          short_desc: 'Memory for sorts.',
          source: 'default',
        },
        {
          name: 'max_connections',
          setting: '100',
          unit: null,
          short_desc: 'Connections.',
          source: 'configuration file',
        },
        {
          name: 'data_checksums',
          setting: 'off',
          unit: null,
          short_desc: null,
          source: 'override',
        },
      ]),
    );
    expect(await listSettings(session, 'postgres', 'session')).toEqual([
      { name: 'data_checksums', value: 'off' },
      { name: 'max_connections', value: '100', description: 'Connections.', changed: true },
      { name: 'work_mem', value: '4096', unit: 'kB', description: 'Memory for sorts.' },
    ]);
  });

  it('reads CockroachDB session variables and cluster settings', async () => {
    const { session, executed } = scriptedSession((sql) =>
      sql === 'SHOW ALL'
        ? records([{ variable: 'application_name', value: '' }])
        : records([
            {
              variable: 'sql.defaults.distsql',
              value: 'auto',
              description: 'default DistSQL mode',
            },
          ]),
    );
    expect(await listSettings(session, 'cockroach', 'session')).toEqual([
      { name: 'application_name', value: '' },
    ]);
    expect(await listSettings(session, 'cockroach', 'server')).toEqual([
      { name: 'sql.defaults.distsql', value: 'auto', description: 'default DistSQL mode' },
    ]);
    expect(executed[1]).toContain('SHOW CLUSTER SETTINGS');
  });

  it('reads SQL Server options of the session and its configuration, pending ones changed', async () => {
    const { session, executed } = scriptedSession((sql) =>
      sql === 'DBCC USEROPTIONS'
        ? records([{ 'Set Option': 'textsize', Value: '2147483647' }])
        : records([
            {
              name: 'max degree of parallelism',
              value_in_use: '0',
              configured: '0',
              description: 'maximum degree',
            },
            {
              name: 'cost threshold for parallelism',
              value_in_use: '5',
              configured: '50',
              description: 'cost',
            },
          ]),
    );
    expect(await listSettings(session, 'mssql', 'session')).toEqual([
      { name: 'textsize', value: '2147483647' },
    ]);
    expect(await listSettings(session, 'mssql', 'server')).toEqual([
      { name: 'cost threshold for parallelism', value: '5', description: 'cost', changed: true },
      { name: 'max degree of parallelism', value: '0', description: 'maximum degree' },
    ]);
    expect(executed[1]).toContain('sys.configurations');
  });

  it('reads ClickHouse settings of the session or the server', async () => {
    const { session, executed } = scriptedSession(() =>
      records([{ name: 'max_threads', value: "'auto(8)'", changed: 1, description: 'threads' }]),
    );
    expect(await listSettings(session, 'clickhouse', 'session')).toEqual([
      { name: 'max_threads', value: "'auto(8)'", description: 'threads', changed: true },
    ]);
    await listSettings(session, 'clickhouse', 'server');
    expect(executed[0]).toContain('system.settings');
    expect(executed[1]).toContain('system.server_settings');
  });

  it('reads Oracle parameters of the session or the system', async () => {
    const { session, executed } = scriptedSession(() =>
      records([
        { NAME: 'processes', VALUE: '300', ISDEFAULT: 'FALSE', DESCRIPTION: 'user processes' },
        { NAME: 'nls_date_format', VALUE: null, ISDEFAULT: 'TRUE', DESCRIPTION: null },
      ]),
    );
    expect(await listSettings(session, 'oracle', 'server')).toEqual([
      { name: 'nls_date_format', value: '' },
      { name: 'processes', value: '300', description: 'user processes', changed: true },
    ]);
    await listSettings(session, 'oracle', 'session');
    expect(executed).toEqual([
      expect.stringContaining('v$system_parameter'),
      expect.stringContaining('FROM v$parameter'),
    ]);
  });

  it('reads each SQLite pragma on its own, skipping those the build lacks', async () => {
    const { session, executed } = scriptedSession((sql) =>
      sql === 'PRAGMA hard_heap_limit'
        ? []
        : sql === 'PRAGMA journal_mode'
          ? records([{ journal_mode: 'wal' }])
          : records([{ value: 1 }]),
    );
    const settings = await listSettings(session, 'sqlite', 'session');
    expect(executed).toHaveLength(SQLITE_PRAGMAS.length);
    expect(settings).toHaveLength(SQLITE_PRAGMAS.length - 1);
    expect(settings.find((one) => one.name === 'journal_mode')).toEqual({
      name: 'journal_mode',
      value: 'wal',
    });
    expect(settings.some((one) => one.name === 'hard_heap_limit')).toBe(false);
  });

  it('drops rows without a name and passes errors on', async () => {
    const empty = scriptedSession(() => records([{ Variable_name: null, Value: 'x' }]));
    expect(await listSettings(empty.session, 'mariadb', 'session')).toEqual([]);
    const failing = scriptedSession(() => new DbError('permission-denied', 'no rights'));
    await expect(listSettings(failing.session, 'oracle', 'session')).rejects.toThrow('no rights');
  });
});
