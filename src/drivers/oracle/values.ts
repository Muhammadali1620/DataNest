// Oracle values as CellValue (ARCHITECTURE.md §5). Numbers are fetched as their exact
// text and dates arrive in their parts (exact-dates.ts), so NUMBER(38) and TIMESTAMP(9)
// keep every digit; LOBs come whole, JSON as its text, intervals as Oracle prints them.

import type { CellValue } from '../../shared/cell-value';
import { binaryValue, safeIntOrTag } from '../common/values';
import { OracleDateText } from './exact-dates';

/** The slice of node-oracledb's column metadata the driver reads. */
export interface OracleColumnLike {
  readonly name: string;
  readonly dbTypeName?: string | undefined;
  readonly precision?: number | undefined;
  readonly scale?: number | undefined;
}

/** The type of a result column as SQL names it: `NUMBER(10,2)`, `VARCHAR2`, … */
export function oracleTypeName(column: OracleColumnLike): string | undefined {
  const name = column.dbTypeName;
  if (name === undefined) {
    return undefined;
  }
  if (name === 'NUMBER' && column.precision !== undefined && column.precision > 0) {
    return column.scale !== undefined && column.scale !== 0
      ? `NUMBER(${column.precision},${column.scale})`
      : `NUMBER(${column.precision})`;
  }
  return name;
}

/** Normalizes one fetched value, using the column's metadata. */
export function toCellValue(value: unknown, column: OracleColumnLike): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  const type = column.dbTypeName ?? '';
  if (value instanceof OracleDateText) {
    // DATE has whole seconds; a TIMESTAMP says its fraction digits in `precision`.
    return { kind: 'datetime', text: value.format(type === 'DATE' ? 0 : (column.precision ?? 6)) };
  }
  if (typeof value === 'string') {
    if (type === 'NUMBER' || type === 'FLOAT') {
      // An integer that fits stays a number; anything else keeps its exact text.
      if (/^-?\d+$/u.test(value)) {
        return safeIntOrTag(value);
      }
      return {
        kind: 'decimal',
        text: value.startsWith('.') ? `0${value}` : value.replace(/^-\./u, '-0.'),
      };
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return binaryValue(value);
  }
  if (value instanceof Date) {
    return { kind: 'datetime', text: value.toISOString().replace('T', ' ').replace('Z', '') };
  }
  // INTERVAL values come as objects ({ years, months } / { days, hours, … }).
  if (typeof value === 'object' && type.startsWith('INTERVAL')) {
    return intervalText(value as Record<string, unknown>);
  }
  return { kind: 'json', text: JSON.stringify(value) };
}

/** `+01-02` and `+03 04:05:06.789000`, the way Oracle prints intervals. */
export function intervalText(value: Record<string, unknown>): string {
  const n = (key: string): number => {
    const part = value[key];
    return typeof part === 'number' ? part : 0;
  };
  if ('years' in value || 'months' in value) {
    const total = n('years') * 12 + n('months');
    const sign = total < 0 ? '-' : '+';
    const months = Math.abs(total);
    return `${sign}${String(Math.floor(months / 12)).padStart(2, '0')}-${String(months % 12).padStart(2, '0')}`;
  }
  const parts = [n('days'), n('hours'), n('minutes'), n('seconds'), n('fseconds')];
  const negative = parts.some((part) => part < 0);
  const [days, hours, minutes, seconds, fraction] = parts.map((part) => Math.abs(part));
  const two = (part: number | undefined): string => String(part ?? 0).padStart(2, '0');
  return `${negative ? '-' : '+'}${two(days)} ${two(hours)}:${two(minutes)}:${two(seconds)}.${String(Math.round((fraction ?? 0) / 1000)).padStart(6, '0')}`;
}
