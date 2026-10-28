import { describe, expect, it } from 'vitest';
import {
  MAX_ACTION_ROWS,
  MAX_CLIPBOARD_CHARS,
  MAX_SEARCH_HITS,
  MAX_SEARCH_LENGTH,
  MAX_WINDOW_ROWS,
  resultGridProtocol,
  tabTitle,
  WINDOW_OVERSCAN,
} from '../../../../src/shared/protocols/result-grid';

const rows = resultGridProtocol.host.requests.rows;
const state = resultGridProtocol.webview.events.state;

describe('rows request', () => {
  it('accepts a window the page may ask for', () => {
    const params = { resultId: 'result-1', offset: 100, limit: 200 };
    expect(rows.params.parse(params)).toEqual(params);
  });

  it('rejects a window that is too large or empty', () => {
    expect(() =>
      rows.params.parse({ resultId: 'result-1', offset: 0, limit: MAX_WINDOW_ROWS + 1 }),
    ).toThrow('limit');
    expect(() => rows.params.parse({ resultId: 'result-1', offset: 0, limit: 0 })).toThrow('limit');
  });

  it('rejects a negative or fractional offset', () => {
    expect(() => rows.params.parse({ resultId: 'r', offset: -1, limit: 10 })).toThrow('offset');
    expect(() => rows.params.parse({ resultId: 'r', offset: 1.5, limit: 10 })).toThrow('offset');
  });

  it('rejects an empty result id', () => {
    expect(() => rows.params.parse({ resultId: '', offset: 0, limit: 10 })).toThrow('resultId');
  });

  it('accepts a window of rows with every value kind', () => {
    const result = {
      resultId: 'result-1',
      offset: 0,
      rows: [[1, 'text', null, true, { kind: 'binary', size: 2, preview: 'ab' }]],
      rowCount: 1,
      changes: [{ row: 0, column: 2, kind: 'default' }],
      states: [{ row: 0, state: 'inserted' }],
    };
    expect(rows.result.parse(result)).toEqual(result);
  });

  it('accepts an empty window, which means the result is gone', () => {
    expect(
      rows.result.parse({
        resultId: 'r',
        offset: 0,
        rows: [],
        rowCount: 0,
        changes: [],
        states: [],
      }),
    ).toEqual({
      resultId: 'r',
      offset: 0,
      rows: [],
      rowCount: 0,
      changes: [],
      states: [],
    });
  });

  it('rejects a window with a bad cell', () => {
    expect(() =>
      rows.result.parse({
        resultId: 'r',
        offset: 0,
        rows: [[undefined]],
        rowCount: 1,
        changes: [],
      }),
    ).toThrow();
  });
});

describe('state event', () => {
  const tab = {
    id: 'result-1',
    title: 'SELECT 1',
    statement: 'SELECT 1',
    columns: [{ name: 'one', dataType: 'int' }],
    rowCount: 1,
    truncated: false,
    durationMs: 3,
    changedCells: 0,
    insertedRows: 0,
    deletedRows: 0,
    revision: 0,
  };

  it('describes the tabs and which one is active', () => {
    const payload = { tabs: [tab], activeId: 'result-1', running: false };
    expect(state.parse(payload)).toEqual(payload);
  });

  it('accepts no tabs at all', () => {
    expect(state.parse({ tabs: [], running: true })).toEqual({ tabs: [], running: true });
  });

  it('accepts a tab that failed and one that affected rows', () => {
    const payload = {
      tabs: [
        { ...tab, error: { code: 'syntax', message: 'near "SELEC"', position: 7 } },
        { ...tab, id: 'result-2', affectedRows: 5, rowCount: 0 },
      ],
      running: false,
    };
    expect(state.parse(payload)).toEqual(payload);
  });

  it('rejects a tab without the fields the page needs', () => {
    const { rowCount: _rowCount, ...incomplete } = tab;
    expect(() => state.parse({ tabs: [incomplete], running: false })).toThrow('rowCount');
  });

  it('rejects extra fields, so nothing leaks into the page by accident', () => {
    expect(() => state.parse({ tabs: [{ ...tab, password: 'secret' }], running: false })).toThrow(
      'unexpected field',
    );
  });

  it('carries no rows: those are fetched window by window', () => {
    expect(() => state.parse({ tabs: [{ ...tab, rows: [[1]] }], running: false })).toThrow(
      'unexpected field',
    );
  });
});

