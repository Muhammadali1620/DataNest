import { beforeEach, describe, expect, it, vi } from 'vitest';
import { treeCommandHandlers } from '../../../../src/vscode/tree/tree-commands';
import { DoubleClickDetector } from '../../../../src/vscode/tree/double-click';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

const NO_TARGET = 'Pick a connection in the DataNest view first';

function setup() {
  const connect = vi.fn(() => Promise.resolve());
  const disconnect = vi.fn(() => Promise.resolve());
  const refresh = vi.fn();
  const invalidate = vi.fn();
  const writeText = vi.fn(() => Promise.resolve());
  const openTable = vi.fn(() => Promise.resolve());
  const showDefinition = vi.fn(() => Promise.resolve());
  const handlers = treeCommandHandlers({
    manager: { connectAny: connect, disconnect },
    tree: { refresh },
    cache: { invalidate },
    openTable,
    showDefinition,
    clipboard: { writeText },
    noTargetMessage: NO_TARGET,
  });
  return {
    handlers,
    connect,
    disconnect,
    refresh,
    invalidate,
    writeText,
    openTable,
    showDefinition,
  };
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
        connectAny: () => Promise.reject(new Error('server down')),
        disconnect: () => Promise.resolve(),
      },
      tree: { refresh },
      cache: { invalidate: () => undefined },
      openTable: () => Promise.resolve(),
      showDefinition: () => Promise.resolve(),
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
  it('refreshes the clicked subtree and drops that connection from the cache', async () => {
    const { handlers, refresh, invalidate } = setup();
    await handlers.refresh(tableNode);
    expect(invalidate).toHaveBeenCalledWith('c1');
    expect(refresh).toHaveBeenCalledWith(tableNode);
  });

  it('refreshes everything from the view title and drops the whole cache', async () => {
    const { handlers, refresh, invalidate } = setup();
    await handlers.refresh();
    expect(invalidate).toHaveBeenCalledWith(undefined);
    expect(refresh).toHaveBeenCalledWith(undefined);
  });

  it('refreshes everything when given a bare id', async () => {
    const { handlers, refresh, invalidate } = setup();
    await handlers.refresh('c1');
    expect(invalidate).toHaveBeenCalledWith(undefined);
    expect(refresh).toHaveBeenCalledWith(undefined);
  });

  it('drops the cache before the tree asks for children again', async () => {
    const order: string[] = [];
    const handlers = treeCommandHandlers({
      manager: {
        connectAny: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
      },
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
      showDefinition: () => Promise.resolve(),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
    });
    await handlers.refresh(tableNode);
    expect(order).toEqual(['invalidate', 'refresh']);
  });

  it('reads the project files again before redrawing the whole tree, not for a subtree', async () => {
    const order: string[] = [];
    const handlers = treeCommandHandlers({
      manager: {
        connectAny: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
      },
      tree: {
        refresh: () => {
          order.push('refresh');
        },
      },
      cache: { invalidate: () => undefined },
      openTable: () => Promise.resolve(),
      showDefinition: () => Promise.resolve(),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
      reloadProjects: () => {
        order.push('reload');
        return Promise.resolve();
      },
    });
    await handlers.refresh();
    await handlers.refresh(tableNode);
    expect(order).toEqual(['reload', 'refresh', 'refresh']);
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

describe('clickTable', () => {
  function clicking() {
    let now = 1000;
    const openTable = vi.fn(() => Promise.resolve());
    const handlers = treeCommandHandlers({
      manager: { connectAny: () => Promise.resolve(), disconnect: () => Promise.resolve() },
      tree: { refresh: vi.fn() },
      cache: { invalidate: vi.fn() },
      openTable,
      showDefinition: () => Promise.resolve(),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
      doubleClick: new DoubleClickDetector(() => now, 500),
    });
    return {
      handlers,
      openTable,
      wait: (ms: number) => {
        now += ms;
      },
    };
  }

  it('does not open on the first click', async () => {
    const { handlers, openTable } = clicking();
    await handlers.clickTable(tableNode);
    expect(openTable).not.toHaveBeenCalled();
  });

  it('opens on the second click within the window', async () => {
    const { handlers, openTable, wait } = clicking();
    await handlers.clickTable(tableNode);
    wait(200);
    await handlers.clickTable(tableNode);
    expect(openTable).toHaveBeenCalledExactlyOnceWith(tableNode);
  });

  it('treats slow clicks as two single ones', async () => {
    const { handlers, openTable, wait } = clicking();
    await handlers.clickTable(tableNode);
    wait(800);
    await handlers.clickTable(tableNode);
    expect(openTable).not.toHaveBeenCalled();
  });

  it('does not pair clicks on different tables', async () => {
    const { handlers, openTable, wait } = clicking();
    await handlers.clickTable(tableNode);
    wait(100);
    await handlers.clickTable({ ...tableNode, name: 'other' });
    expect(openTable).not.toHaveBeenCalled();
  });

  it('starts a new pair after a double click', async () => {
    const { handlers, openTable, wait } = clicking();
    await handlers.clickTable(tableNode);
    await handlers.clickTable(tableNode);
    wait(100);
    await handlers.clickTable(tableNode);
    expect(openTable).toHaveBeenCalledTimes(1);
  });

  it('ignores nodes that are not tables and empty targets', async () => {
    const { handlers, openTable } = clicking();
    await handlers.clickTable(connectionNode);
    await handlers.clickTable(connectionNode);
    await handlers.clickTable();
    await handlers.clickTable('c1');
    expect(openTable).not.toHaveBeenCalled();
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

describe('showDefinition', () => {
  it('opens the definition of a table with its scope', async () => {
    const { handlers, showDefinition } = setup();
    await handlers.showDefinition(tableNode);
    expect(showDefinition).toHaveBeenCalledWith('c1', {
      database: 'app',
      kind: 'table',
      name: 'orders',
    });
  });

  it('asks for a view as a view', async () => {
    const { handlers, showDefinition } = setup();
    await handlers.showDefinition({
      ...tableNode,
      scope: { database: 'shop', schema: 'sales' },
      name: 'totals',
      tableKind: 'view',
    });
    expect(showDefinition).toHaveBeenCalledWith('c1', {
      database: 'shop',
      schema: 'sales',
      kind: 'view',
      name: 'totals',
    });
  });

  it('ignores nodes without a definition and calls without a node', async () => {
    const { handlers, showDefinition } = setup();
    await handlers.showDefinition(connectionNode);
    await handlers.showDefinition({ kind: 'group', group: 'views', connectionId: 'c1', scope: {} });
    await handlers.showDefinition({
      kind: 'column',
      connectionId: 'c1',
      table: { name: 'orders' },
      column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
    });
    await handlers.showDefinition();
    await handlers.showDefinition('c1');
    expect(showDefinition).not.toHaveBeenCalled();
  });

  it('lets a failure reach the command guard', async () => {
    const handlers = treeCommandHandlers({
      manager: {
        connectAny: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
      },
      tree: { refresh: () => undefined },
      cache: { invalidate: () => undefined },
      openTable: () => Promise.resolve(),
      showDefinition: () => Promise.reject(new Error('no rights')),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
    });
    await expect(handlers.showDefinition(tableNode)).rejects.toThrow('no rights');
  });
});

describe('disconnect with open transactions (V4.8)', () => {
  function withConfirm(answer: boolean) {
    const disconnect = vi.fn(() => Promise.resolve());
    const refresh = vi.fn();
    const asked: string[] = [];
    const handlers = treeCommandHandlers({
      manager: { connectAny: () => Promise.resolve(), disconnect },
      tree: { refresh },
      cache: { invalidate: () => undefined },
      openTable: () => Promise.resolve(),
      showDefinition: () => Promise.resolve(),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
      confirmDisconnect: (connectionId) => {
        asked.push(connectionId);
        return Promise.resolve(answer);
      },
    });
    return { handlers, disconnect, refresh, asked };
  }

  it('asks first and disconnects on yes', async () => {
    const { handlers, disconnect, asked } = withConfirm(true);
    await handlers.disconnect(connectionNode);
    expect(asked).toEqual(['c1']);
    expect(disconnect).toHaveBeenCalledWith('c1');
  });

  it('keeps the connection on no', async () => {
    const { handlers, disconnect, refresh } = withConfirm(false);
    await handlers.disconnect(connectionNode);
    expect(disconnect).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('clickTable and the row it leaves as it was (V11.12)', () => {
  it('tells the expansion keeper about every click and settles the double one', async () => {
    const calls: string[] = [];
    let now = 0;
    const handlers = treeCommandHandlers({
      manager: { connectAny: () => Promise.resolve(), disconnect: () => Promise.resolve() },
      tree: { refresh: vi.fn() },
      cache: { invalidate: vi.fn() },
      openTable: () => Promise.resolve(),
      showDefinition: () => Promise.resolve(),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
      doubleClick: new DoubleClickDetector(() => now, 500),
      expansion: {
        clicked: () => calls.push('clicked'),
        settle: () => calls.push('settle'),
      },
    });
    await handlers.clickTable(tableNode);
    now += 100;
    await handlers.clickTable(tableNode);
    expect(calls).toEqual(['clicked', 'clicked', 'settle']);
  });
});

describe('clickNode, openNodeSql and nodeActions (V11.12)', () => {
  const column: TreeNode = {
    kind: 'column',
    connectionId: 'c1',
    table: { database: 'app', name: 'orders' },
    column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
  };
  const index: TreeNode = {
    kind: 'index',
    connectionId: 'c1',
    table: { database: 'app', name: 'orders' },
    index: { name: 'ix', columns: ['a'], unique: false, primary: false },
  };

  function clicking() {
    let now = 0;
    const openNodeSql = vi.fn(() => Promise.resolve());
    const showActions = vi.fn(() => Promise.resolve());
    const handlers = treeCommandHandlers({
      manager: { connectAny: () => Promise.resolve(), disconnect: () => Promise.resolve() },
      tree: { refresh: vi.fn() },
      cache: { invalidate: vi.fn() },
      openTable: () => Promise.resolve(),
      showDefinition: () => Promise.resolve(),
      clipboard: { writeText: () => Promise.resolve() },
      noTargetMessage: NO_TARGET,
      doubleClick: new DoubleClickDetector(() => now, 500),
      openNodeSql,
      showActions,
    });
    return {
      handlers,
      openNodeSql,
      showActions,
      wait: (ms: number) => {
        now += ms;
      },
    };
  }

  it('opens the SQL of a column on the second click only', async () => {
    const { handlers, openNodeSql, wait } = clicking();
    await handlers.clickNode(column);
    expect(openNodeSql).not.toHaveBeenCalled();
    wait(100);
    await handlers.clickNode(column);
    expect(openNodeSql).toHaveBeenCalledExactlyOnceWith('c1', {
      kind: 'column',
      table: { database: 'app', name: 'orders' },
      column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
    });
  });

  it('does not pair a column with the index next to it, or slow clicks', async () => {
    const { handlers, openNodeSql, wait } = clicking();
    await handlers.clickNode(column);
    wait(100);
    await handlers.clickNode(index);
    wait(900);
    await handlers.clickNode(index);
    expect(openNodeSql).not.toHaveBeenCalled();
  });

  it('opens the SQL of a trigger and of a foreign key the same way', async () => {
    const { handlers, openNodeSql } = clicking();
    const trigger: TreeNode = {
      kind: 'object',
      connectionId: 'c1',
      object: { database: 'app', kind: 'trigger', name: 'audit', table: 'orders' },
    };
    await handlers.clickNode(trigger);
    await handlers.clickNode(trigger);
    expect(openNodeSql).toHaveBeenCalledWith('c1', { kind: 'object', object: trigger.object });
  });

  it('ignores nodes without SQL and empty targets', async () => {
    const { handlers, openNodeSql } = clicking();
    for (const target of [connectionNode, tableNode, undefined, 'c1']) {
      await handlers.clickNode(target);
      await handlers.clickNode(target);
      await handlers.openNodeSql(target);
    }
    expect(openNodeSql).not.toHaveBeenCalled();
  });

  it('opens the SQL at once from the menu', async () => {
    const { handlers, openNodeSql } = clicking();
    await handlers.openNodeSql(index);
    expect(openNodeSql).toHaveBeenCalledTimes(1);
  });

  it('shows the actions of a node, and of nothing else', async () => {
    const { handlers, showActions } = clicking();
    await handlers.nodeActions(column);
    await handlers.nodeActions('c1');
    expect(showActions).toHaveBeenCalledExactlyOnceWith(column);
  });
});
