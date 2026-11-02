// ZooKeeper nodes in the tree (V13.24): their ids and names, their place among the other
// nodes, the context values that pick their menus, how the tree model lists them, and how
// they look.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../../../../src/services/connection-manager';
import { ConnectionStore } from '../../../../src/services/connection-store';
import { MetadataCache } from '../../../../src/services/metadata-cache';
import { ZookeeperNodeBrowser } from '../../../../src/services/zookeeper/node-browser';
import {
  connectionContext,
  connectionIdOf,
  isTreeNode,
  nameOf,
  nodeId,
  objectRefOf,
  scopeOf,
  TREE_CONTEXT,
  type TreeNode,
} from '../../../../src/vscode/tree/nodes';
import { refOf } from '../../../../src/vscode/tree/favorites';
import { TreeModel, type TreeTexts } from '../../../../src/vscode/tree/tree-model';
import {
  zookeeperIcon,
  zookeeperMoreItem,
  zookeeperNodeItem,
} from '../../../../src/vscode/tree/zookeeper-items';
import { FakeDriverProvider } from '../../../helpers/fake-driver';
import { FakeZookeeperDriver, MemoryTree } from '../../../helpers/fake-zookeeper-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../../helpers/fakes';
import { must } from '../../../helpers/must';
import * as stub from '../../../helpers/vscode-stub';

vi.mock('vscode', () => import('../../../helpers/vscode-stub'));

const icon = (value: unknown): stub.ThemeIcon => value as stub.ThemeIcon;

const TEXTS: TreeTexts = {
  emptyFolder: 'Drag here',
  tables: 'Tables',
  views: 'Views',
  noTables: 'No tables',
  noViews: 'No views',
  noDatabases: 'No databases',
  noColumns: 'No columns',
  noZookeeperNodes: 'No znodes',
  empty: {
    functions: 'No functions',
    procedures: 'No procedures',
    sequences: 'No sequences',
    events: 'No events',
    indexes: 'No indexes',
    foreignKeys: 'No foreign keys',
    triggers: 'No triggers',
  },
};

describe('ZooKeeper nodes', () => {
  const node: TreeNode = {
    kind: 'zookeeperNode',
    connectionId: 'c1',
    path: '/app/db',
    name: 'db',
    numChildren: 2,
  };
  const more: TreeNode = {
    kind: 'zookeeperMore',
    connectionId: 'c1',
    path: '/app',
    loaded: 300,
    total: 900,
  };

  it('has an id of its own for every znode, and one for "load more"', () => {
    const other: TreeNode = { ...node, path: '/app/db2' };
    const ids = [node, other, more, { ...more, path: '/x' }].map(nodeId);
    expect(new Set(ids).size).toBe(4);
    expect(nodeId({ ...node, connectionId: 'c2' })).not.toBe(nodeId(node));
  });

  it('copies the whole path of a znode', () => {
    expect(nameOf(node)).toBe('/app/db');
    expect(nameOf(more)).toBeUndefined();
  });

  it('belongs to its connection, without a SQL scope or definition', () => {
    for (const one of [node, more]) {
      expect(isTreeNode(one)).toBe(true);
      expect(connectionIdOf(one)).toBe('c1');
      expect(scopeOf(one)).toEqual({});
      expect(objectRefOf(one)).toBeUndefined();
    }
  });

  it('cannot be starred yet: only their connection can', () => {
    expect(refOf(node)).toBeUndefined();
    expect(refOf(more)).toBeUndefined();
    expect(refOf({ kind: 'connection', connectionId: 'c1' })).toEqual({
      kind: 'connection',
      connectionId: 'c1',
    });
  });

  it('marks ZooKeeper connections apart from every other family', () => {
    expect(connectionContext({ project: false, connected: true, family: 'zookeeper' })).toBe(
      TREE_CONTEXT.zookeeperConnectionConnected,
    );
    expect(connectionContext({ project: false, connected: false, family: 'zookeeper' })).toBe(
      TREE_CONTEXT.zookeeperConnection,
    );
    expect(connectionContext({ project: true, connected: true, family: 'zookeeper' })).toBe(
      TREE_CONTEXT.projectZookeeperConnectionConnected,
    );
    expect(connectionContext({ project: true, connected: false, family: 'zookeeper' })).toBe(
      TREE_CONTEXT.projectZookeeperConnection,
    );
    const contexts = [false, true].flatMap((project) =>
      [false, true].flatMap((connected) =>
        (['sql', 'redis', 'mongodb', 'elasticsearch', 'etcd', 'kafka', 'zookeeper'] as const).map(
          (family) => connectionContext({ project, connected, family }),
        ),
      ),
    );
    expect(new Set(contexts).size).toBe(28);
  });
});

