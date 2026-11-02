import { describe, expect, it } from 'vitest';
import {
  FAVORITABLE_CONTEXTS,
  FAVORITES_STATE_KEY,
  type FavoriteNode,
  FavoritesStore,
  MAX_FAVORITES,
  STARRED_SUFFIX,
  favoriteNodeId,
  isFavoriteNode,
  nodeOfRef,
  parseRef,
  refKey,
  refOf,
  starredContext,
  unwrapFavorite,
} from '../../../../src/vscode/tree/favorites';
import { type TreeNode, TREE_CONTEXT, nodeId } from '../../../../src/vscode/tree/nodes';
import { FakeMemento } from '../../../helpers/fakes';
import { must } from '../../../helpers/must';

const table: TreeNode = {
  kind: 'table',
  connectionId: 'c1',
  scope: { database: 'shop', schema: 'public' },
  name: 'orders',
  tableKind: 'table',
  stats: { rows: 10 },
} as TreeNode;

const NODES: TreeNode[] = [
  { kind: 'connection', connectionId: 'c1' },
  { kind: 'database', connectionId: 'c1', database: 'shop' },
  { kind: 'schema', connectionId: 'c1', database: 'shop', schema: 'public' },
  { kind: 'schema', connectionId: 'c1', schema: 'main' },
  table,
  {
    kind: 'table',
    connectionId: 'c1',
    scope: {},
    name: 'v',
    tableKind: 'view',
    materialized: true,
  },
  { kind: 'redisDatabase', connectionId: 'r', database: 3, keys: 99 },
  { kind: 'mongoDatabase', connectionId: 'm', database: 'app', sizeOnDisk: 5 },
  {
    kind: 'mongoCollection',
    connectionId: 'm',
    database: 'app',
    collection: 'users',
    collectionType: 'view',
    viewOn: 'x',
  },
  {
    kind: 'elasticIndex',
    connectionId: 'e',
    index: { name: 'logs', status: 'close', hidden: true, docs: '5' },
  },
  { kind: 'kafkaTopic', connectionId: 'k', topic: 'orders', internal: false },
  { kind: 'kafkaGroup', connectionId: 'k', group: 'billing', state: 'Stable', members: 3 },
];

function node(index: number): TreeNode {
  const found = NODES[index];
  if (found === undefined) {
    throw new Error(`no node ${index}`);
  }
  return found;
}

describe('refOf and nodeOfRef', () => {
  it('describes every kind of node that may be starred and builds the same node back', () => {
    for (const node of NODES) {
      const ref = refOf(node);
      expect(ref, node.kind).toBeDefined();
      if (ref === undefined) {
        continue;
      }
      expect(nodeId(nodeOfRef(ref))).toBe(nodeId(node));
      expect(refKey(ref)).toBe(nodeId(node));
    }
  });

  it('leaves out what goes stale: sizes, counts, stats', () => {
    const json = JSON.stringify(NODES.map(refOf));
    expect(json).not.toMatch(/stats|sizeOnDisk|viewOn|docs|hidden|keys/u);
  });

  it('knows nothing of nodes that cannot be starred', () => {
    const others: TreeNode[] = [
      { kind: 'message', text: 'x' },
      { kind: 'group', group: 'tables', connectionId: 'c1', scope: {} },
      {
        kind: 'redisKey',
        connectionId: 'r',
        database: 0,
        key: { text: 'k', bytes: [] } as never,
        name: 'k',
      },
      { kind: 'connectionFolder', folder: 'F' },
    ];
    for (const node of others) {
      expect(refOf(node), node.kind).toBeUndefined();
    }
  });
});

