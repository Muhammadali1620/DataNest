// The changes a user has made to a result and not saved yet: edited cells, rows to
// delete and rows to insert. Existing rows are keyed by the row object itself, so
// sorting the result cannot attach a change to the wrong row.

import type { CellValue } from '../shared/cell-value';

export type ResultRow = readonly CellValue[];

/** A cell the user changed but has not saved yet. */
export type CellChange =
  | { readonly kind: 'value'; readonly value: CellValue }
  /** The column's own default, written as the DEFAULT keyword. */
  | { readonly kind: 'default' };

/** A row waiting to be inserted: only the columns the user filled in. */
export type PendingRow = ReadonlyMap<number, CellChange>;

/** Where a pending change sits in the rows as they are shown. */
export interface ChangedCell {
  readonly row: number;
  readonly column: number;
  readonly kind: CellChange['kind'];
}

export type RowState = 'inserted' | 'deleted';

export interface RowMark {
  readonly row: number;
  readonly state: RowState;
}

export interface OverlaidRows {
  /** The rows as the user sees them, pending values included. */
  readonly rows: ResultRow[];
  readonly changes: ChangedCell[];
  readonly states: RowMark[];
}

export class PendingEdits {
  private readonly changes = new Map<ResultRow, Map<number, CellChange>>();
  private readonly deleted = new Set<ResultRow>();
  private readonly inserted: Map<number, CellChange>[] = [];
  /** Grows with every mutation, so a page can tell its rows went stale. */
  private version = 0;

  get revision(): number {
    return this.version;
  }

  /** Cells changed in rows that exist on the server. */
  get changedCells(): number {
    let count = 0;
    for (const cells of this.changes.values()) {
      count += cells.size;
    }
    return count;
  }

  get insertedRows(): number {
    return this.inserted.length;
  }

  get deletedRows(): number {
    return this.deleted.size;
  }

  get isEmpty(): boolean {
    return this.changes.size === 0 && this.deleted.size === 0 && this.inserted.length === 0;
  }

  changeOf(row: ResultRow, column: number): CellChange | undefined {
    return this.changes.get(row)?.get(column);
  }

  /** Records, or with `undefined` withdraws, the change of one cell of an existing row. */
  setChange(row: ResultRow, column: number, change: CellChange | undefined): void {
    const cells = this.changes.get(row) ?? new Map<number, CellChange>();
    if (change === undefined) {
      cells.delete(column);
    } else {
      cells.set(column, change);
    }
    if (cells.size === 0) {
      this.changes.delete(row);
    } else {
      this.changes.set(row, cells);
    }
    this.version += 1;
  }

  isDeleted(row: ResultRow): boolean {
    return this.deleted.has(row);
  }

  setDeleted(row: ResultRow, deleted: boolean): void {
    if (deleted ? !this.deleted.has(row) : this.deleted.has(row)) {
      if (deleted) {
        this.deleted.add(row);
      } else {
        this.deleted.delete(row);
      }
      this.version += 1;
    }
  }

  insertedRow(index: number): PendingRow | undefined {
    return this.inserted[index];
  }

  /** Queues a row to insert, with the values it starts from; returns its position. */
  addInserted(cells: PendingRow = new Map()): number {
    this.inserted.push(new Map(cells));
    this.version += 1;
    return this.inserted.length - 1;
  }

  removeInserted(index: number): boolean {
    if (index < 0 || index >= this.inserted.length) {
      return false;
    }
    this.inserted.splice(index, 1);
    this.version += 1;
    return true;
  }

  /** A default on a new row is the same as leaving the column out, so it is unset. */
  setInsertedChange(index: number, column: number, change: CellChange | undefined): boolean {
    const row = this.inserted[index];
    if (row === undefined) {
      return false;
    }
    if (change === undefined || change.kind === 'default') {
      row.delete(column);
    } else {
      row.set(column, change);
    }
    this.version += 1;
    return true;
  }

  /** Edited cells per existing row, in the order the rows are given. */
  updates(rows: readonly ResultRow[]): { row: ResultRow; cells: PendingRow }[] {
    const found: { row: ResultRow; cells: PendingRow }[] = [];
    for (const row of rows) {
      const cells = this.changes.get(row);
      if (cells !== undefined && !this.deleted.has(row)) {
        found.push({ row, cells });
      }
    }
    return found;
  }

  deletions(rows: readonly ResultRow[]): ResultRow[] {
    return rows.filter((row) => this.deleted.has(row));
  }

  insertions(): PendingRow[] {
    return [...this.inserted];
  }

  /** Throws every pending change away. */
  clear(): void {
    this.changes.clear();
    this.deleted.clear();
    this.inserted.length = 0;
    this.version += 1;
  }

  /**
   * The rows of a window with pending values put in. `rows` are the server's rows;
   * new rows follow them. A DEFAULT has no value to show, so it appears as NULL and
   * the returned change list tells the page what it really is.
   *
   * @param insertable whether a column takes part in an INSERT (computed ones do not)
   */
  overlay(
    rows: readonly ResultRow[],
    from: number,
    to: number,
    columnCount: number,
    insertable: (column: number) => boolean,
  ): OverlaidRows {
    const shown: ResultRow[] = [];
    const changes: ChangedCell[] = [];
    const states: RowMark[] = [];
    for (let index = from; index < to; index++) {
      const row = rows[index];
      if (row === undefined) {
        const fresh = this.inserted[index - rows.length];
        const cells: CellValue[] = Array.from({ length: columnCount }, () => null);
        for (let column = 0; column < columnCount; column++) {
          const change = fresh?.get(column);
          if (change?.kind === 'value') {
            cells[column] = change.value;
            changes.push({ row: index, column, kind: 'value' });
          } else if (insertable(column)) {
            changes.push({ row: index, column, kind: 'default' });
          }
        }
        shown.push(cells);
        states.push({ row: index, state: 'inserted' });
        continue;
      }
      if (this.deleted.has(row)) {
        states.push({ row: index, state: 'deleted' });
      }
      const pending = this.changes.get(row);
      if (pending === undefined) {
        shown.push(row);
        continue;
      }
      const cells = [...row];
      for (const [column, change] of pending) {
        cells[column] = change.kind === 'value' ? change.value : null;
        changes.push({ row: index, column, kind: change.kind });
      }
      shown.push(cells);
    }
    return { rows: shown, changes, states };
  }
}
