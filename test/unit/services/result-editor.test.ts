import { describe, expect, it } from 'vitest';
import type { EditableResult } from '../../../src/core/model/editability';
import { ResultEditor, sameValue } from '../../../src/services/result-editor';
import { type NewResult, ResultStore } from '../../../src/services/result-store';
import { MAX_CELL_FILE_BYTES } from '../../../src/services/cell-file';
import { retainedBytes } from '../../../src/shared/binary-bytes';
import type { BinaryValue } from '../../../src/shared/cell-value';

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

  it('follows the row, not the position, after the result is sorted', async () => {
    const { store, id, editor } = setup();
    await store.sort(id, 0, 'desc');
    // The row with id 2 is now first; editing position 0 edits that row.
    editor.editCell(id, 0, 1, { kind: 'text', text: 'zed' });
    expect(store.rowAt(id, 0)?.[0]).toBe(2);
    expect(store.window(id, 0, 2)?.rows.map((row) => row[1])).toEqual(['zed', 'alice']);
  });
});

describe('ResultEditor.setFromFile (V10.2.4)', () => {
  const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);

  it('loads a file into a binary column, the bytes kept whole for saving', () => {
    const { store, id, editor } = setup();
    expect(editor.setFromFile(id, 0, 4, bytes(0x89, 0x50, 0x4e, 0x47))).toEqual({ ok: true });
    const change = store.changeAt(id, 0, 4);
    expect(change).toMatchObject({ kind: 'value', value: { kind: 'binary', size: 4 } });
    const value = change?.kind === 'value' ? change.value : null;
    expect(
      value !== null && typeof value === 'object' && retainedBytes(value as BinaryValue),
    ).toEqual(bytes(0x89, 0x50, 0x4e, 0x47));
  });

  it('loads UTF-8 text into a text column, without a byte order mark', () => {
    const { store, id, editor } = setup();
    expect(editor.setFromFile(id, 1, 1, text('﻿Здравствуй'))).toEqual({ ok: true });
    expect(store.changeAt(id, 1, 1)).toEqual({ kind: 'value', value: 'Здравствуй' });
  });

  it('loads into a new row too', () => {
    const { store, id, editor } = setup();
    const added = editor.rowAction(id, 'add', []);
    const row = added.ok ? (added.row ?? -1) : -1;
    expect(editor.setFromFile(id, row, 1, text('new'))).toEqual({ ok: true });
    expect(store.window(id, row, 1)?.rows[0]?.[1]).toBe('new');
  });

  it('refuses a text file that is not UTF-8', () => {
    const { id, editor } = setup();
    expect(editor.setFromFile(id, 0, 1, bytes(0xff, 0xfe, 0x41))).toEqual({
      ok: false,
      error: 'not-text',
    });
  });

  it('refuses columns that are typed rather than loaded, and computed ones', () => {
    const { id, editor } = setup();
    expect(editor.setFromFile(id, 0, 2, text('42'))).toEqual({
      ok: false,
      error: 'read-only-column',
    });
    expect(editor.setFromFile(id, 0, 5, text('1'))).toEqual({
      ok: false,
      error: 'read-only-column',
    });
  });

  it('refuses a read-only result, a missing row and a row marked for deletion', () => {
    const readOnly = setup({ edit: { editable: false, reason: 'no-key' } });
    expect(readOnly.editor.setFromFile(readOnly.id, 0, 4, bytes(1))).toEqual({
      ok: false,
      error: 'not-editable',
    });
    const { id, editor } = setup();
    expect(editor.setFromFile(id, 9, 4, bytes(1))).toEqual({ ok: false, error: 'no-such-row' });
    editor.rowAction(id, 'delete', [0]);
    expect(editor.setFromFile(id, 0, 4, bytes(1))).toEqual({ ok: false, error: 'row-deleted' });
  });

  it('refuses a file larger than a value can be', () => {
    const { id, editor } = setup();
    expect(editor.setFromFile(id, 0, 4, new Uint8Array(MAX_CELL_FILE_BYTES + 1))).toEqual({
      ok: false,
      error: 'too-large',
    });
  });
});

