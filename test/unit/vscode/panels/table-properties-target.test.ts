import { describe, expect, it } from 'vitest';
import { propertiesTarget } from '../../../../src/vscode/panels/table-properties-target';

describe('propertiesTarget', () => {
  it('reads a connection, a scope, a table and a tab', () => {
    expect(
      propertiesTarget({
        connectionId: 'c1',
        scope: { database: 'shop', schema: 'public' },
        table: 'orders',
        tab: 'checks',
      }),
    ).toEqual({
      connectionId: 'c1',
      table: 'orders',
      scope: { database: 'shop', schema: 'public' },
      tab: 'checks',
    });
  });

  it('opens on the default tab when none, or an unknown one, is named', () => {
    expect(propertiesTarget({ connectionId: 'c', table: 't' })?.tab).toBeUndefined();
    expect(propertiesTarget({ connectionId: 'c', table: 't', tab: 'nope' })?.tab).toBeUndefined();
  });

  it('leaves out empty or non-text parts of the scope', () => {
    expect(
      propertiesTarget({ connectionId: 'c', table: 't', scope: { database: '', schema: 5 } })
        ?.scope,
    ).toEqual({});
    expect(propertiesTarget({ connectionId: 'c', table: 't', scope: 'x' })?.scope).toEqual({});
  });

  it('ignores anything that is not a table address', () => {
    for (const arg of [
      undefined,
      null,
      'orders',
      5,
      {},
      { connectionId: 'c' },
      { connectionId: 'c', table: '' },
      { connectionId: 1, table: 't' },
    ]) {
      expect(propertiesTarget(arg), JSON.stringify(arg)).toBeUndefined();
    }
  });
});
