// Checks a name the user typed for a new database, schema or table before any SQL
// is built from it. Quoting makes any name safe; this only catches names the server
// would reject or silently change.

import { type DriverId, isSqlDriver, type SqlDriverId } from '../../shared/connection';

export type IdentifierProblem = 'empty' | 'nul' | 'too-long';

/** The longest name each server keeps as is (PostgreSQL counts bytes and truncates). */
const LIMITS: Readonly<
  Record<SqlDriverId, { readonly max: number; readonly bytes: boolean } | undefined>
> = {
  mysql: { max: 64, bytes: false },
  postgres: { max: 63, bytes: true },
  sqlite: undefined,
  mssql: { max: 128, bytes: false },
  // Names are file names on the server's disk; it allows long ones.
  clickhouse: undefined,
  oracle: { max: 128, bytes: true },
};

export function identifierProblem(name: string, driver: DriverId): IdentifierProblem | undefined {
  if (name.trim() === '') {
    return 'empty';
  }
  if (name.includes('\u0000')) {
    return 'nul';
  }
  const limit = isSqlDriver(driver) ? LIMITS[driver] : undefined;
  if (limit !== undefined) {
    const length = limit.bytes ? new TextEncoder().encode(name).length : Array.from(name).length;
    if (length > limit.max) {
      return 'too-long';
    }
  }
  return undefined;
}

/** The longest name a driver accepts, for the message; undefined means no limit. */
export function identifierLimit(driver: DriverId): number | undefined {
  return isSqlDriver(driver) ? LIMITS[driver]?.max : undefined;
}

/**
 * The name inside a quoted identifier: `"a""b"`, `` `a``b` `` and `[a]]b]` (SQL Server)
 * all give `a"b`, ``a`b``, `a]b`. Text that is not quoted comes back as it is; an
 * unterminated one loses only its opening quote.
 */
export function unquoteIdentifier(raw: string): string {
  const open = raw[0];
  if (open !== '"' && open !== '`' && open !== '[') {
    return raw;
  }
  const close = open === '[' ? ']' : open;
  const inner = raw.slice(1, raw.length > 1 && raw.endsWith(close) ? -1 : undefined);
  return inner.replaceAll(close + close, close);
}
