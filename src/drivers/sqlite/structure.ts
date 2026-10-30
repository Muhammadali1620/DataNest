// The structure of an existing SQLite table for the designer. SQLite keeps the
// original CREATE text, so AUTOINCREMENT and the indexes and triggers a rebuild
// must recreate are read from sqlite_master.

import { DbError } from '../../core/errors';
import type {
  ColumnDetail,
  TableDependent,
  TableRef,
  TableStructure,
} from '../../core/model/objects';
import type { CellValue } from '../../shared/cell-value';
import type { MetadataReader } from '../driver';
import type { SqliteQueryRunner } from './metadata';
import { msg } from '../../core/user-message';

export async function readSqliteStructure(
  session: SqliteQueryRunner,
  table: TableRef,
  reader: Pick<MetadataReader, 'listIndexes' | 'listForeignKeys'>,
): Promise<TableStructure> {
  const [own] = await session.queryRows(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table.name],
  );
  if (own === undefined) {
    throw new DbError('not-found', msg('{0} does not exist', table.name));
  }
  const autoIncrement = /\bAUTOINCREMENT\b/i.test(text(own[0]));
  // hidden: 0 ordinary, 1 hidden (virtual tables), 2 and 3 generated columns.
  const rows = await session.queryRows(
    `SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)
     WHERE hidden <> 1 ORDER BY cid`,
    [table.name],
  );
  const keyed = rows
    .filter((row) => number(row[4]) > 0)
    .sort((a, b) => number(a[4]) - number(b[4]))
    .map((row) => text(row[0]));
  const columns = rows.map((row): ColumnDetail => {
    const defaultExpression = optional(row[3]);
    const type = text(row[1]);
    return {
      name: text(row[0]),
      dataType: type,
      nullable: number(row[2]) === 0,
      // Only the INTEGER PRIMARY KEY of a table declared with AUTOINCREMENT counts.
      autoIncrement:
        autoIncrement && keyed.length === 1 && keyed[0] === text(row[0]) && /^integer$/i.test(type),
      generated: number(row[5]) >= 2,
      ...(defaultExpression === undefined ? {} : { defaultExpression }),
    };
  });
  const dependents = await session.queryRows(
    `SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
     ORDER BY type, name`,
    [table.name],
  );
  return {
    columns,
    primaryKey: keyed,
    indexes: await reader.listIndexes(table),
    foreignKeys: await reader.listForeignKeys(table),
    dependents: dependents.map((row): TableDependent => ({
      kind: text(row[0]) === 'trigger' ? 'trigger' : 'index',
      name: text(row[1]),
      sql: text(row[2]),
    })),
  };
}

function text(value: CellValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function optional(value: CellValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: CellValue | undefined): number {
  return typeof value === 'number' ? value : 0;
}
