import { describe, expect, it } from 'vitest';
import type { EditableResult } from '../../../src/core/model/editability';
import { ResultEditor, sameValue } from '../../../src/services/result-editor';
import { type NewResult, ResultStore } from '../../../src/services/result-store';

const DOC = 'untitled:Query-1.sql';

const EDIT: EditableResult = {
  editable: true,
  table: { name: 'users' },
  columnMap: ['id', 'name', 'age', 'status', 'photo', null],
  columns: [
    { name: 'id', dataType: 'int', nullable: false, kind: 'integer' },
    { name: 'name', dataType: 'varchar(20)', nullable: true, kind: 'text' },
    { name: 'age', dataType: 'int', nullable: true, kind: 'integer' },
    {
      name: 'status',
      dataType: "enum('new','paid')",
      nullable: false,
      kind: 'enum',
      options: ['new', 'paid'],
    },
    { name: 'photo', dataType: 'blob', nullable: true, kind: 'binary' },
    null,
  ],
  keyColumns: ['id'],
  keyIndexes: [0],
};

function setup(overrides: Partial<NewResult> = {}) {
  const store = new ResultStore();
  const summary = store.add({
    documentUri: DOC,
    statement: 'SELECT * FROM users',
    statementStart: 0,
    columns: ['id', 'name', 'age', 'status', 'photo', 'total'].map((name) => ({ name })),
    rows: [
      [1, 'alice', 30, 'new', { kind: 'binary', size: 1, preview: 'ff' }, 3],
      [2, null, null, 'paid', null, 4],
    ],
    truncated: false,
    durationMs: 1,
    edit: EDIT,
    ...overrides,
  });
  return { store, id: summary.id, editor: new ResultEditor(store) };
}

describe('sameValue', () => {
  it('compares NULLs and text', () => {
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue(null, 'x')).toBe(false);
    expect(sameValue('x', null)).toBe(false);
    expect(sameValue('x', 'x')).toBe(true);
  });

  it('sees through the shape of a number', () => {
    expect(sameValue(5, 5)).toBe(true);
    expect(sameValue(5, { kind: 'bigint', text: '5' })).toBe(true);
    expect(sameValue({ kind: 'decimal', text: '1.50' }, 1.5)).toBe(false);
  });
});

