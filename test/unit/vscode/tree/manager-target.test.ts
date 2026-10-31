import { describe, expect, it } from 'vitest';
import { managerTargetOf, managerTargetOfNode } from '../../../../src/vscode/tree/manager-target';
import { isTreeNode, type TreeNode } from '../../../../src/vscode/tree/nodes';

const tableRef = { database: 'shop', schema: 'public', name: 'orders' };

const node = (value: object): TreeNode => value as unknown as TreeNode;

const NODES = {
  connection: node({ kind: 'connection', connectionId: 'c1' }),
  database: node({ kind: 'database', connectionId: 'c1', database: 'shop' }),
  schema: node({ kind: 'schema', connectionId: 'c1', database: 'shop', schema: 'public' }),
  table: node({
    kind: 'table',
    connectionId: 'c1',
    scope: { database: 'shop', schema: 'public' },
    name: 'orders',
    tableKind: 'view',
  }),
  column: node({ kind: 'column', connectionId: 'c1', table: tableRef, column: { name: 'id' } }),
  message: node({ kind: 'message', text: 'x' }),
};

describe('managerTargetOfNode', () => {
  it('starts from a connection with nothing else', () => {
    expect(managerTargetOfNode(NODES.connection)).toEqual({ connectionId: 'c1' });
  });

  it('carries the database and schema of a scope', () => {
    expect(managerTargetOfNode(NODES.database)).toEqual({ connectionId: 'c1', database: 'shop' });
    expect(managerTargetOfNode(NODES.schema, 'dump')).toEqual({
      connectionId: 'c1',
      database: 'shop',
      schema: 'public',
      section: 'dump',
    });
  });

  it('names the table, and its kind, of a table or a view', () => {
    expect(managerTargetOfNode(NODES.table)).toEqual({
      connectionId: 'c1',
      database: 'shop',
      schema: 'public',
      table: { name: 'orders', kind: 'view' },
    });
  });

  it('reads the table off a column', () => {
    expect(managerTargetOfNode(NODES.column)).toMatchObject({
      table: { name: 'orders', kind: 'table' },
      schema: 'public',
    });
  });

  it('has no page for items that are not SQL objects', () => {
    expect(managerTargetOfNode(NODES.message)).toBeUndefined();
  });
});

describe('managerTargetOf', () => {
  const of = (value: unknown, section?: Parameters<typeof managerTargetOf>[2]) =>
    managerTargetOf(value, isTreeNode, section);

  it('accepts a tree item and a bare connection id', () => {
    expect(of(NODES.connection)).toEqual({ connectionId: 'c1' });
    expect(of('c9', 'log')).toEqual({ connectionId: 'c9', section: 'log' });
  });

  it('accepts the object another page passes', () => {
    expect(
      of({
        connectionId: 'c1',
        scope: { database: 'shop', schema: 'public' },
        table: { name: 'orders', kind: 'view' },
        section: 'sync',
      }),
    ).toEqual({
      connectionId: 'c1',
      database: 'shop',
      schema: 'public',
      table: { name: 'orders', kind: 'view' },
      section: 'sync',
    });
  });

  it('takes a table given by name as a table', () => {
    expect(of({ connectionId: 'c1', table: 'orders' })).toEqual({
      connectionId: 'c1',
      table: { name: 'orders', kind: 'table' },
    });
  });

  it('ignores a section it does not know, keeping the default', () => {
    expect(of({ connectionId: 'c1', section: 'nope' }, 'dump')).toEqual({
      connectionId: 'c1',
      section: 'dump',
    });
  });

  it('refuses what is not a target', () => {
    expect(of(undefined)).toBeUndefined();
    expect(of('')).toBeUndefined();
    expect(of(42)).toBeUndefined();
    expect(of({ scope: {} })).toBeUndefined();
    expect(of({ connectionId: '' })).toBeUndefined();
  });
});
