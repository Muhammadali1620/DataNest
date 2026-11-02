import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { ZookeeperCreateMode } from '../../../../src/drivers/zookeeper-driver';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import {
  zookeeperCommandHandlers,
  type ZookeeperCommandUi,
} from '../../../../src/vscode/zookeeper/zookeeper-commands';
import { FakeZookeeperSession, MemoryTree } from '../../../helpers/fake-zookeeper-driver';

const zkConfig = (id: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: `zk ${id}`,
  driver: 'zookeeper',
  host: 'h',
  ...extra,
});

interface Calls {
  opened: { connectionId: string; path: string }[];
  refreshed: (TreeNode | undefined)[];
  loadMore: { connectionId: string; path: string }[];
  resets: (string | undefined)[];
  inputs: Parameters<ZookeeperCommandUi['input']>[0][];
  confirmed: { message: string; detail: string | undefined; action: string }[];
  infos: string[];
}

let tree: MemoryTree;
let session: FakeZookeeperSession;
let calls: Calls;
let configs: ConnectionConfig[];
let typed: string | undefined;
let mode: ZookeeperCreateMode | undefined;
let confirmAnswer: boolean;
let pickedConnection: string | undefined;

function handlers() {
  const ui: ZookeeperCommandUi = {
    input: (options) => {
      calls.inputs.push(options);
      return Promise.resolve(typed);
    },
    pickMode: () => Promise.resolve(mode),
    confirm: (message, detail, action) => {
      calls.confirmed.push({ message, detail, action });
      return Promise.resolve(confirmAnswer);
    },
    pickConnection: () => Promise.resolve(pickedConnection),
    info: (message) => {
      calls.infos.push(message);
    },
  };
  return zookeeperCommandHandlers({
    store: {
      get: (id) => configs.find((config) => config.id === id),
      list: () => configs,
    },
    browser: {
      loadMore: (connectionId, path) => {
        calls.loadMore.push({ connectionId, path });
        return Promise.resolve();
      },
      reset: (connectionId) => {
        calls.resets.push(connectionId);
      },
    },
    session: () => Promise.resolve(session),
    tree: {
      refresh: (node) => {
        calls.refreshed.push(node);
      },
    },
    ui,
    openNode: (connectionId, path) => {
      calls.opened.push({ connectionId, path });
      return Promise.resolve();
    },
    texts: { noZookeeper: 'no zookeeper', readOnly: 'read-only' },
  });
}

async function failure(promise: unknown): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error('The command did not fail');
}

const node = (path: string, connectionId = 'c1'): TreeNode => ({
  kind: 'zookeeperNode',
  connectionId,
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
});

beforeEach(() => {
  tree = new MemoryTree();
  session = new FakeZookeeperSession(tree);
  calls = {
    opened: [],
    refreshed: [],
    loadMore: [],
    resets: [],
    inputs: [],
    confirmed: [],
    infos: [],
  };
  configs = [zkConfig('c1')];
  typed = undefined;
  mode = 'persistent';
  confirmAnswer = true;
  pickedConnection = undefined;
  tree.put('/app/a');
  tree.put('/app/b/deep');
});

describe('loadMoreNodes', () => {
  it('brings the next page and redraws the znode it belongs to', async () => {
    const more: TreeNode = {
      kind: 'zookeeperMore',
      connectionId: 'c1',
      path: '/app',
      loaded: 300,
      total: 900,
    };
    await handlers().loadMoreNodes(more);
    expect(calls.loadMore).toEqual([{ connectionId: 'c1', path: '/app' }]);
    expect(calls.refreshed).toEqual([node('/app')]);
  });

  it('redraws the connection for the top', async () => {
    await handlers().loadMoreNodes({
      kind: 'zookeeperMore',
      connectionId: 'c1',
      path: '/',
      loaded: 1,
      total: 2,
    });
    expect(calls.refreshed).toEqual([{ kind: 'connection', connectionId: 'c1' }]);
  });

  it('ignores anything else', async () => {
    await handlers().loadMoreNodes(node('/app'));
    await handlers().loadMoreNodes(undefined);
    expect(calls.loadMore).toEqual([]);
  });
});

describe('openNode', () => {
  it('opens the page of a znode', async () => {
    await handlers().openNode(node('/app/a'));
    expect(calls.opened).toEqual([{ connectionId: 'c1', path: '/app/a' }]);
  });

  it('ignores anything else', async () => {
    await handlers().openNode({ kind: 'connection', connectionId: 'c1' });
    expect(calls.opened).toEqual([]);
  });
});

