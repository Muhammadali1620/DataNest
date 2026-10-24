// Normalization of PostgreSQL values. The session installs identity type parsers,
// so almost everything arrives as the server's text and only needs tagging by OID;
// precision is never lost on the way to the grid.

import type { CellValue } from '../../shared/cell-value';
import { binaryValue, safeIntOrTag } from '../common/values';

/** Builtin type OIDs (a stable part of the wire protocol). */
export const PG_OID = {
  BOOL: 16,
  BYTEA: 17,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  OID: 26,
  JSON: 114,
  FLOAT4: 700,
  FLOAT8: 701,
  INET: 869,
  BPCHAR: 1042,
  VARCHAR: 1043,
  DATE: 1082,
  TIME: 1083,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  INTERVAL: 1186,
  TIMETZ: 1266,
  NUMERIC: 1700,
  UUID: 2950,
  JSONB: 3802,
} as const;

const TYPE_NAMES: Readonly<Record<number, string>> = {
  [PG_OID.BOOL]: 'bool',
  [PG_OID.BYTEA]: 'bytea',
  [PG_OID.INT8]: 'int8',
  [PG_OID.INT2]: 'int2',
  [PG_OID.INT4]: 'int4',
  [PG_OID.TEXT]: 'text',
  [PG_OID.OID]: 'oid',
  [PG_OID.JSON]: 'json',
  [PG_OID.FLOAT4]: 'float4',
  [PG_OID.FLOAT8]: 'float8',
  [PG_OID.INET]: 'inet',
  [PG_OID.BPCHAR]: 'char',
  [PG_OID.VARCHAR]: 'varchar',
  [PG_OID.DATE]: 'date',
  [PG_OID.TIME]: 'time',
  [PG_OID.TIMESTAMP]: 'timestamp',
  [PG_OID.TIMESTAMPTZ]: 'timestamptz',
  [PG_OID.INTERVAL]: 'interval',
  [PG_OID.TIMETZ]: 'timetz',
  [PG_OID.NUMERIC]: 'numeric',
  [PG_OID.UUID]: 'uuid',
  [PG_OID.JSONB]: 'jsonb',
};

export function pgTypeName(oid: number | undefined): string | undefined {
  return oid === undefined ? undefined : TYPE_NAMES[oid];
}

/**
 * Parsers the session installs instead of pg's defaults: only values that fit a
 * JS primitive exactly are converted; everything else stays the server's text.
 */
export function pgTypeParser(oid: number): (raw: string) => unknown {
  switch (oid) {
    case PG_OID.BOOL:
      return (raw) => raw === 't' || raw === 'true';
    case PG_OID.INT2:
    case PG_OID.INT4:
    case PG_OID.OID:
      return (raw) => Number.parseInt(raw, 10);
    case PG_OID.FLOAT4:
    case PG_OID.FLOAT8:
      return (raw) => Number.parseFloat(raw);
    default:
      return (raw) => raw;
  }
}

const DATETIME_OIDS: ReadonlySet<number> = new Set([
  PG_OID.DATE,
  PG_OID.TIME,
  PG_OID.TIMETZ,
  PG_OID.TIMESTAMP,
  PG_OID.TIMESTAMPTZ,
]);

export function toCellValue(value: unknown, oid?: number): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (oid !== undefined) {
      if (oid === PG_OID.INT8) {
        return safeIntOrTag(value);
      }
      if (oid === PG_OID.NUMERIC) {
        return { kind: 'decimal', text: value };
      }
      if (DATETIME_OIDS.has(oid)) {
        return { kind: 'datetime', text: value };
      }
      if (oid === PG_OID.JSON || oid === PG_OID.JSONB) {
        return { kind: 'json', text: value };
      }
      if (oid === PG_OID.BYTEA) {
        return byteaToBinary(value);
      }
    }
    return value;
  }
  if (typeof value === 'bigint') {
    return safeIntOrTag(value.toString());
  }
  if (value instanceof Uint8Array) {
    return binaryValue(value);
  }
  // Defensive: identity parsers should prevent parsed objects from appearing.
  const text = JSON.stringify(value) as string | undefined;
  return { kind: 'json', text: text ?? '[unserializable]' };
}

/** bytea text format is `\x` followed by hex. */
function byteaToBinary(text: string): CellValue {
  if (text.startsWith('\\x')) {
    const hex = text.slice(2);
    return binaryValue(Buffer.from(hex, 'hex'));
  }
  // Legacy escape format; keep the raw text rather than guessing.
  return text;
}
