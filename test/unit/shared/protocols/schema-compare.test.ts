import { describe, expect, it } from 'vitest';
import { schemaCompareProtocol } from '../../../../src/shared/protocols/schema-compare';

describe('schemaCompareProtocol', () => {
  const state = {
    source: 'Local · src',
    target: 'Local · dst',
    items: [
      { id: 'table:t', kind: 'table', name: 't', status: 'changed' },
      {
        id: 'object:x',
        kind: 'trigger',
        name: 'tr',
        status: 'added',
        context: 'orders',
        hidden: true,
      },
    ],
  };

  it('accepts the state the host sends', () => {
    const parse = (value: unknown) => schemaCompareProtocol.webview.events.state.parse(value);
    expect(parse(state)).toEqual(state);
    expect(parse({ ...state, loading: { side: 'target', done: 1, total: 3 } }).loading?.side).toBe(
      'target',
    );
    expect(() => parse({ ...state, items: [{ ...state.items[0], kind: 'index' }] })).toThrow();
    expect(() => parse({ ...state, items: [{ ...state.items[0], status: 'moved' }] })).toThrow();
  });

  it('checks the details and the script request', () => {
    const detail = schemaCompareProtocol.host.requests.detail.result;
    const ok = {
      id: 'table:t',
      columns: [{ name: 'a', change: 'added', after: 'int' }],
      keys: [
        {
          kind: 'primaryKey',
          name: 'PRIMARY KEY',
          change: 'changed',
          before: '(a)',
          after: '(a, b)',
        },
      ],
      notes: [],
      diff: [{ op: 'add', text: 'x' }],
      script: '',
    };
    expect(detail.parse(ok)).toEqual(ok);
    expect(() => detail.parse({ ...ok, keys: [{ ...ok.keys[0], kind: 'check' }] })).toThrow();
    expect(schemaCompareProtocol.host.requests.openScript.params.parse({ ids: ['a'] })).toEqual({
      ids: ['a'],
    });
  });
});