describe('TreeModel with ZooKeeper (V13.24)', () => {
  let tree: MemoryTree;

  async function setup(size = 300) {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const driver = new FakeZookeeperDriver(tree);
    const drivers = Object.assign(new FakeDriverProvider(), {
      getZookeeper: () => Promise.resolve(driver),
    });
    const manager = new ConnectionManager({ store, drivers, logger });
    const zookeeperNodes = new ZookeeperNodeBrowser({
      manager,
      settings: { childrenPerLoad: () => size },
      logger,
    });
    const model = new TreeModel({
      store,
      manager,
      cache: new MetadataCache({ logger }),
      zookeeperNodes,
      settings: { showSystemObjects: () => false },
      logger,
      texts: TEXTS,
    });
    const config = await store.add({ name: 'Ensemble', driver: 'zookeeper', host: 'h' });
    const connection: TreeNode = { kind: 'connection', connectionId: config.id };
    return { model, config, connection, zookeeperNodes };
  }

  beforeEach(() => {
    tree = new MemoryTree();
    tree.put('/app/db/host');
    tree.put('/app/db/port');
    tree.put('/app/name');
    tree.put('/eph', 'x', '72057594037927937');
    tree.put('/other');
  });

  const names = (nodes: readonly TreeNode[]): string[] =>
    nodes.map((one) => (one.kind === 'zookeeperNode' ? one.name : one.kind));

  it('lists the top znodes under the connection', async () => {
    const { model, connection } = await setup();
    const top = await model.children(connection);
    expect(names(top)).toEqual(['app', 'eph', 'other']);
    expect(top[0]).toMatchObject({
      kind: 'zookeeperNode',
      path: '/app',
      numChildren: 2,
      znodeKind: 'persistent',
    });
    expect(top[1]).toMatchObject({ znodeKind: 'ephemeral', numChildren: 0 });
  });

  it('opens a znode one level at a time', async () => {
    const { model, connection } = await setup();
    const [app] = await model.children(connection);
    const level = await model.children(must(app));
    expect(names(level)).toEqual(['db', 'name']);
    expect(level[0]).toMatchObject({ path: '/app/db', numChildren: 2 });
    expect(names(await model.children(must(level[0])))).toEqual(['host', 'port']);
  });

  it('ends a long list with "load more" until the last page is read', async () => {
    const { model, connection, zookeeperNodes } = await setup(2);
    const first = await model.children(connection);
    expect(first).toHaveLength(3);
    expect(first.at(-1)).toMatchObject({ kind: 'zookeeperMore', path: '/', loaded: 2, total: 3 });
    await zookeeperNodes.loadMore(connection.connectionId, '/');
    const all = await model.children(connection);
    expect(all).toHaveLength(3);
    expect(all.some((one) => one.kind === 'zookeeperMore')).toBe(false);
  });

  it('says an ensemble without znodes has none', async () => {
    tree = new MemoryTree();
    const { model, connection } = await setup();
    expect(await model.children(connection)).toEqual([
      { kind: 'message', text: 'No znodes', connectionId: connection.connectionId },
    ]);
  });

  it('shows a znode without children as an empty list, not a message', async () => {
    const { model, connection } = await setup();
    const top = await model.children(connection);
    expect(await model.children(must(top[2]))).toEqual([]);
  });

  it('finds the parent of a znode and of "load more", for revealing', async () => {
    const { model, connection } = await setup();
    const [app] = await model.children(connection);
    const [db] = await model.children(must(app));
    expect(model.parentOf(must(db))).toMatchObject({ kind: 'zookeeperNode', path: '/app' });
    expect(model.parentOf(must(app))).toEqual({
      kind: 'connection',
      connectionId: connection.connectionId,
    });
    expect(
      model.parentOf({
        kind: 'zookeeperMore',
        connectionId: connection.connectionId,
        path: '/app',
        loaded: 1,
        total: 2,
      }),
    ).toMatchObject({ kind: 'zookeeperNode', path: '/app', name: 'app' });
    expect(
      model.parentOf({
        kind: 'zookeeperMore',
        connectionId: connection.connectionId,
        path: '/',
        loaded: 1,
        total: 2,
      }),
    ).toEqual({ kind: 'connection', connectionId: connection.connectionId });
  });

  it('has nothing under "load more"', async () => {
    const { model, connection } = await setup();
    expect(
      await model.children({
        kind: 'zookeeperMore',
        connectionId: connection.connectionId,
        path: '/',
        loaded: 1,
        total: 2,
      }),
    ).toEqual([]);
  });
});

