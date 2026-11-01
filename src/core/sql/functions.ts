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

/** InfluxQL aggregates and selectors, then the Flux functions most queries start with. */
const INFLUX_FUNCTIONS: readonly SqlFunction[] = [
  fn('COUNT', 'field'),
  fn('MEAN', 'field'),
  fn('MEDIAN', 'field'),
  fn('SUM', 'field'),
  fn('MIN', 'field'),
  fn('MAX', 'field'),
  fn('FIRST', 'field'),
  fn('LAST', 'field'),
  fn('SPREAD', 'field'),
  fn('STDDEV', 'field'),
  fn('PERCENTILE', 'field', 'n'),
  fn('DERIVATIVE', 'field', 'unit'),
  fn('NON_NEGATIVE_DERIVATIVE', 'field', 'unit'),
  fn('MOVING_AVERAGE', 'field', 'n'),
  fn('NOW'),
  fn('time', 'interval'),
  fn('from', 'bucket: "name"'),
  fn('range', 'start: -1h'),
  fn('filter', 'fn: (r) => r._measurement == "name"'),
  fn('aggregateWindow', 'every: 1m', 'fn: mean'),
  fn('window', 'every: 1m'),
  fn('mean'),
  fn('sum'),
  fn('last'),
  fn('first'),
  fn('limit', 'n: 100'),
  fn('sort', 'columns: ["_time"]'),
  fn('keep', 'columns: ["_time", "_value"]'),
  fn('group', 'columns: []'),
  fn('pivot', 'rowKey: ["_time"]', 'columnKey: ["_field"]', 'valueColumn: "_value"'),
  fn('map', 'fn: (r) => ({ r with _value: r._value })'),
  fn('derivative', 'unit: 1s'),
];

const OWN: Readonly<Record<Exclude<SqlDriverId, 'libsql'>, readonly SqlFunction[]>> = {
  // Cypher (V13.21): the functions people reach for first.
  neo4j: [
    fn('labels', 'node'),
    fn('type', 'relationship'),
    fn('elementId', 'entity'),
    fn('id', 'entity'),
    fn('keys', 'entity'),
    fn('properties', 'entity'),
    fn('nodes', 'path'),
    fn('relationships', 'path'),
    fn('startNode', 'relationship'),
    fn('endNode', 'relationship'),
    fn('size', 'list'),
    fn('head', 'list'),
    fn('last', 'list'),
    fn('range', 'start', 'end'),
    fn('collect', 'expression'),
    fn('toString', 'value'),
    fn('toInteger', 'value'),
    fn('toFloat', 'value'),
    fn('toBoolean', 'value'),
    fn('toLower', 'text'),
    fn('toUpper', 'text'),
    fn('split', 'text', 'delimiter'),
    fn('substring', 'text', 'start', 'length'),
    fn('datetime'),
    fn('date'),
    fn('duration', 'map'),
    fn('timestamp'),
    fn('rand'),
    fn('point', 'map'),
    fn('distance', 'point1', 'point2'),
    fn('shortestPath', 'pattern'),
    fn('count', 'expression'),
    fn('sum', 'expression'),
    fn('avg', 'expression'),
    fn('min', 'expression'),
    fn('max', 'expression'),
    fn('coalesce', 'value', 'fallback'),
    fn('abs', 'number'),
    fn('round', 'number'),
    fn('floor', 'number'),
    fn('ceil', 'number'),
    fn('sqrt', 'number'),
  ],
  influxdb: INFLUX_FUNCTIONS,
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
  // A plugin's own functions are not known: the editor offers only what the server tells.
  plugin: [],
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

/** A libSQL server runs SQLite's SQL (V13.17). */
const BY_DRIVER: Readonly<Record<SqlDriverId, readonly SqlFunction[]>> = {
  ...OWN,
  libsql: OWN.sqlite,
};

/** The functions of a dialect, common ones first; standard SQL when none is known. */
export function functionsOf(driver?: DriverId): readonly SqlFunction[] {
  if (driver === 'neo4j') {
    // Cypher has none of the SQL functions that COMMON lists.
    return BY_DRIVER.neo4j;
  }
  return driver === undefined || !isSqlDriver(driver) ? COMMON : [...COMMON, ...BY_DRIVER[driver]];
}

/** `COALESCE(${1:value}, ${2:fallback})`: a call with tab stops for its arguments. */
export function callSnippet(fn: SqlFunction): string {
  const args = fn.args.map((arg, index) => `\${${index + 1}:${arg}}`).join(', ');
  return `${fn.name}(${args})`;
}