describe('ResultEditor.fillCells (V12.6)', () => {
  const rows = (): NewResult['rows'] =>
    [1, 2, 3, 4].map((id) => [id, `n${id}`, id * 10, 'new', null, id]);

  /** What the grid would show in a column after the fill, top to bottom. */
  function shown(store: ResultStore, id: string, column: number): unknown[] {
    return (store.window(id, 0, 10)?.rows ?? []).map((row) => row[column]);
  }

  it('puts one value into every selected cell', () => {
    const { store, id, editor } = setup({ rows: rows() });
    const done = editor.fillCells(
      id,
      { top: 0, bottom: 2, columns: [1] },
      { kind: 'value', input: { kind: 'text', text: 'x' } },
    );
    expect(done).toEqual({ ok: true, changed: 3, skipped: 0 });
    expect(shown(store, id, 1)).toEqual(['x', 'x', 'x', 'n4']);
    expect(store.get(id)?.changedCells).toBe(3);
  });

  it('sets NULL and the default across a block', () => {
    const { store, id, editor } = setup({ rows: rows() });
    expect(
      editor.fillCells(
        id,
        { top: 1, bottom: 2, columns: [1, 2] },
        { kind: 'value', input: { kind: 'null' } },
      ),
    ).toEqual({ ok: true, changed: 4, skipped: 0 });
    expect(shown(store, id, 2)).toEqual([10, null, null, 40]);
    expect(
      editor.fillCells(
        id,
        { top: 0, bottom: 0, columns: [1] },
        { kind: 'value', input: { kind: 'default' } },
      ),
    ).toEqual({ ok: true, changed: 1, skipped: 0 });
    expect(store.changeAt(id, 0, 1)).toEqual({ kind: 'default' });
  });

  it('skips the cells a column refuses and says why', () => {
    const { store, id, editor } = setup({ rows: rows() });
    // id is NOT NULL, name takes NULL; photo is binary and total is computed.
    const done = editor.fillCells(
      id,
      { top: 0, bottom: 1, columns: [0, 1, 4, 5] },
      { kind: 'value', input: { kind: 'null' } },
    );
    expect(done).toEqual({ ok: true, changed: 2, skipped: 6, error: 'not-null' });
    expect(shown(store, id, 1)).toEqual([null, null, 'n3', 'n4']);
    expect(shown(store, id, 0)).toEqual([1, 2, 3, 4]);
  });

  it('fails when no cell took the input, with the first reason', () => {
    const { store, id, editor } = setup({ rows: rows() });
    expect(
      editor.fillCells(
        id,
        { top: 0, bottom: 1, columns: [2] },
        { kind: 'value', input: { kind: 'text', text: 'abc' } },
      ),
    ).toEqual({ ok: false, error: 'invalid-integer' });
    expect(
      editor.fillCells(
        id,
        { top: 0, bottom: 1, columns: [5] },
        { kind: 'value', input: { kind: 'text', text: '1' } },
      ),
    ).toEqual({ ok: false, error: 'read-only-column' });
    expect(store.get(id)?.changedCells).toBe(0);
  });

  it('counts a cell that already holds the value as done, not skipped', () => {
    const { id, editor } = setup({ rows: rows() });
    expect(
      editor.fillCells(
        id,
        { top: 0, bottom: 0, columns: [1] },
        { kind: 'value', input: { kind: 'text', text: 'n1' } },
      ),
    ).toEqual({ ok: true, changed: 1, skipped: 0 });
  });

  it('copies the top cell down, column by column', () => {
    const { store, id, editor } = setup({ rows: rows() });
    const done = editor.fillCells(id, { top: 1, bottom: 3, columns: [1, 2] }, { kind: 'down' });
    expect(done).toEqual({ ok: true, changed: 4, skipped: 0 });
    expect(shown(store, id, 1)).toEqual(['n1', 'n2', 'n2', 'n2']);
    expect(shown(store, id, 2)).toEqual([10, 20, 20, 20]);
  });

  it('copies a NULL and a value that was just edited', () => {
    const { store, id, editor } = setup({ rows: rows() });
    editor.editCell(id, 0, 1, { kind: 'null' });
    editor.editCell(id, 0, 2, { kind: 'text', text: '99' });
    editor.fillCells(id, { top: 0, bottom: 2, columns: [1, 2] }, { kind: 'down' });
    expect(shown(store, id, 1)).toEqual([null, null, null, 'n4']);
    expect(shown(store, id, 2)).toEqual([99, 99, 99, 40]);
  });

  it('copying down one row changes nothing', () => {
    const { store, id, editor } = setup({ rows: rows() });
    expect(editor.fillCells(id, { top: 2, bottom: 2, columns: [1] }, { kind: 'down' })).toEqual({
      ok: true,
      changed: 0,
      skipped: 0,
    });
    expect(store.get(id)?.changedCells).toBe(0);
  });

  it('fills a number series, the same in every column', () => {
    const { store, id, editor } = setup({ rows: rows() });
    const done = editor.fillCells(
      id,
      { top: 0, bottom: 3, columns: [0, 2] },
      { kind: 'series', start: '100', step: '5' },
    );
    expect(done).toEqual({ ok: true, changed: 8, skipped: 0 });
    expect(shown(store, id, 0)).toEqual([100, 105, 110, 115]);
    expect(shown(store, id, 2)).toEqual([100, 105, 110, 115]);
  });

  it('fills a text series from a template', () => {
    const { store, id, editor } = setup({ rows: rows() });
    editor.fillCells(
      id,
      { top: 1, bottom: 3, columns: [1] },
      { kind: 'series', start: '1', step: '1', template: 'user{n}', pad: 2 },
    );
    expect(shown(store, id, 1)).toEqual(['n1', 'user01', 'user02', 'user03']);
  });

  it('fills a series of dates', () => {
    const { store, id, editor } = setup({
      columns: [{ name: 'id' }, { name: 'name' }, { name: 'born' }],
      rows: [
        [1, 'a', null],
        [2, 'b', null],
        [3, 'c', null],
      ],
      edit: {
        ...EDIT,
        columnMap: ['id', 'name', 'born'],
        columns: [
          EDIT.columns[0] ?? null,
          EDIT.columns[1] ?? null,
          { name: 'born', dataType: 'date', nullable: true, kind: 'date' },
        ],
      },
    });
    const done = editor.fillCells(
      id,
      { top: 0, bottom: 2, columns: [2] },
      { kind: 'dates', start: '2024-01-31', step: 1, unit: 'month' },
    );
    expect(done).toEqual({ ok: true, changed: 3, skipped: 0 });
    expect(shown(store, id, 2)).toEqual([
      { kind: 'datetime', text: '2024-01-31' },
      { kind: 'datetime', text: '2024-02-29' },
      { kind: 'datetime', text: '2024-03-31' },
    ]);
  });

  it('lets the column judge each text of a series', () => {
    const { id, editor } = setup({ rows: rows() });
    expect(
      editor.fillCells(
        id,
        { top: 0, bottom: 1, columns: [3] },
        { kind: 'series', start: '1', step: '1' },
      ),
    ).toEqual({ ok: false, error: 'invalid-enum' });
  });

  it('reports a series that cannot be made', () => {
    const { store, id, editor } = setup({ rows: rows() });
    const box = { top: 0, bottom: 1, columns: [2] };
    expect(editor.fillCells(id, box, { kind: 'series', start: 'x', step: '1' })).toEqual({
      ok: false,
      error: 'invalid-start',
    });
    expect(
      editor.fillCells(id, box, { kind: 'series', start: '1', step: '1', template: 'n' }),
    ).toEqual({
      ok: false,
      error: 'invalid-template',
    });
    expect(editor.fillCells(id, box, { kind: 'dates', start: 'x', step: 1, unit: 'day' })).toEqual({
      ok: false,
      error: 'invalid-start-date',
    });
    expect(store.get(id)?.changedCells).toBe(0);
  });

  it('skips deleted rows and rows that are not there', () => {
    const { store, id, editor } = setup({ rows: rows() });
    editor.rowAction(id, 'delete', [1]);
    const done = editor.fillCells(
      id,
      { top: 0, bottom: 5, columns: [1] },
      { kind: 'value', input: { kind: 'text', text: 'x' } },
    );
    expect(done).toEqual({ ok: true, changed: 3, skipped: 3, error: 'row-deleted' });
    expect(shown(store, id, 1)).toEqual(['x', 'n2', 'x', 'x']);
  });

  it('fills new rows too', () => {
    const { store, id, editor } = setup({ rows: rows() });
    editor.rowAction(id, 'add', []);
    editor.fillCells(
      id,
      { top: 3, bottom: 4, columns: [1] },
      { kind: 'series', start: '1', step: '1', template: 'x{n}' },
    );
    expect(shown(store, id, 1)).toEqual(['n1', 'n2', 'n3', 'x1', 'x2']);
  });

  it('refuses a read-only result, an empty or reversed block and too many cells', () => {
    const readOnly = setup({ rows: rows(), edit: { editable: false, reason: 'no-key' } });
    const value = { kind: 'value', input: { kind: 'null' } } as const;
    expect(
      readOnly.editor.fillCells(readOnly.id, { top: 0, bottom: 0, columns: [1] }, value),
    ).toEqual({
      ok: false,
      error: 'not-editable',
    });
    const { id, editor } = setup({ rows: rows() });
    expect(editor.fillCells(id, { top: 2, bottom: 1, columns: [1] }, value)).toEqual({
      ok: false,
      error: 'no-such-row',
    });
    expect(editor.fillCells(id, { top: 0, bottom: 1, columns: [] }, value)).toEqual({
      ok: false,
      error: 'no-such-row',
    });
    expect(editor.fillCells(id, { top: 0, bottom: 200_000, columns: [1] }, value)).toEqual({
      ok: false,
      error: 'too-many-cells',
    });
    expect(editor.fillCells('result-404', { top: 0, bottom: 0, columns: [1] }, value)).toEqual({
      ok: false,
      error: 'not-editable',
    });
  });

  it('cannot copy down from a row that is not there', () => {
    const { id, editor } = setup({ rows: rows() });
    expect(editor.fillCells(id, { top: 50, bottom: 52, columns: [1] }, { kind: 'down' })).toEqual({
      ok: false,
      error: 'no-such-row',
    });
  });
});
