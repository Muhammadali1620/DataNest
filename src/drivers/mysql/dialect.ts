import { mysqlDump } from './dump';
import { wktToMysqlGeometry } from '../../core/geo/wkb';
import { KEYWORDS } from '../../core/sql/keywords';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect } from '../driver';
import { STANDARD_TRANSACTION } from '../common/transaction';
import { quoteIdentifier, quoteString, quoteTable } from './quote';
import { mysqlDdl } from './ddl';

export { quoteIdentifier, quoteTable };

/**
 * Renders a value as a MySQL literal. Only for generated SQL the user previews;
 * user input in queries goes through driver parameters instead (ARCHITECTURE.md §8).
 */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'string') {
    return quoteString(value);
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
      case 'decimal':
        return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.text)
          ? value.text
          : quoteString(value.text);
      case 'datetime':
      case 'json':
        return quoteString(value.text);
      case 'binary':
        return `x'${value.preview}'`;
    }
  }
  return 'NULL';
}

/**
 * A geometry the driver showed as text (`SRID=4326;POINT(1 2)`, V13.13), as the value the
 * server keeps: the hex of four bytes of SRID and the WKB. MySQL and MariaDB take that for
 * a spatial column as it is (mysqldump writes the same), in the axis order they store,
 * which is the order of the text; ST_GeomFromText would swap latitude and longitude on
 * MySQL 8 for a geographic SRID and does not exist in the same form on MariaDB. Only
 * a plain 2D geometry gets here, so nothing but hex digits is written.
 */
export function spatialLiteral(text: string): string | undefined {
  const bytes = wktToMysqlGeometry(text);
  return bytes === undefined ? undefined : `x'${Buffer.from(bytes).toString('hex')}'`;
}

export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0 ? `${base} LIMIT ${limit}` : `${base} LIMIT ${limit} OFFSET ${offset}`;
}

export const mysqlDialect: Dialect = {
  keywords: KEYWORDS.mysql,
  quoteIdentifier,
  quoteTable,
  literal,
  spatialLiteral,
  paginate,
  estimateRowsSql: (table) =>
    `SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${
      table.database === undefined ? 'DATABASE()' : quoteString(table.database)
    } AND TABLE_NAME = ${quoteString(table.name)}`,
  // A named zone needs the server's time zone tables; an offset always works.
  setTimeZone: (zone) => `SET time_zone = ${quoteString(zone)}`,
  likeText: (quotedColumn, quotedPattern) =>
    `CAST(${quotedColumn} AS CHAR) LIKE ${quotedPattern} ESCAPE '!'`,
  defaultKeyword: true,
  insertDefaultRow: (quotedTable) => `INSERT INTO ${quotedTable} () VALUES ()`,
  transaction: STANDARD_TRANSACTION,
  ddl: mysqlDdl,
  dump: mysqlDump,
};
