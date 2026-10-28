import { describe, expect, it } from 'vitest';
import {
  describeColumn,
  nodeId,
  objectRefOf,
  scopeOf,
  tableRefOf,
  type TreeNode,
} from '../../../../src/vscode/tree/nodes';

describe('scopeOf', () => {
  it('is empty for a connection and for messages', () => {
    expect(scopeOf({ kind: 'connection', connectionId: 'c1' })).toEqual({});
    expect(scopeOf({ kind: 'message', text: 'oops' })).toEqual({});
  });

  it('carries the database and the schema down the tree', () => {
    expect(scopeOf({ kind: 'database', connectionId: 'c1', database: 'app' })).toEqual({
      database: 'app',
    });
    expect(
      scopeOf({ kind: 'schema', connectionId: 'c1', database: 'app', schema: 'public' }),
    ).toEqual({ database: 'app', schema: 'public' });
    expect(scopeOf({ kind: 'schema', connectionId: 'c1', schema: 'public' })).toEqual({
      schema: 'public',
    });
  });

  it('passes the scope of groups and tables through unchanged', () => {
    const scope = { database: 'app', schema: 'public' };
    expect(scopeOf({ kind: 'group', group: 'tables', connectionId: 'c1', scope })).toEqual(scope);
    expect(
      scopeOf({ kind: 'table', connectionId: 'c1', scope, name: 't', tableKind: 'table' }),
    ).toEqual(scope);
  });

  it('derives the scope of a column from its table', () => {
    expect(
      scopeOf({
        kind: 'column',
        connectionId: 'c1',
        table: { database: 'app', name: 'orders' },
        column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
      }),
    ).toEqual({ database: 'app' });
  });
});

describe('nodeId', () => {
  const nodes: TreeNode[] = [
    { kind: 'connection', connectionId: 'c1' },
    { kind: 'database', connectionId: 'c1', database: 'app' },
    { kind: 'schema', connectionId: 'c1', database: 'app', schema: 'public' },
    { kind: 'group', group: 'tables', connectionId: 'c1', scope: { database: 'app' } },
    { kind: 'group', group: 'views', connectionId: 'c1', scope: { database: 'app' } },
    {
      kind: 'table',
      connectionId: 'c1',
      scope: { database: 'app' },
      name: 'orders',
      tableKind: 'table',
    },
    {
      kind: 'column',
      connectionId: 'c1',
      table: { database: 'app', name: 'orders' },
      column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
    },
    { kind: 'message', text: 'No tables', connectionId: 'c1' },
  ];

  it('gives every node kind a distinct id', () => {
    const ids = nodes.map(nodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is stable for equal nodes', () => {
    const database: TreeNode = { kind: 'database', connectionId: 'c1', database: 'app' };
    expect(nodeId(database)).toBe(
      nodeId({ kind: 'database', connectionId: 'c1', database: 'app' }),
    );
  });

  it('separates connections, databases and schemas', () => {
    expect(nodeId({ kind: 'database', connectionId: 'c1', database: 'app' })).not.toBe(
      nodeId({ kind: 'database', connectionId: 'c2', database: 'app' }),
    );
    expect(nodeId({ kind: 'schema', connectionId: 'c1', schema: 'public' })).not.toBe(
      nodeId({ kind: 'schema', connectionId: 'c1', database: 'app', schema: 'public' }),
    );
  });

  it('does not let a name containing a separator collide with another node', () => {
    const tricky = nodeId({ kind: 'database', connectionId: 'c1', database: 'a:b' });
    const plain = nodeId({ kind: 'database', connectionId: 'c1:a', database: 'b' });
    expect(tricky).not.toBe(plain);
  });

  it('distinguishes tables with the same name in different scopes', () => {
    const inApp = nodeId({
      kind: 'table',
      connectionId: 'c1',
      scope: { database: 'app' },
      name: 'orders',
      tableKind: 'table',
    });
    const inShop = nodeId({
      kind: 'table',
      connectionId: 'c1',
      scope: { database: 'shop' },
      name: 'orders',
      tableKind: 'table',
    });
    expect(inApp).not.toBe(inShop);
  });
});

describe('tableRefOf', () => {
  it('joins the scope with the table name', () => {
    expect(
      tableRefOf({
        kind: 'table',
        connectionId: 'c1',
        scope: { database: 'app', schema: 'public' },
        name: 'orders',
        tableKind: 'table',
      }),
    ).toEqual({ database: 'app', schema: 'public', name: 'orders' });
  });
});

describe('objectRefOf', () => {
  it('points at a table or a view by kind, scope and name', () => {
    expect(
      objectRefOf({
        kind: 'table',
        connectionId: 'c1',
        scope: { database: 'app', schema: 'public' },
        name: 'orders',
        tableKind: 'table',
      }),
    ).toEqual({ database: 'app', schema: 'public', kind: 'table', name: 'orders' });
    expect(
      objectRefOf({
        kind: 'table',
        connectionId: 'c1',
        scope: {},
        name: 'totals',
        tableKind: 'view',
      }),
    ).toEqual({ kind: 'view', name: 'totals' });
  });

  it('has nothing for nodes that hold no definition', () => {
    const nodes: TreeNode[] = [
      { kind: 'connection', connectionId: 'c1' },
      { kind: 'database', connectionId: 'c1', database: 'app' },
      { kind: 'schema', connectionId: 'c1', schema: 'public' },
      { kind: 'group', group: 'tables', connectionId: 'c1', scope: {} },
      {
        kind: 'column',
        connectionId: 'c1',
        table: { name: 't' },
        column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
      },
      { kind: 'message', text: 'x' },
    ];
    for (const node of nodes) {
      expect(objectRefOf(node)).toBeUndefined();
    }
  });
});

describe('describeColumn', () => {
  it('lists the type, the key and the nullability', () => {
    expect(describeColumn({ name: 'id', dataType: 'int', nullable: false, primaryKey: true })).toBe(
      'int, PK, NOT NULL',
    );
  });

  it('shows just the type for a plain nullable column', () => {
    expect(
      describeColumn({ name: 'note', dataType: 'text', nullable: true, primaryKey: false }),
    ).toBe('text');
  });

  it('includes a default when there is one', () => {
    expect(
      describeColumn({
        name: 'created_at',
        dataType: 'datetime',
        nullable: false,
        primaryKey: false,
        defaultValue: 'now()',
      }),
    ).toBe('datetime, NOT NULL, DEFAULT now()');
  });
});
