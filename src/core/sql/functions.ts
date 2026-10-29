// Functions completion offers, with their arguments as snippet placeholders. A short
// list of what people type every day per dialect, not the whole manual.

import { type DriverId, isSqlDriver, type SqlDriverId } from '../../shared/connection';

export interface SqlFunction {
  readonly name: string;
  /** Argument names, shown as placeholders: `COALESCE(value, fallback)`. */
  readonly args: readonly string[];
}

function fn(name: string, ...args: string[]): SqlFunction {
  return { name, args };
}

/** LENGTH and SUBSTR are spelled LEN and SUBSTRING in SQL Server. */
const LENGTH_SUBSTR: readonly SqlFunction[] = [
  fn('LENGTH', 'text'),
  fn('SUBSTR', 'text', 'start', 'length'),
];

const COMMON: readonly SqlFunction[] = [
  fn('COUNT', 'expression'),
  fn('SUM', 'expression'),
  fn('AVG', 'expression'),
  fn('MIN', 'expression'),
  fn('MAX', 'expression'),
  fn('COALESCE', 'value', 'fallback'),
  fn('NULLIF', 'value', 'other'),
  fn('CAST', 'value AS type'),
  fn('LOWER', 'text'),
  fn('UPPER', 'text'),
  fn('TRIM', 'text'),
  fn('REPLACE', 'text', 'from', 'to'),
  fn('ABS', 'number'),
  fn('ROUND', 'number', 'digits'),
  fn('ROW_NUMBER'),
  fn('RANK'),
  fn('LAG', 'expression'),
  fn('LEAD', 'expression'),
];