describe('Kafka favorites (V13.29)', () => {
  it('keeps only the name of a topic or group, and builds a node that has the same id', () => {
    const topic = refOf(node(NODES.length - 2));
    const group = refOf(node(NODES.length - 1));
    expect(topic).toEqual({ kind: 'kafkaTopic', connectionId: 'k', name: 'orders' });
    expect(group).toEqual({ kind: 'kafkaGroup', connectionId: 'k', name: 'billing' });
    expect(nodeOfRef(must(group))).toMatchObject({ state: '', members: 0 });
  });

  it('knows a topic of the cluster by its leading underscore', () => {
    expect(
      nodeOfRef({ kind: 'kafkaTopic', connectionId: 'k', name: '__consumer_offsets' }),
    ).toMatchObject({
      internal: true,
    });
    expect(nodeOfRef({ kind: 'kafkaTopic', connectionId: 'k', name: 'orders' })).toMatchObject({
      internal: false,
    });
  });

  it('does not star a partition or a folder', () => {
    expect(refOf({ kind: 'kafkaTopics', connectionId: 'k' })).toBeUndefined();
    expect(refOf({ kind: 'kafkaGroups', connectionId: 'k' })).toBeUndefined();
  });
});

describe('parseRef', () => {
  it('reads what refOf wrote', () => {
    for (const node of NODES) {
      const ref = refOf(node);
      expect(parseRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
    }
  });

  it('rejects anything that is not a descriptor', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      42,
      [],
      {},
      { kind: 'connection' },
      { kind: 'connection', connectionId: '' },
      { kind: 'connection', connectionId: 7 },
      { kind: 'database', connectionId: 'c' },
      { kind: 'schema', connectionId: 'c', schema: 5 },
      { kind: 'schema', connectionId: 'c', schema: 's', database: 5 },
      { kind: 'table', connectionId: 'c', name: 'n', tableKind: 'procedure' },
      { kind: 'table', connectionId: 'c', tableKind: 'table' },
      { kind: 'redisDatabase', connectionId: 'c', database: 1.5 },
      { kind: 'redisDatabase', connectionId: 'c', database: '1' },
      {
        kind: 'mongoCollection',
        connectionId: 'c',
        database: 'd',
        collection: 'x',
        collectionType: 'bad',
      },
      { kind: 'elasticIndex', connectionId: 'c' },
      { kind: 'kafkaTopic', connectionId: 'c' },
      { kind: 'kafkaGroup', connectionId: 'c', name: '' },
      { kind: 'column', connectionId: 'c' },
      { kind: 'connection', connectionId: 'x'.repeat(1001) },
    ];
    for (const value of bad) {
      expect(parseRef(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('drops unknown extra fields', () => {
    expect(parseRef({ kind: 'connection', connectionId: 'c', evil: true })).toEqual({
      kind: 'connection',
      connectionId: 'c',
    });
  });
});

describe('FavoritesStore', () => {
  const make = (state = new FakeMemento()) => ({ state, store: new FavoritesStore(state) });

  it('starts empty', () => {
    expect(make().store.list()).toEqual([]);
  });

  it('stars a node and takes the star off again, in the order of starring', async () => {
    const { store } = make();
    expect(await store.toggle(node(4))).toBe(true);
    expect(await store.toggle(node(0))).toBe(true);
    expect(store.has(node(4))).toBe(true);
    expect(store.list().map((ref) => ref.kind)).toEqual(['table', 'connection']);
    expect(await store.toggle(node(4))).toBe(false);
    expect(store.has(node(4))).toBe(false);
    expect(store.list().map((ref) => ref.kind)).toEqual(['connection']);
  });

  it('finds a node by identity, whatever its volatile fields say', async () => {
    const { store } = make();
    await store.toggle(table);
    expect(store.has({ ...table, stats: undefined } as TreeNode)).toBe(true);
    expect(store.has({ kind: 'redisDatabase', connectionId: 'r', database: 3, keys: 1 })).toBe(
      false,
    );
  });

  it('refuses a node that cannot be starred, without a change', async () => {
    const { store, state } = make();
    expect(await store.toggle({ kind: 'message', text: 'x' })).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(state.data.has(FAVORITES_STATE_KEY)).toBe(false);
    expect(store.has({ kind: 'message', text: 'x' })).toBe(false);
  });

  it('survives a restart', async () => {
    const { store, state } = make();
    for (const node of NODES) {
      await store.toggle(node);
    }
    const again = new FavoritesStore(state);
    expect(again.list()).toEqual(store.list());
    expect(again.list()).toHaveLength(NODES.length);
  });

  it('ignores damaged state and keeps what is readable, without repeats', () => {
    const good = { kind: 'connection', connectionId: 'c' };
    for (const raw of [undefined, null, 'x', 5, [], {}, { items: 'no' }]) {
      const state = new FakeMemento();
      state.data.set(FAVORITES_STATE_KEY, raw);
      expect(new FavoritesStore(state).list()).toEqual([]);
    }
    const state = new FakeMemento();
    state.data.set(FAVORITES_STATE_KEY, { version: 1, items: [good, 7, { kind: 'x' }, good] });
    expect(new FavoritesStore(state).list()).toEqual([good]);
  });

  it('stops at the limit and says so, but still lets a star go', async () => {
    const state = new FakeMemento();
    const items = Array.from({ length: MAX_FAVORITES }, (_unused, index) => ({
      kind: 'connection',
      connectionId: `c${index}`,
    }));
    state.data.set(FAVORITES_STATE_KEY, { version: 1, items });
    const store = new FavoritesStore(state);
    expect(store.list()).toHaveLength(MAX_FAVORITES);
    expect(await store.toggle({ kind: 'connection', connectionId: 'one-more' })).toBeUndefined();
    expect(store.list()).toHaveLength(MAX_FAVORITES);
    expect(await store.toggle({ kind: 'connection', connectionId: 'c0' })).toBe(false);
    expect(await store.toggle({ kind: 'connection', connectionId: 'one-more' })).toBe(true);
  });

  it('drops the stars of connections that are gone, and only then tells anyone', async () => {
    const { store } = make();
    await store.toggle({ kind: 'connection', connectionId: 'a' });
    await store.toggle({ kind: 'database', connectionId: 'b', database: 'd' });
    await store.toggle({ kind: 'connection', connectionId: 'c' });
    let calls = 0;
    store.onDidChange(() => (calls += 1));
    await store.retainConnections(new Set(['a', 'b', 'c', 'zzz']));
    expect(calls).toBe(0);
    await store.retainConnections(new Set(['a', 'c']));
    expect(calls).toBe(1);
    expect(store.list().map((ref) => ref.connectionId)).toEqual(['a', 'c']);
  });

  it('tells listeners about every change and lets them go', async () => {
    const { store } = make();
    let calls = 0;
    const listener = store.onDidChange(() => (calls += 1));
    await store.toggle(node(0));
    await store.toggle(node(0));
    expect(calls).toBe(2);
    listener.dispose();
    await store.toggle(node(0));
    expect(calls).toBe(2);
  });
});

describe('entries of the Favorites group', () => {
  const entry: FavoriteNode = { kind: 'favorite', target: table, via: TREE_CONTEXT.favorites };

  it('gives commands the real node, also from a list of them', () => {
    expect(isFavoriteNode(entry)).toBe(true);
    expect(unwrapFavorite(entry)).toBe(table);
    expect(unwrapFavorite([entry, 'x', table])).toEqual([table, 'x', table]);
    expect(unwrapFavorite(table)).toBe(table);
    expect(unwrapFavorite(undefined)).toBeUndefined();
    expect(unwrapFavorite('id')).toBe('id');
  });

  it('is not fooled by look-alikes', () => {
    expect(isFavoriteNode({ kind: 'favorite' })).toBe(false);
    expect(isFavoriteNode(null)).toBe(false);
    expect(isFavoriteNode(table)).toBe(false);
  });

  it('has an id of its own, apart from the node in the ordinary tree', () => {
    expect(favoriteNodeId(entry)).not.toBe(nodeId(table));
    const child: FavoriteNode = {
      kind: 'favorite',
      target: node(3),
      via: favoriteNodeId(entry),
    };
    expect(favoriteNodeId(child)).not.toBe(favoriteNodeId({ ...child, via: 'other' }));
    expect(favoriteNodeId(child)).not.toBe(nodeId(node(3)));
  });
});

describe('the star on the context value', () => {
  it('adds the suffix once', () => {
    expect(starredContext('datanest.table')).toBe(`datanest.table${STARRED_SUFFIX}`);
    expect(starredContext(`datanest.table${STARRED_SUFFIX}`)).toBe(
      `datanest.table${STARRED_SUFFIX}`,
    );
    expect(starredContext(undefined)).toBeUndefined();
  });

  it('lists the contexts of the nodes that may be starred, without repeats', () => {
    expect(new Set(FAVORITABLE_CONTEXTS).size).toBe(FAVORITABLE_CONTEXTS.length);
    expect(FAVORITABLE_CONTEXTS).toContain(TREE_CONTEXT.table);
    expect(FAVORITABLE_CONTEXTS).toContain(TREE_CONTEXT.connectionDisabled);
    expect(FAVORITABLE_CONTEXTS).not.toContain(TREE_CONTEXT.column);
  });
});

describe('etcd nodes (V13.19)', () => {
  it('can be starred as folders and keys; the "load more" leaf cannot (V13.27)', () => {
    expect(
      refOf({ kind: 'etcdFolder', connectionId: 'c1', prefix: { text: '/a/' }, name: 'a' }),
    ).toEqual({ kind: 'etcdFolder', connectionId: 'c1', prefix: { text: '/a/' } });
    expect(refOf({ kind: 'etcdKey', connectionId: 'c1', key: { text: '/a' }, name: 'a' })).toEqual({
      kind: 'etcdKey',
      connectionId: 'c1',
      key: { text: '/a' },
    });
    expect(
      refOf({ kind: 'etcdMore', connectionId: 'c1', prefix: { text: '' }, loaded: 1 }),
    ).toBeUndefined();
    expect(refOf({ kind: 'connection', connectionId: 'c1' })).toEqual({
      kind: 'connection',
      connectionId: 'c1',
    });
  });
});

describe('etcd and ZooKeeper stars (V13.27)', () => {
  const nodes: TreeNode[] = [
    { kind: 'etcdFolder', connectionId: 'c1', prefix: { text: '/app/' }, name: 'app' },
    { kind: 'etcdKey', connectionId: 'c1', key: { text: '/app/db' }, name: 'db' },
    { kind: 'zookeeperNode', connectionId: 'c1', path: '/app/db', name: 'db' },
  ];

  it('gives a node back with the name shown in the tree, found again by id', () => {
    for (const node of nodes) {
      const ref = refOf(node);
      expect(ref).toBeDefined();
      if (ref === undefined) {
        continue;
      }
      expect(nodeOfRef(ref)).toMatchObject({ kind: node.kind });
      expect(nodeId(nodeOfRef(ref))).toBe(nodeId(node));
      expect(parseRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
    }
  });

  it('takes the name of a folder without its closing slash', () => {
    const node = nodeOfRef({ kind: 'etcdFolder', connectionId: 'c', prefix: { text: '/a/b/' } });
    expect(node).toMatchObject({ name: 'b' });
  });

  it('refuses saved data that is not a key or a path', () => {
    for (const value of [
      { kind: 'etcdKey', connectionId: 'c' },
      { kind: 'etcdKey', connectionId: 'c', key: 'x' },
      { kind: 'etcdKey', connectionId: 'c', key: { text: 1 } },
      { kind: 'etcdKey', connectionId: 'c', key: { text: 'a', hex: 'zz' } },
      { kind: 'etcdKey', connectionId: 'c', key: { text: 'a', hex: 'abc' } },
      { kind: 'etcdFolder', connectionId: 'c', prefix: null },
      { kind: 'zookeeperNode', connectionId: 'c' },
      { kind: 'zookeeperNode', connectionId: 'c', path: '/' },
      { kind: 'zookeeperNode', connectionId: 'c', path: 'app' },
      { kind: 'zookeeperNode', connectionId: 'c', path: `/${'a'.repeat(4000)}` },
    ]) {
      expect(parseRef(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('keeps the bytes of a key whose text is empty', () => {
    expect(parseRef({ kind: 'etcdKey', connectionId: 'c', key: { text: '', hex: '00' } })).toEqual({
      kind: 'etcdKey',
      connectionId: 'c',
      key: { text: '', hex: '00' },
    });
  });
});
