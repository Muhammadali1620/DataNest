// The name of a table's copy beside it (V10.2.3): a suggestion that is free, and the
// reasons a typed one cannot be used.

import type { DriverId } from '../../shared/connection';

/** Longest table name each server keeps whole; PostgreSQL would cut a longer one. */
const NAME_LIMITS: Partial<Record<DriverId, number>> = { postgres: 63, mysql: 64 };
const DEFAULT_NAME_LIMIT = 128;

export function tableNameLimit(driver: DriverId): number {
  return NAME_LIMITS[driver] ?? DEFAULT_NAME_LIMIT;
}

/** `orders_copy`, then `orders_copy2`, … — the first that no table has (in any case). */
export function copyName(name: string, existing: readonly string[], limit: number): string {
  const taken = new Set(existing.map((table) => table.toLowerCase()));
  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? '_copy' : `_copy${attempt}`;
    const candidate = `${name.slice(0, Math.max(1, limit - suffix.length))}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

export type DuplicateNameProblem = 'empty' | 'too-long' | 'taken';

export function duplicateNameProblem(
  name: string,
  existing: readonly string[],
  limit: number,
): DuplicateNameProblem | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'empty';
  }
  if (trimmed.length > limit) {
    return 'too-long';
  }
  const lower = trimmed.toLowerCase();
  return existing.some((table) => table.toLowerCase() === lower) ? 'taken' : undefined;
}
