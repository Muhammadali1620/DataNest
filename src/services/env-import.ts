// Finding connections in .env files: URLs (`DATABASE_URL=postgres://…`) and groups of
// separate variables (`DB_HOST`, `DB_PORT`, … or libpq's `PGHOST`, …). Pure: the
// editor integration reads the files and asks which candidates to add.

import { type ConnectionInput, type DriverId, isFileDriver } from '../shared/connection';
import { parseConnectionUrl, suggestedName, urlDriver } from '../shared/connection-url';

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Replaces `${NAME}`, `${NAME:-fallback}` and `$NAME` with values defined in the file. */
function expand(value: string, vars: ReadonlyMap<string, string>, depth = 0): string {
  if (depth > 10) {
    return value;
  }
  return value.replace(
    /\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
      if (match === '\\$') {
        return '$';
      }
      const name = braced ?? bare ?? '';
      const found = vars.get(name);
      if (found !== undefined && found !== '') {
        return expand(found, vars, depth + 1);
      }
      return fallback === undefined ? '' : expand(fallback, vars, depth + 1);
    },
  );
}

const DOUBLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
};

/**
 * Reads a .env file the way the common loaders do: `KEY=value`, `export KEY=…`,
 * comments, single, double and backtick quotes (which may span lines), escapes in
 * double quotes, and `${VAR}` expansion everywhere but in single quotes.
 */
