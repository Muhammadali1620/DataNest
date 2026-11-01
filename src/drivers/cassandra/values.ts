// What the Cassandra driver hands over (Long, Integer, BigDecimal, Uuid, Buffer, collections,
// user-defined types) and the values DataNest keeps in cells. Integers and decimals stay text,
// so nothing is rounded; collections, UDTs and tuples become JSON text with the numbers as
// the server wrote them.

import { types } from 'cassandra-driver';
import type { CellValue } from '../../shared/cell-value';
import { binaryValue, safeIntOrTag } from '../common/values';

const { Long, Integer, BigDecimal, Uuid, InetAddress, LocalDate, LocalTime, Duration, Tuple } =
  types;

const UDT_CODE: number = types.dataTypes.udt;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A timestamp as ISO text; a date the engine cannot show says so. */
function isoOf(date: Date): string {
  return Number.isNaN(date.getTime()) ? 'Invalid Date' : date.toISOString();
}

/** The JSON text of a value: integers and decimals written in full, every key quoted. */
export function jsonText(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Long.isLong(value) || value instanceof Integer || value instanceof BigDecimal) {
    const text = value.toString();
    return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(text) ? text : JSON.stringify(text);
  }
  if (value instanceof Date) {
    return JSON.stringify(isoOf(value));
  }
  if (Buffer.isBuffer(value)) {
    return JSON.stringify(`0x${value.toString('hex')}`);
  }
  if (value instanceof Tuple) {
    return `[${value.values().map(jsonText).join(',')}]`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(jsonText).join(',')}]`;
  }
  if (ArrayBuffer.isView(value)) {
    return `[${Array.from(value as unknown as ArrayLike<number>)
      .map(jsonText)
      .join(',')}]`;
  }
  if (value instanceof Map) {
    return `{${[...(value as Map<unknown, unknown>).entries()]
      .map(([key, item]) => `${JSON.stringify(String(key))}:${jsonText(item)}`)
      .join(',')}}`;
  }
  if (value instanceof Set) {
    return `[${[...(value as Set<unknown>)].map(jsonText).join(',')}]`;
  }
  if (
    value instanceof Uuid ||
    value instanceof InetAddress ||
    value instanceof LocalDate ||
    value instanceof LocalTime ||
    value instanceof Duration
  ) {
    return JSON.stringify(value.toString());
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${jsonText(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(typeof value === 'symbol' ? value.toString() : '[unsupported]');
}

/** One value of a row as a cell. */
export function fromCassandra(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return safeIntOrTag(value.toString());
  }
  if (Long.isLong(value) || value instanceof Integer) {
    return safeIntOrTag(value.toString());
  }
  if (value instanceof BigDecimal) {
    return { kind: 'decimal', text: value.toString() };
  }
  if (value instanceof Date) {
    return { kind: 'datetime', text: isoOf(value) };
  }
  if (value instanceof LocalDate || value instanceof LocalTime) {
    return { kind: 'datetime', text: value.toString() };
  }
  if (value instanceof Uuid || value instanceof InetAddress || value instanceof Duration) {
    return value.toString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return binaryValue(value);
  }
  return { kind: 'json', text: jsonText(value) };
}

/** The type of a result column as the tree and the grid show it (`text`, `list<int>`, …). */
export function typeName(type: unknown): string | undefined {
  if (!isRecord(type) || typeof type.code !== 'number') {
    return undefined;
  }
  // The driver spells collections, tuples and user-defined types out in full.
  const name = (
    types as unknown as { getDataTypeNameByCode(type: unknown): string | undefined }
  ).getDataTypeNameByCode(type);
  // `varchar` is the protocol's name for what CQL calls `text`; the tree shows `text`.
  return name?.replace(/\bvarchar\b/gu, 'text') ?? (type.code === UDT_CODE ? 'udt' : undefined);
}
