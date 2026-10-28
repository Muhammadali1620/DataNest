// CREATE TABLE for SQLite, shared by the designer of new tables and the rebuild
// that ALTER falls back to.

import type { TableRef } from '../../core/model/objects';
import type { TableDesign } from '../../shared/table-design';
import {
  columnSql,
  createIndexSql,
  createTableSql,
  foreignKeySql,
  primaryKeySql,
} from '../common/design-sql';
import { quoteIdentifier, quoteTable } from './quote';

export function sqliteCreateTable(table: TableRef, design: TableDesign): string[] {
  // AUTOINCREMENT exists only as part of an inline INTEGER PRIMARY KEY.
  const inlineKey = design.columns.some((column) => column.autoIncrement);
  const columns = design.columns.map((column) =>
    columnSql(column, {
      quote: quoteIdentifier,
      autoIncrement: () => 'PRIMARY KEY AUTOINCREMENT',
      trailer: () => '',
    }),
  );
  const target = quoteTable({ ...table, name: design.name.trim() });
  // A foreign key in SQLite can only point into the same database file.
  const keys = design.foreignKeys.map((key) =>
    foreignKeySql(design, key, quoteIdentifier, quoteIdentifier(key.targetTable.trim())),
  );
  return [
    createTableSql(target, [
      ...columns,
      ...(inlineKey ? [] : primaryKeySql(design, quoteIdentifier)),
      ...keys,
    ]),
    // An attached database names the index, not the table: "aux"."ix" ON "t".
    ...design.indexes.map((index) =>
      createIndexSql(
        design,
        index,
        quoteIdentifier,
        quoteIdentifier(design.name.trim()),
        quoteTable({ ...table, name: index.name.trim() }),
      ),
    ),
  ];
}
