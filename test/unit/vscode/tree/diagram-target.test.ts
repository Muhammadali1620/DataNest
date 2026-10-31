import { describe, expect, it } from 'vitest';
import { diagramStartOf, diagramTitle } from '../../../../src/vscode/tree/diagram-target';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

const table = (
  name: string,
  schema = 'public',
  connectionId = 'c',
  tableKind: 'table' | 'view' = 'table',
): TreeNode => ({
  kind: 'table',
  connectionId,
  scope: { database: 'shop', schema },
  name,
  tableKind,
});

describe('diagramStartOf', () => {
  it('draws the whole schema over the clicked table when nothing else is selected', () => {
    expect(diagramStartOf(table('orders'), undefined)).toEqual({
      connectionId: 'c',
      scope: { database: 'shop', schema: 'public' },
      focus: 'orders',
    });
  });

  it('takes the selected tables of the same connection and scope, but no views', () => {
    const start = diagramStartOf(table('a'), [
      table('a'),
      table('b'),
      table('v', 'public', 'c', 'view'),
      table('other', 'sales'),
      table('x', 'public', 'c2'),
      { kind: 'database', connectionId: 'c', database: 'shop' },
    ]);
    expect(start?.tables).toEqual(['a', 'b']);
    expect(start?.focus).toBe('a');
  });

  it('ignores a selection the clicked table is not part of', () => {
    const start = diagramStartOf(table('a'), [table('b')]);
    expect(start?.tables).toBeUndefined();
    expect(start?.focus).toBe('a');
  });

  it('draws nothing from a view', () => {
    expect(diagramStartOf(table('v', 'public', 'c', 'view'), undefined)).toBeUndefined();
  });

  it('draws a whole database, schema or Tables folder', () => {
    expect(
      diagramStartOf({ kind: 'database', connectionId: 'c', database: 'shop' }, undefined),
    ).toEqual({
      connectionId: 'c',
      scope: { database: 'shop' },
    });
    expect(
      diagramStartOf(
        { kind: 'schema', connectionId: 'c', database: 'shop', schema: 'sales' },
        undefined,
      ),
    ).toEqual({ connectionId: 'c', scope: { database: 'shop', schema: 'sales' } });
    expect(
      diagramStartOf(
        { kind: 'group', group: 'tables', connectionId: 'c', scope: { schema: 'main' } },
        undefined,
      ),
    ).toEqual({ connectionId: 'c', scope: { schema: 'main' } });
  });

  it('asks for the scope of a connection', () => {
    expect(diagramStartOf({ kind: 'connection', connectionId: 'c' }, undefined)).toEqual({
      connectionId: 'c',
      scope: undefined,
    });
  });

  it('draws nothing from other folders and items', () => {
    const others: TreeNode[] = [
      { kind: 'group', group: 'views', connectionId: 'c', scope: {} },
      { kind: 'connectionFolder', folder: 'work' },
      { kind: 'redisDatabase', connectionId: 'r', database: 0, keys: 1 },
      { kind: 'message', text: 'x' },
    ];
    for (const node of others) {
      expect(diagramStartOf(node, undefined)).toBeUndefined();
    }
  });
});

describe('diagramTitle', () => {
  it('names the scope', () => {
    expect(diagramTitle({ database: 'shop', schema: 'public' }, undefined, 'Local')).toBe(
      'shop.public',
    );
    expect(diagramTitle({ database: 'shop' }, undefined, 'Local')).toBe('shop');
  });

  it('uses the connection name where the connection is the scope', () => {
    expect(diagramTitle({}, undefined, 'app.db')).toBe('app.db');
  });

  it('names one chosen table, or counts several', () => {
    expect(diagramTitle({ database: 'shop' }, ['orders'], 'Local')).toBe('shop.orders');
    expect(diagramTitle({ database: 'shop' }, ['a', 'b', 'c'], 'Local')).toBe('shop (3)');
  });
});