describe('goToNode', () => {
  it('opens the znode whose whole path was typed', async () => {
    typed = '/app/b';
    await handlers().goToNode({ kind: 'connection', connectionId: 'c1' });
    expect(calls.opened).toEqual([{ connectionId: 'c1', path: '/app/b' }]);
  });

  it('cuts a trailing slash', async () => {
    typed = '/app/b/';
    await handlers().goToNode({ kind: 'connection', connectionId: 'c1' });
    expect(calls.opened).toEqual([{ connectionId: 'c1', path: '/app/b' }]);
  });

  it('starts the question from the znode it was run on', async () => {
    typed = undefined;
    await handlers().goToNode(node('/app'));
    expect(calls.inputs[0]?.value).toBe('/app/');
    await handlers().goToNode({ kind: 'connection', connectionId: 'c1' });
    expect(calls.inputs[1]?.value).toBe('/');
  });

  it('checks what is typed as it is typed', async () => {
    await handlers().goToNode({ kind: 'connection', connectionId: 'c1' });
    const validate = calls.inputs[0]?.validate;
    expect(validate?.('/ok/path')).toBeUndefined();
    expect(validate?.('no-slash')).toBeDefined();
    expect(validate?.('/a//b')).toBeDefined();
  });

  it('says so when there is no such znode', async () => {
    typed = '/missing';
    await handlers().goToNode({ kind: 'connection', connectionId: 'c1' });
    expect(calls.opened).toEqual([]);
    expect(calls.infos).toHaveLength(1);
    expect(calls.infos[0]).toContain('/missing');
  });

  it('does nothing when the user backs out', async () => {
    typed = undefined;
    await handlers().goToNode({ kind: 'connection', connectionId: 'c1' });
    expect(calls.opened).toEqual([]);
    expect(calls.infos).toEqual([]);
  });
});

describe('the connection of a command', () => {
  it('is the only ZooKeeper connection when the command comes from the palette', async () => {
    configs = [zkConfig('c1'), { id: 'm', name: 'db', driver: 'mysql', host: 'h' }];
    typed = '/app';
    await handlers().goToNode(undefined);
    expect(calls.opened).toEqual([{ connectionId: 'c1', path: '/app' }]);
  });

  it('is asked for when there are several', async () => {
    configs = [zkConfig('c1'), zkConfig('c2')];
    pickedConnection = 'c2';
    typed = '/app';
    await handlers().goToNode(undefined);
    expect(calls.opened).toEqual([{ connectionId: 'c2', path: '/app' }]);
    pickedConnection = undefined;
    await handlers().goToNode(undefined);
    expect(calls.opened).toHaveLength(1);
  });

  it('is refused when there is none, or when the clicked one is not ZooKeeper', async () => {
    configs = [{ id: 'm', name: 'db', driver: 'mysql', host: 'h' }];
    expect((await failure(handlers().goToNode(undefined))).code).toBe('not-found');
    expect(
      (await failure(handlers().goToNode({ kind: 'connection', connectionId: 'm' }))).code,
    ).toBe('unsupported');
  });
});