export function parseDotenv(text: string): Map<string, string> {
  const raw = new Map<string, { value: string; expand: boolean }>();
  const source = text.replace(/\r\n?/g, '\n');
  let index = 0;
  while (index < source.length) {
    const lineEnd = source.indexOf('\n', index);
    const line = source.slice(index, lineEnd === -1 ? source.length : lineEnd);
    const next = lineEnd === -1 ? source.length : lineEnd + 1;
    const match = /^\s*(?:export\s+)?([^=\s#]+)\s*=\s*/.exec(line);
    if (match === null || !KEY.test(match[1] ?? '')) {
      index = next;
      continue;
    }
    const key = match[1] ?? '';
    const valueStart = index + match[0].length;
    const quote = source[valueStart];
    if (quote === '"' || quote === "'" || quote === '`') {
      let end = valueStart + 1;
      let value = '';
      while (end < source.length && source[end] !== quote) {
        const char = source[end] ?? '';
        if (quote === '"' && char === '\\' && end + 1 < source.length) {
          const escaped = source[end + 1] ?? '';
          value += DOUBLE_ESCAPES[escaped] ?? `\\${escaped}`;
          end += 2;
          continue;
        }
        value += char;
        end += 1;
      }
      raw.set(key, { value, expand: quote !== "'" });
      const after = source.indexOf('\n', end);
      index = after === -1 ? source.length : after + 1;
      continue;
    }
    const rest = line.slice(match[0].length);
    // An unquoted value ends at a comment that follows whitespace.
    const comment = rest.search(/\s#/);
    const value = (comment === -1 ? rest : rest.slice(0, comment)).trim();
    raw.set(key, { value: value.startsWith('#') ? '' : value, expand: true });
    index = next;
  }
  const plain = new Map([...raw].map(([key, entry]) => [key, entry.value]));
  return new Map(
    [...raw].map(([key, entry]) => [key, entry.expand ? expand(entry.value, plain) : entry.value]),
  );
}

export interface EnvCandidate {
  readonly input: ConnectionInput;
  readonly password?: string;
  /** The variable (or group, like `DB_*`) it came from. */
  readonly source: string;
}

const SUFFIXES = {
  host: ['HOST', 'HOSTNAME', 'SERVER'],
  port: ['PORT'],
  user: ['USER', 'USERNAME', 'LOGIN'],
  password: ['PASSWORD', 'PASS', 'PWD'],
  database: ['NAME', 'DATABASE', 'DB', 'DBNAME'],
  driver: ['CONNECTION', 'DRIVER', 'ENGINE', 'TYPE', 'DIALECT', 'CLIENT'],
} as const;

function driverFromWord(word: string): DriverId | undefined {
  const text = word.toLowerCase();
  if (text.includes('sqlite')) {
    return 'sqlite';
  }
  if (/postgres|pgsql|(^|[^a-z])pg([^a-z]|$)/.test(text)) {
    return 'postgres';
  }
  if (/mysql|maria/.test(text)) {
    return 'mysql';
  }
  return undefined;
}

/** A group of separate variables sharing a prefix: `DB_HOST`, `DB_PORT`, `DB_USER`, … */
function fromGroup(prefix: string, vars: ReadonlyMap<string, string>): EnvCandidate | undefined {
  const get = (kind: keyof typeof SUFFIXES): string | undefined => {
    for (const suffix of SUFFIXES[kind]) {
      const value = vars.get(`${prefix}${suffix}`)?.trim();
      if (value !== undefined && value !== '') {
        return value;
      }
    }
    return undefined;
  };
  const host = get('host');
  const portText = get('port');
  const port = portText !== undefined && /^\d+$/.test(portText) ? Number(portText) : undefined;
  const named = get('driver');
  const driver =
    (named === undefined ? undefined : driverFromWord(named)) ??
    driverFromWord(prefix) ??
    (port === 5432 ? 'postgres' : port === 3306 ? 'mysql' : undefined);
  if (driver === undefined) {
    return undefined;
  }
  const database = get('database');
  const source = `${prefix}*`;
  if (isFileDriver(driver)) {
    // Laravel: DB_CONNECTION=sqlite with the file in DB_DATABASE.
    if (database === undefined) {
      return undefined;
    }
    const input: ConnectionInput = { name: '', driver, file: database };
    return { input: { ...input, name: suggestedName(input) }, source };
  }
  if (host === undefined) {
    return undefined;
  }
  const user = get('user');
  const password = get('password');
  const input: ConnectionInput = {
    name: '',
    driver,
    host,
    ...(port === undefined || port < 1 || port > 65_535 ? {} : { port }),
    ...(user === undefined ? {} : { user }),
    ...(database === undefined ? {} : { database }),
  };
  return {
    input: { ...input, name: suggestedName(input) },
    ...(password === undefined ? {} : { password }),
    source,
  };
}

/** Two candidates for the same place are one: a URL and the variables it was built from. */
function identity(input: ConnectionInput): string {
  return JSON.stringify([
    input.driver,
    input.host?.toLowerCase(),
    input.port,
    input.user,
    input.database,
    input.file,
  ]);
}

/** Every connection a .env file describes, URLs first, in file order. */
export function connectionsFromEnv(vars: ReadonlyMap<string, string>): EnvCandidate[] {
  const found: EnvCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: EnvCandidate | undefined): void => {
    if (candidate === undefined) {
      return;
    }
    const key = identity(candidate.input);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(candidate);
    }
  };
  for (const [key, value] of vars) {
    if (urlDriver(value) === undefined) {
      continue;
    }
    const parsed = parseConnectionUrl(value);
    if (parsed.ok) {
      add({ ...parsed.value, source: key });
    }
  }
  const prefixes = new Set<string>();
  for (const key of vars.keys()) {
    const upper = key.toUpperCase();
    for (const suffix of [...SUFFIXES.host, ...SUFFIXES.driver]) {
      if (upper.endsWith(suffix) && upper.length > suffix.length) {
        prefixes.add(key.slice(0, key.length - suffix.length));
      }
    }
  }
  for (const prefix of prefixes) {
    add(fromGroup(prefix, vars));
  }
  return found;
}

/** .env files worth reading: not the templates that hold placeholders. */
export function isEnvFileName(name: string): boolean {
  if (!/^\.env(\..+)?$/.test(name)) {
    return false;
  }
  return !/\.(example|sample|template|dist|defaults|schema)$/i.test(name);
}

/** True when a saved connection already points at the same place. */
export function sameTarget(a: ConnectionInput, b: ConnectionInput): boolean {
  return identity(a) === identity(b);
}
