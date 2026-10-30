// The script that makes the target table's rows like the source's (V8.4): INSERT the
// rows only in the source, UPDATE the columns that differ, DELETE the rows only in
// the target — each part only when asked for. Values are literals of the target's
// dialect; computed columns are never written. DataNest only writes the script.

import type { TableRef } from '../../core/model/objects';
import type { Dialect } from '../../drivers/driver';
import type { CellValue } from '../../shared/cell-value';
import type { DriverId } from '../../shared/connection';
import { commentLine, INSERT_ROWS, insertStatement, scriptStatement } from '../dump-script';
import { literalOf } from '../sql-literal';
import { transferValue } from '../transfer/transfer-values';
import type { NeutralType } from '../transfer/type-map';
import { type ColumnMode, sameValue } from './comparable';
import type { DataCompareResult, KeptRow } from './data-compare';

export interface SyncScriptInput {
  readonly dialect: Dialect;
  readonly driver: DriverId;
  /** The target table, which the script changes. */
  readonly table: TableRef;
  /** Key and compared columns as named in the target, in the order of the kept rows. */
  readonly key: readonly string[];
  readonly columns: readonly string[];
  /** Target types of the key and compared columns, in that order: source values are made to fit. */
  readonly types: readonly NeutralType[];
  /** How the key and compared columns compare, in that order. */
  readonly modes: readonly ColumnMode[];
  /** Target columns that may be written: not computed. */
  readonly writable: ReadonlySet<string>;
  /** An INSERT writes an auto-numbered column, which some databases want said. */
  readonly identity: boolean;
  /** Wrap the changes in a transaction (the database has them). */
  readonly transactions: boolean;
  readonly result: DataCompareResult;
  readonly include: {
    readonly insert: boolean;
    readonly update: boolean;
    readonly delete: boolean;
  };
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly date: Date;
}

export function syncScript(input: SyncScriptInput): string {
  const { dialect, result } = input;
  const quotedTable = dialect.quoteTable(input.table);
  const literal = (cell: CellValue): string => literalOf(dialect, cell);
  /** A source value as the target column takes it. */
  const fitted = (cell: CellValue, index: number): string => {
    const type = input.types[index];
    return literal(type === undefined ? cell : transferValue(cell, type));
  };
  const width = input.key.length;
  const where = (row: KeptRow): string =>
    input.key
      .map((column, index) => {
        const cell = row[index] ?? null;
        const name = dialect.quoteIdentifier(column);
        return cell === null ? `${name} IS NULL` : `${name} = ${literal(cell)}`;
      })
      .join(' AND ');

  const out: string[] = [
    commentLine('DataNest data sync'),
    commentLine(`From (source): ${input.sourceLabel}`),
    commentLine(`To (target):   ${input.targetLabel}`),
    commentLine(`Written ${input.date.toISOString()}. Review it before running.`),
  ];
  const body: string[] = [];

  if (input.include.insert && result.onlySourceRows.length > 0) {
    const all = [...input.key, ...input.columns];
    const positions = all.flatMap((column, index) =>
      index < width || input.writable.has(column) ? [index] : [],
    );
    const quotedColumns = positions.map((index) => dialect.quoteIdentifier(all[index] ?? ''));
    body.push('\n', commentLine(`Rows only in the source: ${result.onlySource}`));
    note(body, result.onlySource, result.onlySourceRows.length);
    for (let start = 0; start < result.onlySourceRows.length; start += INSERT_ROWS) {
      const tuples = result.onlySourceRows
        .slice(start, start + INSERT_ROWS)
        .map(
          (row) => `(${positions.map((index) => fitted(row[index] ?? null, index)).join(', ')})`,
        );
      body.push(
        insertStatement(
          dialect.dump.insert(quotedTable, quotedColumns, tuples, input.identity),
          input.driver,
        ),
      );
    }
  }

  if (input.include.update && result.differentRows.length > 0) {
    body.push('\n', commentLine(`Rows that differ: ${result.different}`));
    note(body, result.different, result.differentRows.length);
    for (const { source, target } of result.differentRows) {
      const sets = input.columns.flatMap((column, offset) => {
        const index = width + offset;
        const value = source[index] ?? null;
        return input.writable.has(column) &&
          !sameValue(value, target[index] ?? null, input.modes[index])
          ? [`${dialect.quoteIdentifier(column)} = ${fitted(value, index)}`]
          : [];
      });
      if (sets.length > 0) {
        body.push(
          scriptStatement(
            `UPDATE ${quotedTable} SET ${sets.join(', ')} WHERE ${where(target)}`,
            input.driver,
          ),
        );
      }
    }
  }

  if (input.include.delete && result.onlyTargetRows.length > 0) {
    body.push('\n', commentLine(`Rows only in the target: ${result.onlyTarget}`));
    note(body, result.onlyTarget, result.onlyTargetRows.length);
    for (const row of result.onlyTargetRows) {
      body.push(scriptStatement(`DELETE FROM ${quotedTable} WHERE ${where(row)}`, input.driver));
    }
  }

  if (body.length === 0) {
    out.push('\n', commentLine('Nothing to change.'));
    return out.join('');
  }
  if (input.transactions) {
    out.push('\n', scriptStatement(dialect.transaction.begin, input.driver));
  }
  out.push(...body);
  if (input.transactions) {
    out.push('\n', scriptStatement(dialect.transaction.commit, input.driver));
  }
  return out.join('');
}

function note(out: string[], total: number, kept: number): void {
  if (kept < total) {
    out.push(commentLine(`Only the first ${kept} of them; compare again after running this.`));
  }
}
