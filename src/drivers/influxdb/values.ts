import type { CellValue } from '../../shared/cell-value';

/**
 * The type name DataNest shows for a Flux column: `dateTime:RFC3339` is a `dateTime`, the
 * rest keep Flux's own word. Without the `#datatype` annotation the type is not known.
 */
export function fluxTypeName(datatype: string | undefined): string | undefined {
  if (datatype === undefined || datatype === '') {
    return undefined;
  }
  return datatype.startsWith('dateTime') ? 'dateTime' : datatype;
}

/** Hex of the first bytes of a binary cell, as the grid previews it. */
const PREVIEW_BYTES = 16;

/**
 * One cell of the annotated CSV. Empty means null (that is how Flux writes it), unless the
 * column has a `#default`. Integers beyond 2^53 stay text, so no digit is lost; times keep
 * the server's spelling.
 */
export function fluxCell(
  text: string,
  datatype: string | undefined,
  fallback: string | undefined,
): CellValue {
  const value = text === '' && fallback !== undefined && fallback !== '' ? fallback : text;
  if (value === '') {
    return null;
  }
  const type = datatype ?? 'string';
  switch (type) {
    case 'long':
    case 'unsignedLong': {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : { kind: 'bigint', text: value };
    }
    case 'double': {
      if (value === '+Inf') {
        return Number.POSITIVE_INFINITY;
      }
      if (value === '-Inf') {
        return Number.NEGATIVE_INFINITY;
      }
      const number = Number(value);
      return Number.isNaN(number) && value !== 'NaN' ? value : number;
    }
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : value;
    case 'base64Binary': {
      const bytes = Buffer.from(value, 'base64');
      return {
        kind: 'binary',
        size: bytes.length,
        preview: bytes.subarray(0, PREVIEW_BYTES).toString('hex'),
      };
    }
    default:
      return type.startsWith('dateTime') ? { kind: 'datetime', text: value } : value;
  }
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

/**
 * One cell of an InfluxQL answer (already JSON): the `time` column is a time in RFC 3339,
 * objects (they do not occur, but a future server may send some) become JSON text.
 */
export function influxqlCell(value: unknown, column: string): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return column === 'time' && TIME.test(value) ? { kind: 'datetime', text: value } : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return { kind: 'json', text: JSON.stringify(value) };
}

/** The type InfluxQL values show: JSON has no more than this to say. */
export function influxqlTypeName(column: string, sample: unknown): string | undefined {
  if (column === 'time') {
    return 'dateTime';
  }
  if (typeof sample === 'number') {
    return Number.isInteger(sample) ? 'integer' : 'float';
  }
  if (typeof sample === 'string') {
    return 'string';
  }
  return typeof sample === 'boolean' ? 'boolean' : undefined;
}
