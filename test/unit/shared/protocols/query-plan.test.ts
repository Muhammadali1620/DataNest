import { describe, expect, it } from 'vitest';
import { queryPlanProtocol } from '../../../../src/shared/protocols/query-plan';

const row = {
  depth: 0,
  operation: 'Seq Scan',
  object: 'orders o',
  cost: 24.5,
  rows: 1450,
  warnings: ['full-scan'],
  properties: [['Alias', 'o']],
  self: 24.5,
  share: 1,
  heat: 'hot',
  descendants: 0,
};

const state = {
  statement: 'SELECT 1',
  connection: 'Local',
  canAnalyze: true,
  running: false,
  analyzed: false,
  basis: 'cost',
  rows: [row],
  properties: [],
  notes: [],
};

describe('queryPlanProtocol', () => {
  const parse = (value: unknown) => queryPlanProtocol.webview.events.state.parse(value);

  it('accepts a plan as the host sends it', () => {
    expect(parse(state)).toEqual(state);
    expect(parse({ ...state, error: 'syntax error' }).error).toBe('syntax error');
  });

  it('rejects unknown warnings, heats and shares above one', () => {
    expect(() => parse({ ...state, rows: [{ ...row, warnings: ['slow'] }] })).toThrow();
    expect(() => parse({ ...state, rows: [{ ...row, heat: 'boiling' }] })).toThrow();
    expect(() => parse({ ...state, rows: [{ ...row, share: 1.5 }] })).toThrow();
    expect(() => parse({ ...state, basis: 'guess' })).toThrow();
  });

  it('takes only the events the page sends', () => {
    const events = queryPlanProtocol.host.events;
    expect(events.explain.parse({ analyze: true })).toEqual({ analyze: true });
    expect(() => events.explain.parse({ analyze: 'yes' })).toThrow();
    expect(events.showRaw.parse({})).toEqual({});
  });
});
