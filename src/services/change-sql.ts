// Turns the pending edits of a result into the INSERT/UPDATE/DELETE statements that
// would save them. Identifiers and values go through the driver's Dialect only
// (ARCHITECTURE.md §8); rows are found by their key as it was *before* the edit.

import type { EditableColumn, EditableResult } from '../core/model/editability';
import type { Dialect } from '../drivers/driver';
import type { CellChange, PendingRow, ResultRow } from './pending-edits';
import { exactLiteralOf } from './sql-literal';

export type ChangeKind = 'delete' | 'update' | 'insert';

export interface ChangeStatement {
  readonly kind: ChangeKind;
  readonly sql: string;
  /**
   * Rows the statement must affect for the save to be trusted: one for a row found
   * by its key, none to check for an insert (servers differ in what they report).
   */
  readonly expectedRows: number | undefined;
}

export interface ChangePlan {
  readonly edit: EditableResult;
  readonly updates: readonly { readonly row: ResultRow; readonly cells: PendingRow }[];
  readonly deletions: readonly ResultRow[];
  readonly insertions: readonly PendingRow[];
}

/**
 * Deletes first, then updates, then inserts: a row removed and another written with
 * its key (or an update that takes a freed key) must not collide with itself.
 */
export function buildChangeStatements(plan: ChangePlan, dialect: Dialect): ChangeStatement[] {
  const { edit } = plan;
  const table = dialect.quoteTable(edit.table);
  const statements: ChangeStatement[] = [];

  const where = (row: ResultRow): string =>
    edit.keyIndexes
      .map((index) => {
        const name = columnAt(edit.columns, index).name;
        const value = row[index] ?? null;
        const column = dialect.quoteIdentifier(name);
        return value === null ? `${column} IS NULL` : `${column} = ${dialect.literal(value)}`;
      })
      .join(' AND ');

  for (const row of plan.deletions) {
    statements.push({
      kind: 'delete',
      sql: `DELETE FROM ${table} WHERE ${where(row)}`,
      expectedRows: 1,
    });
  }

  for (const { row, cells } of plan.updates) {
    const assignments = [...cells]
      .sort(([left], [right]) => left - right)
      .map(([index, change]) => {
        const info = columnAt(edit.columns, index);
        return `${dialect.quoteIdentifier(info.name)} = ${valueSql(change, info, dialect)}`;
      });
    if (assignments.length > 0) {
      statements.push({
        kind: 'update',
        sql: `UPDATE ${table} SET ${assignments.join(', ')} WHERE ${where(row)}`,
        expectedRows: 1,
      });
    }
  }

  for (const cells of plan.insertions) {
    const entries = [...cells].sort(([left], [right]) => left - right);
    if (entries.length === 0) {
      statements.push({ kind: 'insert', sql: dialect.insertDefaultRow(table), expectedRows: 1 });
      continue;
    }
    const names = entries.map(([index]) =>
      dialect.quoteIdentifier(columnAt(edit.columns, index).name),
    );
    const values = entries.map(([index, change]) =>
      valueSql(change, columnAt(edit.columns, index), dialect),
    );
    statements.push({
      kind: 'insert',
      sql: `INSERT INTO ${table} (${names.join(', ')}) VALUES (${values.join(', ')})`,
      expectedRows: 1,
    });
  }
  return statements;
}

function columnAt(columns: readonly (EditableColumn | null)[], index: number): EditableColumn {
  const info = columns[index];
  if (info === undefined || info === null) {
    // The editor never queues a change for a computed column, so this is a bug.
    throw new Error(`Column ${index} is not backed by a table column`);
  }
  return info;
}

function valueSql(change: CellChange, info: EditableColumn, dialect: Dialect): string {
  if (change.kind === 'value') {
    // A binary value from a file carries its bytes; never write just its preview.
    return exactLiteralOf(dialect, change.value);
  }
  if (dialect.defaultKeyword) {
    return 'DEFAULT';
  }
  // The default is an expression from the schema (e.g. `'x'` or `CURRENT_TIMESTAMP`).
  return info.defaultValue ?? 'NULL';
}
