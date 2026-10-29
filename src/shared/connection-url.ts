// Connection URLs as frameworks and hosting providers print them:
// `postgres://user:pass@host:5432/db?sslmode=require`, `mysql://…`, `sqlite:///file.db`,
// `sqlserver://host;databaseName=db`, with `jdbc:` and SQLAlchemy-style `+driver` prefixes. Shared by the host (commands,
// .env import) and the connection form, which can fill itself from a pasted URL.

import type { ConnectionInput, DriverId, SslMode, SslSettings } from './connection';

export interface ParsedConnectionUrl {
  readonly input: ConnectionInput;
  /** Kept apart from the input: it goes to SecretStorage, never into the config. */
  readonly password?: string;
}

export type UrlProblem = 'not-a-url' | 'unknown-scheme' | 'no-host' | 'no-file';

export type UrlResult =
  | { readonly ok: true; readonly value: ParsedConnectionUrl }
  | { readonly ok: false; readonly problem: UrlProblem };

const SCHEMES: Readonly<Record<string, DriverId>> = {
  mysql: 'mysql',
  mysqlx: 'mysql',
  mariadb: 'mysql',
  postgres: 'postgres',
  postgresql: 'postgres',
  pgsql: 'postgres',
  // CockroachDB and YugabyteDB speak PostgreSQL's protocol (V6.5); SQLAlchemy and other
  // tools name the first by its own scheme.
  cockroachdb: 'postgres',
  cockroach: 'postgres',
  yugabytedb: 'postgres',
  // TiDB speaks MySQL's.
  tidb: 'mysql',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  file: 'sqlite',
  mssql: 'mssql',
  sqlserver: 'mssql',
  clickhouse: 'clickhouse',
  ch: 'clickhouse',
  oracle: 'oracle',
  // `rediss` is Redis over TLS; Valkey is a Redis fork with the same protocol (V7.1).
  redis: 'redis',
  rediss: 'redis',
  valkey: 'redis',
  valkeys: 'redis',
};

/** Schemes that mean TLS by themselves, with the certificate checked. */
const TLS_SCHEMES = new Set(['rediss', 'valkeys']);

/** The driver a URL is for, or undefined when DataNest does not know the scheme. */
export function urlDriver(text: string): DriverId | undefined {
  const match = /^\s*(?:jdbc:)?([a-z][a-z0-9.-]*)(?:\+[a-z0-9_.-]+)?:/i.exec(text);
  return match?.[1] === undefined ? undefined : SCHEMES[match[1].toLowerCase()];
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray "%" is not an escape; keep the text as the user wrote it.
    return text;
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** `sslmode` (libpq, Prisma) and `ssl-mode` (MySQL) map onto our modes. */
const SSL_MODE_NAMES: Readonly<Record<string, SslMode | 'off'>> = {
  disable: 'off',
  disabled: 'off',
  allow: 'off',
  prefer: 'off',
  preferred: 'off',
  require: 'require',
  required: 'require',
  'verify-ca': 'verify-ca',
  verify_ca: 'verify-ca',
  'verify-full': 'verify-full',
  verify_identity: 'verify-full',
};

function sslFrom(params: URLSearchParams): SslSettings | undefined {
  const get = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = nonEmpty(params.get(name));
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };
  const modeText = get('sslmode', 'ssl-mode', 'sslMode', 'ssl_mode')?.toLowerCase();
  let mode: SslMode | 'off' | undefined =
    modeText === undefined ? undefined : SSL_MODE_NAMES[modeText];
  // `secure=true` is how ClickHouse clients ask for HTTPS.
  const ssl = get('ssl', 'tls', 'useSSL', 'secure')?.toLowerCase();
  if (mode === undefined && ssl !== undefined) {
    if (ssl === 'true' || ssl === '1' || ssl === 'require') {
      mode = 'require';
    } else if (ssl.includes('"rejectunauthorized":true')) {
      // mysql2 / PlanetScale style: ssl={"rejectUnauthorized":true}
      mode = 'verify-full';
    } else if (ssl.startsWith('{')) {
      mode = 'require';
    }
  }
  const ca = get('sslrootcert', 'ssl-ca', 'sslca', 'sslcert-ca');
  const cert = get('sslcert', 'ssl-cert');
  const key = get('sslkey', 'ssl-key');
  if (mode === undefined || mode === 'off') {
    return undefined;
  }
  return {
    mode,
    ...(ca === undefined ? {} : { ca: decode(ca) }),
    ...(cert === undefined ? {} : { cert: decode(cert) }),
    ...(key === undefined ? {} : { key: decode(key) }),
  };
}

