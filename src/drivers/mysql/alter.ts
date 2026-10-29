// ALTER TABLE for MySQL, MariaDB and TiDB. DDL there is not transactional, so the plan
// keeps few statements: keys out, one ALTER for columns, indexes and the primary
// key (renames first where a column is placed after a renamed one), keys back in, then
// the rename.

import type { ColumnDesign, TableBackground, TableDesign } from '../../shared/table-design';
import { diffTables, isEmptyDiff } from '../../shared/table-diff';
import type { TableRef } from '../../core/model/objects';
import { type AlterPlan, EMPTY_PLAN } from '../driver';
import { columnList, columnSql, foreignKeySql } from '../common/design-sql';
import { mysqlDefault } from './defaults';
import { quoteIdentifier, quoteString, quoteTable } from './quote';

function definition(column: ColumnDesign): string {
  return columnSql(column, {
    quote: quoteIdentifier,
    autoIncrement: () => 'AUTO_INCREMENT',
    trailer: (c) => (c.comment === '' ? '' : `COMMENT ${quoteString(c.comment)}`),
    defaultSql: mysqlDefault,
  });
}

/**
 * Clauses that add and move columns. The final order is reached by walking the new
 * order and placing a column only where it does not already follow the right one,
 * so unchanged columns are not rewritten (a rewrite would drop what the designer
 * does not model, such as a column collation).
 */
function columnClauses(
  before: TableDesign,
  after: TableDesign,
  changed: ReadonlySet<string>,
): string[] {
  const keptIds = new Set(after.columns.map((column) => column.id));
  const current = before.columns.filter((column) => keptIds.has(column.id)).map((c) => c.id);
  const clauses: string[] = [];
  after.columns.forEach((column, index) => {
    const previous = index === 0 ? undefined : after.columns[index - 1];
    const position =
      previous === undefined ? 'FIRST' : `AFTER ${quoteIdentifier(previous.name.trim())}`;
    const at = current.indexOf(column.id);
    const wanted = previous === undefined ? 0 : current.indexOf(previous.id) + 1;
    if (column.original === undefined || at === -1) {
      clauses.push(`ADD COLUMN ${definition(column)} ${position}`);
      current.splice(wanted, 0, column.id);
      return;
    }
    const moved = at !== wanted;
    if (moved) {
      current.splice(at, 1);
      current.splice(current.indexOf(previous?.id ?? '') + 1, 0, column.id);
    }
    if (moved || changed.has(column.id)) {
      clauses.push(
        `CHANGE COLUMN ${quoteIdentifier(column.original)} ${definition(column)}${moved ? ` ${position}` : ''}`,
      );
    }
  });
  return clauses;
}

export function mysqlAlterTable(
  table: TableRef,
  before: TableDesign,
  after: TableDesign,
  _background: TableBackground,
): AlterPlan {
  const diff = diffTables(before, after);
  if (isEmptyDiff(diff)) {
    return EMPTY_PLAN;
  }
  const target = quoteTable(table);
  const statements: string[] = [];
  if (diff.droppedKeys.length > 0) {
    // Keys go first: the columns and indexes they lean on may change below.
    statements.push(
      `ALTER TABLE ${target}\n  ${diff.droppedKeys
        .map((key) => `DROP FOREIGN KEY ${quoteIdentifier(key.original ?? key.name)}`)
        .join(',\n  ')}`,
    );
  }
  let changed = new Set(diff.changed.map((change) => change.after.id));
  const keyColumns = after.columns.filter((column) => column.primaryKey).map((c) => c.id);
  let columns = columnClauses(before, after, changed);
  // TiDB reads `AFTER x` by the names the table had before the statement, MySQL by those
  // after it: a column placed after a renamed one gets the rename in a statement first.
  const renames = after.columns.filter(
    (column) => column.original !== undefined && column.original !== column.name.trim(),
  );
  const leansOnRename = renames.some((column) =>
    columns.some(
      (clause) =>
        !clause.startsWith(`CHANGE COLUMN ${quoteIdentifier(column.original ?? '')} `) &&
        clause.endsWith(`AFTER ${quoteIdentifier(column.name.trim())}`),
    ),
  );
  if (leansOnRename) {
    statements.push(
      `ALTER TABLE ${target}\n  ${renames
        .map(
          (column) =>
            `CHANGE COLUMN ${quoteIdentifier(column.original ?? '')} ${definition(column)}`,
        )
        .join(',\n  ')}`,
    );
    const renamedIds = new Set(renames.map((column) => column.id));
    const renamed = (list: readonly ColumnDesign[]): ColumnDesign[] =>
      list.map((column) => {
        const now = renames.find((rename) => rename.id === column.id);
        return now === undefined ? column : { ...now, original: now.name.trim() };
      });
    changed = new Set([...changed].filter((id) => !renamedIds.has(id)));
    columns = columnClauses(
      { ...before, columns: renamed(before.columns) },
      { ...after, columns: renamed(after.columns) },
      changed,
    );
  }
  const clauses = [
    ...diff.droppedIndexes.map(
      (index) => `DROP INDEX ${quoteIdentifier(index.original ?? index.name)}`,
    ),
    ...(diff.primaryKey && before.columns.some((column) => column.primaryKey)
      ? ['DROP PRIMARY KEY']
      : []),
    ...diff.dropped.map(
      (column) => `DROP COLUMN ${quoteIdentifier(column.original ?? column.name)}`,
    ),
    ...columns,
    ...(diff.primaryKey && keyColumns.length > 0
      ? [`ADD PRIMARY KEY ${columnList(after, keyColumns, quoteIdentifier)}`]
      : []),
    ...diff.addedIndexes.map(
      (index) =>
        `ADD ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(index.name.trim())} ${columnList(after, index.columns, quoteIdentifier)}`,
    ),
    ...(diff.comment ? [`COMMENT = ${quoteString(after.comment)}`] : []),
  ];
  if (clauses.length > 0) {
    statements.push(`ALTER TABLE ${target}\n  ${clauses.join(',\n  ')}`);
  }
  if (diff.addedKeys.length > 0) {
    statements.push(
      `ALTER TABLE ${target}\n  ${diff.addedKeys
        .map(
          (key) =>
            `ADD ${foreignKeySql(
              after,
              key,
              quoteIdentifier,
              quoteTable({
                ...table,
                ...(key.targetSchema === undefined ? {} : { database: key.targetSchema }),
                name: key.targetTable.trim(),
              }),
            )}`,
        )
        .join(',\n  ')}`,
    );
  }
  if (diff.renamed) {
    statements.push(
      `RENAME TABLE ${target} TO ${quoteTable({ ...table, name: after.name.trim() })}`,
    );
  }
  return { statements, notes: [], recovery: [] };
}
