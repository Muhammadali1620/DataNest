// Applies one edit of a cell to a result: checks the cell may be edited, reads what
// the user typed by the column's type, and queues the change in the ResultStore.
// Nothing reaches the database here; saving is a separate step (V2.4).

import { cellText } from '../shared/cell-text';
import type { RowAction } from '../shared/row-action';
import { type EditInput, type InputProblem, parseCellInput } from '../shared/cell-input';
import type { CellValue } from '../shared/cell-value';
import type { EditableResult } from '../core/model/editability';
import type { CellChange, PendingRow, ResultStore } from './result-store';

export type EditError =
  /** The result is read-only (V2.1). */
  | 'not-editable'
  /** The row is gone: a newer run or page replaced the result. */
  | 'no-such-row'
  /** The row is marked for deletion; restore it before editing. */
  | 'row-deleted'
  /** The cell is computed or of a kind the grid cannot edit as text. */
  | 'read-only-column'
  | 'not-null'
  | InputProblem;

export type RowActionOutcome =
  /** `row` is where the grid shows the first new row, when the action made any. */
  { readonly ok: true; readonly row?: number } | { readonly ok: false; readonly error: EditError };

export type EditOutcome = { readonly ok: true } | { readonly ok: false; readonly error: EditError };

function fail(error: EditError): EditOutcome {
  return { ok: false, error };
}

/** True when writing `next` would leave the row as the server has it. */
export function sameValue(original: CellValue | undefined, next: CellValue): boolean {
  if (original === undefined || original === null || next === null) {
    return (original ?? null) === next;
  }
  return cellText(original) === cellText(next);
}

export class ResultEditor {
  constructor(private readonly results: ResultStore) {}

  editCell(resultId: string, row: number, column: number, input: EditInput): EditOutcome {
    const edit = this.results.get(resultId)?.edit;
    if (edit?.editable !== true) {
      return fail('not-editable');
    }
    const inserted = this.results.isInsertedRow(resultId, row);
    // A new row has no server value to compare with: every typed value is a change.
    const original = inserted ? [] : this.results.rowAt(resultId, row);
    if (original === undefined) {
      return fail('no-such-row');
    }
    if (this.results.isDeletedRow(resultId, row)) {
      return fail('row-deleted');
    }
    const info = edit.columns[column];
    if (info === undefined || info === null || info.kind === 'binary') {
      return fail('read-only-column');
    }
    let change: CellChange | undefined;
    switch (input.kind) {
      case 'default':
        change = { kind: 'default' };
        break;
      case 'null':
        if (!info.nullable) {
          return fail('not-null');
        }
        change =
          !inserted && original[column] === null ? undefined : { kind: 'value', value: null };
        break;
      case 'text': {
        const parsed = parseCellInput(info.kind, input.text, info.options);
        if (!parsed.ok) {
          return fail(parsed.problem);
        }
        change =
          !inserted && sameValue(original[column], parsed.value)
            ? undefined
            : { kind: 'value', value: parsed.value };
        break;
      }
    }
    return this.results.setChange(resultId, row, column, change)
      ? { ok: true }
      : fail('no-such-row');
  }

  /** Adds, duplicates, deletes or restores rows of an editable result. */
  rowAction(resultId: string, action: RowAction, rows: readonly number[]): RowActionOutcome {
    const edit = this.results.get(resultId)?.edit;
    if (edit?.editable !== true) {
      return fail('not-editable');
    }
    switch (action) {
      case 'add': {
        const row = this.results.addRow(resultId);
        return row === undefined ? fail('no-such-row') : { ok: true, row };
      }
      case 'duplicate': {
        let first: number | undefined;
        for (const index of [...new Set(rows)].sort((a, b) => a - b)) {
          const cells = this.copyOf(resultId, index, edit);
          if (cells === undefined) {
            return fail('no-such-row');
          }
          const added = this.results.addRow(resultId, cells);
          first ??= added;
        }
        return first === undefined ? { ok: true } : { ok: true, row: first };
      }
      case 'delete': {
        // Highest first: dropping a new row moves every row after it up by one.
        for (const index of [...new Set(rows)].sort((a, b) => b - a)) {
          if (!this.results.deleteRow(resultId, index)) {
            return fail('no-such-row');
          }
        }
        return { ok: true };
      }
      case 'revert':
        return this.results.revertRows(resultId, rows) ? { ok: true } : fail('no-such-row');
      case 'restore': {
        for (const index of new Set(rows)) {
          if (!this.results.restoreRow(resultId, index)) {
            return fail('no-such-row');
          }
        }
        return { ok: true };
      }
    }
  }

  /**
   * The values a duplicate starts from: what the row shows now, except keys (the
   * server is left to generate them) and columns that are not insertable. A key the
   * user must choose themselves stays unset and is flagged when saving.
   */
  private copyOf(resultId: string, index: number, edit: EditableResult): PendingRow | undefined {
    const window = this.results.window(resultId, index, 1);
    const shown = window?.rows[0];
    if (window === undefined || shown === undefined || window.offset !== index) {
      return undefined;
    }
    const defaults = new Set(
      window.changes.filter((change) => change.kind === 'default').map((change) => change.column),
    );
    const cells = new Map<number, CellChange>();
    shown.forEach((value, column) => {
      const info = edit.columns[column];
      if (
        info === undefined ||
        info === null ||
        info.kind === 'binary' ||
        defaults.has(column) ||
        edit.keyIndexes.includes(column)
      ) {
        return;
      }
      cells.set(column, { kind: 'value', value });
    });
    return cells;
  }
}