describe('protocol shape', () => {
  it('lets the host answer rows, paging, sorting and searching', () => {
    expect(Object.keys(resultGridProtocol.host.requests).sort()).toEqual([
      'editCell',
      'pageTo',
      'rowAction',
      'rows',
      'search',
      'sort',
    ]);
    expect(Object.keys(resultGridProtocol.host.events).sort()).toEqual([
      'cancel',
      'copyText',
      'exportResult',
      'ready',
      'revealError',
      'selectTab',
    ]);
  });

  it('gives the page no requests, only the state event', () => {
    expect(Object.keys(resultGridProtocol.webview.requests)).toEqual([]);
    expect(Object.keys(resultGridProtocol.webview.events)).toEqual(['state']);
  });

  it('keeps the overscan smaller than one window', () => {
    expect(WINDOW_OVERSCAN).toBeGreaterThan(0);
    expect(WINDOW_OVERSCAN * 2).toBeLessThan(MAX_WINDOW_ROWS);
  });
});

describe('editCell request', () => {
  const { editCell } = resultGridProtocol.host.requests;
  const base = { resultId: 'result-1', row: 0, column: 1 };

  it('accepts typed text, NULL and DEFAULT', () => {
    for (const input of [
      { kind: 'text', text: 'x' },
      { kind: 'text', text: '' },
      { kind: 'null' },
      { kind: 'default' },
    ]) {
      expect(editCell.params.parse({ ...base, input })).toEqual({ ...base, input });
    }
  });

  it('rejects an unknown input kind, a missing text and negative positions', () => {
    expect(() => editCell.params.parse({ ...base, input: { kind: 'drop-table' } })).toThrow();
    expect(() => editCell.params.parse({ ...base, input: { kind: 'text' } })).toThrow();
    expect(() => editCell.params.parse({ ...base, row: -1, input: { kind: 'null' } })).toThrow();
  });

  it('answers ok, or the reason it was refused', () => {
    expect(editCell.result.parse({ ok: true })).toEqual({ ok: true });
    expect(editCell.result.parse({ ok: false, error: 'not-null' })).toEqual({
      ok: false,
      error: 'not-null',
    });
    expect(() => editCell.result.parse({ ok: false, error: 'whatever' })).toThrow();
  });
});

describe('rowAction request', () => {
  const { rowAction } = resultGridProtocol.host.requests;

  it('accepts each action with the rows it names', () => {
    for (const action of ['add', 'duplicate', 'delete', 'restore'] as const) {
      const params = { resultId: 'result-1', action, rows: [0, 5] };
      expect(rowAction.params.parse(params)).toEqual(params);
    }
    expect(rowAction.params.parse({ resultId: 'r', action: 'add', rows: [] }).rows).toEqual([]);
  });

  it('rejects an unknown action, a negative or fractional row and too many rows', () => {
    expect(() => rowAction.params.parse({ resultId: 'r', action: 'drop', rows: [] })).toThrow();
    expect(() => rowAction.params.parse({ resultId: 'r', action: 'delete', rows: [-1] })).toThrow();
    expect(() =>
      rowAction.params.parse({ resultId: 'r', action: 'delete', rows: [1.5] }),
    ).toThrow();
    expect(() =>
      rowAction.params.parse({
        resultId: 'r',
        action: 'delete',
        rows: Array.from({ length: MAX_ACTION_ROWS + 1 }, () => 0),
      }),
    ).toThrow();
  });

  it('answers ok with the first new row, or why it was refused', () => {
    expect(rowAction.result.parse({ ok: true, row: 4 })).toEqual({ ok: true, row: 4 });
    expect(rowAction.result.parse({ ok: false, error: 'row-deleted' })).toEqual({
      ok: false,
      error: 'row-deleted',
    });
  });
});

