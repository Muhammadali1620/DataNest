// Reads the cells a "Copy as" names out of the result store and renders them. The
// clipboard itself belongs to the editor integration, so this returns the text.

import type { CopyError, CopyFormat } from '../shared/copy-format';
import { MAX_COPY_ROWS } from '../shared/copy-format';
import type { ConnectionManager } from './connection-manager';
import { copyAs } from './copy-as';
import type { ResultStore } from './result-store';

export interface CopyRequest {
  readonly resultId: string;
  readonly format: CopyFormat;
  /** Rows, inclusive; all of them when absent. */
  readonly top?: number | undefined;
  readonly bottom?: number | undefined;
  /** The result columns to copy, in order; all of them when absent. */
  readonly columns?: readonly number[] | undefined;
}

export type CopyReply =
  | { readonly ok: true; readonly text: string; readonly rows: number }
  | { readonly ok: false; readonly error: CopyError };

export interface ResultCopierDeps {
  readonly results: ResultStore;
  readonly manager: Pick<ConnectionManager, 'driverOf'>;
}

export class ResultCopier {
  constructor(private readonly deps: ResultCopierDeps) {}

  async render(request: CopyRequest): Promise<CopyReply> {
    const summary = this.deps.results.get(request.resultId);
    if (summary === undefined || summary.error !== undefined || summary.columns.length === 0) {
      return { ok: false, error: 'no-rows' };
    }
    const total = summary.rowCount + summary.insertedRows;
    const lastColumn = summary.columns.length - 1;
    const top = clamp(request.top ?? 0, 0, Math.max(0, total - 1));
    const bottom = clamp(request.bottom ?? total - 1, top, Math.max(0, total - 1));
    // Columns that do not exist and repeats are dropped, not trusted.
    const selected =
      request.columns === undefined
        ? Array.from({ length: lastColumn + 1 }, (_, index) => index)
        : [...new Set(request.columns)].filter(
            (index) => Number.isInteger(index) && index >= 0 && index <= lastColumn,
          );
    if (selected.length === 0) {
      return { ok: false, error: 'no-rows' };
    }
    if (total === 0) {
      return { ok: false, error: 'no-rows' };
    }
    if (bottom - top + 1 > MAX_COPY_ROWS) {
      return { ok: false, error: 'too-many-rows' };
    }
    // The window carries unsaved edits, so what is copied is what the grid shows.
    const window = this.deps.results.window(request.resultId, top, bottom - top + 1);
    if (window === undefined || window.rows.length === 0) {
      return { ok: false, error: 'no-rows' };
    }
    const dialect =
      summary.origin === undefined
        ? undefined
        : (await this.deps.manager.driverOf(summary.origin.target.connectionId)).dialect;
    const outcome = copyAs({
      format: request.format,
      columns: summary.columns,
      rows: window.rows,
      selected,
      dialect,
      edit: summary.edit,
    });
    return outcome.ok
      ? { ok: true, text: outcome.text, rows: window.rows.length }
      : { ok: false, error: outcome.error };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.trunc(value), max));
}
