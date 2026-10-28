import { describe, expect, it } from 'vitest';
import {
  describeColumn,
  describeForeignKey,
  describeIndex,
  nodeId,
  objectLabel,
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
    { kind: 'group', group: 'functions', connectionId: 'c1', scope: { database: 'app' } },
    {
      kind: 'folder',
      folder: 'indexes',
      connectionId: 'c1',
      table: { database: 'app', name: 'orders' },
    },
    {
      kind: 'folder',
      folder: 'triggers',
      connectionId: 'c1',
      table: { database: 'app', name: 'orders' },
    },
    {
      kind: 'object',
      connectionId: 'c1',
      object: { database: 'app', kind: 'function', name: 'f', signature: 'a integer' },
    },
    {
      kind: 'object',
      connectionId: 'c1',
      object: { database: 'app', kind: 'function', name: 'f', signature: 'a text' },
    },
    {
      kind: 'object',
      connectionId: 'c1',
      object: { database: 'app', kind: 'procedure', name: 'f' },
    },
    {
      kind: 'object',
      connectionId: 'c1',
      object: { database: 'app', kind: 'trigger', name: 'audit', table: 'orders' },
    },
    {
      kind: 'object',
      connectionId: 'c1',
      object: { database: 'app', kind: 'trigger', name: 'audit', table: 'items' },
    },
    {
      kind: 'index',
      connectionId: 'c1',
      table: { database: 'app', name: 'orders' },
      index: { name: 'ix', columns: ['a'], unique: false, primary: false },
    },
    {
      kind: 'foreignKey',
      connectionId: 'c1',
      table: { database: 'app', name: 'orders' },
      key: { name: 'ix', columns: ['a'], target: { name: 'u' }, targetColumns: ['id'] },
    },
  ];

  it('gives every node kind a distinct id, overloads and same-named triggers included', () => {
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

  it('points at a routine, trigger or sequence as it is', () => {
    const object = { schema: 'public', kind: 'function' as const, name: 'f', signature: 'a int' };
    expect(objectRefOf({ kind: 'object', connectionId: 'c1', object })).toBe(object);
  });

  it('has nothing for indexes, keys and folders', () => {
    const table = { name: 't' };
    expect(
      objectRefOf({ kind: 'folder', folder: 'indexes', connectionId: 'c1', table }),
    ).toBeUndefined();
    expect(
      objectRefOf({
        kind: 'index',
        connectionId: 'c1',
        table,
        index: { name: 'i', columns: [], unique: false, primary: false },
      }),
    ).toBeUndefined();
    expect(
      objectRefOf({
        kind: 'foreignKey',
        connectionId: 'c1',
        table,
        key: { name: 'k', columns: [], target: { name: 'u' }, targetColumns: [] },
      }),
    ).toBeUndefined();
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

describe('scopeOf for objects and table parts', () => {
  it('takes the scope of the object or of the table', () => {
    expect(
      scopeOf({
        kind: 'object',
        connectionId: 'c1',
        object: { database: 'app', schema: 's', kind: 'sequence', name: 'seq' },
      }),
    ).toEqual({ database: 'app', schema: 's' });
    expect(
      scopeOf({
        kind: 'folder',
        folder: 'foreignKeys',
        connectionId: 'c1',
        table: { database: 'app', name: 't' },
      }),
    ).toEqual({ database: 'app' });
  });
});

describe('describeIndex', () => {
  it('names the primary key, uniqueness and a special method', () => {
    expect(
      describeIndex({
        name: 'PRIMARY',
        columns: ['id'],
        unique: true,
        primary: true,
        method: 'BTREE',
      }),
    ).toBe('PRIMARY KEY (id)');
    expect(describeIndex({ name: 'u', columns: ['a', 'b'], unique: true, primary: false })).toBe(
      'UNIQUE (a, b)',
    );
    expect(
      describeIndex({
        name: 'f',
        columns: ['body'],
        unique: false,
        primary: false,
        method: 'FULLTEXT',
      }),
    ).toBe('fulltext (body)');
    expect(
      describeIndex({ name: 'g', columns: ['tags'], unique: true, primary: false, method: 'gin' }),
    ).toBe('UNIQUE gin (tags)');
  });

  it('shows the condition of a partial index', () => {
    expect(
      describeIndex({
        name: 'p',
        columns: ['price'],
        unique: false,
        primary: false,
        where: 'price > 10',
      }),
    ).toBe('(price) WHERE price > 10');
  });
});

describe('describeForeignKey', () => {
  it('shows the columns and the qualified target', () => {
    expect(
      describeForeignKey({
        name: 'fk',
        columns: ['a', 'b'],
        target: { schema: 'sales', name: 'orders' },
        targetColumns: ['x', 'y'],
      }),
    ).toBe('(a, b) → sales.orders (x, y)');
  });
});

describe('objectLabel', () => {
  it('adds the arguments of a routine with a signature', () => {
    expect(objectLabel({ kind: 'function', name: 'f', signature: 'a integer' })).toBe(
      'f(a integer)',
    );
    expect(objectLabel({ kind: 'function', name: 'g', signature: '' })).toBe('g()');
    expect(objectLabel({ kind: 'event', name: 'nightly' })).toBe('nightly');
  });
});
