import { describe, expect, it } from 'vitest';
import { resultChartProtocol } from '../../../../src/shared/protocols/result-chart';

describe('resultChartProtocol', () => {
  it('accepts the state the host sends', () => {
    const state = {
      title: 'SELECT',
      columns: [{ name: 'k', kind: 'text' }],
      rows: 3,
      truncated: false,
      config: { type: 'bar', x: 0, ys: [1], aggregate: 'sum' },
      data: {
        labels: ['a'],
        series: [{ name: 'v', values: [1, null] }],
        labelKind: 'text',
        points: 1,
        skipped: 0,
        folded: 2,
      },
    };
    expect(resultChartProtocol.webview.events.state.parse(state)).toEqual(state);
  });

  it('limits what the page may ask for', () => {
    const { configure, save } = resultChartProtocol.host.requests;
    expect(
      configure.params.parse({ config: { type: 'pie', x: 0, ys: [], aggregate: 'count' } }),
    ).toBeDefined();
    expect(() =>
      configure.params.parse({ config: { type: 'radar', x: 0, ys: [], aggregate: 'none' } }),
    ).toThrow();
    expect(() =>
      configure.params.parse({ config: { type: 'bar', x: -1, ys: [], aggregate: 'none' } }),
    ).toThrow();
    expect(() =>
      configure.params.parse({
        config: { type: 'bar', x: 0, ys: [1, 2, 3, 4, 5, 6, 7, 8, 9], aggregate: 'none' },
      }),
    ).toThrow();
    expect(() =>
      configure.params.parse({ config: { type: 'bar', x: 0, ys: [], aggregate: 'median' } }),
    ).toThrow();
    expect(save.params.parse({ format: 'png', data: 'iVBOR' })).toBeDefined();
    expect(() => save.params.parse({ format: 'gif', data: '' })).toThrow();
  });
});
