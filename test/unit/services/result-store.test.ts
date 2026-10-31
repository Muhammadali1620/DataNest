import type { EditableResult } from '../../../src/core/model/editability';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_KEPT_CELLS,
  MAX_RESULTS_PER_DOCUMENT,
  ResultStore,
  type NewResult,
} from '../../../src/services/result-store';

const DOC = 'untitled:Query-1.sql';

function result(overrides: Partial<NewResult> = {}): NewResult {
  return {
    documentUri: DOC,
    statement: 'SELECT 1',
    statementStart: 0,
    columns: [{ name: 'one' }],
    rows: [[1]],
    truncated: false,
    durationMs: 5,
    ...overrides,
  };
}

/** A store whose sorts and searches wait at every pause until the test lets them go on. */
function heldStore(): { store: ResultStore; release: () => Promise<void> } {
  const waiting: (() => void)[] = [];
  const store = new ResultStore({
    sortPause: {
      // A slice of zero ends at every step, so a sort pauses at once.
      now: () => 0,
      sliceMs: 0,
      pause: () => new Promise<void>((resolve) => waiting.push(resolve)),
    },
  });
  const release = async (): Promise<void> => {
    while (waiting.length > 0) {
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  return { store, release };
}

describe('ResultStore', () => {
  it('stores a result and gives back a summary without the rows', () => {
    const store = new ResultStore();
    const summary = store.add(result());
    expect(summary).toMatchObject({
      documentUri: DOC,
      statement: 'SELECT 1',
      rowCount: 1,
      truncated: false,
      durationMs: 5,
    });
    expect(summary).not.toHaveProperty('rows');
    expect(store.get(summary.id)).toEqual(summary);
  });

  it('gives every result its own id', () => {
    const store = new ResultStore();
    const first = store.add(result());
    const second = store.add(result());
    expect(first.id).not.toBe(second.id);
    expect(store.size).toBe(2);
  });

  it('counts rows from what was stored', () => {
    const store = new ResultStore();
    const summary = store.add(result({ rows: [[1], [2], [3]] }));
    expect(summary.rowCount).toBe(3);
  });

  it('keeps affected rows and the truncated flag when given', () => {
    const store = new ResultStore();
    const summary = store.add(result({ rows: [], affectedRows: 7, truncated: true }));
    expect(summary.affectedRows).toBe(7);
    expect(summary.truncated).toBe(true);
  });

  it('omits affected rows when the server said nothing', () => {
    const store = new ResultStore();
    expect(store.add(result())).not.toHaveProperty('affectedRows');
  });

  it('stores a failure with its code, message and position', () => {
    const store = new ResultStore();
    const summary = store.add(
      result({
        rows: [],
        columns: [],
        error: { code: 'syntax', message: 'near "SELEC"', position: 7 },
      }),
    );
    expect(summary.error).toEqual({ code: 'syntax', message: 'near "SELEC"', position: 7 });
    expect(summary.rowCount).toBe(0);
  });

  it('returns nothing for an unknown id', () => {
    expect(new ResultStore().get('result-404')).toBeUndefined();
  });

  describe('forDocument', () => {
    it('lists a document’s results oldest first', () => {
      const store = new ResultStore();
      const first = store.add(result({ statement: 'SELECT 1' }));
      const second = store.add(result({ statement: 'SELECT 2' }));
      expect(store.forDocument(DOC).map((item) => item.id)).toEqual([first.id, second.id]);
    });

    it('keeps documents apart', () => {
      const store = new ResultStore();
      store.add(result());
      store.add(result({ documentUri: 'untitled:Other.sql' }));
      expect(store.forDocument(DOC)).toHaveLength(1);
      expect(store.forDocument('untitled:Other.sql')).toHaveLength(1);
      expect(store.forDocument('untitled:None.sql')).toEqual([]);
    });

    it('drops the oldest results beyond the per-document limit', () => {
      const store = new ResultStore();
      const ids: string[] = [];
      for (let index = 0; index < MAX_RESULTS_PER_DOCUMENT + 3; index++) {
        ids.push(store.add(result({ statement: `SELECT ${index}` })).id);
      }
      expect(store.forDocument(DOC)).toHaveLength(MAX_RESULTS_PER_DOCUMENT);
      // The three oldest are gone entirely, not just hidden from the list.
      for (const dropped of ids.slice(0, 3)) {
        expect(store.get(dropped)).toBeUndefined();
      }
      const newest = ids.at(-1);
      expect(newest).toBeDefined();
      expect(store.get(newest ?? '')).toBeDefined();
    });
  });

  describe('window', () => {
    const rows = Array.from({ length: 10 }, (_, index) => [index]);

    it('returns the asked-for slice with the total count', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(store.window(id, 2, 3)).toEqual({
        offset: 2,
        rows: [[2], [3], [4]],
        rowCount: 10,
        changes: [],
        states: [],
      });
    });

    it('stops at the end of the result', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(store.window(id, 8, 100)?.rows).toEqual([[8], [9]]);
    });

    it('clamps an offset past the end to an empty window', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(store.window(id, 50, 10)).toEqual({
        offset: 10,
        rows: [],
        rowCount: 10,
        changes: [],
        states: [],
      });
    });

    it('treats a negative or fractional range sensibly', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(store.window(id, -5, 2)?.rows).toEqual([[0], [1]]);
      expect(store.window(id, 0, -1)?.rows).toEqual([]);
      expect(store.window(id, 1.7, 2.9)?.rows).toEqual([[1], [2]]);
    });

    it('returns nothing for an unknown result', () => {
      expect(new ResultStore().window('result-404', 0, 10)).toBeUndefined();
    });
  });

  describe('pending changes', () => {
    const rows = [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ];

    it('shows a changed value in the window and reports where it is', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      expect(store.setChange(id, 1, 1, { kind: 'value', value: 'B!' })).toBe(true);
      expect(store.window(id, 0, 3)).toEqual({
        offset: 0,
        rows: [
          [1, 'a'],
          [2, 'B!'],
          [3, 'c'],
        ],
        rowCount: 3,
        changes: [{ row: 1, column: 1, kind: 'value' }],
        states: [],
      });
    });

    it('shows a DEFAULT as NULL and marks it as a default', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      store.setChange(id, 0, 1, { kind: 'default' });
      const window = store.window(id, 0, 1);
      expect(window?.rows).toEqual([[1, null]]);
      expect(window?.changes).toEqual([{ row: 0, column: 1, kind: 'default' }]);
    });

    it('does not touch the rows the server returned', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      store.setChange(id, 0, 1, { kind: 'value', value: 'z' });
      expect(store.rowAt(id, 0)).toEqual([1, 'a']);
      expect(store.allRows(id)).toEqual(rows);
    });

    it('keeps a change with its row when the result is sorted', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      store.setChange(id, 0, 1, { kind: 'value', value: 'z' });
      await store.sort(id, 0, 'desc');
      const window = store.window(id, 0, 3);
      expect(window?.rows).toEqual([
        [3, 'c'],
        [2, 'b'],
        [1, 'z'],
      ]);
      expect(window?.changes).toEqual([{ row: 2, column: 1, kind: 'value' }]);
    });

    it('counts changed cells, withdraws them and bumps the revision each time', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      expect(store.get(id)).toMatchObject({ changedCells: 0, revision: 0 });
      store.setChange(id, 0, 0, { kind: 'value', value: 9 });
      store.setChange(id, 0, 1, { kind: 'default' });
      store.setChange(id, 2, 1, { kind: 'value', value: 'q' });
      expect(store.get(id)).toMatchObject({ changedCells: 3, revision: 3 });
      store.setChange(id, 0, 0, undefined);
      expect(store.get(id)).toMatchObject({ changedCells: 2, revision: 4 });
      expect(store.changeAt(id, 0, 0)).toBeUndefined();
      expect(store.changeAt(id, 0, 1)).toEqual({ kind: 'default' });
    });

    it('notifies listeners when a change is made', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      const seen: string[] = [];
      store.onDidChange((uri) => {
        seen.push(uri);
      });
      store.setChange(id, 0, 0, { kind: 'value', value: 9 });
      expect(seen).toEqual(['untitled:Query-1.sql']);
    });

    it('refuses a cell that does not exist', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      expect(store.setChange(id, 99, 0, { kind: 'default' })).toBe(false);
      expect(store.setChange(id, 0, 99, { kind: 'default' })).toBe(false);
      expect(store.setChange(id, 0, -1, { kind: 'default' })).toBe(false);
      expect(store.setChange('result-404', 0, 0, { kind: 'default' })).toBe(false);
      expect(store.get(id)?.changedCells).toBe(0);
    });

    it('leaves a window without changes when nothing is pending', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      expect(store.window(id, 0, 3)?.changes).toEqual([]);
    });

    it('forgets changes with the result', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }] }));
      store.setChange(id, 0, 0, { kind: 'default' });
      store.clearDocument('untitled:Query-1.sql');
      expect(store.window(id, 0, 3)).toBeUndefined();
    });
  });

  describe('pending rows', () => {
    const rows = [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ];
    const edit = {
      editable: true as const,
      table: { name: 't' },
      columnMap: ['id', 'v'],
      columns: [
        { name: 'id', dataType: 'int', nullable: false, kind: 'integer' as const },
        { name: 'v', dataType: 'text', nullable: true, kind: 'text' as const },
      ],
      keyColumns: ['id'],
      keyIndexes: [0],
    };
    function add() {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, columns: [{ name: 'id' }, { name: 'v' }], edit }));
      return { store, id };
    }

    it('shows a new row after the server rows, with every cell a default', () => {
      const { store, id } = add();
      expect(store.addRow(id)).toBe(3);
      const window = store.window(id, 0, 10);
      expect(window?.rowCount).toBe(4);
      expect(window?.rows[3]).toEqual([null, null]);
      expect(window?.states).toEqual([{ row: 3, state: 'inserted' }]);
      expect(window?.changes).toEqual([
        { row: 3, column: 0, kind: 'default' },
        { row: 3, column: 1, kind: 'default' },
      ]);
      expect(store.get(id)).toMatchObject({ insertedRows: 1, rowCount: 3 });
    });

    it('starts a new row from given cells', () => {
      const { store, id } = add();
      store.addRow(id, new Map([[1, { kind: 'value', value: 'hi' }]]));
      expect(store.window(id, 3, 1)?.rows[0]).toEqual([null, 'hi']);
      expect(store.isInsertedRow(id, 3)).toBe(true);
      expect(store.isInsertedRow(id, 2)).toBe(false);
      expect(store.isInsertedRow(id, 4)).toBe(false);
    });

    it('edits a cell of a new row, and a DEFAULT unsets it again', () => {
      const { store, id } = add();
      const index = store.addRow(id) ?? -1;
      store.setChange(id, index, 1, { kind: 'value', value: 'x' });
      expect(store.changeAt(id, index, 1)).toEqual({ kind: 'value', value: 'x' });
      store.setChange(id, index, 1, { kind: 'default' });
      expect(store.changeAt(id, index, 1)).toBeUndefined();
      expect(store.get(id)?.changedCells).toBe(0);
    });

    it('marks a server row for deletion and restores it', () => {
      const { store, id } = add();
      expect(store.deleteRow(id, 1)).toBe(true);
      expect(store.isDeletedRow(id, 1)).toBe(true);
      expect(store.window(id, 0, 3)?.states).toEqual([{ row: 1, state: 'deleted' }]);
      expect(store.get(id)?.deletedRows).toBe(1);
      expect(store.restoreRow(id, 1)).toBe(true);
      expect(store.isDeletedRow(id, 1)).toBe(false);
      expect(store.get(id)?.deletedRows).toBe(0);
    });

    it('drops a new row outright when it is deleted', () => {
      const { store, id } = add();
      store.addRow(id);
      expect(store.deleteRow(id, 3)).toBe(true);
      expect(store.get(id)?.insertedRows).toBe(0);
      expect(store.window(id, 0, 10)?.rowCount).toBe(3);
    });

    it('keeps a deleted row marked after sorting', async () => {
      const { store, id } = add();
      store.deleteRow(id, 0);
      await store.sort(id, 0, 'desc');
      expect(store.window(id, 0, 3)?.states).toEqual([{ row: 2, state: 'deleted' }]);
    });

    it('keeps new rows after the server rows when sorted', async () => {
      const { store, id } = add();
      store.addRow(id, new Map([[0, { kind: 'value', value: 0 }]]));
      await store.sort(id, 0, 'desc');
      expect(store.window(id, 0, 4)?.rows.map((row) => row[0])).toEqual([3, 2, 1, 0]);
    });

    it('refuses rows that are not there', () => {
      const { store, id } = add();
      expect(store.deleteRow(id, 9)).toBe(false);
      expect(store.restoreRow(id, 9)).toBe(false);
      expect(store.addRow('result-404')).toBeUndefined();
      expect(store.deleteRow('result-404', 0)).toBe(false);
      expect(store.restoreRow('result-404', 0)).toBe(false);
    });

    it('does not mark computed columns of a new row as defaults', () => {
      const store = new ResultStore();
      const { id } = store.add(
        result({
          rows,
          columns: [{ name: 'id' }, { name: 'total' }],
          edit: { ...edit, columns: [edit.columns[0] ?? null, null] },
        }),
      );
      store.addRow(id);
      expect(store.window(id, 3, 1)?.changes).toEqual([{ row: 3, column: 0, kind: 'default' }]);
    });
  });

  describe('saving support', () => {
    const rows = [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ];
    function add() {
      const store = new ResultStore();
      const { id } = store.add(
        result({
          rows,
          columns: [{ name: 'id' }, { name: 'v' }],
          origin: { target: { connectionId: 'c1', database: 'app' }, owner: 'editor:x' },
        }),
      );
      return { store, id };
    }

    it('remembers where the rows came from', () => {
      const { store, id } = add();
      expect(store.get(id)?.origin).toEqual({
        target: { connectionId: 'c1', database: 'app' },
        owner: 'editor:x',
      });
    });

    it('hands over the pending changes as a plan', () => {
      const { store, id } = add();
      store.setChange(id, 0, 1, { kind: 'value', value: 'z' });
      store.deleteRow(id, 2);
      store.addRow(id, new Map([[1, { kind: 'value', value: 'n' }]]));
      const plan = store.pendingPlan(id);
      expect(plan?.updates).toEqual([
        { row: rows[0], cells: new Map([[1, { kind: 'value', value: 'z' }]]) },
      ]);
      expect(plan?.deletions).toEqual([rows[2]]);
      expect(plan?.insertions).toHaveLength(1);
      expect(store.pendingPlan('result-404')).toBeUndefined();
    });

    it('throws every pending change away', () => {
      const { store, id } = add();
      store.setChange(id, 0, 1, { kind: 'default' });
      store.deleteRow(id, 1);
      store.addRow(id);
      expect(store.discardPending(id)).toBe(true);
      expect(store.get(id)).toMatchObject({ changedCells: 0, insertedRows: 0, deletedRows: 0 });
      expect(store.discardPending('result-404')).toBe(false);
    });

    it('reverts the chosen rows only: cell edits, deletion marks and new rows', () => {
      const { store, id } = add();
      store.setChange(id, 0, 1, { kind: 'value', value: 'z' });
      store.setChange(id, 1, 1, { kind: 'value', value: 'y' });
      store.deleteRow(id, 2);
      store.addRow(id);
      store.addRow(id);
      expect(store.revertRows(id, [0, 2, 3])).toBe(true);
      expect(store.get(id)).toMatchObject({ changedCells: 1, insertedRows: 1, deletedRows: 0 });
      expect(store.changeAt(id, 1, 1)).toEqual({ kind: 'value', value: 'y' });
      expect(store.revertRows(id, [99])).toBe(false);
      // A bad index among good ones reverts nothing.
      expect(store.revertRows(id, [1, 99])).toBe(false);
      expect(store.changeAt(id, 1, 1)).toEqual({ kind: 'value', value: 'y' });
      expect(store.revertRows('result-404', [0])).toBe(false);
    });

    it('swaps in fresh rows, dropping pending changes and keeping the sort', async () => {
      const { store, id } = add();
      await store.sort(id, 0, 'desc');
      store.setChange(id, 0, 1, { kind: 'default' });
      expect(
        store.replaceRows(
          id,
          [{ name: 'id' }, { name: 'v' }],
          [
            [10, 'x'],
            [11, 'y'],
          ],
          true,
        ),
      ).toBe(true);
      expect(store.get(id)).toMatchObject({
        rowCount: 2,
        truncated: true,
        changedCells: 0,
        sort: { column: 0, direction: 'desc' },
      });
      expect(store.window(id, 0, 5)?.rows).toEqual([
        [11, 'y'],
        [10, 'x'],
      ]);
      // Clearing the sort goes back to the server's order of the fresh rows.
      await store.sort(id, 0);
      expect(store.window(id, 0, 5)?.rows.map((row) => row[0])).toEqual([10, 11]);
    });

    it('notifies when pending changes are discarded, reverted or replaced', () => {
      const { store, id } = add();
      let count = 0;
      store.onDidChange(() => {
        count += 1;
      });
      store.discardPending(id);
      store.revertRows(id, [0]);
      store.replaceRows(id, [], [], false);
      expect(count).toBe(3);
    });

    it('refuses to replace the rows of an unknown result', () => {
      expect(new ResultStore().replaceRows('result-404', [], [], false)).toBe(false);
    });
  });

  describe('clearing', () => {
    it('clearDocument removes only that document', () => {
      const store = new ResultStore();
      const kept = store.add(result({ documentUri: 'untitled:Other.sql' }));
      store.add(result());
      store.clearDocument(DOC);
      expect(store.forDocument(DOC)).toEqual([]);
      expect(store.get(kept.id)).toBeDefined();
    });

    it('clearDocument on an unknown document does nothing', () => {
      const store = new ResultStore();
      store.add(result());
      store.clearDocument('untitled:None.sql');
      expect(store.size).toBe(1);
    });

    it('clear empties the store', () => {
      const store = new ResultStore();
      store.add(result());
      store.add(result({ documentUri: 'untitled:Other.sql' }));
      store.clear();
      expect(store.size).toBe(0);
      expect(store.forDocument(DOC)).toEqual([]);
    });
  });

  describe('events', () => {
    it('fires for the document on add, clearDocument and clear', () => {
      const store = new ResultStore();
      const changed = vi.fn();
      store.onDidChange(changed);
      store.add(result());
      store.clearDocument(DOC);
      store.add(result());
      store.clear();
      expect(changed.mock.calls).toEqual([[DOC], [DOC], [DOC], [DOC]]);
    });

    it('stays quiet for a clearDocument that changed nothing', () => {
      const store = new ResultStore();
      const changed = vi.fn();
      store.onDidChange(changed);
      store.clearDocument('untitled:None.sql');
      expect(changed).not.toHaveBeenCalled();
    });

    it('stops notifying a disposed listener', () => {
      const store = new ResultStore();
      const changed = vi.fn();
      store.onDidChange(changed).dispose();
      store.add(result());
      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('sort', () => {
    const rows = [
      [3, 'c'],
      [1, 'a'],
      [2, 'b'],
    ];

    it('orders the stored rows and reports the order on the summary', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      const sorted = await store.sort(id, 0, 'asc');
      expect(sorted?.sort).toEqual({ column: 0, direction: 'asc' });
      expect(store.window(id, 0, 10)?.rows.map((row) => row[0])).toEqual([1, 2, 3]);
    });

    it('sorts every row, not just a loaded window', async () => {
      const store = new ResultStore();
      const many = Array.from({ length: 500 }, (_, index) => [500 - index]);
      const { id } = store.add(result({ rows: many }));
      await store.sort(id, 0, 'asc');
      // The first window now holds what was at the very end before.
      expect(store.window(id, 0, 3)?.rows).toEqual([[1], [2], [3]]);
    });

    it('sorts descending', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      await store.sort(id, 0, 'desc');
      expect(store.window(id, 0, 10)?.rows.map((row) => row[0])).toEqual([3, 2, 1]);
    });

    it('restores the server order when no direction is given', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      await store.sort(id, 0, 'asc');
      const restored = await store.sort(id, 0);
      expect(restored?.sort).toBeUndefined();
      expect(store.window(id, 0, 10)?.rows.map((row) => row[0])).toEqual([3, 1, 2]);
    });

    it('sorts from the server order every time, not from the last sort', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      await store.sort(id, 0, 'asc');
      await store.sort(id, 1, 'desc');
      expect(store.window(id, 0, 10)?.rows.map((row) => row[1])).toEqual(['c', 'b', 'a']);
    });

    it('keeps the row count and the rest of the summary', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, durationMs: 9 }));
      const sorted = await store.sort(id, 0, 'asc');
      expect(sorted).toMatchObject({ rowCount: 3, durationMs: 9, statement: 'SELECT 1' });
    });

    it('tells the document that its results changed', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      const changed = vi.fn();
      store.onDidChange(changed);
      await store.sort(id, 0, 'asc');
      expect(changed).toHaveBeenCalledWith(DOC);
    });

    it('returns nothing for an unknown result', async () => {
      expect(await new ResultStore().sort('result-404', 0, 'asc')).toBeUndefined();
    });

    const many = Array.from({ length: 5000 }, (_, index) => [`row ${(index * 31) % 5000}`]);

    it('lets a newer sort win over one that is still running', async () => {
      const { store, release } = heldStore();
      const { id } = store.add(result({ rows: many }));
      const first = store.sort(id, 0, 'asc');
      const second = store.sort(id, 0, 'desc');
      await release();
      expect(await first).toBeUndefined();
      expect((await second)?.sort).toEqual({ column: 0, direction: 'desc' });
      // Numbers inside text compare by value, so 4999 comes after 999.
      expect(store.window(id, 0, 1)?.rows).toEqual([['row 4999']]);
    });

    it('drops a sort whose result was cleared meanwhile', async () => {
      const { store, release } = heldStore();
      const { id } = store.add(result({ rows: many }));
      const sorting = store.sort(id, 0, 'asc');
      store.clearDocument(DOC);
      await release();
      expect(await sorting).toBeUndefined();
      expect(store.get(id)).toBeUndefined();
    });

    it('drops a sort of rows that were replaced meanwhile', async () => {
      const { store, release } = heldStore();
      const { id } = store.add(result({ rows: many }));
      const sorting = store.sort(id, 0, 'asc');
      store.replaceRows(id, [{ name: 'one' }], [['z'], ['a']], false);
      await release();
      expect(await sorting).toBeUndefined();
      expect(store.window(id, 0, 5)?.rows).toEqual([['z'], ['a']]);
      expect(store.get(id)?.sort).toBeUndefined();
    });

    it('keeps the rows readable while a sort is running', async () => {
      const { store, release } = heldStore();
      const { id } = store.add(result({ rows: many }));
      const sorting = store.sort(id, 0, 'asc');
      // The server order is still what the grid gets until the sort is done.
      expect(store.window(id, 0, 1)?.rows).toEqual([['row 0']]);
      expect(store.window(id, 1, 1)?.rows).toEqual([['row 31']]);
      await release();
      await sorting;
      expect(store.window(id, 0, 2)?.rows).toEqual([['row 0'], ['row 1']]);
    });

    // The million rows of the budget are measured in test/perf; here the behaviour, on
    // fewer rows, so it holds under coverage instrumentation too.
    it('sorts a big result without holding the host for long', async () => {
      const big = Array.from({ length: 200_000 }, (_, index) => [(index * 7919) % 200_000]);
      const store = new ResultStore();
      const { id } = store.add(result({ rows: big }));
      let longest = 0;
      let last = performance.now();
      const probe = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 1);
      try {
        last = performance.now();
        await store.sort(id, 0, 'desc');
      } finally {
        clearInterval(probe);
      }
      expect(store.window(id, 0, 2)?.rows).toEqual([[199_999], [199_998]]);
      // Generous for slow machines: before V9.1 the whole sort ran in one go.
      expect(longest).toBeLessThan(500);
    }, 60_000);
  });

  describe('cell budget', () => {
    const rows = (count: number): number[][] =>
      Array.from({ length: count }, (_, index) => [index]);

    it('is about twenty million cells by default', () => {
      expect(MAX_KEPT_CELLS).toBe(20_000_000);
    });

    it('drops the oldest results of any document once the budget is passed', () => {
      const store = new ResultStore({ maxCells: 100 });
      const old = store.add(result({ documentUri: 'a', rows: rows(60) }));
      const kept = store.add(result({ documentUri: 'b', rows: rows(30) }));
      const fresh = store.add(result({ documentUri: 'c', rows: rows(40) }));
      expect(store.get(old.id)).toBeUndefined();
      expect(store.forDocument('a')).toEqual([]);
      expect(store.get(kept.id)).toBeDefined();
      expect(store.get(fresh.id)).toBeDefined();
    });

    it('counts cells, not rows', () => {
      const store = new ResultStore({ maxCells: 100 });
      const wide = store.add(
        result({ columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], rows: rows(20) }),
      );
      store.add(result({ rows: rows(45) }));
      // 60 + 45 cells: one over the budget, so the wide result goes.
      expect(store.get(wide.id)).toBeUndefined();
    });

    it('always keeps the newest result, however big', () => {
      const store = new ResultStore({ maxCells: 10 });
      const older = store.add(result({ rows: rows(5) }));
      const huge = store.add(result({ rows: rows(1000) }));
      expect(store.get(huge.id)?.rowCount).toBe(1000);
      expect(store.get(older.id)).toBeUndefined();
    });

    it('keeps a result with unsaved changes and drops the next oldest instead', () => {
      const store = new ResultStore({ maxCells: 100 });
      const edited = store.add(result({ documentUri: 'a', rows: rows(40) }));
      store.setChange(edited.id, 0, 0, { kind: 'value', value: 'x' });
      const plain = store.add(result({ documentUri: 'b', rows: rows(40) }));
      store.add(result({ documentUri: 'c', rows: rows(40) }));
      expect(store.get(edited.id)?.changedCells).toBe(1);
      expect(store.get(plain.id)).toBeUndefined();
    });

    it('tells every document that lost a result', () => {
      const store = new ResultStore({ maxCells: 50 });
      store.add(result({ documentUri: 'a', rows: rows(30) }));
      store.add(result({ documentUri: 'b', rows: rows(10) }));
      const changed = vi.fn();
      store.onDidChange(changed);
      store.add(result({ documentUri: 'c', rows: rows(30) }));
      expect(changed.mock.calls.map(([uri]) => uri as string).sort()).toEqual(['a', 'c']);
    });

    it('keeps the remaining results of a document that lost its oldest', () => {
      const store = new ResultStore({ maxCells: 50 });
      const first = store.add(result({ rows: rows(30) }));
      const second = store.add(result({ rows: rows(10) }));
      store.add(result({ documentUri: 'other', rows: rows(15) }));
      expect(store.forDocument(DOC).map((summary) => summary.id)).toEqual([second.id]);
      expect(store.get(first.id)).toBeUndefined();
    });
  });

  describe('summarize (V10.2.4)', () => {
    const rows = [
      [1, { kind: 'decimal', text: '1.10' }, 'a'],
      [2, { kind: 'decimal', text: '2.20' }, null],
      [3, null, 'c'],
    ] as const;

    it('totals a rectangle of the shown cells', async () => {
      const store = new ResultStore();
      const { id } = store.add(
        result({
          columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
          rows: rows.map((row) => [...row]),
        }),
      );
      expect(await store.summarize(id, 0, 2, [0, 1])).toEqual({
        cells: 6,
        values: 5,
        numbers: 5,
        sum: '9.30',
        average: '1.86',
        min: '1',
        max: '3',
      });
      expect(await store.summarize(id, 1, 1, [2])).toEqual({ cells: 1, values: 0, numbers: 0 });
    });

    it('totals what is shown: sorted, edited and new rows included', async () => {
      const store = new ResultStore();
      const edit: EditableResult = {
        editable: true,
        table: { name: 't' },
        columnMap: ['a'],
        columns: [{ name: 'a', dataType: 'int', nullable: true, kind: 'integer' }],
        keyColumns: ['a'],
        keyIndexes: [0],
      };
      const { id } = store.add(result({ columns: [{ name: 'a' }], rows: [[5], [1], [3]], edit }));
      await store.sort(id, 0, 'asc');
      expect(await store.summarize(id, 0, 0, [0])).toMatchObject({ min: '1', max: '1' });
      store.setChange(id, 0, 0, { kind: 'value', value: 10 });
      const added = store.addRow(id, new Map([[0, { kind: 'value', value: 100 }]]));
      expect(added).toBe(3);
      expect(await store.summarize(id, 0, 3, [0])).toMatchObject({ sum: '118', max: '100' });
    });

    it('ignores columns that are not there and answers nothing for an unknown result', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows: [[1], [2]] }));
      expect(await store.summarize(id, 0, 1, [0, 7])).toMatchObject({ cells: 2, sum: '3' });
      expect(await store.summarize('result-404', 0, 1, [0])).toBeUndefined();
      expect(await store.summarize(id, 1, 0, [0])).toBeUndefined();
    });

    const many = Array.from({ length: 5000 }, (_, index) => [index]);

    it('stops a summary that a newer one overtook', async () => {
      const { store, release } = heldStore();
      const { id } = store.add(result({ rows: many }));
      const first = store.summarize(id, 0, 4999, [0]);
      const second = store.summarize(id, 0, 9, [0]);
      await release();
      expect(await first).toBeUndefined();
      expect(await second).toMatchObject({ sum: '45' });
    });

    it('stops a summary when the rows are replaced or edited, or the result goes away', async () => {
      const replaced = heldStore();
      const two = replaced.store.add(result({ rows: many }));
      const again = replaced.store.summarize(two.id, 0, 4999, [0]);
      replaced.store.replaceRows(two.id, [{ name: 'one' }], [[1]], false);
      await replaced.release();
      expect(await again).toBeUndefined();

      const edited = heldStore();
      const edit: EditableResult = {
        editable: true,
        table: { name: 't' },
        columnMap: ['one'],
        columns: [{ name: 'one', dataType: 'int', nullable: true, kind: 'integer' }],
        keyColumns: ['one'],
        keyIndexes: [0],
      };
      const four = edited.store.add(result({ rows: many, edit }));
      const before = edited.store.summarize(four.id, 0, 4999, [0]);
      edited.store.setChange(four.id, 4000, 0, { kind: 'value', value: 1 });
      await edited.release();
      expect(await before).toBeUndefined();

      const cleared = heldStore();
      const three = cleared.store.add(result({ rows: many }));
      const gone = cleared.store.summarize(three.id, 0, 4999, [0]);
      cleared.store.clear();
      await cleared.release();
      expect(await gone).toBeUndefined();
    });
  });

  describe('search', () => {
    const rows = [
      [1, 'alice@example.com'],
      [2, 'bob@test.org'],
      [3, 'carol@example.com'],
    ];

    it('finds the rows that contain the text', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(await store.search(id, 'example.com')).toEqual({ rows: [0, 2], total: 2 });
    });

    it('searches in the order the rows are shown', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      await store.sort(id, 0, 'desc');
      // carol is now the first row, so her index moved.
      expect((await store.search(id, 'carol'))?.rows).toEqual([0]);
    });

    it('honours the cap it is given', async () => {
      const store = new ResultStore();
      const many = Array.from({ length: 30 }, () => ['match']);
      const { id } = store.add(result({ rows: many }));
      const hits = await store.search(id, 'match', 5);
      expect(hits?.rows).toHaveLength(5);
      expect(hits?.total).toBe(30);
    });

    it('finds nothing for a blank search', async () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(await store.search(id, '  ')).toEqual({ rows: [], total: 0 });
    });

    it('returns nothing for an unknown result', async () => {
      expect(await new ResultStore().search('result-404', 'x')).toBeUndefined();
    });

    const many = Array.from({ length: 5000 }, (_, index) => [`row ${index}`]);

    it('stops a search that a newer one overtook', async () => {
      const { store, release } = heldStore();
      const { id } = store.add(result({ rows: many }));
      const first = store.search(id, 'row 1');
      const second = store.search(id, 'row 4999');
      await release();
      expect(await first).toBeUndefined();
      expect(await second).toEqual({ rows: [4999], total: 1 });
    });

    it('stops a search when fresh rows replace the searched ones', async () => {
      const { store, release } = heldStore();
      const { id } = store.add(result({ rows: many }));
      const searching = store.search(id, 'row 7');
      store.replaceRows(id, [{ name: 'one' }], [['row 7']], false);
      await release();
      expect(await searching).toBeUndefined();
      expect(await store.search(id, 'row 7')).toEqual({ rows: [0], total: 1 });
    });

    it('stops a search when the result goes away', async () => {
      const { store, release } = heldStore();
      const { id } = store.add(result({ rows: many }));
      const searching = store.search(id, 'row');
      store.clear();
      await release();
      expect(await searching).toBeUndefined();
    });

    it('searches separate results independently', async () => {
      const { store, release } = heldStore();
      const one = store.add(result({ rows: many }));
      const two = store.add(result({ rows: many }));
      const first = store.search(one.id, 'row 10');
      const second = store.search(two.id, 'row 20');
      await release();
      expect((await first)?.total).toBe(111);
      expect((await second)?.total).toBe(111);
    });
  });
});
