// Applies one edit of a cell to a result: checks the cell may be edited, reads what
// the user typed by the column's type, and queues the change in the ResultStore.
// Nothing reaches the database here; saving is a separate step (V2.4).

import { cellText } from '../shared/cell-text';
import { type EditInput, type InputProblem, parseCellInput } from '../shared/cell-input';
import type { CellValue } from '../shared/cell-value';
import type { CellChange, ResultStore } from './result-store';

export type EditError =
  /** The result is read-only (V2.1). */
  | 'not-editable'
  /** The row is gone: a newer run or page replaced the result. */
  | 'no-such-row'
  /** The cell is computed or of a kind the grid cannot edit as text. */
  | 'read-only-column'
  | 'not-null'
  | InputProblem;

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
    const original = this.results.rowAt(resultId, row);
    if (original === undefined) {
      return fail('no-such-row');
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
        change = original[column] === null ? undefined : { kind: 'value', value: null };
        break;
      case 'text': {
        const parsed = parseCellInput(info.kind, input.text, info.options);
        if (!parsed.ok) {
          return fail(parsed.problem);
        }
        change = sameValue(original[column], parsed.value)
          ? undefined
          : { kind: 'value', value: parsed.value };
        break;
      }
    }
    return this.results.setChange(resultId, row, column, change)
      ? { ok: true }
      : fail('no-such-row');
  }
}
