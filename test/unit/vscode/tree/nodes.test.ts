import { describe, expect, it } from 'vitest';
import {
  connectionContext,
  connectionIdOf,
  isTreeNode,
  nameOf,
  nodeId,
  TREE_CONTEXT,
  relationKindOf,
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

describe('relationKindOf', () => {
  const node = {
    kind: 'table' as const,
    connectionId: 'c1',
    scope: {},
    name: 'x',
  };

  it('tells tables, views and materialized views apart', () => {
    expect(relationKindOf({ ...node, tableKind: 'table' })).toBe('table');
    expect(relationKindOf({ ...node, tableKind: 'view' })).toBe('view');
    expect(relationKindOf({ ...node, tableKind: 'view', materialized: true })).toBe(
      'materialized-view',
    );
  });
});

describe('connection folders', () => {
  it('have an id of their own, a name and no connection', async () => {
    const { nodeId, nameOf, isTreeNode, connectionIdOf, scopeOf, objectRefOf } =
      await import('../../../../src/vscode/tree/nodes');
    const node = { kind: 'connectionFolder' as const, folder: 'Prod:EU' };
    expect(nodeId(node)).toBe('connectionFolder:Prod\\:EU');
    expect(nodeId(node)).not.toBe(nodeId({ kind: 'connection', connectionId: 'Prod:EU' }));
    expect(nameOf(node)).toBe('Prod:EU');
    expect(isTreeNode(node)).toBe(true);
    expect(connectionIdOf(node)).toBeUndefined();
    expect(scopeOf(node)).toEqual({});
    expect(objectRefOf(node)).toBeUndefined();
  });
});

describe('project nodes', () => {
  it('have an id of their own and no connection, scope, name or object', async () => {
    const { nodeId, nameOf, isTreeNode, connectionIdOf, scopeOf, objectRefOf } =
      await import('../../../../src/vscode/tree/nodes');
    const node = { kind: 'project' as const, key: 'file:///a:b', name: 'a' };
    expect(nodeId(node)).toBe('project:file\\:///a\\:b');
    expect(nodeId(node)).not.toBe(nodeId({ kind: 'connectionFolder', folder: 'file:///a:b' }));
    expect(isTreeNode(node)).toBe(true);
    expect(connectionIdOf(node)).toBeUndefined();
    expect(nameOf(node)).toBeUndefined();
    expect(scopeOf(node)).toEqual({});
    expect(objectRefOf(node)).toBeUndefined();
  });
});

describe('Redis nodes (V7.1)', () => {
  const database: TreeNode = { kind: 'redisDatabase', connectionId: 'c1', database: 3, keys: 9 };

  it('gives a database an id of its own that does not change with its key count', () => {
    expect(nodeId(database)).toBe(nodeId({ ...database, keys: 0 }));
    expect(nodeId(database)).not.toBe(nodeId({ ...database, database: 4 }));
    expect(isTreeNode(database)).toBe(true);
    expect(connectionIdOf(database)).toBe('c1');
  });

  it('has no SQL scope, name or definition', () => {
    expect(scopeOf(database)).toEqual({});
    expect(nameOf(database)).toBeUndefined();
    expect(objectRefOf(database)).toBeUndefined();
  });

  it('marks Redis connections apart, so only the shared menus show', () => {
    const contexts = [false, true].flatMap((project) =>
      [false, true].flatMap((connected) =>
        [false, true].map((redis) => connectionContext({ project, connected, redis })),
      ),
    );
    expect(new Set(contexts).size).toBe(8);
    expect(connectionContext({ project: false, connected: true, redis: true })).toBe(
      TREE_CONTEXT.redisConnectionConnected,
    );
    expect(connectionContext({ project: true, connected: false, redis: true })).toBe(
      TREE_CONTEXT.projectRedisConnection,
    );
    expect(connectionContext({ project: true, connected: true, redis: false })).toBe(
      TREE_CONTEXT.projectConnectionConnected,
    );
    expect(connectionContext({ project: false, connected: false, redis: false })).toBe(
      TREE_CONTEXT.connection,
    );
  });
});

describe('Redis key nodes (V7.2)', () => {
  const folder: TreeNode = {
    kind: 'redisFolder',
    connectionId: 'c1',
    database: 0,
    path: ['user', '1'],
    prefix: 'user:1:',
    count: 2,
  };
  const key: TreeNode = {
    kind: 'redisKey',
    connectionId: 'c1',
    database: 0,
    key: { text: 'user:1:name' },
    name: 'name',
    keyType: 'string',
  };
  const binary: TreeNode = { ...key, key: { text: 'user:1:name', hex: '75' } };
  const more: TreeNode = { kind: 'redisMore', connectionId: 'c1', database: 0, loaded: 5 };

  it('gives every node an id that survives a changed count or type', () => {
    expect(nodeId(folder)).toBe(nodeId({ ...folder, count: 9 }));
    expect(nodeId(key)).toBe(nodeId({ ...key, keyType: 'hash' }));
    expect(nodeId(more)).toBe(nodeId({ ...more, loaded: 10 }));
    expect(new Set([nodeId(folder), nodeId(key), nodeId(binary), nodeId(more)]).size).toBe(4);
    // A folder path is not confused with a name that holds the separator.
    expect(nodeId(folder)).not.toBe(nodeId({ ...folder, path: ['user:1'] }));
  });

  it('copies the full key name, or the prefix of a folder', () => {
    expect(nameOf(key)).toBe('user:1:name');
    expect(nameOf(folder)).toBe('user:1:');
    expect(nameOf(more)).toBeUndefined();
  });

  it('is a tree node of a connection, with no SQL scope or definition', () => {
    for (const node of [folder, key, more]) {
      expect(isTreeNode(node)).toBe(true);
      expect(connectionIdOf(node)).toBe('c1');
      expect(scopeOf(node)).toEqual({});
      expect(objectRefOf(node)).toBeUndefined();
    }
  });
});
