// Query results live here, in the extension host, and the webview asks for the
// rows it can see (ARCHITECTURE.md D6). Keeping them out of the webview is what
// makes a large result set cheap to display.

import { type Disposable, toDisposable } from '../core/disposable';
import type { ResultEdit } from '../core/model/editability';
import type { ResultColumn } from '../drivers/driver';
import { type SortDirection, sortRows } from '../shared/cell-compare';
import { findRows, type SearchHits } from '../shared/cell-search';
import type { CellValue } from '../shared/cell-value';

export type ResultRow = readonly CellValue[];

/** A page of a table view, so the panel can offer Prev/Next and a count. */
export interface ResultPage {
  /** Rows skipped before this page. */
  readonly offset: number;
  /** Rows one page holds. */
  readonly pageSize: number;
  /** Rows the whole table has, when counting succeeded. */
  readonly totalRows?: number;
}

/** How a result is currently ordered; absent means "as the server returned it". */
export interface ResultSort {
  readonly column: number;
  readonly direction: SortDirection;
}

export interface ResultSummary {
  readonly id: string;
  /** The document whose run produced this result. */
  readonly documentUri: string;
  /** The statement as it was sent, for the result tab's title and tooltip. */
  readonly statement: string;
  /** Offset of the statement in its document, so an error can be pointed at. */
  readonly statementStart: number;
  readonly columns: readonly ResultColumn[];
  readonly rowCount: number;
  /** True when the row limit stopped the read before the end. */
  readonly truncated: boolean;
  /** Rows an INSERT/UPDATE/DELETE reported, when the server said. */
  readonly affectedRows?: number;
  readonly durationMs: number;
  /** Set instead of rows when the statement failed. */
  readonly error?: ResultError;
  /** Set once the user sorted the result in the grid. */
  readonly sort?: ResultSort;
  /** Set for a table view, which is paged rather than scrolled to the end. */
  readonly page?: ResultPage;
  /** Whether rows can be edited in place; absent for statements that return no rows. */
  readonly edit?: ResultEdit;
  /** Cells with a pending change; zero when nothing waits to be saved. */
  readonly changedCells: number;
  /** Grows with every change to the pending edits, so a page can tell its rows went stale. */
  readonly revision: number;
}

/** A cell the user changed but has not saved yet. */
export type CellChange =
  | { readonly kind: 'value'; readonly value: CellValue }
  /** The column's own default, written as the DEFAULT keyword. */
  | { readonly kind: 'default' };

/** Where a pending change sits in the rows as they are shown. */
export interface ChangedCell {
  readonly row: number;
  readonly column: number;
  readonly kind: CellChange['kind'];
}

export interface ResultError {
  readonly code: string;
  readonly message: string;
  /** Character offset of the problem inside the statement, when known. */
  readonly position?: number;
}

/** A result with its rows; only the store sees this whole object. */
interface StoredResult extends Omit<ResultSummary, 'changedCells'> {
  /** Rows in the order they are shown. */
  rows: ResultRow[];
  /** The order the server returned, so sorting can be undone. */
  readonly original: readonly ResultRow[];
  sort?: ResultSort;
  /** Pending changes, keyed by the row object so sorting cannot move them. */
  readonly changes: Map<ResultRow, Map<number, CellChange>>;
  revision: number;
}

export interface ResultWindow {
  readonly offset: number;
  readonly rows: ResultRow[];
  /** Total rows held, so the grid can size its scrollbar. */
  readonly rowCount: number;
  /** Pending changes inside this window; `rows` already show the changed values. */
  readonly changes: ChangedCell[];
}

export interface NewResult {
  readonly documentUri: string;
  readonly statement: string;
  readonly statementStart: number;
  readonly columns: readonly ResultColumn[];
  readonly rows: ResultRow[];
  readonly truncated: boolean;
  readonly affectedRows?: number;
  readonly durationMs: number;
  readonly error?: ResultError;
  readonly page?: ResultPage;
  readonly edit?: ResultEdit;
}

/** How many results of one document are kept; older ones are dropped. */
export const MAX_RESULTS_PER_DOCUMENT = 20;

/**
 * Results of every document, newest last. A document keeps only its most recent
 * runs, so a long editing session cannot grow without bound.
 */
export class ResultStore {
  private readonly results = new Map<string, StoredResult>();
  private readonly byDocument = new Map<string, string[]>();
  private readonly listeners = new Set<(documentUri: string) => void>();
  private nextId = 1;

  get size(): number {
    return this.results.size;
  }