describe('zookeeperNodeItem', () => {
  const node = {
    kind: 'zookeeperNode',
    connectionId: 'c1',
    path: '/app/db',
    name: 'db',
    numChildren: 1234,
    znodeKind: 'persistent',
  } as const;

  it('is a collapsed blue folder with the number of children, and opens its page on a click', () => {
    const item = zookeeperNodeItem(node);
    expect(item.label).toBe('db');
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.Collapsed);
    expect(item.id).toBe(nodeId(node));
    expect(item.contextValue).toBe(TREE_CONTEXT.zookeeperNode);
    expect(icon(item.iconPath).id).toBe('folder');
    expect(icon(item.iconPath).color?.id).toBe('charts.blue');
    expect(item.description).toBe('1,234');
    expect(item.tooltip).toBe('/app/db\n1,234 children');
    expect(item.command).toMatchObject({
      command: 'datanest.zookeeper.openNode',
      arguments: [node],
    });
  });

  it('is a yellow file and a leaf when it is known to have no children', () => {
    const item = zookeeperNodeItem({ ...node, numChildren: 0 });
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.None);
    expect(icon(item.iconPath).id).toBe('symbol-file');
    expect(icon(item.iconPath).color?.id).toBe('charts.yellow');
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBe('/app/db');
  });

  it('can be expanded while the number of children is not known', () => {
    const { numChildren: _unknown, ...bare } = node;
    expect(zookeeperNodeItem(bare).collapsibleState).toBe(stub.TreeItemCollapsibleState.Collapsed);
  });

  it('calls the top by its slash', () => {
    expect(zookeeperNodeItem({ ...node, path: '/', name: '/' }).label).toBe('/');
  });

  it('shows by colour what kind of znode it is', () => {
    expect(icon(zookeeperNodeItem({ ...node, znodeKind: 'ephemeral' }).iconPath)).toMatchObject({
      id: 'watch',
    });
    expect(zookeeperNodeItem({ ...node, znodeKind: 'ephemeral' }).tooltip).toContain('Ephemeral');
    expect(zookeeperNodeItem({ ...node, znodeKind: 'ttl' }).tooltip).toContain('time to live');
    expect(icon(zookeeperNodeItem({ ...node, znodeKind: 'container' }).iconPath).id).toBe(
      'package',
    );
    expect(zookeeperNodeItem({ ...node, znodeKind: 'container' }).tooltip).toContain('Container');
  });

  it('marks a sequential znode by its counter', () => {
    const item = zookeeperNodeItem({ ...node, name: 'job-0000000007', numChildren: 0 });
    expect(icon(item.iconPath).id).toBe('list-ordered');
    expect(item.tooltip).toContain('Sequential');
  });

  it('shows a znode the ACL hides as locked, and not expandable', () => {
    const item = zookeeperNodeItem({ ...node, denied: true });
    expect(icon(item.iconPath).id).toBe('lock');
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.None);
    expect(item.tooltip).toContain('ACL');
  });
});

describe('zookeeperIcon', () => {
  it('picks the icon by kind, sequence and children', () => {
    expect(zookeeperIcon('persistent', true, false).id).toBe('folder');
    expect(zookeeperIcon(undefined, false, false).id).toBe('symbol-file');
    expect(zookeeperIcon('ttl', false, false).id).toBe('history');
    expect(zookeeperIcon('persistent', false, true).id).toBe('list-ordered');
  });
});

describe('zookeeperMoreItem', () => {
  const node = {
    kind: 'zookeeperMore',
    connectionId: 'c1',
    path: '/app',
    loaded: 300,
    total: 1500,
  } as const;

  it('is a leaf that brings the next page on a click', () => {
    const item = zookeeperMoreItem(node);
    expect(item.label).toBe('Load more znodes…');
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.None);
    expect(item.description).toBe('300 of 1,500 loaded');
    expect(item.contextValue).toBe(TREE_CONTEXT.zookeeperMore);
    expect(item.id).toBe(nodeId(node));
    expect(icon(item.iconPath).id).toBe('ellipsis');
    expect(item.command).toMatchObject({
      command: 'datanest.zookeeper.loadMoreNodes',
      arguments: [node],
    });
  });
});