/** `sqlite:///abs/db`, `sqlite:rel.db`, `file:./dev.db`, `sqlite:///C:/x.db`. */
function sqliteFile(rest: string): string | undefined {
  let path = rest.split(/[?#]/)[0] ?? '';
  if (path.startsWith('//')) {
    path = path.slice(2);
  }
  path = decode(path);
  // `///C:/x.db` leaves "/C:/x.db": a Windows drive keeps no leading slash.
  if (/^\/[A-Za-z]:[\\/]/.test(path)) {
    path = path.slice(1);
  }
  return nonEmpty(path);
}

/** A short name: the database, else the host. */
export function suggestedName(input: ConnectionInput): string {
  if (input.driver === 'sqlite') {
    const file = input.file ?? '';
    return file.split(/[\\/]/).pop() ?? file;
  }
  // A Redis database is a number, which says less than the host.
  if (input.driver === 'redis') {
    return input.host ?? input.driver;
  }
  return input.database ?? input.host ?? input.driver;
}

/**
 * TLS of a Redis URL: `rediss://` checks the certificate, unless the URL turns that off
 * the way Python clients do (`ssl_cert_reqs=none`).
 */
function redisSsl(scheme: string, params: URLSearchParams, ssl: SslSettings | undefined) {
  if (ssl !== undefined || !TLS_SCHEMES.has(scheme)) {
    return ssl;
  }
  const reqs = params.get('ssl_cert_reqs')?.toLowerCase();
  return { mode: reqs === 'none' || reqs === 'cert_none' ? 'require' : 'verify-full' } as const;
}

const SQL_SERVER_HEAD =
  /^(?:([^:@/;]*)(?::([^@/;]*))?@)?([^:/?;\\]+)(?:\\([^:/?;]+))?(?::(\d+))?(?:\/([^?;]*))?(?:\?([^;]*))?$/u;

/**
 * SQL Server URLs come in two shapes: `mssql://user:pass@host:1433/db?encrypt=true`
 * and the JDBC one, `sqlserver://host\\instance:1433;databaseName=db;user=sa;encrypt=true`.
 * Both are read; properties after `;` win over the URL parts.
 */
function sqlServerUrl(plain: string): UrlResult {
  const rest = plain.replace(/^[a-z][a-z0-9.-]*:(?:\/\/)?/iu, '');
  const [head = '', ...pairs] = rest.split(';');
  const match = SQL_SERVER_HEAD.exec(head.trim());
  if (match === null) {
    return { ok: false, problem: head.trim() === '' ? 'no-host' : 'not-a-url' };
  }
  const props = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(match[7] ?? '')) {
    props.set(key.toLowerCase(), value);
  }
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals > 0) {
      props.set(
        pair.slice(0, equals).trim().toLowerCase().replace(/\s+/gu, ''),
        pair.slice(equals + 1).trim(),
      );
    }
  }
  const prop = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = nonEmpty(props.get(name));
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };
  const server = nonEmpty(decode(match[3] ?? ''));
  if (server === undefined) {
    return { ok: false, problem: 'no-host' };
  }
  const instance = prop('instancename') ?? nonEmpty(match[4]);
  const host = instance === undefined ? server : `${server}\\${instance}`;
  const portText = prop('port') ?? match[5];
  const port = portText !== undefined && /^\d+$/u.test(portText) ? Number(portText) : undefined;
  const user = prop('user', 'userid', 'username', 'uid') ?? nonEmpty(decode(match[1] ?? ''));
  const password = prop('password', 'pwd') ?? nonEmpty(decode(match[2] ?? ''));
  const database =
    prop('databasename', 'database', 'initialcatalog') ?? nonEmpty(decode(match[6] ?? ''));
  const encrypt = prop('encrypt')?.toLowerCase();
  const trust = prop('trustservercertificate')?.toLowerCase();
  const ssl: SslSettings | undefined =
    encrypt === 'true' || encrypt === 'yes' || encrypt === 'strict' || encrypt === 'mandatory'
      ? { mode: trust === 'true' || trust === 'yes' ? 'require' : 'verify-full' }
      : undefined;
  const input: ConnectionInput = {
    name: '',
    driver: 'mssql',
    host,
    ...(port === undefined || port < 1 || port > 65_535 ? {} : { port }),
    ...(user === undefined ? {} : { user }),
    ...(database === undefined ? {} : { database }),
    ...(ssl === undefined ? {} : { ssl }),
  };
  return {
    ok: true,
    value: {
      input: { ...input, name: suggestedName(input) },
      ...(password === undefined ? {} : { password }),
    },
  };
}

const ORACLE_REST =
  /^(?:\/\/)?(?:([^:/@]+)(?:[:/]([^@]*))?@)?(?:\/\/)?(\[[^\]]+\]|[^:/@?]+)(?::(\d+))?(?:[/:]([^?/]+))?\/?(?:\?.*)?$/u;

