import { describe, expect, it, vi } from 'vitest';
import {
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
      expect(store.window(id, 50, 10)).toEqual({ offset: 10, rows: [], rowCount: 10, changes: [] });
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
      const { id } = store.add(result({ rows }));
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
      });
    });

    it('shows a DEFAULT as NULL and marks it as a default', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      store.setChange(id, 0, 1, { kind: 'default' });
      const window = store.window(id, 0, 1);
      expect(window?.rows).toEqual([[1, null]]);
      expect(window?.changes).toEqual([{ row: 0, column: 1, kind: 'default' }]);
    });

    it('does not touch the rows the server returned', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      store.setChange(id, 0, 1, { kind: 'value', value: 'z' });
      expect(store.rowAt(id, 0)).toEqual([1, 'a']);
      expect(store.allRows(id)).toEqual(rows);
    });

    it('keeps a change with its row when the result is sorted', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      store.setChange(id, 0, 1, { kind: 'value', value: 'z' });
      store.sort(id, 0, 'desc');
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
      const { id } = store.add(result({ rows }));
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
      const { id } = store.add(result({ rows }));
      const seen: string[] = [];
      store.onDidChange((uri) => {
        seen.push(uri);
      });
      store.setChange(id, 0, 0, { kind: 'value', value: 9 });
      expect(seen).toEqual(['untitled:Query-1.sql']);
    });

    it('refuses a cell that does not exist', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(store.setChange(id, 99, 0, { kind: 'default' })).toBe(false);
      expect(store.setChange(id, 0, 99, { kind: 'default' })).toBe(false);
      expect(store.setChange(id, 0, -1, { kind: 'default' })).toBe(false);
      expect(store.setChange('result-404', 0, 0, { kind: 'default' })).toBe(false);
      expect(store.get(id)?.changedCells).toBe(0);
    });

    it('leaves a window without changes when nothing is pending', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(store.window(id, 0, 3)?.changes).toEqual([]);
    });

    it('forgets changes with the result', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      store.setChange(id, 0, 0, { kind: 'default' });
      store.clearDocument('untitled:Query-1.sql');
      expect(store.window(id, 0, 3)).toBeUndefined();
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

    it('orders the stored rows and reports the order on the summary', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      const sorted = store.sort(id, 0, 'asc');
      expect(sorted?.sort).toEqual({ column: 0, direction: 'asc' });
      expect(store.window(id, 0, 10)?.rows.map((row) => row[0])).toEqual([1, 2, 3]);
    });

    it('sorts every row, not just a loaded window', () => {
      const store = new ResultStore();
      const many = Array.from({ length: 500 }, (_, index) => [500 - index]);
      const { id } = store.add(result({ rows: many }));
      store.sort(id, 0, 'asc');
      // The first window now holds what was at the very end before.
      expect(store.window(id, 0, 3)?.rows).toEqual([[1], [2], [3]]);
    });

    it('sorts descending', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      store.sort(id, 0, 'desc');
      expect(store.window(id, 0, 10)?.rows.map((row) => row[0])).toEqual([3, 2, 1]);
    });

    it('restores the server order when no direction is given', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      store.sort(id, 0, 'asc');
      const restored = store.sort(id, 0);
      expect(restored?.sort).toBeUndefined();
      expect(store.window(id, 0, 10)?.rows.map((row) => row[0])).toEqual([3, 1, 2]);
    });

    it('sorts from the server order every time, not from the last sort', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      store.sort(id, 0, 'asc');
      store.sort(id, 1, 'desc');
      expect(store.window(id, 0, 10)?.rows.map((row) => row[1])).toEqual(['c', 'b', 'a']);
    });

    it('keeps the row count and the rest of the summary', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows, durationMs: 9 }));
      const sorted = store.sort(id, 0, 'asc');
      expect(sorted).toMatchObject({ rowCount: 3, durationMs: 9, statement: 'SELECT 1' });
    });

    it('tells the document that its results changed', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      const changed = vi.fn();
      store.onDidChange(changed);
      store.sort(id, 0, 'asc');
      expect(changed).toHaveBeenCalledWith(DOC);
    });

    it('returns nothing for an unknown result', () => {
      expect(new ResultStore().sort('result-404', 0, 'asc')).toBeUndefined();
    });
  });

  describe('search', () => {
    const rows = [
      [1, 'alice@example.com'],
      [2, 'bob@test.org'],
      [3, 'carol@example.com'],
    ];

    it('finds the rows that contain the text', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(store.search(id, 'example.com')).toEqual({ rows: [0, 2], total: 2 });
    });

    it('searches in the order the rows are shown', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      store.sort(id, 0, 'desc');
      // carol is now the first row, so her index moved.
      expect(store.search(id, 'carol')?.rows).toEqual([0]);
    });

    it('honours the cap it is given', () => {
      const store = new ResultStore();
      const many = Array.from({ length: 30 }, () => ['match']);
      const { id } = store.add(result({ rows: many }));
      const hits = store.search(id, 'match', 5);
      expect(hits?.rows).toHaveLength(5);
      expect(hits?.total).toBe(30);
    });

    it('finds nothing for a blank search', () => {
      const store = new ResultStore();
      const { id } = store.add(result({ rows }));
      expect(store.search(id, '  ')).toEqual({ rows: [], total: 0 });
    });

    it('returns nothing for an unknown result', () => {
      expect(new ResultStore().search('result-404', 'x')).toBeUndefined();
    });
  });
});
