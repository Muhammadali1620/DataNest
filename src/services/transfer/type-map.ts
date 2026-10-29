// Column types and defaults from one database for another (V5.6). A type is read
// into a neutral form (an integer of so many bytes, text of some length, a moment
// with or without a zone…) and written back in the words of the target. Between
// databases of the same kind nothing is translated.

import type { DriverId } from '../../shared/connection';
import { enumOptions } from '../../shared/cell-input';
import { splitType } from '../../shared/table-design';

export type NeutralType =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'integer'; readonly bytes: 1 | 2 | 3 | 4 | 8; readonly unsigned: boolean }
  | { readonly kind: 'decimal'; readonly precision?: number; readonly scale?: number }
  | { readonly kind: 'float'; readonly double: boolean }
  | { readonly kind: 'string'; readonly length: number; readonly fixed: boolean }
  | { readonly kind: 'text' }
  | { readonly kind: 'date' }
  | { readonly kind: 'time' }
  | { readonly kind: 'datetime'; readonly zone: boolean; readonly precision?: number }
  | { readonly kind: 'json' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'uuid' }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

const INT_BYTES: readonly (readonly [RegExp, 1 | 2 | 3 | 4 | 8])[] = [
  [/^tinyint\b/u, 1],
  [/^(smallint|int2|smallserial|serial2)\b/u, 2],
  [/^mediumint\b/u, 3],
  [/^(int|integer|int4|serial|serial4)\b/u, 4],
  [/^(bigint|int8|bigserial|serial8)\b/u, 8],
];

