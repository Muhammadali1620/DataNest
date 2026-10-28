import { describe, expect, it } from 'vitest';
import { PendingEdits, type ResultRow } from '../../../src/services/pending-edits';

const A: ResultRow = [1, 'a'];
const B: ResultRow = [2, 'b'];
const C: ResultRow = [3, 'c'];
const ROWS = [A, B, C];
const ALL = (): boolean => true;

describe('PendingEdits', () => {
  describe('cell changes', () => {
    it('records, replaces and withdraws a change', () => {
      const pending = new PendingEdits();
      expect(pending.isEmpty).toBe(true);
      pending.setChange(A, 1, { kind: 'value', value: 'x' });
      pending.setChange(A, 1, { kind: 'value', value: 'y' });
      expect(pending.changeOf(A, 1)).toEqual({ kind: 'value', value: 'y' });
      expect(pending.changedCells).toBe(1);
      expect(pending.isEmpty).toBe(false);
      pending.setChange(A, 1, undefined);
      expect(pending.changedCells).toBe(0);
      expect(pending.isEmpty).toBe(true);
    });

    it('counts cells across rows', () => {
      const pending = new PendingEdits();
      pending.setChange(A, 0, { kind: 'default' });
      pending.setChange(A, 1, { kind: 'default' });
      pending.setChange(B, 1, { kind: 'default' });
      expect(pending.changedCells).toBe(3);
    });

    it('moves the revision on every mutation', () => {
      const pending = new PendingEdits();
      const seen = [pending.revision];
      pending.setChange(A, 0, { kind: 'default' });
      seen.push(pending.revision);
      pending.setDeleted(B, true);
      seen.push(pending.revision);
      pending.addInserted();
      seen.push(pending.revision);
      pending.clear();
      seen.push(pending.revision);
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  describe('deleted rows', () => {
    it('marks and restores', () => {
      const pending = new PendingEdits();
      pending.setDeleted(A, true);
      expect(pending.isDeleted(A)).toBe(true);
      expect(pending.deletedRows).toBe(1);
      pending.setDeleted(A, false);
      expect(pending.isDeleted(A)).toBe(false);
      expect(pending.deletedRows).toBe(0);
    });

    it('does not move the revision when nothing changed', () => {
      const pending = new PendingEdits();
      pending.setDeleted(A, false);
      expect(pending.revision).toBe(0);
      pending.setDeleted(A, true);
      const after = pending.revision;
      pending.setDeleted(A, true);
      expect(pending.revision).toBe(after);
    });
  });

  describe('inserted rows', () => {
    it('adds a row, sets its cells and treats DEFAULT as unset', () => {
      const pending = new PendingEdits();
      const index = pending.addInserted(new Map([[0, { kind: 'value', value: 7 }]]));
      expect(pending.insertedRows).toBe(1);
      pending.setInsertedChange(index, 1, { kind: 'value', value: 'z' });
      pending.setInsertedChange(index, 0, { kind: 'default' });
      expect([...(pending.insertedRow(index) ?? [])]).toEqual([[1, { kind: 'value', value: 'z' }]]);
    });

    it('copies the starting cells instead of sharing them', () => {
      const pending = new PendingEdits();
      const start = new Map([[0, { kind: 'value' as const, value: 1 }]]);
      const index = pending.addInserted(start);
      pending.setInsertedChange(index, 0, { kind: 'value', value: 2 });
      expect(start.get(0)).toEqual({ kind: 'value', value: 1 });
    });

    it('removes a row and refuses one that is not there', () => {
      const pending = new PendingEdits();
      pending.addInserted();
      expect(pending.removeInserted(5)).toBe(false);
      expect(pending.removeInserted(-1)).toBe(false);
      expect(pending.removeInserted(0)).toBe(true);
      expect(pending.insertedRows).toBe(0);
      expect(pending.setInsertedChange(0, 0, { kind: 'value', value: 1 })).toBe(false);
    });
  });

  describe('overlay', () => {
    it('shows pending values and reports them', () => {
      const pending = new PendingEdits();
      pending.setChange(B, 1, { kind: 'value', value: 'B' });
      pending.setChange(C, 1, { kind: 'default' });
      const shown = pending.overlay(ROWS, 0, 3, 2, ALL);
      expect(shown.rows).toEqual([A, [2, 'B'], [3, null]]);
      expect(shown.changes).toEqual([
        { row: 1, column: 1, kind: 'value' },
        { row: 2, column: 1, kind: 'default' },
      ]);
      expect(shown.states).toEqual([]);
    });

    it('does not alter the rows it was given', () => {
      const pending = new PendingEdits();
      pending.setChange(A, 1, { kind: 'value', value: 'changed' });
      pending.overlay(ROWS, 0, 3, 2, ALL);
      expect(A).toEqual([1, 'a']);
    });

    it('marks deleted rows and puts new rows after the server rows', () => {
      const pending = new PendingEdits();
      pending.setDeleted(B, true);
      pending.addInserted(new Map([[1, { kind: 'value', value: 'new' }]]));
      const shown = pending.overlay(ROWS, 0, 4, 2, ALL);
      expect(shown.rows[3]).toEqual([null, 'new']);
      expect(shown.states).toEqual([
        { row: 1, state: 'deleted' },
        { row: 3, state: 'inserted' },
      ]);
      expect(shown.changes).toHaveLength(2);
      expect(shown.changes).toContainEqual({ row: 3, column: 1, kind: 'value' });
      expect(shown.changes).toContainEqual({ row: 3, column: 0, kind: 'default' });
    });

    it('does not mark a column that cannot be inserted as a default', () => {
      const pending = new PendingEdits();
      pending.addInserted();
      const shown = pending.overlay([], 0, 1, 2, (column) => column === 0);
      expect(shown.changes).toEqual([{ row: 0, column: 0, kind: 'default' }]);
    });

    it('covers only the asked-for slice', () => {
      const pending = new PendingEdits();
      pending.setChange(C, 0, { kind: 'value', value: 30 });
      pending.addInserted();
      const shown = pending.overlay(ROWS, 2, 4, 2, ALL);
      expect(shown.rows).toHaveLength(2);
      expect(shown.rows[0]).toEqual([30, 'c']);
      expect(shown.states).toEqual([{ row: 3, state: 'inserted' }]);
    });
  });

  describe('what to save', () => {
    it('lists updates in row order, leaving out rows that are being deleted', () => {
      const pending = new PendingEdits();
      pending.setChange(C, 0, { kind: 'default' });
      pending.setChange(A, 0, { kind: 'default' });
      pending.setChange(B, 0, { kind: 'default' });
      pending.setDeleted(B, true);
      expect(pending.updates(ROWS).map((update) => update.row)).toEqual([A, C]);
    });

    it('lists deletions and insertions', () => {
      const pending = new PendingEdits();
      pending.setDeleted(C, true);
      pending.setDeleted(A, true);
      pending.addInserted();
      pending.addInserted();
      expect(pending.deletions(ROWS)).toEqual([A, C]);
      expect(pending.insertions()).toHaveLength(2);
    });

    it('forgets everything on clear', () => {
      const pending = new PendingEdits();
      pending.setChange(A, 0, { kind: 'default' });
      pending.setDeleted(B, true);
      pending.addInserted();
      pending.clear();
      expect(pending.isEmpty).toBe(true);
      expect(pending.updates(ROWS)).toEqual([]);
    });
  });
});
