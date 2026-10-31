// The command-line client of a connection (V10.2.6): `mysql`, `psql`, `sqlite3`,
// `sqlcmd`, `clickhouse client`, `sql` (SQLcl), `redis-cli` or `mongosh`, with the
// arguments that reach the same server. A password goes in an environment variable the
// client reads — never on the command line, which other users of the machine can see —
// or the client asks for it itself.

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  type ConnectionConfig,
  DEFAULT_PORTS,
  effectivePort,
  redisModeOf,
  mongoModeOf,
} from '../shared/connection';

export interface CliCommand {
  /** The program, as found on the PATH. */
  readonly program: string;
  readonly args: readonly string[];
  /** Variables for the client's process only; the password among them when it reads one. */
  readonly env: Readonly<Record<string, string>>;
  /** True when the client asks for the password itself. */
  readonly asksPassword: boolean;
}

/** Where the client should connect: the server, or a local tunnel port in front of it. */
export interface CliEndpoint {
  readonly host: string;
  readonly port: number;
}

/** Programs to look for, in order: the first one on the PATH is used. */
export const CLI_PROGRAMS: Readonly<Record<ConnectionConfig['driver'], readonly string[]>> = {
  mysql: ['mysql', 'mariadb'],
  postgres: ['psql'],
  sqlite: ['sqlite3'],
  mssql: ['sqlcmd'],
  clickhouse: ['clickhouse-client', 'clickhouse'],
  oracle: ['sql', 'sqlplus'],
  redis: ['redis-cli', 'valkey-cli'],
  mongodb: ['mongosh'],
  elasticsearch: [],
};

/** The program's path, looked up like a shell would; undefined when it is not installed. */
export function findOnPath(
  program: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const path = env.PATH ?? env.Path ?? '';
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((ext) => ext !== '')
      : [''];
  for (const dir of path.split(platform === 'win32' ? ';' : delimiter)) {
    if (dir === '') {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(dir, `${program}${extension}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * The command for a connection, given the program to run, where to reach the server and
 * its password. Undefined for a kind of database that has no such client.
 */
export function cliCommand(
  config: ConnectionConfig,
  program: string,
  endpoint: CliEndpoint | undefined,
  password: string | undefined,
): CliCommand | undefined {
  const host = endpoint?.host ?? config.host ?? 'localhost';
  const port = endpoint?.port ?? effectivePort(config) ?? DEFAULT_PORTS[config.driver];
  const socket = endpoint === undefined ? (config.socket?.trim() ?? '') : '';
  const user = config.user?.trim() ?? '';
  const database = config.database?.trim() ?? '';
  const has = (value: string | undefined): value is string => value !== undefined && value !== '';
  const secret = (name: string): Record<string, string> =>
    has(password) ? { [name]: password } : {};
  switch (config.driver) {
    case 'mysql':
      return {
        program,
        args: [
          ...(socket === '' ? ['--host', host, '--port', String(port)] : ['--socket', socket]),
          ...(user === '' ? [] : ['--user', user]),
          ...(config.ssl === undefined
            ? []
            : [
                '--ssl-mode',
                config.ssl.mode === 'require'
                  ? 'REQUIRED'
                  : config.ssl.mode === 'verify-ca'
                    ? 'VERIFY_CA'
                    : 'VERIFY_IDENTITY',
              ]),
          ...(has(config.ssl?.ca) ? ['--ssl-ca', config.ssl.ca] : []),
          ...(database === '' ? [] : [database]),
        ],
        env: secret('MYSQL_PWD'),
        asksPassword: false,
      };
    case 'postgres':
      return {
        program,
        args: [
          '--host',
          socket === '' ? host : socket,
          '--port',
          String(port),
          ...(user === '' ? [] : ['--username', user]),
          '--dbname',
          database === '' ? 'postgres' : database,
        ],
        env: {
          ...secret('PGPASSWORD'),
          ...(config.ssl === undefined ? {} : { PGSSLMODE: config.ssl.mode }),
          ...(has(config.ssl?.ca) ? { PGSSLROOTCERT: config.ssl.ca } : {}),
        },
        asksPassword: false,
      };
    case 'sqlite':
      return { program, args: [config.file ?? ''], env: {}, asksPassword: false };
    case 'mssql': {
      const [server, instance] = host.split('/');
      return {
        program,
        args: [
          '-S',
          instance !== undefined && endpoint === undefined && config.port === undefined
            ? `${server ?? host}\\${instance}`
            : `${server ?? host},${port}`,
          ...(user === '' ? [] : ['-U', user]),
          ...(database === '' ? [] : ['-d', database]),
          ...(config.ssl === undefined ? [] : ['-N']),
          ...(config.ssl !== undefined && config.ssl.mode !== 'verify-full' ? ['-C'] : []),
        ],
        env: secret('SQLCMDPASSWORD'),
        asksPassword: false,
      };
    }
    case 'clickhouse':
      // The client speaks the native protocol, not HTTP: its port is the server's default.
      return {
        program,
        args: [
          ...(program.endsWith('clickhouse') || program.endsWith('clickhouse.exe')
            ? ['client']
            : []),
          '--host',
          host,
          ...(user === '' ? [] : ['--user', user]),
          ...(database === '' ? [] : ['--database', database]),
          ...(config.ssl === undefined ? [] : ['--secure']),
        ],
        env: secret('CLICKHOUSE_PASSWORD'),
        asksPassword: false,
      };
    case 'oracle':
      // SQLcl and SQL*Plus take no password from the environment: they ask.
      return {
        program,
        args: [`${user}@//${host}:${port}${database === '' ? '' : `/${database}`}`],
        env: {},
        asksPassword: true,
      };
    case 'redis':
      if (redisModeOf(config) !== 'standalone') {
        return undefined;
      }
      return {
        program,
        args: [
          ...(socket === '' ? ['-h', host, '-p', String(port)] : ['-s', socket]),
          ...(user === '' ? [] : ['--user', user]),
          ...(database === '' || database === '0' ? [] : ['-n', database]),
          ...(config.ssl === undefined ? [] : ['--tls']),
          ...(has(config.ssl?.ca) ? ['--cacert', config.ssl.ca] : []),
        ],
        env: secret('REDISCLI_AUTH'),
        asksPassword: false,
      };
    case 'mongodb': {
      if (mongoModeOf(config) !== 'direct') {
        return undefined;
      }
      const path = database === '' ? '' : `/${encodeURIComponent(database)}`;
      return {
        program,
        args: [
          `mongodb://${host}:${port}${path}`,
          ...(user === '' ? [] : ['--username', user]),
          ...(has(config.mongo?.authSource)
            ? ['--authenticationDatabase', config.mongo.authSource]
            : []),
          ...(config.ssl === undefined ? [] : ['--tls']),
        ],
        env: {},
        // mongosh asks for the password when a user is given without one.
        asksPassword: user !== '',
      };
    }
    case 'elasticsearch':
      return undefined;
  }
}
