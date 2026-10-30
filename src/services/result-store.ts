// Query results live here, in the extension host, and the webview asks for the
// rows it can see (ARCHITECTURE.md D6). Keeping them out of the webview is what
// makes a large result set cheap to display.

import { type Disposable, toDisposable } from '../core/disposable';
import type { ResultEdit } from '../core/model/editability';
import type { SessionTarget } from './connection-manager';
import type { ResultColumn } from '../drivers/driver';
import type { ChangePlan } from './change-sql';
import { type SortDirection, sortRows, sortRowsPaused } from '../shared/cell-compare';
import type { PauseOptions } from '../shared/merge-sort';
import type { TableFilter } from '../shared/table-filter';
import { findRowsPaused, type SearchHits } from '../shared/cell-search';
import {
  type CellChange,
  type ChangedCell,
  PendingEdits,
  type PendingRow,
  type ResultRow,
  type RowMark,
} from './pending-edits';

export type { CellChange, ChangedCell, PendingRow, ResultRow };

/** A page of a table view, so the panel can offer Prev/Next and a count. */
export interface ResultPage {
  /** Rows skipped before this page. */
  readonly offset: number;
  /** Rows one page holds. */
  readonly pageSize: number;
  /** Rows the whole table has, when counting succeeded. */
  readonly totalRows?: number;
  /** True when `totalRows` is the server's estimate, not a count. */
  readonly approximate?: boolean;
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
  /** The server-side filter a table view was read with. */
  readonly filter?: TableFilter;
  /** Whether rows can be edited in place; absent for statements that return no rows. */
  readonly edit?: ResultEdit;
  /** Where the rows came from, so edits can be saved through the same session. */
  readonly origin?: ResultOrigin;
  /** Cells changed in rows that exist on the server; zero when nothing waits to be saved. */
  readonly changedCells: number;
  /** New rows waiting to be inserted; the grid shows them after the server's rows. */
  readonly insertedRows: number;
  /** Rows marked for deletion. */
  readonly deletedRows: number;
  /** Grows with every change to the pending edits, so a page can tell its rows went stale. */
  readonly revision: number;
}

export interface ResultError {
  readonly code: string;
  readonly message: string;
  /** Character offset of the problem inside the statement, when known. */
  readonly position?: number;
}

/** The connection and session owner that produced a result. */
export interface ResultOrigin {
  readonly target: SessionTarget;
  /** The `ConnectionManager` owner key of the session that ran the statement. */
  readonly owner: string;
}

/** A result with its rows; only the store sees this whole object. */
interface StoredResult extends Omit<
  ResultSummary,
  | 'changedCells'
  | 'insertedRows'
  | 'deletedRows'
  | 'revision'
  | 'columns'
  | 'rowCount'
  | 'truncated'
> {
  // These change when saved edits are re-read from the server.
  columns: readonly ResultColumn[];
  rowCount: number;
  truncated: boolean;
  /** Rows in the order they are shown. */
  rows: ResultRow[];
  /** The order the server returned, so sorting can be undone. */
  original: readonly ResultRow[];
  sort?: ResultSort;
  /** Pending changes, keyed by the row object so sorting cannot move them. */
  readonly pending: PendingEdits;
  /** Grows with every sort request, so a slow sort that was overtaken is not applied. */
  sortTicket: number;
  /** Grows with every search, so a newer one stops the one still running. */
  searchTicket: number;
}

export interface ResultWindow {
  readonly offset: number;
  readonly rows: ResultRow[];
  /** Rows shown in all (server rows, then new ones), so the grid can size its scrollbar. */
  readonly rowCount: number;
  /** Pending changes inside this window; `rows` already show the changed values. */
  readonly changes: ChangedCell[];
  /** Which rows of the window are new or marked for deletion. */
  readonly states: RowMark[];
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
  readonly filter?: TableFilter;
  /** An order the server already applied (a table view); the rows are not re-sorted. */
  readonly sort?: ResultSort;
  readonly edit?: ResultEdit;
  readonly origin?: ResultOrigin;
}

