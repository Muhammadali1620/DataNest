import { describe, expect, it } from 'vitest';
import {
  connectionIdOf,
  isTreeNode,
  nameOf,
  type TreeNode,
} from '../../../../src/vscode/tree/nodes';

const column: TreeNode = {
  kind: 'column',
  connectionId: 'c1',
  table: { database: 'app', name: 'orders' },
  column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
};

describe('connectionIdOf', () => {
  it('reads the id from any node that belongs to a connection', () => {
    expect(connectionIdOf({ kind: 'connection', connectionId: 'c1' })).toBe('c1');
    expect(connectionIdOf({ kind: 'database', connectionId: 'c1', database: 'app' })).toBe('c1');
    expect(connectionIdOf({ kind: 'schema', connectionId: 'c1', schema: 'public' })).toBe('c1');
    expect(connectionIdOf({ kind: 'group', group: 'tables', connectionId: 'c1', scope: {} })).toBe(
      'c1',
    );
    expect(connectionIdOf(column)).toBe('c1');
  });

  it('accepts a plain id from the command palette', () => {
    expect(connectionIdOf('c1')).toBe('c1');
  });

  it('is undefined without a target, for an empty id and for a message node', () => {
    expect(connectionIdOf(undefined)).toBeUndefined();
    expect(connectionIdOf('')).toBeUndefined();
    expect(connectionIdOf({ kind: 'message', text: 'No tables' })).toBeUndefined();
  });

  it('reads the id of a message that belongs to a connection', () => {
    expect(connectionIdOf({ kind: 'message', text: 'No tables', connectionId: 'c1' })).toBe('c1');
  });
});

describe('isTreeNode', () => {
  it('accepts every node kind', () => {
    const nodes: TreeNode[] = [
      { kind: 'connection', connectionId: 'c1' },
      { kind: 'database', connectionId: 'c1', database: 'app' },
      { kind: 'schema', connectionId: 'c1', schema: 'public' },
      { kind: 'group', group: 'views', connectionId: 'c1', scope: {} },
      { kind: 'table', connectionId: 'c1', scope: {}, name: 't', tableKind: 'table' },
      column,
      { kind: 'folder', folder: 'indexes', connectionId: 'c1', table: { name: 't' } },
      { kind: 'object', connectionId: 'c1', object: { kind: 'event', name: 'e' } },
      {
        kind: 'index',
        connectionId: 'c1',
        table: { name: 't' },
        index: { name: 'i', columns: [], unique: false, primary: false },
      },
      {
        kind: 'foreignKey',
        connectionId: 'c1',
        table: { name: 't' },
        key: { name: 'k', columns: [], target: { name: 'u' }, targetColumns: [] },
      },
      { kind: 'message', text: 'x' },
    ];
    for (const node of nodes) {
      expect(isTreeNode(node)).toBe(true);
    }
  });

  it('rejects anything else a command might receive', () => {
    expect(isTreeNode(undefined)).toBe(false);
    expect(isTreeNode(null)).toBe(false);
    expect(isTreeNode('c1')).toBe(false);
    expect(isTreeNode({})).toBe(false);
    expect(isTreeNode({ kind: 'something-else' })).toBe(false);
  });
});

describe('nameOf', () => {
  it('gives the object name for the nodes that have one', () => {
    expect(nameOf({ kind: 'database', connectionId: 'c1', database: 'app' })).toBe('app');
    expect(nameOf({ kind: 'schema', connectionId: 'c1', schema: 'public' })).toBe('public');
    expect(
      nameOf({ kind: 'table', connectionId: 'c1', scope: {}, name: 'orders', tableKind: 'table' }),
    ).toBe('orders');
    expect(nameOf(column)).toBe('id');
    expect(
      nameOf({
        kind: 'object',
        connectionId: 'c1',
        object: { kind: 'function', name: 'total', signature: 'a integer' },
      }),
    ).toBe('total');
    expect(
      nameOf({
        kind: 'index',
        connectionId: 'c1',
        table: { name: 't' },
        index: { name: 'ix_t', columns: ['a'], unique: false, primary: false },
      }),
    ).toBe('ix_t');
    expect(
      nameOf({
        kind: 'foreignKey',
        connectionId: 'c1',
        table: { name: 't' },
        key: { name: 'fk_t', columns: ['a'], target: { name: 'u' }, targetColumns: ['id'] },
      }),
    ).toBe('fk_t');
  });

  it('has nothing to copy for connections, groups and messages', () => {
    expect(nameOf({ kind: 'connection', connectionId: 'c1' })).toBeUndefined();
    expect(
      nameOf({ kind: 'group', group: 'tables', connectionId: 'c1', scope: {} }),
    ).toBeUndefined();
    expect(nameOf({ kind: 'message', text: 'x' })).toBeUndefined();
    expect(
      nameOf({ kind: 'folder', folder: 'triggers', connectionId: 'c1', table: { name: 't' } }),
    ).toBeUndefined();
  });
});