describe('ResultEditor rows', () => {
  it('adds a row at the end and says where', () => {
    const { store, id, editor } = setup();
    expect(editor.rowAction(id, 'add', [])).toEqual({ ok: true, row: 2 });
    expect(store.get(id)?.insertedRows).toBe(1);
  });

  it('lets the cells of a new row be typed in, and NULL be set on a nullable one', () => {
    const { store, id, editor } = setup();
    editor.rowAction(id, 'add', []);
    expect(editor.editCell(id, 2, 1, { kind: 'text', text: 'carol' })).toEqual({ ok: true });
    expect(editor.editCell(id, 2, 2, { kind: 'null' })).toEqual({ ok: true });
    expect(store.changeAt(id, 2, 1)).toEqual({ kind: 'value', value: 'carol' });
    expect(store.changeAt(id, 2, 2)).toEqual({ kind: 'value', value: null });
    // Typing the same text a server row has is still a value for a new row.
    expect(editor.editCell(id, 2, 2, { kind: 'text', text: '30' })).toEqual({ ok: true });
    expect(store.changeAt(id, 2, 2)).toEqual({ kind: 'value', value: 30 });
  });

  it('refuses NULL on a NOT NULL column of a new row', () => {
    const { id, editor } = setup();
    editor.rowAction(id, 'add', []);
    expect(editor.editCell(id, 2, 3, { kind: 'null' })).toEqual({ ok: false, error: 'not-null' });
  });

  it('duplicates rows, leaving the key and binary columns to the server', () => {
    const { store, id, editor } = setup();
    editor.editCell(id, 0, 1, { kind: 'text', text: 'edited' });
    expect(editor.rowAction(id, 'duplicate', [0, 1])).toEqual({ ok: true, row: 2 });
    const rows = store.window(id, 2, 2)?.rows;
    // id (key) and photo (binary) are unset; the edited text is carried over.
    expect(rows?.[0]).toEqual([null, 'edited', 30, 'new', null, null]);
    expect(rows?.[1]).toEqual([null, null, null, 'paid', null, null]);
    expect(store.get(id)?.insertedRows).toBe(2);
  });

  it('does not copy a value that is only a pending DEFAULT', () => {
    const { store, id, editor } = setup();
    editor.editCell(id, 0, 1, { kind: 'default' });
    editor.rowAction(id, 'duplicate', [0]);
    expect(store.changeAt(id, 2, 1)).toBeUndefined();
  });

  it('duplicates a row only once even if named twice', () => {
    const { store, id, editor } = setup();
    editor.rowAction(id, 'duplicate', [1, 1]);
    expect(store.get(id)?.insertedRows).toBe(1);
  });

  it('deletes and restores server rows', () => {
    const { store, id, editor } = setup();
    expect(editor.rowAction(id, 'delete', [0, 1])).toEqual({ ok: true });
    expect(store.get(id)?.deletedRows).toBe(2);
    expect(editor.rowAction(id, 'restore', [0])).toEqual({ ok: true });
    expect(store.get(id)?.deletedRows).toBe(1);
  });

  it('deletes new rows together with server rows, whatever the order', () => {
    const { store, id, editor } = setup();
    editor.rowAction(id, 'add', []);
    editor.rowAction(id, 'add', []);
    editor.rowAction(id, 'add', []);
    // Rows 2, 3 and 4 are new; dropping 2 and 3 must not shift what 4 means.
    expect(editor.rowAction(id, 'delete', [2, 3, 1])).toEqual({ ok: true });
    expect(store.get(id)).toMatchObject({ insertedRows: 1, deletedRows: 1 });
  });

  it('does not edit a row that is marked for deletion', () => {
    const { id, editor } = setup();
    editor.rowAction(id, 'delete', [0]);
    expect(editor.editCell(id, 0, 1, { kind: 'text', text: 'x' })).toEqual({
      ok: false,
      error: 'row-deleted',
    });
    editor.rowAction(id, 'restore', [0]);
    expect(editor.editCell(id, 0, 1, { kind: 'text', text: 'x' })).toEqual({ ok: true });
  });

  it('reverts rows: edits, deletion marks and new rows', () => {
    const { store, id, editor } = setup();
    editor.editCell(id, 0, 1, { kind: 'text', text: 'x' });
    editor.rowAction(id, 'delete', [1]);
    editor.rowAction(id, 'add', []);
    expect(editor.rowAction(id, 'revert', [0, 1, 2])).toEqual({ ok: true });
    expect(store.get(id)).toMatchObject({ changedCells: 0, insertedRows: 0, deletedRows: 0 });
    expect(editor.rowAction(id, 'revert', [99])).toEqual({ ok: false, error: 'no-such-row' });
  });

  it('refuses rows that are not there and read-only results', () => {
    const { id, editor } = setup();
    expect(editor.rowAction(id, 'delete', [99])).toEqual({ ok: false, error: 'no-such-row' });
    expect(editor.rowAction(id, 'duplicate', [99])).toEqual({ ok: false, error: 'no-such-row' });
    expect(editor.rowAction(id, 'restore', [99])).toEqual({ ok: false, error: 'no-such-row' });
    const readOnly = setup({ edit: { editable: false, reason: 'no-key' } });
    for (const action of ['add', 'duplicate', 'delete', 'restore', 'revert'] as const) {
      expect(readOnly.editor.rowAction(readOnly.id, action, [0])).toEqual({
        ok: false,
        error: 'not-editable',
      });
    }
    expect(editor.rowAction('result-404', 'add', [])).toEqual({ ok: false, error: 'not-editable' });
  });
});

