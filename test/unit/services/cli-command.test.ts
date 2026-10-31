import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_PROGRAMS, cliCommand, findOnPath } from '../../../src/services/cli-command';
import type { ConnectionConfig } from '../../../src/shared/connection';

function config(overrides: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: 'c',
    name: 'n',
    driver: 'mysql',
    host: 'db',
    user: 'app',
    database: 'shop',
    ...overrides,
  };
}

describe('cliCommand', () => {
  it('runs mysql with the password in MYSQL_PWD, never in the arguments', () => {
    const command = cliCommand(config({ port: 3307 }), '/usr/bin/mysql', undefined, 's3cret');
    expect(command).toEqual({
      program: '/usr/bin/mysql',
      args: ['--host', 'db', '--port', '3307', '--user', 'app', 'shop'],
      env: { MYSQL_PWD: 's3cret' },
      asksPassword: false,
    });
    expect(command?.args.join(' ')).not.toContain('s3cret');
  });

  it('uses the socket and the TLS mode of a MySQL connection', () => {
    expect(
      cliCommand(
        config({ socket: '/run/mysqld.sock', ssl: { mode: 'verify-full', ca: '/ca.pem' } }),
        'mysql',
        undefined,
        undefined,
      )?.args,
    ).toEqual([
      '--socket',
      '/run/mysqld.sock',
      '--user',
      'app',
      '--ssl-mode',
      'VERIFY_IDENTITY',
      '--ssl-ca',
      '/ca.pem',
      'shop',
    ]);
    expect(
      cliCommand(config({ ssl: { mode: 'require' } }), 'mysql', undefined, undefined)?.args,
    ).toContain('REQUIRED');
    expect(
      cliCommand(config({ ssl: { mode: 'verify-ca' } }), 'mysql', undefined, undefined)?.args,
    ).toContain('VERIFY_CA');
  });

  it('goes to the local port of a tunnel instead of the server', () => {
    expect(
      cliCommand(
        config({ socket: '/run/x.sock' }),
        'mysql',
        { host: '127.0.0.1', port: 50_000 },
        undefined,
      )?.args.slice(0, 4),
    ).toEqual(['--host', '127.0.0.1', '--port', '50000']);
  });

  it('runs psql with PGPASSWORD and the TLS mode in its own variables', () => {
    expect(
      cliCommand(
        config({ driver: 'postgres', ssl: { mode: 'verify-ca', ca: '/ca.pem' } }),
        'psql',
        undefined,
        'pw',
      ),
    ).toEqual({
      program: 'psql',
      args: ['--host', 'db', '--port', '5432', '--username', 'app', '--dbname', 'shop'],
      env: { PGPASSWORD: 'pw', PGSSLMODE: 'verify-ca', PGSSLROOTCERT: '/ca.pem' },
      asksPassword: false,
    });
    expect(
      cliCommand(
        config({ driver: 'postgres', database: undefined, socket: '/run/postgresql' }),
        'psql',
        undefined,
        undefined,
      )?.args,
    ).toEqual([
      '--host',
      '/run/postgresql',
      '--port',
      '5432',
      '--username',
      'app',
      '--dbname',
      'postgres',
    ]);
  });

  it('opens the SQLite file', () => {
    expect(
      cliCommand(config({ driver: 'sqlite', file: '/data/a.db' }), 'sqlite3', undefined, undefined),
    ).toEqual({
      program: 'sqlite3',
      args: ['/data/a.db'],
      env: {},
      asksPassword: false,
    });
  });

  it('runs sqlcmd with SQLCMDPASSWORD, an instance by name, and encryption', () => {
    expect(
      cliCommand(config({ driver: 'mssql', host: 'srv/SQLEXPRESS' }), 'sqlcmd', undefined, 'pw'),
    ).toEqual({
      program: 'sqlcmd',
      args: ['-S', 'srv\\SQLEXPRESS', '-U', 'app', '-d', 'shop'],
      env: { SQLCMDPASSWORD: 'pw' },
      asksPassword: false,
    });
    expect(
      cliCommand(
        config({ driver: 'mssql', port: 1444, ssl: { mode: 'require' } }),
        'sqlcmd',
        undefined,
        undefined,
      )?.args,
    ).toEqual(['-S', 'db,1444', '-U', 'app', '-d', 'shop', '-N', '-C']);
    expect(
      cliCommand(
        config({ driver: 'mssql', ssl: { mode: 'verify-full' } }),
        'sqlcmd',
        undefined,
        undefined,
      )?.args,
    ).not.toContain('-C');
  });

  it('runs clickhouse client, alone or as a subcommand, on its native port', () => {
    expect(
      cliCommand(
        config({ driver: 'clickhouse', ssl: { mode: 'require' } }),
        'clickhouse-client',
        undefined,
        'pw',
      ),
    ).toEqual({
      program: 'clickhouse-client',
      args: ['--host', 'db', '--user', 'app', '--database', 'shop', '--secure'],
      env: { CLICKHOUSE_PASSWORD: 'pw' },
      asksPassword: false,
    });
    expect(
      cliCommand(config({ driver: 'clickhouse' }), '/opt/clickhouse', undefined, undefined)
        ?.args[0],
    ).toBe('client');
  });

  it('lets SQLcl ask for the password itself', () => {
    expect(
      cliCommand(
        config({ driver: 'oracle', port: 1522, database: 'ORCL' }),
        'sql',
        undefined,
        'pw',
      ),
    ).toEqual({
      program: 'sql',
      args: ['app@//db:1522/ORCL'],
      env: {},
      asksPassword: true,
    });
  });

  it('runs redis-cli with REDISCLI_AUTH, a socket and a database number', () => {
    expect(
      cliCommand(
        config({ driver: 'redis', database: '3', user: undefined }),
        'redis-cli',
        undefined,
        'pw',
      ),
    ).toEqual({
      program: 'redis-cli',
      args: ['-h', 'db', '-p', '6379', '-n', '3'],
      env: { REDISCLI_AUTH: 'pw' },
      asksPassword: false,
    });
    expect(
      cliCommand(
        config({
          driver: 'redis',
          database: '0',
          socket: '/run/r.sock',
          ssl: { mode: 'require', ca: '/ca' },
        }),
        'redis-cli',
        undefined,
        undefined,
      )?.args,
    ).toEqual(['-s', '/run/r.sock', '--user', 'app', '--tls', '--cacert', '/ca']);
  });

  it('runs mongosh, which asks for the password of a user', () => {
    expect(
      cliCommand(
        config({
          driver: 'mongodb',
          mongo: { mode: 'direct', authSource: 'admin' },
          ssl: { mode: 'require' },
        }),
        'mongosh',
        undefined,
        'pw',
      ),
    ).toEqual({
      program: 'mongosh',
      args: [
        'mongodb://db:27017/shop',
        '--username',
        'app',
        '--authenticationDatabase',
        'admin',
        '--tls',
      ],
      env: {},
      asksPassword: true,
    });
    expect(
      cliCommand(
        config({ driver: 'mongodb', user: undefined, database: undefined }),
        'mongosh',
        undefined,
        undefined,
      )?.asksPassword,
    ).toBe(false);
  });

  it('has nothing for setups a single client cannot reach, nor for Elasticsearch', () => {
    expect(
      cliCommand(
        config({ driver: 'redis', redis: { mode: 'cluster' } }),
        'redis-cli',
        undefined,
        undefined,
      ),
    ).toBeUndefined();
    expect(
      cliCommand(
        config({ driver: 'mongodb', mongo: { mode: 'srv' } }),
        'mongosh',
        undefined,
        undefined,
      ),
    ).toBeUndefined();
    expect(
      cliCommand(config({ driver: 'elasticsearch' }), 'x', undefined, undefined),
    ).toBeUndefined();
    expect(CLI_PROGRAMS.elasticsearch).toEqual([]);
  });

  it('leaves the password out when there is none', () => {
    expect(cliCommand(config({ driver: 'postgres' }), 'psql', undefined, '')?.env).toEqual({});
  });
});

describe('findOnPath', () => {
  it('finds the first directory that has the program', () => {
    const present = new Set([join('/opt/bin', 'psql'), join('/usr/bin', 'psql')]);
    expect(
      findOnPath('psql', { PATH: ['/bin', '/opt/bin', '/usr/bin'].join(':') }, 'linux', (path) =>
        present.has(path),
      ),
    ).toBe(join('/opt/bin', 'psql'));
    expect(findOnPath('mysql', { PATH: '/bin' }, 'linux', () => false)).toBeUndefined();
    expect(findOnPath('mysql', {}, 'linux', () => true)).toBeUndefined();
  });

  it('tries the extensions of PATHEXT on Windows, and reads Path too', () => {
    const present = new Set([join('C:\\pg\\bin', 'psql.EXE')]);
    expect(
      findOnPath('psql', { Path: 'C:\\x;C:\\pg\\bin', PATHEXT: '.COM;.EXE' }, 'win32', (path) =>
        present.has(path),
      ),
    ).toBe(join('C:\\pg\\bin', 'psql.EXE'));
  });
});
