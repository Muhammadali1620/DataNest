import { beforeEach, describe, expect, it, vi } from 'vitest';
import { treeCommandHandlers } from '../../../../src/vscode/tree/tree-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

const NO_TARGET = 'Pick a connection in the DataNest view first';

function setup() {
  const connect = vi.fn(() => Promise.resolve());
  const disconnect = vi.fn(() => Promise.resolve());
  const refresh = vi.fn();
  const invalidate = vi.fn();
  const writeText = vi.fn(() => Promise.resolve());
  const openTable = vi.fn(() => Promise.resolve());
  const handlers = treeCommandHandlers({
    manager: { connect, disconnect } as never,
    tree: { refresh },
    cache: { invalidate },
    openTable,
    clipboard: { writeText },
    noTargetMessage: NO_TARGET,
  });
  return { handlers, connect, disconnect, refresh, invalidate, writeText, openTable };
}

const connectionNode: TreeNode = { kind: 'connection', connectionId: 'c1' };
const tableNode: TreeNode = {
  kind: 'table',
  connectionId: 'c1',
  scope: { database: 'app' },
  name: 'orders',
  tableKind: 'table',
};

describe('connect', () => {
  it('connects the clicked connection and refreshes the tree', async () => {
    const { handlers, connect, refresh } = setup();
    await handlers.connect(connectionNode);
    expect(connect).toHaveBeenCalledWith('c1');
    expect(refresh).toHaveBeenCalledWith();
  });

  it('works on a node below the connection', async () => {
    const { handlers, connect } = setup();
    await handlers.connect(tableNode);
    expect(connect).toHaveBeenCalledWith('c1');
  });

  it('explains itself when run from the palette without a target', async () => {
    const { handlers, connect } = setup();
    await expect(handlers.connect()).rejects.toMatchObject({
      name: 'DbError',
      code: 'not-found',
      message: NO_TARGET,
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('lets a failure through and does not refresh', async () => {
    const refresh = vi.fn();
    const failing = treeCommandHandlers({
      manager: {
        connect: () => Promise.reject(new Error('server down')),
        disconnect: () => Promise.resolve(),
      },
      tree: { refresh },
      cache: { invalidate: () => undefined },
      openTable: () => Promise.resolve(),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
    });
    await expect(failing.connect(connectionNode)).rejects.toThrow('server down');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  it('disconnects the clicked connection and refreshes', async () => {
    const { handlers, disconnect, refresh } = setup();
    await handlers.disconnect(connectionNode);
    expect(disconnect).toHaveBeenCalledWith('c1');
    expect(refresh).toHaveBeenCalledWith();
  });

  it('needs a target as well', async () => {
    const { handlers, disconnect } = setup();
    await expect(handlers.disconnect()).rejects.toMatchObject({ code: 'not-found' });
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe('refresh', () => {
  it('refreshes the clicked subtree and drops that connection from the cache', () => {
    const { handlers, refresh, invalidate } = setup();
    handlers.refresh(tableNode);
    expect(invalidate).toHaveBeenCalledWith('c1');
    expect(refresh).toHaveBeenCalledWith(tableNode);
  });

  it('refreshes everything from the view title and drops the whole cache', () => {
    const { handlers, refresh, invalidate } = setup();
    handlers.refresh();
    expect(invalidate).toHaveBeenCalledWith(undefined);
    expect(refresh).toHaveBeenCalledWith(undefined);
  });

  it('refreshes everything when given a bare id', () => {
    const { handlers, refresh, invalidate } = setup();
    handlers.refresh('c1');
    expect(invalidate).toHaveBeenCalledWith(undefined);
    expect(refresh).toHaveBeenCalledWith(undefined);
  });

  it('drops the cache before the tree asks for children again', () => {
    const order: string[] = [];
    const handlers = treeCommandHandlers({
      manager: { connect: () => Promise.resolve(), disconnect: () => Promise.resolve() } as never,
      tree: {
        refresh: () => {
          order.push('refresh');
        },
      },
      cache: {
        invalidate: () => {
          order.push('invalidate');
        },
      },
      openTable: () => Promise.resolve(),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
    });
    handlers.refresh(tableNode);
    expect(order).toEqual(['invalidate', 'refresh']);
  });
});

describe('copyName', () => {
  let harness: ReturnType<typeof setup>;

  beforeEach(() => {
    harness = setup();
  });

  it('copies the name of an object', async () => {
    await harness.handlers.copyName(tableNode);
    expect(harness.writeText).toHaveBeenCalledWith('orders');
  });

  it('copies a column name', async () => {
    await harness.handlers.copyName({
      kind: 'column',
      connectionId: 'c1',
      table: { name: 'orders' },
      column: { name: 'email', dataType: 'text', nullable: true, primaryKey: false },
    });
    expect(harness.writeText).toHaveBeenCalledWith('email');
  });

  it('does nothing for nodes without a name of their own', async () => {
    await harness.handlers.copyName(connectionNode);
    await harness.handlers.copyName({
      kind: 'group',
      group: 'tables',
      connectionId: 'c1',
      scope: {},
    });
    expect(harness.writeText).not.toHaveBeenCalled();
  });

  it('does nothing without a target', async () => {
    await harness.handlers.copyName();
    await harness.handlers.copyName('c1');
    expect(harness.writeText).not.toHaveBeenCalled();
  });
});

describe('openTable', () => {
  it('opens a table node', async () => {
    const { handlers, openTable } = setup();
    await handlers.openTable(tableNode);
    expect(openTable).toHaveBeenCalledWith(tableNode);
  });

  it('opens a view the same way', async () => {
    const { handlers, openTable } = setup();
    const view: TreeNode = { ...tableNode, name: 'order_totals', tableKind: 'view' };
    await handlers.openTable(view);
    expect(openTable).toHaveBeenCalledWith(view);
  });

  it('ignores nodes that are not tables', async () => {
    const { handlers, openTable } = setup();
    await handlers.openTable(connectionNode);
    await handlers.openTable({ kind: 'group', group: 'tables', connectionId: 'c1', scope: {} });
    await handlers.openTable();
    await handlers.openTable('c1');
    expect(openTable).not.toHaveBeenCalled();
  });
});