/** Reads a type as the source database wrote it. Unknown types become text. */
export function neutralType(dataType: string, driver: DriverId): NeutralType {
  const type = dataType.trim().toLowerCase();
  const numbers = (/\(([^)]*)\)/u.exec(type)?.[1] ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (
    /^(bool|boolean)$/u.test(type) ||
    /^tinyint\s*\(\s*1\s*\)/u.test(type) ||
    /^bit\s*\(\s*1\s*\)$/u.test(type)
  ) {
    return { kind: 'boolean' };
  }
  if (/\[\]$|^array/u.test(type)) {
    return { kind: 'text' };
  }
  if (type.startsWith('year')) {
    return { kind: 'integer', bytes: 2, unsigned: false };
  }
  // SQLite keeps every integer in eight bytes, whatever the declaration says.
  if (driver === 'sqlite' && type.includes('int')) {
    return { kind: 'integer', bytes: 8, unsigned: false };
  }
  for (const [pattern, bytes] of INT_BYTES) {
    if (pattern.test(type)) {
      return { kind: 'integer', bytes, unsigned: type.includes('unsigned') };
    }
  }
  if (/^(decimal|numeric|dec|fixed|number)\b/u.test(type)) {
    const [precision, scale] = numbers;
    return {
      kind: 'decimal',
      ...(precision === undefined ? {} : { precision }),
      ...(precision === undefined ? {} : { scale: scale ?? 0 }),
    };
  }
  if (type.startsWith('money')) {
    return { kind: 'decimal', precision: 19, scale: 4 };
  }
  if (/^(double|float8)/u.test(type)) {
    return { kind: 'float', double: true };
  }
  if (type.startsWith('float4')) {
    return { kind: 'float', double: false };
  }
  // REAL is four bytes in PostgreSQL, eight in MySQL and SQLite; FLOAT the other way round.
  if (type.startsWith('real')) {
    return { kind: 'float', double: driver !== 'postgres' };
  }
  if (type.startsWith('float')) {
    const [bits] = numbers;
    return {
      kind: 'float',
      double:
        driver === 'postgres' ? bits === undefined || bits > 24 : bits !== undefined && bits > 24,
    };
  }
  if (/^(n?varchar|character varying|varchar2|nvarchar2)/u.test(type)) {
    const [length] = numbers;
    return length === undefined ? { kind: 'text' } : { kind: 'string', length, fixed: false };
  }
  if (/^(n?char|character|bpchar)\b/u.test(type)) {
    return { kind: 'string', length: numbers[0] ?? 1, fixed: true };
  }
  if (/^(text|tinytext|mediumtext|longtext|clob|citext|string|name)\b/u.test(type)) {
    return { kind: 'text' };
  }
  if (/^date$/u.test(type)) {
    return { kind: 'date' };
  }
  if (/^time\b/u.test(type) && !type.startsWith('timestamp')) {
    return { kind: 'time' };
  }
  if (/^(timestamptz|timestamp\s*(\(\d+\))?\s*with time zone)/u.test(type)) {
    return { kind: 'datetime', zone: true, ...precisionOf(numbers) };
  }
  if (/^(timestamp|datetime)/u.test(type)) {
    return { kind: 'datetime', zone: false, ...precisionOf(numbers) };
  }
  if (/^jsonb?$/u.test(type)) {
    return { kind: 'json' };
  }
  if (/blob|bytea|binary|^raw\b|^bit\b/u.test(type)) {
    return { kind: 'binary' };
  }
  if (/^uuid$|^uniqueidentifier$/u.test(type)) {
    return { kind: 'uuid' };
  }
  if (/^enum\s*\(/u.test(type)) {
    return { kind: 'enum', values: enumOptions(dataType) ?? [] };
  }
  return { kind: 'text' };
}

function precisionOf(numbers: readonly number[]): { precision?: number } {
  return numbers[0] === undefined ? {} : { precision: Math.min(numbers[0], 6) };
}

/**
 * The type for the target, split as the table designer keeps it. `indexed` columns
 * stay short in MySQL, which cannot index TEXT or BLOB without a prefix.
 */
export function targetType(
  neutral: NeutralType,
  to: DriverId,
  indexed: boolean,
): { type: string; length: string } {
  switch (to) {
    case 'mysql':
      return mysqlType(neutral, indexed);
    case 'postgres':
      return postgresType(neutral);
    case 'sqlite':
      return sqliteType(neutral);
  }
}

const t = (type: string, length = ''): { type: string; length: string } => ({ type, length });

function mysqlType(neutral: NeutralType, indexed: boolean): { type: string; length: string } {
  switch (neutral.kind) {
    case 'boolean':
      return t('tinyint', '1');
    case 'integer': {
      const name = { 1: 'tinyint', 2: 'smallint', 3: 'mediumint', 4: 'int', 8: 'bigint' }[
        neutral.bytes
      ];
      return t(neutral.unsigned ? `${name} unsigned` : name);
    }
    case 'decimal':
      return neutral.precision === undefined
        ? t('decimal', '65,30')
        : t('decimal', `${Math.min(neutral.precision, 65)},${Math.min(neutral.scale ?? 0, 30)}`);
    case 'float':
      return t(neutral.double ? 'double' : 'float');
    case 'string':
      if (neutral.fixed && neutral.length <= 255) {
        return t('char', String(neutral.length));
      }
      return neutral.length <= 16_383
        ? t('varchar', String(neutral.length))
        : t(indexed ? 'varchar' : 'longtext', indexed ? '255' : '');
    case 'text':
      return indexed ? t('varchar', '255') : t('longtext');
    case 'date':
      return t('date');
    case 'time':
      return t('time');
    case 'datetime':
      return t('datetime', String(neutral.precision ?? 6));
    case 'json':
      return t('json');
    case 'binary':
      return indexed ? t('varbinary', '255') : t('longblob');
    case 'uuid':
      return t('char', '36');
    case 'enum':
      return neutral.values.length === 0
        ? t('varchar', '255')
        : t('enum', neutral.values.map((value) => `'${value.replaceAll("'", "''")}'`).join(','));
  }
}

function postgresType(neutral: NeutralType): { type: string; length: string } {
  switch (neutral.kind) {
    case 'boolean':
      return t('boolean');
    case 'integer':
      if (neutral.bytes === 8) {
        return neutral.unsigned ? t('numeric', '20,0') : t('bigint');
      }
      if (neutral.bytes === 4 && neutral.unsigned) {
        return t('bigint');
      }
      return t(neutral.bytes <= 2 ? 'smallint' : 'integer');
    case 'decimal':
      return neutral.precision === undefined
        ? t('numeric')
        : t('numeric', `${Math.min(neutral.precision, 1000)},${neutral.scale ?? 0}`);
    case 'float':
      return t(neutral.double ? 'double precision' : 'real');
    case 'string':
      return t(neutral.fixed ? 'char' : 'varchar', String(neutral.length));
    case 'text':
    case 'enum':
      return t('text');
    case 'date':
      return t('date');
    case 'time':
      return t('time');
    case 'datetime': {
      const precision = neutral.precision === undefined ? '' : String(neutral.precision);
      return neutral.zone ? t('timestamp with time zone', precision) : t('timestamp', precision);
    }
    case 'json':
      return t('jsonb');
    case 'binary':
      return t('bytea');
    case 'uuid':
      return t('uuid');
  }
}

function sqliteType(neutral: NeutralType): { type: string; length: string } {
  switch (neutral.kind) {
    case 'boolean':
      return t('boolean');
    case 'integer':
      return t('integer');
    case 'decimal':
      return neutral.precision === undefined
        ? t('numeric')
        : t('numeric', `${neutral.precision},${neutral.scale ?? 0}`);
    case 'float':
      return t('real');
    case 'string':
      return t(neutral.fixed ? 'char' : 'varchar', String(neutral.length));
    case 'text':
    case 'enum':
    case 'uuid':
    case 'json':
      return t('text');
    case 'date':
      return t('date');
    case 'time':
      return t('time');
    case 'datetime':
      return t('datetime');
    case 'binary':
      return t('blob');
  }
}

/** The type of a column for the target: as it is between the same databases. */
export function mapColumnType(
  dataType: string,
  from: DriverId,
  to: DriverId,
  indexed: boolean,
): { type: string; length: string } {
  if (from === to) {
    return splitType(dataType);
  }
  return targetType(neutralType(dataType, from), to, indexed);
}

const NOW =
  /^(current_timestamp|now|localtimestamp|transaction_timestamp|statement_timestamp)\s*(\(\s*\d*\s*\))?$/iu;

/**
 * A default for the target, or undefined when it cannot be carried over (a function
 * of the source database): the column then gets none, and the caller says so.
 */
export function mapDefault(
  expression: string,
  neutral: NeutralType,
  from: DriverId,
  to: DriverId,
): string | undefined {
  if (from === to) {
    return expression;
  }
  // PostgreSQL writes literals with a cast: 'new'::character varying, 0::numeric.
  const text = expression
    .trim()
    .replace(/::[\w\s"[\]().,]+$/u, '')
    .trim();
  const bare = text.replace(/^\((.*)\)$/u, '$1').trim();
  if (/^null$/iu.test(bare)) {
    return undefined;
  }
  if (neutral.kind === 'boolean') {
    if (/^(true|'t'|'true'|b?'1'|1)$/iu.test(bare)) {
      return to === 'mysql' ? '1' : 'TRUE';
    }
    if (/^(false|'f'|'false'|b?'0'|0)$/iu.test(bare)) {
      return to === 'mysql' ? '0' : 'FALSE';
    }
    return undefined;
  }
  if (/^[+-]?\d+(\.\d+)?$/u.test(bare)) {
    return bare;
  }
  if (/^'(?:[^'\\]|'')*'$/u.test(bare)) {
    return bare;
  }
  if (NOW.test(bare) || /^current_(date|time)$/iu.test(bare)) {
    if (/^current_date$/iu.test(bare)) {
      return 'CURRENT_DATE';
    }
    if (neutral.kind === 'datetime' && to === 'mysql' && (neutral.precision ?? 6) > 0) {
      return `CURRENT_TIMESTAMP(${neutral.precision ?? 6})`;
    }
    return 'CURRENT_TIMESTAMP';
  }
  return undefined;
}
