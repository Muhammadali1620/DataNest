import { describe, expect, it } from 'vitest';
import type { ResultSummary } from '../../../../src/services/result-store';
import { resultGridProtocol } from '../../../../src/shared/protocols/result-grid';
import { buildState, errorOffsetOf } from '../../../../src/vscode/panels/results-state';

function summary(overrides: Partial<ResultSummary> = {}): ResultSummary {
  return {
    id: 'result-1',
    documentUri: 'untitled:Query-1.sql',
    statement: 'SELECT 1',
    statementStart: 0,
    columns: [{ name: 'one', dataType: 'int' }],
    rowCount: 1,
    truncated: false,
    durationMs: 4,
    changedCells: 0,
    insertedRows: 0,
    deletedRows: 0,
    revision: 0,
    ...overrides,
  };
}

describe('buildState', () => {
  it('turns a result into a tab the page can render', () => {
    const state = buildState([summary()], undefined, false);
    expect(state).toEqual({
      tabs: [
        {
          id: 'result-1',
          title: 'SELECT 1',
          statement: 'SELECT 1',
          columns: [{ name: 'one', dataType: 'int' }],
          rowCount: 1,
          truncated: false,
          durationMs: 4,
          changedCells: 0,
          insertedRows: 0,
          deletedRows: 0,
          revision: 0,
        },
      ],
      activeId: 'result-1',
      running: false,
    });
  });

  it('tells the page whether a result is editable and why not, without internals', () => {
    const state = buildState(
      [
        summary({
          edit: {
            editable: true,
            table: { name: 't' },
            columnMap: ['one'],
            columns: [null],
            keyColumns: ['one'],
            keyIndexes: [0],
          },
        }),
        summary({ id: 'result-2', edit: { editable: false, reason: 'no-key' } }),
        summary({ id: 'result-3' }),
      ],
      undefined,
      false,
    );
    expect(state.tabs.map((tab) => tab.edit)).toEqual([
      { editable: true, columns: [null] },
      { editable: false, reason: 'no-key' },
      undefined,
    ]);
    expect(() => resultGridProtocol.webview.events.state.parse(state)).not.toThrow();
  });

  it('is valid for the protocol, including the awkward cases', () => {
    const state = buildState(
      [
        summary(),
        summary({ id: 'result-2', affectedRows: 3, rowCount: 0, columns: [] }),
        summary({
          id: 'result-3',
          error: { code: 'syntax', message: 'near "SELEC"', position: 7 },
        }),
        summary({ id: 'result-4', statement: 'SELECT\n  very,\n  long,\n  statement' }),
      ],
      'result-2',
      true,
    );
    expect(() => resultGridProtocol.webview.events.state.parse(state)).not.toThrow();
  });

  it('has no tabs and no active id for a document without results', () => {
    expect(buildState([], undefined, false)).toEqual({ tabs: [], running: false });
  });

  it('activates the newest tab when nothing was chosen', () => {
    const state = buildState([summary(), summary({ id: 'result-2' })], undefined, false);
    expect(state.activeId).toBe('result-2');
  });

  it('keeps the tab the user chose', () => {
    const state = buildState([summary(), summary({ id: 'result-2' })], 'result-1', false);
    expect(state.activeId).toBe('result-1');
  });

  it('falls back to the newest tab when the chosen one is gone', () => {
    const state = buildState([summary({ id: 'result-9' })], 'result-1', false);
    expect(state.activeId).toBe('result-9');
  });

  it('shortens the tab title but keeps the statement in full', () => {
    const long = 'SELECT a, b, c, d, e, f, g, h, i, j, k, l, m FROM a_long_table_name WHERE x = 1';
    const [tab] = buildState([summary({ statement: long })], undefined, false).tabs;
    expect(tab?.title.length).toBeLessThan(long.length);
    expect(tab?.statement).toBe(long);
  });

  it('passes the running flag through', () => {
    expect(buildState([], undefined, true).running).toBe(true);
  });

  it('keeps affected rows, truncation and errors', () => {
    const state = buildState(
      [
        summary({ affectedRows: 7 }),
        summary({ id: 'result-2', truncated: true }),
        summary({ id: 'result-3', error: { code: 'timeout', message: 'too slow' } }),
      ],
      'result-1',
      false,
    );
    expect(state.tabs[0]?.affectedRows).toBe(7);
    expect(state.tabs[1]?.truncated).toBe(true);
    expect(state.tabs[2]?.error).toEqual({ code: 'timeout', message: 'too slow' });
  });

  it('omits a column type the driver did not report', () => {
    const state = buildState([summary({ columns: [{ name: 'calc' }] })], undefined, false);
    expect(state.tabs[0]?.columns[0]).toEqual({ name: 'calc' });
  });

  it('never carries the document uri into the page', () => {
    const state = buildState([summary()], undefined, false);
    expect(JSON.stringify(state)).not.toContain('untitled:');
  });
});

describe('errorOffsetOf', () => {
  it('adds the position inside the statement to where the statement starts', () => {
    expect(
      errorOffsetOf(
        {
          statementStart: 100,
          statement: 'SELECT 1',
          error: { code: 'syntax', message: 'x', position: 7 },
        },
        1000,
      ),
    ).toBe(107);
  });

  it('points at the start of the statement when the server gave no position', () => {
    expect(
      errorOffsetOf(
        { statementStart: 42, statement: 'SELECT 1', error: { code: 'syntax', message: 'x' } },
        1000,
      ),
    ).toBe(42);
  });

  it('has nothing to point at when the statement succeeded', () => {
    expect(errorOffsetOf({ statementStart: 10, statement: 'SELECT 1' }, 1000)).toBeUndefined();
  });

  it('stays inside a document that was edited since the run', () => {
    expect(
      errorOffsetOf(
        {
          statementStart: 900,
          statement: 'SELECT 1',
          error: { code: 'syntax', message: 'x', position: 7 },
        },
        50,
      ),
    ).toBe(50);
  });

  it('never goes negative', () => {
    expect(
      errorOffsetOf(
        {
          statementStart: 0,
          statement: 'SELECT 1',
          error: { code: 'syntax', message: 'x', position: 0 },
        },
        0,
      ),
    ).toBe(0);
  });
});
