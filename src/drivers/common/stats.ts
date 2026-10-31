// Reading the numbers and comments of catalog statistics (V10.2.3), whatever type the
// client library hands them over in.

import type { TableStats } from '../../core/model/objects';

/** A count or size: a non-negative finite number; unknown (`-1`, NULL, text) is absent. */
export function statCount(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint' || (typeof value === 'string' && /^\d+(\.\d+)?$/u.test(value))
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

/** A comment worth showing: not empty, not just spaces. */
export function statComment(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** One row of statistics, leaving out what the server does not know. */
export function tableStats(
  name: string,
  rows: unknown,
  bytes: unknown,
  comment: unknown,
): TableStats {
  const rowCount = statCount(rows);
  // No table takes no space: zero is a server that does not know (TiDB), or an empty
  // table of an engine that allocates nothing yet — neither is worth showing.
  const counted = statCount(bytes);
  const size = counted === 0 ? undefined : counted;
  const text = statComment(comment);
  return {
    name,
    ...(rowCount === undefined ? {} : { rows: rowCount }),
    ...(size === undefined ? {} : { bytes: size }),
    ...(text === undefined ? {} : { comment: text }),
  };
}
