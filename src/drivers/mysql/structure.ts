// The structure of an existing MySQL or MariaDB table for the designer. The two
// servers print defaults differently: MySQL 8 stores the bare value and marks
// expressions, MariaDB stores a SQL expression already. Both become an expression.

import { DbError } from '../../core/errors';
import type { ColumnDetail, TableRef, TableStructure } from '../../core/model/objects';
import type { MetadataReader } from '../driver';
import type { MysqlRowReader } from './definitions';
import { quoteString } from './quote';
import { msg } from '../../core/user-message';

/** Types whose default MySQL prints without quotes and that need none. */
const NUMERIC = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'double',
  'real',
  'bit',
  'year',
]);

/** Functions MySQL accepts after DEFAULT without parentheses. */
const BARE_FUNCTION = /^(current_timestamp|now|localtime|localtimestamp)(\(\d*\))?$/i;

/**
 * The default of a column as an expression to write after DEFAULT. `ON UPDATE …`
 * rides along, because rewriting the column without it would silently drop it.
 */
export function mysqlDefaultExpression(
  raw: string | undefined,
  extra: string,
  dataType: string,
  mariaDb: boolean,
): string | undefined {
  let expression: string | undefined;
  if (raw === undefined) {
    expression = undefined;
  } else if (mariaDb) {
    expression = raw === 'NULL' ? undefined : raw;
  } else if (/DEFAULT_GENERATED/i.test(extra)) {
    expression = BARE_FUNCTION.test(raw) ? raw : `(${raw})`;
  } else if (NUMERIC.has(dataType.toLowerCase()) || /^b'[01]*'$/i.test(raw)) {
    expression = raw;
  } else {
    expression = quoteString(raw);
  }
  const onUpdate = /\bon update (\w+(?:\(\d*\))?)/i.exec(extra);
  if (onUpdate !== null) {
    return `${expression ?? 'NULL'} ON UPDATE ${onUpdate[1] ?? ''}`;
  }
  return expression;
}

export async function readMysqlStructure(
  read: MysqlRowReader,
  table: TableRef,
  reader: Pick<MetadataReader, 'listIndexes' | 'listForeignKeys'>,
): Promise<TableStructure> {
  const scope = [table.database ?? null, table.name];
  const rows = await read(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, DATA_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    scope,
  );
  if (rows.length === 0) {
    throw new DbError('not-found', msg('{0} does not exist', table.name));
  }
  const [version] = await read('SELECT VERSION()');
  const mariaDb = /mariadb/i.test(text(version?.[0]));
  const columns = rows.map((row): ColumnDetail => {
    const extra = text(row[4]);
    const defaultExpression = mysqlDefaultExpression(
      optional(row[3]),
      extra,
      text(row[6]),
      mariaDb,
    );
    const comment = text(row[5]);
    return {
      name: text(row[0]),
      dataType: text(row[1]),
      nullable: text(row[2]).toUpperCase() === 'YES',
      autoIncrement: /auto_increment/i.test(extra),
      generated: /\b(virtual|stored|persistent) generated\b/i.test(extra),
      ...(defaultExpression === undefined ? {} : { defaultExpression }),
      ...(comment === '' ? {} : { comment }),
    };
  });
  const [tableRow] = await read(
    `SELECT TABLE_COMMENT, TABLE_TYPE FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`,
    scope,
  );
  // MySQL fills the comment of every view with the word VIEW.
  const comment = /VIEW/i.test(text(tableRow?.[1])) ? '' : text(tableRow?.[0]);
  const indexes = await reader.listIndexes(table);
  return {
    columns,
    primaryKey: indexes.find((index) => index.primary)?.columns ?? [],
    indexes,
    foreignKeys: await reader.listForeignKeys(table),
    checks: await readMysqlChecks(read, scope, mariaDb),
    ...(comment === '' ? {} : { comment }),
  };
}

/**
 * CHECK constraints: MySQL 8.0.16+ and MariaDB 10.2+ keep them in information_schema.
 * An older server has no such table; it simply has no checks to show.
 */
async function readMysqlChecks(
  read: MysqlRowReader,
  scope: (string | null)[],
  mariaDb: boolean,
): Promise<{ name: string; expression: string }[]> {
  try {
    const rows = mariaDb
      ? await read(
          `SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
           WHERE CONSTRAINT_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
           ORDER BY CONSTRAINT_NAME`,
          scope,
        )
      : await read(
          `SELECT c.CONSTRAINT_NAME, c.CHECK_CLAUSE
           FROM information_schema.CHECK_CONSTRAINTS c
           JOIN information_schema.TABLE_CONSTRAINTS t
             ON t.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME
           WHERE t.TABLE_SCHEMA = COALESCE(?, DATABASE()) AND t.TABLE_NAME = ?
             AND t.CONSTRAINT_TYPE = 'CHECK'
           ORDER BY c.CONSTRAINT_NAME`,
          scope,
        );
    return rows.map((row) => ({ name: text(row[0]), expression: text(row[1]) }));
  } catch {
    // Servers without the view: no checks to list.
    return [];
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value);
}
