// Connection URLs as frameworks and hosting providers print them:
// `postgres://user:pass@host:5432/db?sslmode=require`, `mysql://…`, `sqlite:///file.db`,
// with `jdbc:` and SQLAlchemy-style `+driver` prefixes. Shared by the host (commands,
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
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  file: 'sqlite',
};

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
  const ssl = get('ssl', 'tls', 'useSSL')?.toLowerCase();
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
  return input.database ?? input.host ?? input.driver;
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
    nonEmpty(params.get('database'));
  const ssl = sslFrom(params);
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
