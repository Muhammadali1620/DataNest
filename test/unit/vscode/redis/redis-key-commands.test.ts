import { describe, expect, it, vi } from 'vitest';
import type { LoadedKey } from '../../../../src/services/redis/key-tree';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import {
  keyNodeOf,
  type RedisPlace,
  redisKeyCommandHandlers,
} from '../../../../src/vscode/redis/redis-key-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

const CONFIGS: ConnectionConfig[] = [
  { id: 'r1', name: 'Cache', driver: 'redis', host: 'h', database: '4' },
  { id: 'r2', name: 'Queue', driver: 'redis', host: 'q' },
  { id: 's1', name: 'Shop', driver: 'mysql', host: 'db' },
];

function setup(
  options: { configs?: ConnectionConfig[]; pattern?: string | undefined; found?: LoadedKey } = {},
) {
  const configs = options.configs ?? CONFIGS;
  const browser = {
    loadMore: vi.fn(() => Promise.resolve()),
    patternOf: vi.fn((): string | undefined => 'old*'),
    setPattern: vi.fn(),
    include: vi.fn(),
  };
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
  });
  return { handlers, browser, refresh, askPattern, pickConnection, findKey, reveal };
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
