import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  etcdCommandHandlers,
  type EtcdCommandUi,
  FIND_LIMIT,
} from '../../../../src/vscode/etcd/etcd-commands';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import { redisKeyRef, type RedisKeyRef } from '../../../../src/shared/redis-key';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeEtcd } from '../../../helpers/fake-etcd';

const ref = (text: string): RedisKeyRef => redisKeyRef(new TextEncoder().encode(text));

const etcdConfig = (id: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: `etcd ${id}`,
  driver: 'etcd',
  host: 'h',
  ...extra,
});

interface Calls {
  opened: { connectionId: string; key: string }[];
  refreshed: (TreeNode | undefined)[];
  loadMore: { connectionId: string; prefix: string }[];
  resets: (string | undefined)[];
  inputs: Parameters<EtcdCommandUi['input']>[0][];
  confirmed: { message: string; detail: string | undefined; action: string }[];
  infos: string[];
  picked: RedisKeyRef[][];
}

let etcd: FakeEtcd;
let calls: Calls;
let configs: ConnectionConfig[];
let typed: string | undefined;
let confirmAnswer: boolean;
let pickedKey: RedisKeyRef | undefined;
let pickedConnection: string | undefined;

function handlers() {
  const ui: EtcdCommandUi = {
    input: (options) => {
      calls.inputs.push(options);
      return Promise.resolve(typed);
    },
    pickKey: (options) => {
      calls.picked.push([...options.keys]);
      return Promise.resolve(pickedKey);
    },
    confirm: (message, detail, action) => {
      calls.confirmed.push({ message, detail, action });
      return Promise.resolve(confirmAnswer);
    },
    pickConnection: () => Promise.resolve(pickedConnection),
    info: (message) => {
      calls.infos.push(message);
    },
  };
  return etcdCommandHandlers({
    store: {
      get: (id) => configs.find((config) => config.id === id),
      list: () => configs,
    },
    browser: {
      loadMore: (connectionId, prefix) => {
        calls.loadMore.push({ connectionId, prefix: prefix.text });
        return Promise.resolve();
      },
      reset: (connectionId) => {
        calls.resets.push(connectionId);
      },
    },
    session: () => Promise.resolve(etcd),
    tree: {
      refresh: (node) => {
        calls.refreshed.push(node);
      },
    },
    ui,
    openKey: (connectionId, key) => {
      calls.opened.push({ connectionId, key: key.text });
      return Promise.resolve();
    },
    texts: { noEtcd: 'no etcd', readOnly: 'read-only' },
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
  throw new Error('It did not fail');
}

const folderNode = (prefix: string, connectionId = 'c1'): TreeNode => ({
  kind: 'etcdFolder',
  connectionId,
  prefix: ref(prefix),
  name: prefix,
});
const keyNode = (key: string, connectionId = 'c1'): TreeNode => ({
  kind: 'etcdKey',
  connectionId,
  key: ref(key),
  name: key,
});
const connectionNode = (connectionId = 'c1'): TreeNode => ({ kind: 'connection', connectionId });

beforeEach(() => {
  etcd = new FakeEtcd();
  configs = [etcdConfig('c1')];
  typed = undefined;
  confirmAnswer = true;
  pickedKey = undefined;
  pickedConnection = undefined;
  calls = {
    opened: [],
    refreshed: [],
    loadMore: [],
    resets: [],
    inputs: [],
    confirmed: [],
    infos: [],
    picked: [],
  };
});

describe('openKey and loadMoreKeys', () => {
  it('opens the page of the clicked key', async () => {
    await handlers().openKey(keyNode('/a/b'));
    expect(calls.opened).toEqual([{ connectionId: 'c1', key: '/a/b' }]);
  });

  it('ignores a click on anything else', async () => {
    await handlers().openKey(folderNode('/a/'));
    await handlers().openKey('c1');
    await handlers().openKey(undefined);
    expect(calls.opened).toEqual([]);
  });

  it('brings the next page of a folder and redraws that folder', async () => {
    await handlers().loadMoreKeys({
      kind: 'etcdMore',
      connectionId: 'c1',
      prefix: ref('/a/'),
      loaded: 300,
    });
    expect(calls.loadMore).toEqual([{ connectionId: 'c1', prefix: '/a/' }]);
    expect(calls.refreshed).toEqual([
      expect.objectContaining({ kind: 'etcdFolder', connectionId: 'c1' }),
    ]);
  });

  it('redraws the connection when the top has more', async () => {
    await handlers().loadMoreKeys({
      kind: 'etcdMore',
      connectionId: 'c1',
      prefix: { text: '' },
      loaded: 300,
    });
    expect(calls.refreshed).toEqual([{ kind: 'connection', connectionId: 'c1' }]);
  });

  it('ignores load more from anything else', async () => {
    await handlers().loadMoreKeys(folderNode('/a/'));
    expect(calls.loadMore).toEqual([]);
  });
});

describe('findKey', () => {
  beforeEach(() => {
    for (const name of ['/app/a', '/app/b', '/other']) {
      etcd.seed(name);
    }
  });

  it('asks for the beginning of a name, lists the keys and opens the one picked', async () => {
    typed = '/app/';
    pickedKey = ref('/app/b');
    await handlers().findKey(connectionNode());
    expect(calls.picked.map((keys) => keys.map((key) => key.text))).toEqual([['/app/a', '/app/b']]);
    expect(calls.opened).toEqual([{ connectionId: 'c1', key: '/app/b' }]);
  });

  it('starts from the folder it was run on', async () => {
    typed = '/app/';
    await handlers().findKey(folderNode('/app/'));
    expect(calls.inputs[0]?.value).toBe('/app/');
  });

  it('says so when nothing starts with it', async () => {
    typed = '/nope';
    await handlers().findKey(connectionNode());
    expect(calls.infos).toHaveLength(1);
    expect(calls.infos[0]).toContain('/nope');
    expect(calls.picked).toEqual([]);
  });

  it('opens nothing when the list is dismissed, and asks nothing when the box is', async () => {
    typed = '/app/';
    await handlers().findKey(connectionNode());
    expect(calls.opened).toEqual([]);
    typed = undefined;
    const reads = etcd.calls.length;
    await handlers().findKey(connectionNode());
    expect(etcd.calls.length).toBe(reads);
  });

  it('lists at most as many keys as the limit', async () => {
    for (let index = 0; index < FIND_LIMIT + 5; index += 1) {
      etcd.seed(`/many/${String(index).padStart(4, '0')}`);
    }
    typed = '/many/';
    await handlers().findKey(connectionNode());
    expect(calls.picked[0]).toHaveLength(FIND_LIMIT);
  });

  it('picks the connection when run from the palette with several', async () => {
    configs = [etcdConfig('c1'), etcdConfig('c2')];
    typed = '/app/';
    pickedConnection = 'c2';
    await handlers().findKey(undefined);
    expect(calls.picked).toHaveLength(1);
  });

  it('uses the only etcd connection without asking, and says when there is none', async () => {
    typed = '/app/';
    pickedKey = ref('/app/a');
    await handlers().findKey(undefined);
    expect(calls.opened[0]?.connectionId).toBe('c1');
    configs = [];
    expect((await failure(handlers().findKey(undefined))).message).toBe('no etcd');
  });

  it('refuses a connection that is not etcd', async () => {
    configs = [{ id: 'sql', name: 'sql', driver: 'mysql', host: 'h' }];
    expect((await failure(handlers().findKey('sql'))).code).toBe('unsupported');
  });

  it('lets the palette pick nothing', async () => {
    configs = [etcdConfig('c1'), etcdConfig('c2')];
    pickedConnection = undefined;
    typed = '/app/';
    await handlers().findKey(undefined);
    expect(calls.picked).toEqual([]);
  });
});

describe('newKey', () => {
  it('asks for a name, makes the key empty and opens its page', async () => {
    typed = '/cfg/new';
    await handlers().newKey(connectionNode());
    expect(etcd.valueOf('/cfg/new')).toBe('');
    expect(calls.opened).toEqual([{ connectionId: 'c1', key: '/cfg/new' }]);
    expect(calls.resets).toEqual(['c1']);
    expect(calls.refreshed).toHaveLength(1);
  });

  it('starts the name with the folder it was run on', async () => {
    typed = '/cfg/new';
    await handlers().newKey(folderNode('/cfg/'));
    expect(calls.inputs[0]?.value).toBe('/cfg/');
  });

  it('refuses an empty name in the box', async () => {
    typed = '/x';
    await handlers().newKey(connectionNode());
    expect(calls.inputs[0]?.validate?.('')).toBeDefined();
    expect(calls.inputs[0]?.validate?.('a')).toBeUndefined();
  });

  it('makes nothing when the box is dismissed or left empty', async () => {
    typed = undefined;
    await handlers().newKey(connectionNode());
    typed = '';
    await handlers().newKey(connectionNode());
    expect(etcd.size).toBe(0);
    expect(calls.opened).toEqual([]);
  });

  it('refuses a name that is taken and leaves the value alone', async () => {
    etcd.seed('/cfg/new', 'keep');
    typed = '/cfg/new';
    const error = await failure(handlers().newKey(connectionNode()));
    expect(error.code).toBe('constraint');
    expect(etcd.valueOf('/cfg/new')).toBe('keep');
    expect(calls.opened).toEqual([]);
  });

  it('refuses a read-only connection before asking anything', async () => {
    configs = [etcdConfig('c1', { readOnly: true })];
    typed = '/x';
    const error = await failure(handlers().newKey(connectionNode()));
    expect(error.code).toBe('permission-denied');
    expect(calls.inputs).toEqual([]);
    expect(etcd.size).toBe(0);
  });

  it('makes a key whose name has characters that are not ASCII', async () => {
    typed = '/ключ/значение';
    await handlers().newKey(connectionNode());
    expect(etcd.keyNames()).toEqual(['/ключ/значение']);
  });
});

describe('deleteKeys', () => {
  beforeEach(() => {
    for (const name of ['/d/a', '/d/b', '/d/sub/c', '/keep/x']) {
      etcd.seed(name);
    }
  });

  it('deletes a key after saying which', async () => {
    await handlers().deleteKeys(keyNode('/d/a'));
    expect(calls.confirmed[0]?.message).toContain('/d/a');
    expect(etcd.keyNames().sort()).toEqual(['/d/b', '/d/sub/c', '/keep/x']);
    expect(calls.resets).toEqual(['c1']);
    expect(calls.refreshed).toHaveLength(1);
  });

  it('deletes everything under a folder after saying how many keys that is', async () => {
    await handlers().deleteKeys(folderNode('/d/'));
    expect(calls.confirmed[0]?.message).toContain('3');
    expect(calls.confirmed[0]?.detail).toContain('/d/');
    expect(etcd.keyNames()).toEqual(['/keep/x']);
  });

  it('deletes nothing when the user says no', async () => {
    confirmAnswer = false;
    await handlers().deleteKeys(folderNode('/d/'));
    expect(etcd.size).toBe(4);
    expect(calls.resets).toEqual([]);
  });

  it('deletes the selected keys together and counts them all', async () => {
    const a = keyNode('/d/a');
    const b = keyNode('/d/b');
    await handlers().deleteKeys(a, [a, b]);
    expect(calls.confirmed[0]?.message).toContain('2');
    expect(etcd.keyNames().sort()).toEqual(['/d/sub/c', '/keep/x']);
  });

  it('deletes only the clicked one when it is not among the selected', async () => {
    const a = keyNode('/d/a');
    await handlers().deleteKeys(a, [keyNode('/d/b')]);
    expect(etcd.keyNames().sort()).toEqual(['/d/b', '/d/sub/c', '/keep/x']);
  });

  it('leaves out selected nodes of another connection', async () => {
    const a = keyNode('/d/a');
    await handlers().deleteKeys(a, [a, keyNode('/d/b', 'c2')]);
    expect(etcd.keyNames().sort()).toEqual(['/d/b', '/d/sub/c', '/keep/x']);
  });

  it('mentions production in the question', async () => {
    configs = [etcdConfig('c1', { production: true })];
    await handlers().deleteKeys(keyNode('/d/a'));
    expect(calls.confirmed[0]?.detail).toContain('production');
  });

  it('refuses a read-only connection and deletes nothing', async () => {
    configs = [etcdConfig('c1', { readOnly: true })];
    expect((await failure(handlers().deleteKeys(keyNode('/d/a')))).code).toBe('permission-denied');
    expect(etcd.size).toBe(4);
    expect(calls.confirmed).toEqual([]);
  });

  it('says there is nothing to delete for a folder that has gone empty', async () => {
    await handlers().deleteKeys(folderNode('/gone/'));
    expect(calls.infos).toHaveLength(1);
    expect(calls.confirmed).toEqual([]);
    expect(calls.resets).toEqual(['c1']);
  });

  it('ignores a node that is not a key or a folder', async () => {
    await handlers().deleteKeys(connectionNode());
    await handlers().deleteKeys(undefined);
    expect(calls.confirmed).toEqual([]);
    expect(etcd.size).toBe(4);
  });

  it('deletes a folder and a key together', async () => {
    const folder = folderNode('/d/sub/');
    const key = keyNode('/d/a');
    await handlers().deleteKeys(key, [key, folder]);
    expect(etcd.keyNames().sort()).toEqual(['/d/b', '/keep/x']);
  });
});