describe('ResultEditor', () => {
  it('queues a typed value, parsed by the column type', () => {
    const { store, id, editor } = setup();
    expect(editor.editCell(id, 0, 2, { kind: 'text', text: ' 31 ' })).toEqual({ ok: true });
    expect(store.changeAt(id, 0, 2)).toEqual({ kind: 'value', value: 31 });
    expect(store.window(id, 0, 1)?.rows[0]?.[2]).toBe(31);
  });

  it('keeps an empty string as text, distinct from NULL', () => {
    const { store, id, editor } = setup();
    editor.editCell(id, 0, 1, { kind: 'text', text: '' });
    expect(store.changeAt(id, 0, 1)).toEqual({ kind: 'value', value: '' });
  });

  it('withdraws the change when the value goes back to the original', () => {
    const { store, id, editor } = setup();
    editor.editCell(id, 0, 1, { kind: 'text', text: 'bob' });
    expect(store.get(id)?.changedCells).toBe(1);
    editor.editCell(id, 0, 1, { kind: 'text', text: 'alice' });
    expect(store.get(id)?.changedCells).toBe(0);
  });

  it('does not queue a change that changes nothing', () => {
    const { store, id, editor } = setup();
    expect(editor.editCell(id, 0, 2, { kind: 'text', text: '30' })).toEqual({ ok: true });
    expect(store.get(id)?.changedCells).toBe(0);
  });

  it('sets NULL on a nullable column and not on a NOT NULL one', () => {
    const { store, id, editor } = setup();
    expect(editor.editCell(id, 0, 1, { kind: 'null' })).toEqual({ ok: true });
    expect(store.changeAt(id, 0, 1)).toEqual({ kind: 'value', value: null });
    expect(editor.editCell(id, 0, 3, { kind: 'null' })).toEqual({ ok: false, error: 'not-null' });
    expect(editor.editCell(id, 0, 0, { kind: 'null' })).toEqual({ ok: false, error: 'not-null' });
  });

  it('treats NULL on a cell that is already NULL as no change', () => {
    const { store, id, editor } = setup();
    expect(editor.editCell(id, 1, 1, { kind: 'null' })).toEqual({ ok: true });
    expect(store.get(id)?.changedCells).toBe(0);
  });

  it('queues DEFAULT, also on a cell that is NULL now', () => {
    const { store, id, editor } = setup();
    expect(editor.editCell(id, 1, 1, { kind: 'default' })).toEqual({ ok: true });
    expect(store.changeAt(id, 1, 1)).toEqual({ kind: 'default' });
  });

  it('replaces an earlier change of the same cell', () => {
    const { store, id, editor } = setup();
    editor.editCell(id, 0, 1, { kind: 'default' });
    editor.editCell(id, 0, 1, { kind: 'text', text: 'bob' });
    expect(store.changeAt(id, 0, 1)).toEqual({ kind: 'value', value: 'bob' });
    expect(store.get(id)?.changedCells).toBe(1);
  });

  it('reports why input was refused and queues nothing', () => {
    const { store, id, editor } = setup();
    expect(editor.editCell(id, 0, 2, { kind: 'text', text: 'abc' })).toEqual({
      ok: false,
      error: 'invalid-integer',
    });
    expect(editor.editCell(id, 0, 3, { kind: 'text', text: 'gone' })).toEqual({
      ok: false,
      error: 'invalid-enum',
    });
    expect(store.get(id)?.changedCells).toBe(0);
  });

  it('refuses binary and computed columns', () => {
    const { id, editor } = setup();
    expect(editor.editCell(id, 0, 4, { kind: 'text', text: 'x' })).toEqual({
      ok: false,
      error: 'read-only-column',
    });
    expect(editor.editCell(id, 0, 5, { kind: 'text', text: '1' })).toEqual({
      ok: false,
      error: 'read-only-column',
    });
    expect(editor.editCell(id, 0, 99, { kind: 'null' })).toEqual({
      ok: false,
      error: 'read-only-column',
    });
  });

  it('refuses a read-only result, an unknown result and a row that is gone', () => {
    const readOnly = setup({ edit: { editable: false, reason: 'no-key' } });
    expect(readOnly.editor.editCell(readOnly.id, 0, 1, { kind: 'null' })).toEqual({
      ok: false,
      error: 'not-editable',
    });
    const noInfo = setup({ edit: undefined });
    expect(noInfo.editor.editCell(noInfo.id, 0, 1, { kind: 'null' })).toEqual({
      ok: false,
      error: 'not-editable',
    });
    const { id, editor } = setup();
    expect(editor.editCell('result-404', 0, 1, { kind: 'null' })).toEqual({
      ok: false,
      error: 'not-editable',
    });
    expect(editor.editCell(id, 50, 1, { kind: 'null' })).toEqual({
      ok: false,
      error: 'no-such-row',
    });
  });

  it('follows the row, not the position, after the result is sorted', () => {
    const { store, id, editor } = setup();
    store.sort(id, 0, 'desc');
    // The row with id 2 is now first; editing position 0 edits that row.
    editor.editCell(id, 0, 1, { kind: 'text', text: 'zed' });
    expect(store.rowAt(id, 0)?.[0]).toBe(2);
    expect(store.window(id, 0, 2)?.rows.map((row) => row[1])).toEqual(['zed', 'alice']);
  });
});