const BY_DRIVER: Readonly<Record<SqlDriverId, readonly SqlFunction[]>> = {
  mysql: [
    ...LENGTH_SUBSTR,
    fn('NOW'),
    fn('CURDATE'),
    fn('DATE_FORMAT', 'date', 'format'),
    fn('DATE_ADD', 'date', 'INTERVAL 1 DAY'),
    fn('DATEDIFF', 'end', 'start'),
    fn('CONCAT', 'a', 'b'),
    fn('CONCAT_WS', 'separator', 'a', 'b'),
    fn('GROUP_CONCAT', 'expression'),
    fn('IFNULL', 'value', 'fallback'),
    fn('IF', 'condition', 'then', 'else'),
    fn('JSON_EXTRACT', 'document', 'path'),
    fn('JSON_OBJECT', 'key', 'value'),
    fn('UUID'),
    fn('LAST_INSERT_ID'),
  ],
  postgres: [
    ...LENGTH_SUBSTR,
    fn('NOW'),
    fn('CURRENT_DATE'),
    fn('DATE_TRUNC', 'unit', 'timestamp'),
    fn('EXTRACT', 'field FROM source'),
    fn('TO_CHAR', 'value', 'format'),
    fn('AGE', 'end', 'start'),
    fn('CONCAT', 'a', 'b'),
    fn('STRING_AGG', 'expression', 'separator'),
    fn('ARRAY_AGG', 'expression'),
    fn('JSONB_BUILD_OBJECT', 'key', 'value'),
    fn('JSONB_AGG', 'expression'),
    fn('GEN_RANDOM_UUID'),
    fn('GENERATE_SERIES', 'start', 'stop'),
    fn('REGEXP_REPLACE', 'text', 'pattern', 'replacement'),
  ],
  sqlite: [
    ...LENGTH_SUBSTR,
    fn('DATETIME', 'value'),
    fn('DATE', 'value'),
    fn('STRFTIME', 'format', 'value'),
    fn('IFNULL', 'value', 'fallback'),
    fn('IIF', 'condition', 'then', 'else'),
    fn('GROUP_CONCAT', 'expression', 'separator'),
    fn('JSON_EXTRACT', 'document', 'path'),
    fn('JSON_OBJECT', 'key', 'value'),
    fn('INSTR', 'text', 'part'),
    fn('PRINTF', 'format', 'value'),
    fn('RANDOM'),
    fn('TYPEOF', 'value'),
  ],
  mssql: [
    fn('LEN', 'text'),
    fn('SUBSTRING', 'text', 'start', 'length'),
    fn('GETDATE'),
    fn('SYSDATETIME'),
    fn('SYSDATETIMEOFFSET'),
    fn('DATEADD', 'day', 'number', 'date'),
    fn('DATEDIFF', 'day', 'start', 'end'),
    fn('DATEPART', 'part', 'date'),
    fn('FORMAT', 'value', 'format'),
    fn('CONVERT', 'type', 'value', 'style'),
    fn('TRY_CAST', 'value AS type'),
    fn('TRY_CONVERT', 'type', 'value'),
    fn('ISNULL', 'value', 'fallback'),
    fn('IIF', 'condition', 'then', 'else'),
    fn('CONCAT', 'a', 'b'),
    fn('STRING_AGG', 'expression', 'separator'),
    fn('CHARINDEX', 'part', 'text'),
    fn('JSON_VALUE', 'document', 'path'),
    fn('NEWID'),
    fn('SCOPE_IDENTITY'),
    fn('OBJECT_ID', 'name'),
  ],
  clickhouse: [
    ...LENGTH_SUBSTR,
    fn('now'),
    fn('today'),
    fn('toDate', 'value'),
    fn('toDateTime', 'value'),
    fn('toStartOfDay', 'time'),
    fn('toStartOfMonth', 'date'),
    fn('dateDiff', "'day'", 'start', 'end'),
    fn('formatDateTime', 'time', 'format'),
    fn('toString', 'value'),
    fn('toInt64', 'value'),
    fn('concat', 'a', 'b'),
    fn('ifNull', 'value', 'fallback'),
    fn('if', 'condition', 'then', 'else'),
    fn('uniq', 'expression'),
    fn('uniqExact', 'expression'),
    fn('countIf', 'condition'),
    fn('sumIf', 'expression', 'condition'),
    fn('groupArray', 'expression'),
    fn('arrayJoin', 'array'),
    fn('quantile', 'level)(expression'),
    fn('JSONExtractString', 'json', 'key'),
    fn('generateUUIDv4'),
  ],
  oracle: [
    ...LENGTH_SUBSTR,
    fn('SYSDATE'),
    fn('SYSTIMESTAMP'),
    fn('TO_CHAR', 'value', 'format'),
    fn('TO_DATE', 'text', "'YYYY-MM-DD'"),
    fn('TO_TIMESTAMP', 'text', 'format'),
    fn('TO_NUMBER', 'text'),
    fn('TRUNC', 'date'),
    fn('ADD_MONTHS', 'date', 'months'),
    fn('MONTHS_BETWEEN', 'end', 'start'),
    fn('NVL', 'value', 'fallback'),
    fn('NVL2', 'value', 'if_not_null', 'if_null'),
    fn('DECODE', 'value', 'match', 'result', 'default'),
    fn('INSTR', 'text', 'part'),
    fn('LISTAGG', "expression, ','"),
    fn('REGEXP_LIKE', 'text', 'pattern'),
    fn('REGEXP_REPLACE', 'text', 'pattern', 'replacement'),
    fn('JSON_VALUE', 'document', 'path'),
    fn('SYS_GUID'),
  ],
};

/** The functions of a dialect, common ones first; standard SQL when none is known. */
export function functionsOf(driver?: DriverId): readonly SqlFunction[] {
  return driver === undefined || !isSqlDriver(driver) ? COMMON : [...COMMON, ...BY_DRIVER[driver]];
}

/** `COALESCE(${1:value}, ${2:fallback})`: a call with tab stops for its arguments. */
export function callSnippet(fn: SqlFunction): string {
  const args = fn.args.map((arg, index) => `\${${index + 1}:${arg}}`).join(', ');
  return `${fn.name}(${args})`;
}
