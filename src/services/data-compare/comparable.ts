// Values made comparable across databases (V8.4): `10.50` from MySQL and `10.5` from
// PostgreSQL are the same number, `true` and `1` the same flag, `2024-01-02T08:00:00Z`
// and `2024-01-02 08:00:00` the same moment, JSON objects equal whatever their key
// order. Strings stay exact: collations differ, and a difference in case is real.

import { retainedBytes } from '../../shared/binary-bytes';
import type { CellValue } from '../../shared/cell-value';

/**
 * How a column's values compare, from its type on either side: a database without a
 * JSON or date type (SQLite) keeps them as text, which must then be read as one.
 */
export type ColumnMode = 'plain' | 'json' | 'datetime';

/** Stands for NULL; no text a database returns starts with this character. */
const NULL_TEXT = '\u0000';

export function comparableText(cell: CellValue, mode: ColumnMode = 'plain'): string {
  if (cell === null) {
    return NULL_TEXT;
  }
  if (typeof cell === 'string' && mode === 'json') {
    return `j${canonicalJson(cell)}`;
  }
  if (typeof cell === 'string' && mode === 'datetime') {
    return `d${canonicalDateTime(cell)}`;
  }
  if (typeof cell === 'boolean') {
    return cell ? 'n1' : 'n0';
  }
  if (typeof cell === 'number') {
    return canonicalNumber(String(cell));
  }
  if (typeof cell === 'string') {
    return `s${cell}`;
  }
  switch (cell.kind) {
    case 'bigint':
    case 'decimal':
      return canonicalNumber(cell.text);
    case 'datetime':
      return `d${canonicalDateTime(cell.text)}`;
    case 'json':
      return `j${canonicalJson(cell.text)}`;
    case 'binary': {
      const bytes = retainedBytes(cell);
      return `b${bytes === undefined ? `${cell.size}:${cell.preview}` : Buffer.from(bytes).toString('hex')}`;
    }
  }
}

/**
 * `010.500` → `10.5`, `-0` → `0`, `1e3` → `1000`; text that is not a number stays as
 * it is, so it never equals a number by accident.
 */
export function canonicalNumber(text: string): string {
  const trimmed = text.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(trimmed);
  if (match === null || (match[2] === '' && (match[3] ?? '') === '')) {
    return `s${text}`;
  }
  const sign = match[1] === '-' ? '-' : '';
  let digits = `${match[2] ?? ''}${match[3] ?? ''}`;
  let point = (match[2] ?? '').length + Number(match[4] ?? '0');
  // Leading zeros move the point; trailing ones after it mean nothing.
  const leading = /^0*/u.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(leading);
  point -= leading;
  digits = digits.replace(/0+$/u, '');
  if (digits === '') {
    return 'n0';
  }
  let integer: string;
  let fraction: string;
  if (point <= 0) {
    integer = '0';
    fraction = `${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    integer = `${digits}${'0'.repeat(point - digits.length)}`;
    fraction = '';
  } else {
    integer = digits.slice(0, point);
    fraction = digits.slice(point);
  }
  return `n${sign}${integer}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * `2024-01-02T08:00:00.000Z` → `2024-01-02 08:00:00`: the separator, zero fractions
 * and a UTC zone are spellings, not differences. Other zones are kept.
 */
export function canonicalDateTime(text: string): string {
  let value = text.trim().replace(/^(\d{4}-\d{2}-\d{2})T/u, '$1 ');
  value = value.replace(/(?:Z|[+-]00(?::?00)?| UTC)$/u, '');
  value = value.replace(/(\.\d*?)0+(?=$|[+-]\d)/u, '$1').replace(/\.(?=$|[+-]\d)/u, '');
  return value;
}

/** JSON with object keys sorted and no spaces; text that does not parse stays as it is. */
export function canonicalJson(text: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    // Not JSON after all (a database's own spelling): compared as text.
    return text;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/** Between the values of a key; escaped inside them, so keys never run together. */
const KEY_SEPARATOR = '\u0001';

/** A row key: the comparable texts of the key columns, unambiguously joined. */
export function keyOf(cells: readonly CellValue[], modes: readonly ColumnMode[] = []): string {
  return cells
    .map((cell, index) =>
      comparableText(cell, modes[index]).replaceAll('\\', '\\\\').replaceAll(KEY_SEPARATOR, '\\1'),
    )
    .join(KEY_SEPARATOR);
}

/**
 * A 53-bit hash of the compared values, so the target side costs a number per row
 * instead of the row. Two FNV-1a hashes with different seeds; equal rows always
 * hash equal, and a collision of different ones is about one in 2^53.
 */
export function rowHash(cells: readonly CellValue[], modes: readonly ColumnMode[] = []): number {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  const feed = (code: number): void => {
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  };
  for (const [position, cell] of cells.entries()) {
    const text = comparableText(cell, modes[position]);
    for (let index = 0; index < text.length; index += 1) {
      feed(text.charCodeAt(index));
    }
    // Ends every value, so ("ab", "c") and ("a", "bc") hash apart.
    feed(0xffff);
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) & 0x1fffff);
}

/** True when two cells hold the same value by the rules above. */
export function sameValue(left: CellValue, right: CellValue, mode: ColumnMode = 'plain'): boolean {
  return comparableText(left, mode) === comparableText(right, mode);
}
