import { describe, expect, it, vi } from 'vitest';
import type { LoadedKey } from '../../../../src/services/redis/key-tree';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import {
  keyNodeOf,
  type RedisPlace,
  redisKeyCommandHandlers,
} from '../../../../src/vscode/redis/redis-key-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import type { NewKeyContent } from '../../../../src/services/redis/key-edits';
import type { RedisKeyRef } from '../../../../src/shared/redis-key';
import { FakeRedisSession } from '../../../helpers/fake-redis';

const CONFIGS: ConnectionConfig[] = [
  { id: 'r1', name: 'Cache', driver: 'redis', host: 'h', database: '4' },
  { id: 'r2', name: 'Queue', driver: 'redis', host: 'q' },
  { id: 's1', name: 'Shop', driver: 'mysql', host: 'db' },
];

function setup(
  options: {
    configs?: ConnectionConfig[];
    pattern?: string | undefined;
    found?: LoadedKey;
    session?: FakeRedisSession;
    confirm?: boolean;
    newKey?: { name: string; content: NewKeyContent } | undefined;
    name?: string;
  } = {},
) {
  const configs = options.configs ?? CONFIGS;
  const session = options.session ?? new FakeRedisSession(() => '1');
  const browser = {
    loadMore: vi.fn(() => Promise.resolve()),
    patternOf: vi.fn((): string | undefined => 'old*'),
    setPattern: vi.fn(),
    include: vi.fn(),
    forget: vi.fn(),
    session: vi.fn(() => Promise.resolve(session)),
  };
  const openKey = vi.fn((_place: RedisPlace, _key: RedisKeyRef) => Promise.resolve());
  const askNewKey = vi.fn((_prefix: string) => Promise.resolve(options.newKey));
  const openConsole = vi.fn((_place: RedisPlace) => undefined);
  const openServerInfo = vi.fn((_place: RedisPlace) => undefined);
  const confirm = vi.fn((_message: string, _detail: string | undefined, _action: string) =>
    Promise.resolve(options.confirm ?? true),
  );
  const refresh = vi.fn();
  const askPattern = vi.fn((_current: string | undefined) => Promise.resolve(options.pattern));
  const pickConnection = vi.fn((ids: readonly string[]) => Promise.resolve(ids[1]));
  const findKey = vi.fn((_place: RedisPlace, _initial: string) => Promise.resolve(options.found));
  const reveal = vi.fn((_place: RedisPlace, _key: LoadedKey) => Promise.resolve());
  const handlers = redisKeyCommandHandlers({
    browser,
    store: { get: (id) => configs.find((config) => config.id === id), list: () => configs },
    tree: { refresh },
    askPattern,
    pickConnection,
    findKey,
    reveal,
    noRedisMessage: 'No Redis',
    openKey,
    askNewKey,
    askName: () => Promise.resolve(options.name),
    openConsole,
    openServerInfo,
    confirm,
    texts: {
      deleteKeys: (names) => `delete ${names.join(',')}?`,
      deleteAction: 'Delete',
      productionDetail: (connection) => `${connection} is production`,
      replaceKey: (name) => `replace ${name}?`,
      replaceAction: 'Replace',
      changeAction: 'Change',
      readOnly: 'read-only',
    },
  });
  return {
    handlers,
    browser,
    refresh,
    askPattern,
    pickConnection,
    findKey,
    reveal,
    openKey,
    confirm,
    session,
    askNewKey,
    openConsole,
    openServerInfo,
  };
}

const db: TreeNode = { kind: 'redisDatabase', connectionId: 'r1', database: 2, keys: 7 };
const dbRefresh = { kind: 'redisDatabase', connectionId: 'r1', database: 2, keys: 0 };

