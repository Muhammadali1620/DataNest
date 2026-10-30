import { describe, expect, it } from 'vitest';
import { compareStartOf, scopeLabel, tableLabel } from '../../../../src/vscode/tree/compare-target';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

describe('compareStartOf', () => {
  it('starts from a database, a schema or a connection', () => {
    expect(compareStartOf({ kind: 'database', connectionId: 'c', database: 'shop' })).toEqual({
      connectionId: 'c',
      scope: { database: 'shop' },
    });
    expect(
      compareStartOf({ kind: 'schema', connectionId: 'c', database: 'shop', schema: 'public' }),
    ).toEqual({
      connectionId: 'c',
      scope: { database: 'shop', schema: 'public' },
    });
    expect(compareStartOf({ kind: 'connection', connectionId: 'c' })).toEqual({
      connectionId: 'c',
      scope: undefined,
    });
  });

  it('starts from nothing else', () => {
    const others: TreeNode[] = [
      { kind: 'group', group: 'tables', connectionId: 'c', scope: {} },
      { kind: 'table', connectionId: 'c', scope: {}, name: 't', tableKind: 'table' },
      { kind: 'message', text: 'x' },
    ];
    expect(others.map(compareStartOf)).toEqual([undefined, undefined, undefined]);
  });
});

describe('scopeLabel', () => {
  it('joins the connection and the scope', () => {
    expect(scopeLabel('Local', { database: 'shop', schema: 'public' })).toBe('Local · shop.public');
    expect(scopeLabel('app.db', {})).toBe('app.db');
  });
});

describe('tableLabel', () => {
  it('names the connection and the table with its scope', () => {
    expect(tableLabel('Local', { database: 'shop', schema: 'public', name: 'orders' })).toBe(
      'Local · shop.public.orders',
    );
    expect(tableLabel('app.db', { name: 'orders' })).toBe('app.db · orders');
  });
});
