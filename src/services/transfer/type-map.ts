// Column types and defaults from one database for another (V5.6). A type is read
// into a neutral form (an integer of so many bytes, text of some length, a moment
// with or without a zone…) and written back in the words of the target. Between
// databases of the same kind nothing is translated.

import { clickhouseBareType } from '../../shared/clickhouse-types';
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
  if (driver === 'clickhouse') {
    return clickhouseNeutral(dataType);
  }
  const type = dataType.trim().toLowerCase();
  // Oracle says what a length counts: `varchar2(100 char)`, `char(10 byte)`.
  const numbers = (/\(([^)]*)\)/u.exec(type)?.[1] ?? '')
    .split(',')
    .map((part) => Number(/^\s*(\d+(?:\.\d+)?)/u.exec(part)?.[1] ?? Number.NaN))
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
  if (driver === 'mssql') {
    const own = mssqlNeutral(type);
    if (own !== undefined) {
      return own;
    }
  }
  if (driver === 'oracle') {
    const own = oracleNeutral(type);
    if (own !== undefined) {
      return own;
    }
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
  // REAL is four bytes in PostgreSQL and SQL Server, eight in MySQL and SQLite; FLOAT
  // the other way round.
  const standardFloats = driver === 'postgres' || driver === 'mssql';
  if (type.startsWith('real')) {
    return { kind: 'float', double: !standardFloats };
  }
  if (type.startsWith('float')) {
    const [bits] = numbers;
    return {
      kind: 'float',
      double: standardFloats ? bits === undefined || bits > 24 : bits !== undefined && bits > 24,
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

/** Oracle types: NUMBER(p) is an integer by its digits, DATE carries a time. */
function oracleNeutral(type: string): NeutralType | undefined {
  const number = /^number(?:\s*\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\))?$/u.exec(type);
  if (number !== null) {
    const precision = number[1] === undefined ? undefined : Number(number[1]);
    const scale = Number(number[2] ?? 0);
    if (precision === undefined) {
      return { kind: 'decimal' };
    }
    if (scale !== 0) {
      return { kind: 'decimal', precision, scale: Math.max(scale, 0) };
    }
    if (precision <= 4) {
      return { kind: 'integer', bytes: 2, unsigned: false };
    }
    if (precision <= 9) {
      return { kind: 'integer', bytes: 4, unsigned: false };
    }
    return precision <= 18
      ? { kind: 'integer', bytes: 8, unsigned: false }
      : { kind: 'decimal', precision, scale: 0 };
  }
  if (type === 'integer' || type === 'int' || type === 'smallint') {
    return { kind: 'decimal', precision: 38, scale: 0 };
  }
  if (type === 'binary_float') {
    return { kind: 'float', double: false };
  }
  if (type === 'binary_double' || type.startsWith('float')) {
    return { kind: 'float', double: true };
  }
  if (type === 'date') {
    return { kind: 'datetime', zone: false, precision: 0 };
  }
  if (type.startsWith('timestamp')) {
    const digits = /\((\d+)\)/u.exec(type)?.[1];
    return {
      kind: 'datetime',
      zone: /with (local )?time zone/u.test(type),
      ...precisionOf(digits === undefined ? [6] : [Number(digits)]),
    };
  }
  if (type.startsWith('interval') || type === 'rowid' || type === 'urowid') {
    return { kind: 'text' };
  }
  if (type === 'long') {
    return { kind: 'text' };
  }
  if (type === 'long raw') {
    return { kind: 'binary' };
  }
  return undefined;
}

/** SQL Server types that mean something else elsewhere, or exist only there. */
function mssqlNeutral(type: string): NeutralType | undefined {
  if (type === 'bit') {
    return { kind: 'boolean' };
  }
  // TINYINT holds 0 to 255 here.
  if (type === 'tinyint') {
    return { kind: 'integer', bytes: 1, unsigned: true };
  }
  if (type === 'smallmoney') {
    return { kind: 'decimal', precision: 10, scale: 4 };
  }
  // TIMESTAMP is a row version: eight bytes that change with every write.
  if (type === 'timestamp' || type === 'rowversion' || type === 'image') {
    return { kind: 'binary' };
  }
  if (type.startsWith('datetimeoffset')) {
    const digits = /\((\d+)\)/u.exec(type)?.[1];
    return {
      kind: 'datetime',
      zone: true,
      ...precisionOf(digits === undefined ? [] : [Number(digits)]),
    };
  }
  if (type === 'smalldatetime') {
    return { kind: 'datetime', zone: false, precision: 0 };
  }
  if (type === 'datetime') {
    return { kind: 'datetime', zone: false, precision: 3 };
  }
  if (type === 'ntext' || type === 'xml' || type === 'sysname') {
    return { kind: 'text' };
  }
  return undefined;
}

const CLICKHOUSE_DECIMALS: Readonly<Record<string, number>> = {
  decimal32: 9,
  decimal64: 18,
  decimal128: 38,
  decimal256: 76,
};

/** ClickHouse types, whose names say their width: Int8, UInt64, Float32, DateTime64(3). */
function clickhouseNeutral(dataType: string): NeutralType {
  const bare = clickhouseBareType(dataType);
  const type = bare.toLowerCase();
  const args = /\((.*)\)$/su.exec(bare)?.[1] ?? '';
  const integer = /^(u?)int(8|16|32|64|128|256)$/u.exec(type);
  if (integer !== null) {
    const bits = Number(integer[2]);
    if (bits > 64) {
      return { kind: 'decimal', precision: bits === 128 ? 39 : 77, scale: 0 };
    }
    return {
      kind: 'integer',
      bytes: (bits / 8) as 1 | 2 | 4 | 8,
      unsigned: integer[1] === 'u',
    };
  }
  const sized = /^(decimal32|decimal64|decimal128|decimal256)\(\s*(\d+)\s*\)$/u.exec(type);
  if (sized !== null) {
    return {
      kind: 'decimal',
      precision: CLICKHOUSE_DECIMALS[sized[1] ?? ''] ?? 38,
      scale: Number(sized[2]),
    };
  }
  const decimal = /^decimal\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/u.exec(type);
  if (decimal !== null) {
    return { kind: 'decimal', precision: Number(decimal[1]), scale: Number(decimal[2] ?? 0) };
  }
  if (type === 'float32') {
    return { kind: 'float', double: false };
  }
  if (type === 'float64') {
    return { kind: 'float', double: true };
  }
  if (type === 'bool' || type === 'boolean') {
    return { kind: 'boolean' };
  }
  const fixed = /^fixedstring\(\s*(\d+)\s*\)$/u.exec(type);
  if (fixed !== null) {
    return { kind: 'string', length: Number(fixed[1]), fixed: true };
  }
  if (type === 'date' || type === 'date32') {
    return { kind: 'date' };
  }
  if (type === 'time' || type.startsWith('time64')) {
    return { kind: 'time' };
  }
  if (type.startsWith('datetime64')) {
    const digits = Number(/^\s*(\d+)/u.exec(args)?.[1] ?? '3');
    return { kind: 'datetime', zone: false, ...precisionOf([digits]) };
  }
  if (type.startsWith('datetime')) {
    return { kind: 'datetime', zone: false, precision: 0 };
  }
  if (type === 'uuid') {
    return { kind: 'uuid' };
  }
  if (/^enum(8|16)\(/u.test(type)) {
    const values: string[] = [];
    for (const match of args.matchAll(/'((?:[^'\\]|\\.)*)'\s*=/gu)) {
      values.push((match[1] ?? '').replace(/\\(.)/gu, '$1'));
    }
    return { kind: 'enum', values };
  }
  if (/^(array|map|tuple|nested|json|object)\b/u.test(type)) {
    return { kind: 'json' };
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
    case 'mssql':
      return mssqlType(neutral, indexed);
    case 'clickhouse':
      return clickhouseType(neutral);
    case 'oracle':
      return oracleType(neutral, indexed);
  }
}

/** The longest VARCHAR2 in characters; an indexed one stays well under the key limit. */
const ORACLE_VARCHAR = 4000;
const ORACLE_INDEXED_VARCHAR = 1000;

function oracleType(neutral: NeutralType, indexed: boolean): { type: string; length: string } {
  switch (neutral.kind) {
    // BOOLEAN exists only from 23ai; NUMBER(1) works everywhere and holds 0 and 1.
    case 'boolean':
      return t('NUMBER', '1');
    case 'integer':
      if (neutral.bytes <= 2) {
        return t('NUMBER', '5');
      }
      if (neutral.bytes <= 4) {
        return t('NUMBER', '10');
      }
      return t('NUMBER', neutral.unsigned ? '20' : '19');
    case 'decimal':
      return neutral.precision === undefined || neutral.precision > 38
        ? t('NUMBER')
        : t('NUMBER', `${neutral.precision},${Math.min(neutral.scale ?? 0, neutral.precision)}`);
    case 'float':
      return t(neutral.double ? 'BINARY_DOUBLE' : 'BINARY_FLOAT');
    case 'string':
      if (neutral.fixed && neutral.length <= 2000) {
        return t('CHAR', `${neutral.length} CHAR`);
      }
      if (neutral.length <= ORACLE_VARCHAR) {
        return t('VARCHAR2', `${neutral.length} CHAR`);
      }
      return indexed ? t('VARCHAR2', `${ORACLE_INDEXED_VARCHAR} CHAR`) : t('CLOB');
    case 'text':
    case 'json':
      return indexed ? t('VARCHAR2', `${ORACLE_INDEXED_VARCHAR} CHAR`) : t('CLOB');
    case 'enum': {
      const longest = Math.max(1, ...neutral.values.map((value) => value.length));
      return t('VARCHAR2', `${neutral.values.length === 0 ? 255 : longest} CHAR`);
    }
    case 'date':
      return t('DATE');
    // Oracle has no time of day on its own.
    case 'time':
      return t('VARCHAR2', '16 CHAR');
    case 'datetime': {
      const precision = String(neutral.precision ?? 6);
      return neutral.zone ? t('TIMESTAMP WITH TIME ZONE', precision) : t('TIMESTAMP', precision);
    }
    case 'binary':
      return indexed ? t('RAW', '2000') : t('BLOB');
    case 'uuid':
      return t('VARCHAR2', '36 CHAR');
  }
}

function clickhouseType(neutral: NeutralType): { type: string; length: string } {
  switch (neutral.kind) {
    case 'boolean':
      return t('Bool');
    case 'integer': {
      const bits = neutral.bytes === 3 ? 32 : neutral.bytes * 8;
      return t(`${neutral.unsigned ? 'UInt' : 'Int'}${bits}`);
    }
    case 'decimal':
      return neutral.precision === undefined
        ? t('Decimal', '38,10')
        : t('Decimal', `${Math.min(neutral.precision, 76)},${neutral.scale ?? 0}`);
    case 'float':
      return t(neutral.double ? 'Float64' : 'Float32');
    case 'string':
    case 'text':
    case 'json':
    case 'binary':
    case 'time':
      return t('String');
    case 'enum':
      return t('LowCardinality', 'String');
    case 'date':
      // Date covers 1970–2149 only; Date32 goes back to 1900.
      return t('Date32');
    case 'datetime': {
      const precision = String(neutral.precision ?? 6);
      return neutral.zone ? t('DateTime64', `${precision}, 'UTC'`) : t('DateTime64', precision);
    }
    case 'uuid':
      return t('UUID');
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

/** Longest NVARCHAR that is not MAX; index keys must stay under 900 bytes as well. */
const MSSQL_NVARCHAR = 4000;
const MSSQL_INDEXED_NVARCHAR = 450;

function mssqlType(neutral: NeutralType, indexed: boolean): { type: string; length: string } {
  switch (neutral.kind) {
    case 'boolean':
      return t('bit');
    case 'integer':
      switch (neutral.bytes) {
        case 1:
          return t(neutral.unsigned ? 'tinyint' : 'smallint');
        case 2:
          return t(neutral.unsigned ? 'int' : 'smallint');
        case 3:
          return t('int');
        case 4:
          return t(neutral.unsigned ? 'bigint' : 'int');
        case 8:
          return neutral.unsigned ? t('decimal', '20,0') : t('bigint');
      }
      break;
    case 'decimal':
      return neutral.precision === undefined
        ? t('decimal', '38,10')
        : t('decimal', `${Math.min(neutral.precision, 38)},${Math.min(neutral.scale ?? 0, 38)}`);
    case 'float':
      return t(neutral.double ? 'float' : 'real');
    case 'string':
      if (neutral.length <= MSSQL_NVARCHAR) {
        return t(neutral.fixed ? 'nchar' : 'nvarchar', String(neutral.length));
      }
      return t('nvarchar', indexed ? String(MSSQL_INDEXED_NVARCHAR) : 'max');
    case 'text':
    case 'json':
      return t('nvarchar', indexed ? String(MSSQL_INDEXED_NVARCHAR) : 'max');
    case 'enum': {
      const longest = Math.max(1, ...neutral.values.map((value) => value.length));
      return t(
        'nvarchar',
        String(neutral.values.length === 0 ? 255 : Math.min(longest, MSSQL_NVARCHAR)),
      );
    }
    case 'date':
      return t('date');
    case 'time':
      return t('time');
    case 'datetime': {
      const precision = String(neutral.precision ?? 7);
      return t(neutral.zone ? 'datetimeoffset' : 'datetime2', precision);
    }
    case 'binary':
      return t('varbinary', indexed ? '900' : 'max');
    case 'uuid':
      return t('uniqueidentifier');
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
  /^(current_timestamp|now|localtimestamp|transaction_timestamp|statement_timestamp|getdate|sysdatetime|getutcdate|sysutcdatetime|sysdatetimeoffset|now64|sysdate|systimestamp)\s*(\(\s*\d*\s*\))?$/iu;

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
  // SQL Server writes Unicode literals as N'…'.
  const bare = text
    .replace(/^\((.*)\)$/u, '$1')
    .trim()
    .replace(/^N'/u, "'");
  if (/^null$/iu.test(bare)) {
    return undefined;
  }
  if (neutral.kind === 'boolean') {
    if (/^(true|'t'|'true'|b?'1'|1)$/iu.test(bare)) {
      return to === 'mysql' || to === 'mssql' || to === 'oracle'
        ? '1'
        : to === 'clickhouse'
          ? 'true'
          : 'TRUE';
    }
    if (/^(false|'f'|'false'|b?'0'|0)$/iu.test(bare)) {
      return to === 'mysql' || to === 'mssql' || to === 'oracle'
        ? '0'
        : to === 'clickhouse'
          ? 'false'
          : 'FALSE';
    }
    return undefined;
  }
  if (/^[+-]?\d+(\.\d+)?$/u.test(bare)) {
    return bare;
  }
  if (/^'(?:[^'\\]|'')*'$/u.test(bare)) {
    return bare;
  }
  const today = /^(current_date|today\s*\(\s*\)|trunc\s*\(\s*sysdate\s*\))$/iu;
  if (NOW.test(bare) || today.test(bare) || /^current_time$/iu.test(bare)) {
    // Oracle keeps a time of day as text (see oracleType), which takes no clock.
    if (to === 'oracle' && neutral.kind === 'time') {
      return undefined;
    }
    if (today.test(bare)) {
      // SQL Server 2022 has no CURRENT_DATE.
      return to === 'mssql'
        ? 'CAST(GETDATE() AS date)'
        : to === 'clickhouse'
          ? 'today()'
          : to === 'oracle'
            ? 'TRUNC(SYSDATE)'
            : 'CURRENT_DATE';
    }
    if (to === 'oracle') {
      return neutral.kind === 'datetime' && (neutral.precision ?? 6) === 0
        ? 'SYSDATE'
        : 'SYSTIMESTAMP';
    }
    if (to === 'clickhouse') {
      const digits = neutral.kind === 'datetime' ? (neutral.precision ?? 6) : 0;
      return digits > 0 ? `now64(${digits})` : 'now()';
    }
    if (to === 'mssql') {
      return neutral.kind === 'datetime' && neutral.zone ? 'SYSDATETIMEOFFSET()' : 'SYSDATETIME()';
    }
    if (neutral.kind === 'datetime' && to === 'mysql' && (neutral.precision ?? 6) > 0) {
      return `CURRENT_TIMESTAMP(${neutral.precision ?? 6})`;
    }
    return 'CURRENT_TIMESTAMP';
  }
  return undefined;
}
