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

/** What a rebuild carries over that the design does not describe. */
export interface CreateExtras {
  /** Table constraints, as `CONSTRAINT "n" CHECK (…)` or `CHECK (…)`. */
  readonly constraints?: readonly string[];
  /** After the closing parenthesis: `WITHOUT ROWID`, `STRICT`. */
  readonly options?: string;
  /** Comment lines in front of the statement, for the preview. */
  readonly comments?: readonly string[];
}

export function sqliteCreateTable(
  table: TableRef,
  design: TableDesign,
  extras: CreateExtras = {},
): string[] {
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
  const options = extras.options === undefined || extras.options === '' ? '' : ` ${extras.options}`;
  const create = createTableSql(
    target,
    [
      ...columns,
      ...(inlineKey ? [] : primaryKeySql(design, quoteIdentifier)),
      ...keys,
      ...(extras.constraints ?? []),
    ],
    options,
  );
  const comments = (extras.comments ?? []).map((line) => `${line}\n`).join('');
  return [
    `${comments}${create}`,
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