/** How many results of one document are kept; older ones are dropped. */
export const MAX_RESULTS_PER_DOCUMENT = 20;

/**
 * Cells all results together may hold — about a gigabyte of ordinary values. Twenty
 * runs of a million rows would otherwise take the extension host down; past this,
 * the oldest results go first (V9.1).
 */
export const MAX_KEPT_CELLS = 20_000_000;

export interface ResultStoreOptions {
  /** Cells kept across all results; `MAX_KEPT_CELLS` by default. */
  readonly maxCells?: number;
  /** How a long sort or search lets the host breathe; tests make it deterministic. */
  readonly sortPause?: PauseOptions;
}

/**
 * Results of every document, newest last. A document keeps only its most recent
 * runs, and all documents together only so many cells, so a long editing session
 * cannot grow without bound.
 */
export class ResultStore {
  private readonly results = new Map<string, StoredResult>();
  private readonly byDocument = new Map<string, string[]>();
  private readonly listeners = new Set<(documentUri: string) => void>();
  private readonly maxCells: number;
  private readonly sortPause: PauseOptions | undefined;
  private nextId = 1;

  constructor(options: ResultStoreOptions = {}) {
    this.maxCells = options.maxCells ?? MAX_KEPT_CELLS;
    this.sortPause = options.sortPause;
  }

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
      pending: new PendingEdits(),
      sortTicket: 0,
      searchTicket: 0,
      rowCount: result.rows.length,
      truncated: result.truncated,
      ...(result.affectedRows === undefined ? {} : { affectedRows: result.affectedRows }),
      durationMs: result.durationMs,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.page === undefined ? {} : { page: result.page }),
      ...(result.filter === undefined ? {} : { filter: result.filter }),
      ...(result.sort === undefined ? {} : { sort: result.sort }),
      ...(result.edit === undefined ? {} : { edit: result.edit }),
      ...(result.origin === undefined ? {} : { origin: result.origin }),
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
    const trimmed = this.trimToBudget(id);
    this.notify(result.documentUri);
    for (const documentUri of trimmed) {
      if (documentUri !== result.documentUri) {
        this.notify(documentUri);
      }
    }
    return summaryOf(stored);
  }

  /**
   * Drops the oldest results until all of them fit the cell budget, and returns the
   * documents that lost one. The newest result always stays, however big, and so does
   * any result with unsaved changes: dropping it would throw the user's edits away.
   */
  private trimToBudget(newest: string): Set<string> {
    const touched = new Set<string>();
    let cells = 0;
    for (const stored of this.results.values()) {
      cells += cellsOf(stored);
    }
    // Map order is insertion order, so this walks from the oldest result.
    for (const [id, stored] of this.results) {
      if (cells <= this.maxCells) {
        break;
      }
      if (id === newest || hasPending(stored)) {
        continue;
      }
      this.results.delete(id);
      cells -= cellsOf(stored);
      const ids = this.byDocument.get(stored.documentUri) ?? [];
      const left = ids.filter((other) => other !== id);
      if (left.length === 0) {
        this.byDocument.delete(stored.documentUri);
      } else {
        this.byDocument.set(stored.documentUri, left);
      }
      touched.add(stored.documentUri);
    }
    return touched;
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
    const total = stored.rows.length + stored.pending.insertedRows;
    const from = Math.max(0, Math.min(Math.trunc(offset), total));
    const to = Math.min(total, from + Math.max(0, Math.trunc(limit)));
    const insertable = (column: number): boolean => {
      const edit = stored.edit;
      const info = edit?.editable === true ? edit.columns[column] : undefined;
      return info !== undefined && info !== null;
    };
    const overlaid = stored.pending.overlay(
      stored.rows,
      from,
      to,
      stored.columns.length,
      insertable,
    );
    return { offset: from, rowCount: total, ...overlaid };
  }

  /** The row shown at an index, as the server returned it (without pending changes). */
  rowAt(id: string, index: number): ResultRow | undefined {
    return this.results.get(id)?.rows[index];
  }

  /** True when the index is past the server's rows, i.e. a row waiting to be inserted. */
  isInsertedRow(id: string, index: number): boolean {
    const stored = this.results.get(id);
    return (
      stored !== undefined &&
      index >= stored.rows.length &&
      stored.pending.insertedRow(index - stored.rows.length) !== undefined
    );
  }

  isDeletedRow(id: string, index: number): boolean {
    const stored = this.results.get(id);
    const row = stored?.rows[index];
    return row !== undefined && stored?.pending.isDeleted(row) === true;
  }

  /** The pending change of one cell, if any. */
  changeAt(id: string, index: number, column: number): CellChange | undefined {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return undefined;
    }
    const fresh = stored.pending.insertedRow(index - stored.rows.length);
    if (index >= stored.rows.length) {
      return fresh?.get(column);
    }
    const row = stored.rows[index];
    return row === undefined ? undefined : stored.pending.changeOf(row, column);
  }

  /**
   * Records, or with `undefined` withdraws, the pending change of one cell, in a
   * server row or in a new one. False when there is no such cell.
   */
  setChange(id: string, index: number, column: number, change: CellChange | undefined): boolean {
    const stored = this.results.get(id);
    if (stored === undefined || column < 0 || column >= stored.columns.length) {
      return false;
    }
    let done: boolean;
    if (index >= stored.rows.length) {
      done = stored.pending.setInsertedChange(index - stored.rows.length, column, change);
    } else {
      const row = stored.rows[index];
      done = row !== undefined;
      if (row !== undefined) {
        stored.pending.setChange(row, column, change);
      }
    }
    if (done) {
      this.notify(stored.documentUri);
    }
    return done;
  }

  /** Queues a new row; returns where the grid shows it. */
  addRow(id: string, cells?: PendingRow): number | undefined {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return undefined;
    }
    const index = stored.rows.length + stored.pending.addInserted(cells);
    this.notify(stored.documentUri);
    return index;
  }

  /**
   * Takes a row out of the result: a server row is marked for deletion (and can be
   * restored), a new row is simply dropped.
   */
  deleteRow(id: string, index: number): boolean {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return false;
    }
    let done: boolean;
    if (index >= stored.rows.length) {
      done = stored.pending.removeInserted(index - stored.rows.length);
    } else {
      const row = stored.rows[index];
      done = row !== undefined;
      if (row !== undefined) {
        stored.pending.setDeleted(row, true);
      }
    }
    if (done) {
      this.notify(stored.documentUri);
    }
    return done;
  }

  /** Everything waiting to be saved, in the shape the SQL builder takes. */
  pendingPlan(id: string): Pick<ChangePlan, 'updates' | 'deletions' | 'insertions'> | undefined {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return undefined;
    }
    return {
      updates: stored.pending.updates(stored.rows),
      deletions: stored.pending.deletions(stored.rows),
      insertions: stored.pending.insertions(),
    };
  }

  /** Throws away every pending change of a result. */
  discardPending(id: string): boolean {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return false;
    }
    stored.pending.clear();
    this.notify(stored.documentUri);
    return true;
  }

  /**
   * Withdraws the pending changes of some rows: cell edits go, a deletion mark is
   * lifted and a new row is dropped. The rows are named as the grid shows them.
   */
  revertRows(id: string, indexes: readonly number[]): boolean {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return false;
    }
    const total = stored.rows.length + stored.pending.insertedRows;
    // Check them all first: a bad index must not leave the others half reverted.
    if (indexes.some((index) => index < 0 || index >= total)) {
      return false;
    }
    // Highest first, because dropping a new row moves the ones after it.
    for (const index of [...new Set(indexes)].sort((a, b) => b - a)) {
      if (index >= stored.rows.length) {
        stored.pending.removeInserted(index - stored.rows.length);
        continue;
      }
      const row = stored.rows[index];
      if (row === undefined) {
        continue;
      }
      stored.pending.setDeleted(row, false);
      for (let column = 0; column < row.length; column++) {
        if (stored.pending.changeOf(row, column) !== undefined) {
          stored.pending.setChange(row, column, undefined);
        }
      }
    }
    this.notify(stored.documentUri);
    return true;
  }

  /**
   * Swaps in freshly read rows after the changes were saved, dropping every pending
   * change. A sort the user had chosen is applied again to the new rows.
   */
  replaceRows(
    id: string,
    columns: readonly ResultColumn[],
    rows: ResultRow[],
    truncated: boolean,
  ): boolean {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return false;
    }
    stored.columns = columns;
    stored.original = [...rows];
    stored.rows =
      stored.sort === undefined ? rows : sortRows(rows, stored.sort.column, stored.sort.direction);
    stored.rowCount = rows.length;
    stored.truncated = truncated;
    stored.pending.clear();
    this.notify(stored.documentUri);
    return true;
  }

  /** Takes the deletion mark off a server row. */
  restoreRow(id: string, index: number): boolean {
    const stored = this.results.get(id);
    const row = stored?.rows[index];
    if (stored === undefined || row === undefined) {
      return false;
    }
    stored.pending.setDeleted(row, false);
    this.notify(stored.documentUri);
    return true;
  }

  /**
   * Re-orders a result by one column, or restores the server's order when
   * `direction` is absent. Sorting happens over every row, not just the loaded
   * ones, which is the whole point of keeping rows in the host. A big result is
   * sorted in slices, so the host keeps answering meanwhile; undefined when the
   * result is gone, or when another sort or fresh rows overtook this one.
   */
  async sort(
    id: string,
    column: number,
    direction?: SortDirection,
  ): Promise<ResultSummary | undefined> {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return undefined;
    }
    const ticket = ++stored.sortTicket;
    const source = stored.original;
    const rows =
      direction === undefined
        ? [...source]
        : await sortRowsPaused(source, column, direction, this.sortPause);
    if (
      this.results.get(id) !== stored ||
      stored.sortTicket !== ticket ||
      stored.original !== source
    ) {
      return undefined;
    }
    stored.rows = rows;
    if (direction === undefined) {
      delete stored.sort;
    } else {
      stored.sort = { column, direction };
    }
    this.notify(stored.documentUri);
    return summaryOf(stored);
  }

  /**
   * Rows containing the text, in the order they are shown. A big result is searched in
   * slices; a newer search of the same result, a sort or fresh rows end this one early,
   * and so does the result going away — all of which give undefined.
   */
  async search(id: string, text: string, limit?: number): Promise<SearchHits | undefined> {
    const stored = this.results.get(id);
    if (stored === undefined) {
      return undefined;
    }
    const ticket = ++stored.searchTicket;
    const rows = stored.rows;
    const stale = (): boolean =>
      this.results.get(id) !== stored || stored.searchTicket !== ticket || stored.rows !== rows;
    const hits = await findRowsPaused(rows, text, limit, { ...this.sortPause, stale });
    return hits === undefined || stale() ? undefined : hits;
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

function cellsOf(stored: StoredResult): number {
  return stored.original.length * Math.max(1, stored.columns.length);
}

function hasPending(stored: StoredResult): boolean {
  const { pending } = stored;
  return pending.changedCells + pending.insertedRows + pending.deletedRows > 0;
}

function summaryOf(stored: StoredResult): ResultSummary {
  const {
    rows: _rows,
    original: _original,
    pending,
    sortTicket: _sort,
    searchTicket: _search,
    ...summary
  } = stored;
  return {
    ...summary,
    changedCells: pending.changedCells,
    insertedRows: pending.insertedRows,
    deletedRows: pending.deletedRows,
    revision: pending.revision,
  };
}
