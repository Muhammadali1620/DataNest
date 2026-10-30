import { describe, expect, it } from 'vitest';
import { dataCompareProtocol, ROWS_PAGE } from '../../../../src/shared/protocols/data-compare';

describe('dataCompareProtocol', () => {
  it('accepts the state and rows the host sends', () => {
    const state = {
      source: 'a',
      target: 'b',
      key: [{ source: 'id', target: 'ID' }],
      columns: [],
      sourceOnly: [],
      targetOnly: ['extra'],
      progress: { phase: 'source', rows: 5000 },
      result: {
        same: 1,
        different: 2,
        onlySource: 0,
        onlyTarget: 0,
        kept: { different: 2, onlySource: 0, onlyTarget: 0 },
        durationMs: 3,
      },
    };
    expect(dataCompareProtocol.webview.events.state.parse(state)).toEqual(state);
    const rows = { rows: [{ cells: ['1', null], target: ['1', 'x'], differs: [false, true] }] };
    expect(dataCompareProtocol.host.requests.rows.result.parse(rows)).toEqual(rows);
  });

  it('limits what the page may ask for', () => {
    const params = dataCompareProtocol.host.requests.rows.params;
    expect(params.parse({ kind: 'onlyTarget', offset: 0, limit: ROWS_PAGE })).toBeDefined();
    expect(() => params.parse({ kind: 'same', offset: 0, limit: 10 })).toThrow();
    expect(() => params.parse({ kind: 'different', offset: 0, limit: ROWS_PAGE + 1 })).toThrow();
    expect(() => params.parse({ kind: 'different', offset: -1, limit: 10 })).toThrow();
  });
});
