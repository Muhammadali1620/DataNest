// Query results live here, in the extension host, and the webview asks for the
// rows it can see (ARCHITECTURE.md D6). Keeping them out of the webview is what
// makes a large result set cheap to display.

import { type Disposable, toDisposable } from '../core/disposable';
import type { ResultColumn } from '../drivers/driver';
import { type SortDirection, sortRows } from '../shared/cell-compare';
import { findRows, type SearchHits } from '../shared/cell-search';
import type { CellValue } from '../shared/cell-value';

export type ResultRow = readonly CellValue[];

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
}

export interface ResultError {
  readonly code: string;
  readonly message: string;
  /** Character offset of the problem inside the statement, when known. */
  readonly position?: number;
}

/** A result with its rows; only the store sees this whole object. */
interface StoredResult extends ResultSummary {
  /** Rows in the order they are shown. */
  rows: ResultRow[];
  /** The order the server returned, so sorting can be undone. */
  readonly original: readonly ResultRow[];
  sort?: ResultSort;
}

export interface ResultWindow {
  readonly offset: number;
  readonly rows: ResultRow[];
  /** Total rows held, so the grid can size its scrollbar. */
  readonly rowCount: number;
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
      rowCount: result.rows.length,
      truncated: result.truncated,
      ...(result.affectedRows === undefined ? {} : { affectedRows: result.affectedRows }),
      durationMs: result.durationMs,
      ...(result.error === undefined ? {} : { error: result.error }),
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
    return { offset: from, rows: stored.rows.slice(from, to), rowCount: stored.rows.length };
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
  const { rows: _rows, original: _original, ...summary } = stored;
  return summary;
}