describe('editable tab state', () => {
  const tab = {
    id: 'result-1',
    title: 't',
    statement: 'SELECT * FROM t',
    columns: [{ name: 'id' }, { name: 'total' }],
    rowCount: 1,
    truncated: false,
    durationMs: 1,
    changedCells: 2,
    insertedRows: 1,
    deletedRows: 0,
    revision: 5,
  };

  it('carries how each column is edited, with null for a computed one', () => {
    const payload = {
      tabs: [
        {
          ...tab,
          edit: {
            editable: true,
            columns: [
              { dataType: 'enum', kind: 'enum', nullable: false, options: ['a', 'b'] },
              null,
            ],
          },
        },
      ],
      running: false,
    };
    expect(state.parse(payload)).toEqual(payload);
  });

  it('rejects an editor kind the page does not know', () => {
    expect(() =>
      state.parse({
        tabs: [
          {
            ...tab,
            edit: { editable: true, columns: [{ dataType: 'x', kind: 'wat', nullable: true }] },
          },
        ],
        running: false,
      }),
    ).toThrow();
  });
});

describe('tabTitle', () => {
  it('flattens whitespace', () => {
    expect(tabTitle('SELECT\n  1,\n  2')).toBe('SELECT 1, 2');
  });

  it('shortens a long statement with an ellipsis', () => {
    const title = tabTitle('SELECT a, b, c, d, e, f, g, h, i, j, k FROM a_very_long_table_name');
    expect(title).toHaveLength(40);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps a short statement as it is', () => {
    expect(tabTitle('SELECT 1')).toBe('SELECT 1');
  });

  it('respects a custom length', () => {
    expect(tabTitle('SELECT 1 FROM customers', 10)).toBe('SELECT 1 …');
  });

  it('handles an empty statement', () => {
    expect(tabTitle('   ')).toBe('');
  });
});

describe('copyText event', () => {
  const copyText = resultGridProtocol.host.events.copyText;

  it('accepts the text a selection produces', () => {
    expect(copyText.parse({ text: 'a\tb\r\nc\td' })).toEqual({ text: 'a\tb\r\nc\td' });
    expect(copyText.parse({ text: '' })).toEqual({ text: '' });
  });

  it('rejects a payload that is not text', () => {
    expect(() => copyText.parse({ text: 42 })).toThrow('text');
    expect(() => copyText.parse({})).toThrow('text');
  });

  it('caps how much may be copied in one go', () => {
    expect(() => copyText.parse({ text: 'x'.repeat(MAX_CLIPBOARD_CHARS + 1) })).toThrow('at most');
  });
});

describe('sort request', () => {
  const sort = resultGridProtocol.host.requests.sort;

  it('accepts a direction and its absence, which means the server order', () => {
    expect(sort.params.parse({ resultId: 'r', column: 2, direction: 'asc' })).toEqual({
      resultId: 'r',
      column: 2,
      direction: 'asc',
    });
    expect(sort.params.parse({ resultId: 'r', column: 0 })).toEqual({ resultId: 'r', column: 0 });
  });

  it('rejects an unknown direction and a bad column', () => {
    expect(() => sort.params.parse({ resultId: 'r', column: 0, direction: 'sideways' })).toThrow(
      'direction',
    );
    expect(() => sort.params.parse({ resultId: 'r', column: -1 })).toThrow('column');
  });

  it('answers whether the result was still there', () => {
    expect(sort.result.parse({ resultId: 'r', applied: true })).toEqual({
      resultId: 'r',
      applied: true,
    });
  });
});

