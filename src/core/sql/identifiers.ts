// Checks a name the user typed for a new database, schema or table before any SQL
// is built from it. Quoting makes any name safe; this only catches names the server
// would reject or silently change.

import type { DriverId } from '../../shared/connection';

export type IdentifierProblem = 'empty' | 'nul' | 'too-long';

/** The longest name each server keeps as is (PostgreSQL counts bytes and truncates). */
const LIMITS: Readonly<
  Record<DriverId, { readonly max: number; readonly bytes: boolean } | undefined>
> = {
  mysql: { max: 64, bytes: false },
  postgres: { max: 63, bytes: true },
  sqlite: undefined,
};

export function identifierProblem(name: string, driver: DriverId): IdentifierProblem | undefined {
  if (name.trim() === '') {
    return 'empty';
  }
  if (name.includes('\u0000')) {
    return 'nul';
  }
  const limit = LIMITS[driver];
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
  return LIMITS[driver]?.max;
}