/**
 * Oracle URLs: `oracle://user:pass@host:1521/SERVICE`, the JDBC thin form
 * `oracle:thin:@//host:1521/SERVICE` (or `@host:1521:SID`) and EZConnect
 * `user/pass@host:1521/SERVICE`. The service plays the database.
 */
function oracleUrl(plain: string): UrlResult {
  const rest = plain.replace(/^oracle:(?:thin:)?/iu, '').replace(/^@/u, '');
  const match = ORACLE_REST.exec(rest.trim());
  if (match === null) {
    return { ok: false, problem: rest.trim() === '' ? 'no-host' : 'not-a-url' };
  }
  const host = nonEmpty(decode(match[3] ?? '').replace(/^\[(.*)\]$/u, '$1'));
  if (host === undefined) {
    return { ok: false, problem: 'no-host' };
  }
  const port = match[4] === undefined ? undefined : Number(match[4]);
  const user = nonEmpty(decode(match[1] ?? ''));
  const password = nonEmpty(decode(match[2] ?? ''));
  const database = nonEmpty(decode(match[5] ?? ''));
  const input: ConnectionInput = {
    name: '',
    driver: 'oracle',
    host,
    ...(port === undefined || port < 1 || port > 65_535 ? {} : { port }),
    ...(user === undefined ? {} : { user }),
    ...(database === undefined ? {} : { database }),
  };
  return {
    ok: true,
    value: {
      input: { ...input, name: suggestedName(input) },
      ...(password === undefined ? {} : { password }),
    },
  };
}

/** Reads a connection URL. Unknown query parameters are ignored. */
export function parseConnectionUrl(text: string): UrlResult {
  const trimmed = text.trim();
  const driver = urlDriver(trimmed);
  if (!/^(?:jdbc:)?[a-z][a-z0-9.+-]*:/i.test(trimmed)) {
    return { ok: false, problem: 'not-a-url' };
  }
  if (driver === undefined) {
    return { ok: false, problem: 'unknown-scheme' };
  }
  // Strip `jdbc:` and `+driver`, so the rest parses as one plain URL.
  const plain = trimmed
    .replace(/^jdbc:/i, '')
    .replace(/^([a-z][a-z0-9.-]*)\+[a-z0-9_.-]+:/i, '$1:');
  if (driver === 'sqlite') {
    const file = sqliteFile(plain.slice(plain.indexOf(':') + 1));
    if (file === undefined) {
      return { ok: false, problem: 'no-file' };
    }
    const input: ConnectionInput = { name: '', driver, file };
    return { ok: true, value: { input: { ...input, name: suggestedName(input) } } };
  }
  if (driver === 'mssql') {
    return sqlServerUrl(plain);
  }
  if (driver === 'oracle') {
    return oracleUrl(plain);
  }
  let url: URL;
  try {
    // A scheme the URL parser treats as special would be normalized; ours never are.
    url = new URL(plain.replace(/^[a-z][a-z0-9.-]*:/i, 'datanest:'));
  } catch {
    return { ok: false, problem: 'not-a-url' };
  }
  const params = url.searchParams;
  const host =
    nonEmpty(decode(url.hostname).replace(/^\[(.*)\]$/, '$1')) ?? nonEmpty(params.get('host'));
  if (host === undefined) {
    return { ok: false, problem: 'no-host' };
  }
  const portText = nonEmpty(url.port) ?? nonEmpty(params.get('port'));
  const port = portText !== undefined && /^\d+$/.test(portText) ? Number(portText) : undefined;
  const user = nonEmpty(decode(url.username)) ?? nonEmpty(params.get('user'));
  const password =
    url.password === '' ? (params.get('password') ?? undefined) : decode(url.password);
  const database =
    nonEmpty(decode(url.pathname.replace(/^\//, '').split('/')[0] ?? '')) ??
    nonEmpty(params.get('dbname')) ??
    nonEmpty(params.get('database')) ??
    (driver === 'redis' ? nonEmpty(params.get('db')) : undefined);
  const scheme = /^([a-z][a-z0-9.-]*):/i.exec(plain)?.[1]?.toLowerCase() ?? '';
  const ssl = driver === 'redis' ? redisSsl(scheme, params, sslFrom(params)) : sslFrom(params);
  const input: ConnectionInput = {
    name: '',
    driver,
    host,
    ...(port === undefined || port < 1 || port > 65_535 ? {} : { port }),
    ...(user === undefined ? {} : { user }),
    ...(database === undefined ? {} : { database }),
    ...(ssl === undefined ? {} : { ssl }),
  };
  return {
    ok: true,
    value: {
      input: { ...input, name: suggestedName(input) },
      ...(password === undefined || password === '' ? {} : { password }),
    },
  };
}