describe('search request', () => {
  const search = resultGridProtocol.host.requests.search;

  it('accepts a needle and answers with row indexes and a total', () => {
    expect(search.params.parse({ resultId: 'r', text: 'abc' })).toEqual({
      resultId: 'r',
      text: 'abc',
    });
    expect(search.result.parse({ resultId: 'r', rows: [1, 5], total: 2 })).toEqual({
      resultId: 'r',
      rows: [1, 5],
      total: 2,
    });
  });

  it('caps the needle and the number of hits', () => {
    expect(() =>
      search.params.parse({ resultId: 'r', text: 'x'.repeat(MAX_SEARCH_LENGTH + 1) }),
    ).toThrow('at most');
    expect(() =>
      search.result.parse({
        resultId: 'r',
        rows: Array.from({ length: MAX_SEARCH_HITS + 1 }, (_, index) => index),
        total: 1,
      }),
    ).toThrow('at most');
  });
});

describe('sorted tab state', () => {
  it('carries the current order of a tab', () => {
    const payload = {
      tabs: [
        {
          id: 'result-1',
          title: 'SELECT 1',
          statement: 'SELECT 1',
          columns: [{ name: 'one' }],
          rowCount: 1,
          truncated: false,
          durationMs: 1,
          changedCells: 0,
          insertedRows: 0,
          deletedRows: 0,
          revision: 0,
          sort: { column: 0, direction: 'desc' },
        },
      ],
      running: false,
    };
    expect(state.parse(payload)).toEqual(payload);
  });

  it('rejects an unknown direction in the state', () => {
    expect(() =>
      state.parse({
        tabs: [
          {
            id: 'r',
            title: 't',
            statement: 't',
            columns: [],
            rowCount: 0,
            truncated: false,
            durationMs: 0,
            changedCells: 0,
            insertedRows: 0,
            deletedRows: 0,
            revision: 0,
            sort: { column: 0, direction: 'random' },
          },
        ],
        running: false,
      }),
    ).toThrow('direction');
  });
});
describe('pageTo request', () => {
  const pageTo = resultGridProtocol.host.requests.pageTo;

  it('accepts an offset and answers whether the page was shown', () => {
    expect(pageTo.params.parse({ resultId: 'r', offset: 200 })).toEqual({
      resultId: 'r',
      offset: 200,
    });
    expect(pageTo.result.parse({ resultId: 'r', applied: false })).toEqual({
      resultId: 'r',
      applied: false,
    });
  });

  it('rejects a negative or fractional offset', () => {
    expect(() => pageTo.params.parse({ resultId: 'r', offset: -1 })).toThrow('offset');
    expect(() => pageTo.params.parse({ resultId: 'r', offset: 1.5 })).toThrow('offset');
  });
});

describe('paged tab state', () => {
  const base = {
    id: 'result-1',
    title: 'SELECT *',
    statement: 'SELECT * FROM t',
    columns: [{ name: 'one' }],
    rowCount: 2,
    truncated: false,
    durationMs: 1,
    changedCells: 0,
    insertedRows: 0,
    deletedRows: 0,
    revision: 0,
  };

  it('carries the page and the row count of a table view', () => {
    const payload = {
      tabs: [{ ...base, page: { offset: 100, pageSize: 50, totalRows: 4242 } }],
      running: false,
    };
    expect(state.parse(payload)).toEqual(payload);
  });

  it('accepts a page whose total is unknown', () => {
    const payload = { tabs: [{ ...base, page: { offset: 0, pageSize: 50 } }], running: false };
    expect(state.parse(payload)).toEqual(payload);
  });

  it('rejects a page with a nonsense size', () => {
    expect(() =>
      state.parse({ tabs: [{ ...base, page: { offset: 0, pageSize: 0 } }], running: false }),
    ).toThrow('pageSize');
  });
});
describe('exportResult event', () => {
  const exportResult = resultGridProtocol.host.events.exportResult;

  it('accepts the formats the extension writes', () => {
    expect(exportResult.parse({ resultId: 'r', format: 'csv' })).toEqual({
      resultId: 'r',
      format: 'csv',
    });
    expect(exportResult.parse({ resultId: 'r', format: 'json' })).toEqual({
      resultId: 'r',
      format: 'json',
    });
  });

  it('rejects a format the host cannot write', () => {
    expect(() => exportResult.parse({ resultId: 'r', format: 'xlsx' })).toThrow('format');
    expect(() => exportResult.parse({ resultId: 'r' })).toThrow('format');
  });
});
