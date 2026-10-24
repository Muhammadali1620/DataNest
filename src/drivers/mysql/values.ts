// Normalization of mysql2 values into CellValue. The connection is opened with
// dateStrings, bigNumberStrings and jsonStrings, so precision-critical types arrive
// as text and only need tagging by column type.

import type { CellValue } from '../../shared/cell-value';

/** MySQL protocol column type codes (a stable part of the wire protocol). */
export const MYSQL_TYPE = {
  DECIMAL: 0,
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  NEWDATE: 14,
  VARCHAR: 15,
  BIT: 16,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255,
} as const;

const TYPE_NAMES: Readonly<Record<number, string>> = {
  [MYSQL_TYPE.DECIMAL]: 'decimal',
  [MYSQL_TYPE.TINY]: 'tinyint',
  [MYSQL_TYPE.SHORT]: 'smallint',
  [MYSQL_TYPE.LONG]: 'int',
  [MYSQL_TYPE.FLOAT]: 'float',
  [MYSQL_TYPE.DOUBLE]: 'double',
  [MYSQL_TYPE.NULL]: 'null',
  [MYSQL_TYPE.TIMESTAMP]: 'timestamp',
  [MYSQL_TYPE.LONGLONG]: 'bigint',
  [MYSQL_TYPE.INT24]: 'mediumint',
  [MYSQL_TYPE.DATE]: 'date',
  [MYSQL_TYPE.TIME]: 'time',
  [MYSQL_TYPE.DATETIME]: 'datetime',
  [MYSQL_TYPE.YEAR]: 'year',
  [MYSQL_TYPE.NEWDATE]: 'date',
  [MYSQL_TYPE.VARCHAR]: 'varchar',
  [MYSQL_TYPE.BIT]: 'bit',
  [MYSQL_TYPE.JSON]: 'json',
  [MYSQL_TYPE.NEWDECIMAL]: 'decimal',
  [MYSQL_TYPE.ENUM]: 'enum',
  [MYSQL_TYPE.SET]: 'set',
  [MYSQL_TYPE.TINY_BLOB]: 'tinyblob',
  [MYSQL_TYPE.MEDIUM_BLOB]: 'mediumblob',
  [MYSQL_TYPE.LONG_BLOB]: 'longblob',
  [MYSQL_TYPE.BLOB]: 'blob',
  [MYSQL_TYPE.VAR_STRING]: 'varchar',
  [MYSQL_TYPE.STRING]: 'char',
  [MYSQL_TYPE.GEOMETRY]: 'geometry',
};

export function mysqlTypeName(columnType: number | undefined): string | undefined {
  return columnType === undefined ? undefined : TYPE_NAMES[columnType];
}

/** How many bytes of a binary value travel to the UI as a hex preview. */
export const BINARY_PREVIEW_BYTES = 256;

const DATETIME_TYPES: ReadonlySet<number> = new Set([
  MYSQL_TYPE.TIMESTAMP,
  MYSQL_TYPE.DATE,
  MYSQL_TYPE.TIME,
  MYSQL_TYPE.DATETIME,
  MYSQL_TYPE.NEWDATE,
]);

const DECIMAL_TYPES: ReadonlySet<number> = new Set([MYSQL_TYPE.DECIMAL, MYSQL_TYPE.NEWDECIMAL]);

export function toCellValue(value: unknown, columnType?: number): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    if (columnType !== undefined) {
      if (DATETIME_TYPES.has(columnType)) {
        return { kind: 'datetime', text: value };
      }
      if (DECIMAL_TYPES.has(columnType)) {
        return { kind: 'decimal', text: value };
      }
      if (columnType === MYSQL_TYPE.LONGLONG) {
        return safeIntOrTag(value);
      }
      if (columnType === MYSQL_TYPE.JSON) {
        return { kind: 'json', text: value };
      }
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return safeIntOrTag(value.toString());
  }
  if (value instanceof Uint8Array) {
    return {
      kind: 'binary',
      size: value.byteLength,
      preview: Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        .subarray(0, BINARY_PREVIEW_BYTES)
        .toString('hex'),
    };
  }
  if (value instanceof Date) {
    // Defensive: dateStrings should prevent this; render without timezone math.
    return { kind: 'datetime', text: formatLocalDateTime(value) };
  }
  // Parsed JSON or geometry objects: keep them readable as JSON text.
  return { kind: 'json', text: safeJson(value) };
}

/** BIGINT values that survive a JS number stay numbers; the rest keep exact text. */
function safeIntOrTag(text: string): CellValue {
  if (/^-?\d{1,15}$/.test(text)) {
    return Number(text);
  }
  const parsed = Number(text);
  if (Number.isSafeInteger(parsed) && String(parsed) === text) {
    return parsed;
  }
  return { kind: 'bigint', text };
}

function formatLocalDateTime(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const base = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const ms = date.getMilliseconds();
  return ms === 0 ? base : `${base}.${pad(ms, 3)}`;
}

function safeJson(value: unknown): string {
  try {
    // JSON.stringify returns undefined for functions and symbols despite its declared type.
    const text = JSON.stringify(value) as string | undefined;
    return text ?? 'null';
  } catch (_error) {
    // Circular structures cannot happen for DB values, but never crash a result row.
    return String(value);
  }
}