describe('newNode', () => {
  it('makes a child below the clicked znode and opens it', async () => {
    typed = 'fresh';
    await handlers().newNode(node('/app'));
    expect(tree.nodes.has('/app/fresh')).toBe(true);
    expect(calls.opened).toEqual([{ connectionId: 'c1', path: '/app/fresh' }]);
    expect(calls.resets).toEqual(['c1']);
    expect(calls.refreshed).toHaveLength(1);
  });

  it('makes a child of the root from the connection', async () => {
    typed = 'top';
    await handlers().newNode({ kind: 'connection', connectionId: 'c1' });
    expect(tree.nodes.has('/top')).toBe(true);
  });

  it('opens the path a sequential znode got', async () => {
    typed = 'job-';
    mode = 'sequential';
    await handlers().newNode(node('/app'));
    expect(calls.opened).toEqual([{ connectionId: 'c1', path: '/app/job-0000000000' }]);
  });

  it('checks the name as it is typed', async () => {
    typed = undefined;
    await handlers().newNode(node('/app'));
    const validate = calls.inputs[0]?.validate;
    expect(validate?.('ok')).toBeUndefined();
    expect(validate?.('')).toBeDefined();
    expect(validate?.('a/b')).toBeDefined();
  });

  it('does nothing when the user backs out of the name or of the way it lives', async () => {
    typed = undefined;
    await handlers().newNode(node('/app'));
    typed = 'x';
    mode = undefined;
    await handlers().newNode(node('/app'));
    expect(tree.nodes.has('/app/x')).toBe(false);
    expect(calls.opened).toEqual([]);
  });

  it('refuses a name that is taken', async () => {
    typed = 'a';
    expect((await failure(handlers().newNode(node('/app')))).code).toBe('constraint');
    expect(calls.opened).toEqual([]);
  });

  it('refuses on a read-only connection before it asks anything', async () => {
    configs = [zkConfig('c1', { readOnly: true })];
    expect((await failure(handlers().newNode(node('/app')))).code).toBe('permission-denied');
    expect(calls.inputs).toEqual([]);
  });

  it('asks first on a production connection', async () => {
    configs = [zkConfig('c1', { production: true })];
    typed = 'p';
    confirmAnswer = false;
    await handlers().newNode(node('/app'));
    expect(calls.confirmed).toHaveLength(1);
    expect(calls.confirmed[0]?.message).toContain('/app/p');
    expect(tree.nodes.has('/app/p')).toBe(false);
    confirmAnswer = true;
    await handlers().newNode(node('/app'));
    expect(tree.nodes.has('/app/p')).toBe(true);
  });
});

describe('deleteNodes', () => {
  it('deletes the clicked znode with everything below it, after saying how many', async () => {
    await handlers().deleteNodes(node('/app/b'));
    expect(calls.confirmed).toHaveLength(1);
    expect(calls.confirmed[0]?.message).toContain('/app/b');
    expect(calls.confirmed[0]?.detail).toContain('2');
    expect(tree.nodes.has('/app/b')).toBe(false);
    expect(tree.nodes.has('/app/b/deep')).toBe(false);
    expect(tree.nodes.has('/app/a')).toBe(true);
    expect(calls.resets).toEqual(['c1']);
  });

  it('says nothing about the count for a znode alone', async () => {
    await handlers().deleteNodes(node('/app/a'));
    expect(calls.confirmed[0]?.detail).toBeUndefined();
    expect(tree.nodes.has('/app/a')).toBe(false);
  });

  it('deletes every selected znode of the connection when the clicked one is among them', async () => {
    const clicked = node('/app/a');
    await handlers().deleteNodes(clicked, [clicked, node('/app/b'), node('/x', 'c9')]);
    expect(calls.confirmed[0]?.message).toContain('2');
    expect(tree.nodes.has('/app/a')).toBe(false);
    expect(tree.nodes.has('/app/b')).toBe(false);
  });

  it('deletes only the clicked one when it is not in the selection', async () => {
    await handlers().deleteNodes(node('/app/a'), [node('/app/b')]);
    expect(tree.nodes.has('/app/a')).toBe(false);
    expect(tree.nodes.has('/app/b')).toBe(true);
  });

  it('never deletes the root', async () => {
    await handlers().deleteNodes({
      kind: 'zookeeperNode',
      connectionId: 'c1',
      path: '/',
      name: '/',
    });
    expect(calls.confirmed).toEqual([]);
  });

  it('leaves everything when the user says no', async () => {
    confirmAnswer = false;
    await handlers().deleteNodes(node('/app/b'));
    expect(tree.nodes.has('/app/b')).toBe(true);
    expect(calls.resets).toEqual([]);
  });

  it('names a production connection in the question', async () => {
    configs = [zkConfig('c1', { production: true })];
    await handlers().deleteNodes(node('/app/a'));
    expect(calls.confirmed[0]?.detail).toContain('production');
  });

  it('refuses on a read-only connection before it asks anything', async () => {
    configs = [zkConfig('c1', { readOnly: true })];
    expect((await failure(handlers().deleteNodes(node('/app/a')))).code).toBe('permission-denied');
    expect(calls.confirmed).toEqual([]);
  });

  it('ignores a node that is not a znode', async () => {
    await handlers().deleteNodes({ kind: 'connection', connectionId: 'c1' });
    await handlers().deleteNodes(undefined);
    expect(calls.confirmed).toEqual([]);
  });
});