describe('loadMoreKeys', () => {
  it('loads the next portion of the database and redraws it', async () => {
    const { handlers, browser, refresh } = setup();
    await handlers.loadMoreKeys({ kind: 'redisMore', connectionId: 'r1', database: 2, loaded: 10 });
    expect(browser.loadMore).toHaveBeenCalledWith('r1', 2);
    expect(refresh).toHaveBeenCalledWith(dbRefresh);
  });

  it('does nothing without a node', async () => {
    const { handlers, browser } = setup();
    await handlers.loadMoreKeys();
    await handlers.loadMoreKeys('r1');
    expect(browser.loadMore).not.toHaveBeenCalled();
  });
});

describe('filterKeys', () => {
  it('asks with the current pattern and applies the answer', async () => {
    const { handlers, browser, refresh, askPattern } = setup({ pattern: 'user:*' });
    await handlers.filterKeys(db);
    expect(askPattern).toHaveBeenCalledWith('old*');
    expect(browser.setPattern).toHaveBeenCalledWith('r1', 2, 'user:*');
    expect(refresh).toHaveBeenCalledWith(dbRefresh);
  });

  it('changes nothing when the user backs out', async () => {
    const { handlers, browser, refresh } = setup({ pattern: undefined });
    await handlers.filterKeys(db);
    expect(browser.setPattern).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('works on the database a connection opens', async () => {
    const { handlers, browser } = setup({ pattern: '' });
    await handlers.filterKeys({ kind: 'connection', connectionId: 'r1' });
    expect(browser.setPattern).toHaveBeenCalledWith('r1', 4, '');
    await handlers.filterKeys('r2');
    expect(browser.setPattern).toHaveBeenLastCalledWith('r2', 0, '');
  });

  it('refuses a SQL connection', async () => {
    const { handlers } = setup();
    await expect(
      handlers.filterKeys({ kind: 'connection', connectionId: 's1' }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: 'No Redis',
    });
  });
});

describe('findKey', () => {
  const found: LoadedKey = { key: { text: 'user:1' }, type: 'hash' };

  it('searches the clicked database, puts the key into the tree and reveals it', async () => {
    const { handlers, findKey, browser, reveal } = setup({ found });
    await handlers.findKey(db);
    expect(findKey).toHaveBeenCalledWith({ connectionId: 'r1', database: 2 }, '');
    expect(browser.include).toHaveBeenCalledWith('r1', 2, found);
    expect(reveal).toHaveBeenCalledWith({ connectionId: 'r1', database: 2 }, found);
  });

  it('opens the key it found', async () => {
    const { handlers, openKey } = setup({ found });
    await handlers.findKey(db);
    expect(openKey).toHaveBeenCalledWith({ connectionId: 'r1', database: 2 }, found.key);
  });

  it('starts from the prefix of a folder', async () => {
    const { handlers, findKey } = setup();
    await handlers.findKey({
      kind: 'redisFolder',
      connectionId: 'r1',
      database: 0,
      path: ['user'],
      prefix: 'user:',
      count: 1,
    });
    expect(findKey).toHaveBeenCalledWith({ connectionId: 'r1', database: 0 }, 'user:');
  });

  it('asks which Redis connection when run from the palette', async () => {
    const { handlers, pickConnection, findKey, reveal } = setup();
    await handlers.findKey();
    expect(pickConnection).toHaveBeenCalledWith(['r1', 'r2']);
    expect(findKey).toHaveBeenCalledWith({ connectionId: 'r2', database: 0 }, '');
    expect(reveal).not.toHaveBeenCalled();
  });

  it('says so when there is no Redis connection', async () => {
    const { handlers } = setup({ configs: CONFIGS.filter((config) => config.driver !== 'redis') });
    await expect(handlers.findKey()).rejects.toMatchObject({
      code: 'not-found',
      message: 'No Redis',
    });
  });

  it('does nothing when the user picks no connection, or a node of no database', async () => {
    const { handlers, findKey, pickConnection } = setup();
    pickConnection.mockResolvedValueOnce(undefined);
    await handlers.findKey();
    await handlers.findKey({ kind: 'message', text: 'x' });
    expect(findKey).not.toHaveBeenCalled();
  });
});

describe('keyNodeOf', () => {
  it('builds the node the tree shows for a key', () => {
    expect(
      keyNodeOf({ connectionId: 'r1', database: 1 }, { key: { text: 'a:b:c' }, type: 'set' }, ':'),
    ).toEqual({
      kind: 'redisKey',
      connectionId: 'r1',
      database: 1,
      key: { text: 'a:b:c' },
      name: 'c',
      keyType: 'set',
    });
    expect(
      keyNodeOf({ connectionId: 'r1', database: 1 }, { key: { text: 'a:b' } }, ''),
    ).toMatchObject({ name: 'a:b' });
  });
});

const keyNode = (text: string, connectionId = 'r1', database = 2): TreeNode => ({
  kind: 'redisKey',
  connectionId,
  database,
  key: { text },
  name: text,
  keyType: 'hash',
});

const PROD: ConnectionConfig[] = [
  { id: 'r1', name: 'Live', driver: 'redis', host: 'h', production: true },
  { id: 'ro', name: 'Mirror', driver: 'redis', host: 'h', readOnly: true },
];

describe('openKey (V7.3)', () => {
  it('opens the clicked key and ignores anything else', async () => {
    const { handlers, openKey } = setup();
    await handlers.openKey(keyNode('user:1'));
    await handlers.openKey(db);
    await handlers.openKey();
    expect(openKey).toHaveBeenCalledTimes(1);
    expect(openKey).toHaveBeenCalledWith({ connectionId: 'r1', database: 2 }, { text: 'user:1' });
  });
});

describe('newKey (V7.3)', () => {
  const content: NewKeyContent = { type: 'hash', field: { text: 'f' }, value: { text: 'v' } };

  it('creates the key, shows it in the tree and opens it', async () => {
    const { handlers, session, browser, refresh, openKey } = setup({
      newKey: { name: 'user:9', content },
    });
    await handlers.newKey(db);
    expect(session.calls[0]?.slice(3)).toEqual(['user:9', 'HSET', 'f', 'v']);
    expect(browser.include).toHaveBeenCalledWith('r1', 2, {
      key: { text: 'user:9' },
      type: 'hash',
    });
    expect(refresh).toHaveBeenCalledWith(dbRefresh);
    expect(openKey).toHaveBeenCalledWith({ connectionId: 'r1', database: 2 }, { text: 'user:9' });
  });

  it('starts the name with the prefix of the folder', async () => {
    const { handlers, askNewKey } = setup();
    await handlers.newKey({
      kind: 'redisFolder',
      connectionId: 'r1',
      database: 0,
      path: ['user'],
      prefix: 'user:',
      count: 1,
    });
    expect(askNewKey).toHaveBeenCalledWith('user:');
  });

  it('does nothing when the user backs out', async () => {
    const { handlers, session, openKey } = setup({ newKey: undefined });
    await handlers.newKey(db);
    expect(session.calls).toEqual([]);
    expect(openKey).not.toHaveBeenCalled();
  });

  it('refuses a read-only connection and asks on production', async () => {
    const readOnly = setup({ configs: PROD, newKey: { name: 'x', content } });
    await expect(readOnly.handlers.newKey('ro')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    const declined = setup({ configs: PROD, confirm: false, newKey: { name: 'x', content } });
    await declined.handlers.newKey({
      kind: 'redisDatabase',
      connectionId: 'r1',
      database: 0,
      keys: 0,
    });
    expect(declined.confirm).toHaveBeenCalledWith('Live is production', undefined, 'Change');
    expect(declined.session.calls).toEqual([]);
  });
});

describe('renameKey (V7.3)', () => {
  it('renames and moves the key in the tree', async () => {
    const { handlers, session, browser } = setup({ name: 'user:2' });
    await handlers.renameKey(keyNode('user:1'));
    expect(session.calls).toEqual([['RENAMENX', 'user:1', 'user:2']]);
    expect(browser.forget).toHaveBeenCalledWith('r1', 2, { text: 'user:1' });
    expect(browser.include).toHaveBeenCalledWith('r1', 2, {
      key: { text: 'user:2' },
      type: 'hash',
    });
  });

  it('replaces a taken name only after asking', async () => {
    const taken = new FakeRedisSession((words) => (words[0] === 'RENAMENX' ? '0' : '1'));
    const agreed = setup({ name: 'b', session: taken });
    await agreed.handlers.renameKey(keyNode('a'));
    expect(agreed.confirm).toHaveBeenCalledWith('replace b?', undefined, 'Replace');
    expect(taken.calls.at(-1)).toEqual(['RENAME', 'a', 'b']);
    const refused = setup({ name: 'b', session: new FakeRedisSession(() => '0'), confirm: false });
    await refused.handlers.renameKey(keyNode('a'));
    expect(refused.browser.forget).not.toHaveBeenCalled();
  });

  it('does nothing for the same name, no name, or a node that is no key', async () => {
    for (const name of ['a', undefined]) {
      const { handlers, session } = setup({ ...(name === undefined ? {} : { name }) });
      await handlers.renameKey(keyNode('a'));
      await handlers.renameKey(db);
      expect(session.calls).toEqual([]);
    }
  });
});

describe('deleteKeys (V7.3)', () => {
  it('deletes every selected key of the database after one question', async () => {
    const { handlers, session, confirm, browser, refresh } = setup();
    const selection = [keyNode('a'), keyNode('b'), keyNode('other', 'r2'), db];
    await handlers.deleteKeys(keyNode('a'), selection);
    expect(confirm).toHaveBeenCalledWith('delete a,b?', undefined, 'Delete');
    expect(session.calls).toEqual([
      ['UNLINK', 'a'],
      ['UNLINK', 'b'],
    ]);
    expect(browser.forget).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith(dbRefresh);
  });

  it('deletes only the clicked key when it is not among the selected', async () => {
    const { handlers, session } = setup();
    await handlers.deleteKeys(keyNode('c'), [keyNode('a')]);
    expect(session.calls).toEqual([['UNLINK', 'c']]);
  });

  it('names production in the question, and keeps everything when declined', async () => {
    const { handlers, session, confirm } = setup({ configs: PROD, confirm: false });
    await handlers.deleteKeys(keyNode('a', 'r1'));
    expect(confirm).toHaveBeenCalledWith('delete a?', 'Live is production', 'Delete');
    expect(session.calls).toEqual([]);
  });

  it('refuses a read-only connection without asking', async () => {
    const { handlers, confirm } = setup({ configs: PROD });
    await expect(handlers.deleteKeys(keyNode('a', 'ro'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('openConsole / serverInfo (V7.4)', () => {
  it('opens on the clicked database, or the one a connection opens', async () => {
    const { handlers, openConsole, openServerInfo } = setup();
    await handlers.openConsole(db);
    await handlers.openConsole({ kind: 'connection', connectionId: 'r1' });
    await handlers.serverInfo({ kind: 'connection', connectionId: 'r2' });
    expect(openConsole.mock.calls).toEqual([
      [{ connectionId: 'r1', database: 2 }],
      [{ connectionId: 'r1', database: 4 }],
    ]);
    expect(openServerInfo).toHaveBeenCalledWith({ connectionId: 'r2', database: 0 });
  });

  it('asks which Redis connection from the palette, and opens nothing when dismissed', async () => {
    const { handlers, openConsole, pickConnection } = setup();
    await handlers.openConsole();
    expect(openConsole).toHaveBeenCalledWith({ connectionId: 'r2', database: 0 });
    pickConnection.mockResolvedValueOnce(undefined);
    await handlers.serverInfo();
    await expect(
      handlers.openConsole({ kind: 'connection', connectionId: 's1' }),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(openConsole).toHaveBeenCalledTimes(1);
  });
});