  /** Stores a result and returns its summary; the id is unique for the session. */
  add(result: NewResult): ResultSummary {
    const id = `result-${this.nextId++}`;
    const stored: StoredResult = {
      id,
      documentUri: result.documentUri,
      statement: result.statement,
      statementStart: Math.max(0, Math.trunc(result.statementStart)),
      columns: result.columns,
      rows: result.rows,
      original: [...result.rows],
      changes: new Map(),
      revision: 0,
      rowCount: result.rows.length,
      truncated: result.truncated,
      ...(result.affectedRows === undefined ? {} : { affectedRows: result.affectedRows }),
      durationMs: result.durationMs,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.page === undefined ? {} : { page: result.page }),
      ...(result.edit === undefined ? {} : { edit: result.edit }),
    };
    this.results.set(id, stored);
    const ids = this.byDocument.get(result.documentUri) ?? [];
    ids.push(id);
    while (ids.length > MAX_RESULTS_PER_DOCUMENT) {
      const dropped = ids.shift();
      if (dropped !== undefined) {
        this.results.delete(dropped);
      }
    }
    this.byDocument.set(result.documentUri, ids);
    this.notify(result.documentUri);
    return summaryOf(stored);
  }

  get(id: string): ResultSummary | undefined {
    const stored = this.results.get(id);
    return stored === undefined ? undefined : summaryOf(stored);
  }

  /** Summaries of a document's results, oldest first. */
  forDocument(documentUri: string): ResultSummary[] {
    return (this.byDocument.get(documentUri) ?? []).flatMap((id) => {
      const stored = this.results.get(id);
      return stored === undefined ? [] : [summaryOf(stored)];
    });
  }

  /**
   * The rows the grid asked for. A range outside the result is not an error: the
   * webview may ask for a window that a newer, shorter result no longer has.
   */
  window(id: string, offset: number, limit: number): ResultWindow | undefined {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return undefined;
    }
    const from = Math.max(0, Math.min(Math.trunc(offset), stored.rows.length));
    const to = Math.min(stored.rows.length, from + Math.max(0, Math.trunc(limit)));
    const rows: ResultRow[] = [];
    const changes: ChangedCell[] = [];
    for (let index = from; index < to; index++) {
      const row = stored.rows[index];
      const pending = row === undefined ? undefined : stored.changes.get(row);
      if (row === undefined || pending === undefined) {
        rows.push(row ?? []);
        continue;
      }
      // The grid shows the edited value; a DEFAULT has none, so it shows as NULL
      // and the change list tells the page what it really is.
      const shown = [...row];
      for (const [column, change] of pending) {
        shown[column] = change.kind === 'value' ? change.value : null;
        changes.push({ row: index, column, kind: change.kind });
      }
      rows.push(shown);
    }
    return { offset: from, rows, rowCount: stored.rows.length, changes };
  }

  /** The row shown at an index, as the server returned it (without pending changes). */
  rowAt(id: string, index: number): ResultRow | undefined {
    return this.results.get(id)?.rows[index];
  }

  /** The pending change of one cell, if any. */
  changeAt(id: string, index: number, column: number): CellChange | undefined {
    const stored = this.results.get(id);
    const row = stored?.rows[index];
    return row === undefined ? undefined : stored?.changes.get(row)?.get(column);
  }

  /**
   * Records, or with `undefined` withdraws, the pending change of one cell. A change
   * back to what the server has is withdrawn by the caller, so nothing is queued
   * that would not alter the row.
   */
  setChange(id: string, index: number, column: number, change: CellChange | undefined): boolean {
    const stored = this.results.get(id);
    const row = stored?.rows[index];
    if (stored === undefined || row === undefined || column < 0 || column >= row.length) {
      return false;
    }
    const cells = stored.changes.get(row) ?? new Map<number, CellChange>();
    if (change === undefined) {
      cells.delete(column);
    } else {
      cells.set(column, change);
    }
    if (cells.size === 0) {
      stored.changes.delete(row);
    } else {
      stored.changes.set(row, cells);
    }
    stored.revision += 1;
    this.notify(stored.documentUri);
    return true;
  }

  /**
   * Re-orders a result by one column, or restores the server's order when
   * `direction` is absent. Sorting happens over every row, not just the loaded
   * ones, which is the whole point of keeping rows in the host.
   */
  sort(id: string, column: number, direction?: SortDirection): ResultSummary | undefined {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return undefined;
    }
    if (direction === undefined) {
      stored.rows = [...stored.original];
      delete stored.sort;
    } else {
      stored.rows = sortRows(stored.original, column, direction);
      stored.sort = { column, direction };
    }
    this.notify(stored.documentUri);
    return summaryOf(stored);
  }

  /** Rows containing the text, in the order they are shown. */
  search(id: string, text: string, limit?: number): SearchHits | undefined {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return undefined;
    }
    return findRows(stored.rows, text, limit);
  }

  /** Every row of a result, for exporting it to a file. */
  allRows(id: string): ResultRow[] | undefined {
    const stored = this.results.get(id);
    return stored === undefined ? undefined : [...stored.rows];
  }

  /** Drops every result of a document, e.g. when its editor closes. */
  clearDocument(documentUri: string): void {
    const ids = this.byDocument.get(documentUri);
    if (ids === undefined) {
      return;
    }
    for (const id of ids) {
      this.results.delete(id);
    }
    this.byDocument.delete(documentUri);
    this.notify(documentUri);
  }

  clear(): void {
    const documents = [...this.byDocument.keys()];
    this.results.clear();
    this.byDocument.clear();
    for (const documentUri of documents) {
      this.notify(documentUri);
    }
  }

  /** Fires with the document whose results changed. */
  onDidChange(listener: (documentUri: string) => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  private notify(documentUri: string): void {
    for (const listener of [...this.listeners]) {
      listener(documentUri);
    }
  }
}

function summaryOf(stored: StoredResult): ResultSummary {
  const { rows: _rows, original: _original, changes, ...summary } = stored;
  let changedCells = 0;
  for (const cells of changes.values()) {
    changedCells += cells.size;
  }
  return { ...summary, changedCells };
}
