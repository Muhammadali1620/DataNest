// ClickHouse values as CellValue (ARCHITECTURE.md §5). The server writes the result as
// JSON with 64-bit integers and decimals quoted, so nothing passes through a JS number
// that does not fit one; the column's type says what each JSON value means.

import { clickhouseBareType } from '../../shared/clickhouse-types';
import type { CellValue } from '../../shared/cell-value';
import { safeIntOrTag } from '../common/values';

const BIG_INTEGER = /^u?int(64|128|256)$/u;

/** Non-finite floats come quoted: `nan`, `inf`, `-inf`. */
function floatOf(text: string): number {
  switch (text.toLowerCase()) {
    case 'nan':
    case '-nan':
      return Number.NaN;
    case 'inf':
    case '+inf':
      return Number.POSITIVE_INFINITY;
    case '-inf':
      return Number.NEGATIVE_INFINITY;
    default:
      return Number(text);
  }
}

/**
 * A JSON value in ClickHouse's own text form: `[1, 'a']`, `{'k': 1}`, `('x', 7)` for a
 * tuple. The server parses a string of this form into an Array, Map or Tuple column,
 * which a JSON string it does not.
 */
export function clickhouseText(value: unknown, tuple = false): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => clickhouseText(item)).join(', ');
    return tuple ? `(${items})` : `[${items}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${clickhouseText(key)}: ${clickhouseText(item)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** Normalizes one JSON value of a column of the given ClickHouse type. */
export function toCellValue(value: unknown, dataType: string): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  const type = clickhouseBareType(dataType).toLowerCase();
  if (typeof value === 'string') {
    if (BIG_INTEGER.test(type)) {
      return safeIntOrTag(value);
    }
    if (type.startsWith('float') || type === 'bfloat16') {
      return floatOf(value);
    }
    if (type.startsWith('decimal')) {
      return { kind: 'decimal', text: value };
    }
    if (type.startsWith('date') || type === 'time' || type.startsWith('time64')) {
      return { kind: 'datetime', text: value };
    }
    return value;
  }
  if (typeof value === 'number') {
    return BIG_INTEGER.test(type) ? safeIntOrTag(String(value)) : value;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  // A tuple arrives as a JSON array, which would read back as an Array: it is shown,
  // and written back, as the tuple it is.
  if (type.startsWith('tuple(') && Array.isArray(value)) {
    return clickhouseText(value, true);
  }
  // Arrays, maps, JSON: shown as the JSON text they arrived as.
  return { kind: 'json', text: JSON.stringify(value) };
}
