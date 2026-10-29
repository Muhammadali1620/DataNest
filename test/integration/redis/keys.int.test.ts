import { afterEach, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/redis';
import type { RedisSession, ResolvedRedisConfig } from '../../../src/drivers/redis-driver';
import { RedisKeyBrowser } from '../../../src/services/redis/key-browser';
import { findKeys, SCAN_START, scanFrom } from '../../../src/services/redis/key-scan';
import { redisKeyBytes } from '../../../src/shared/redis-key';
import { replyText } from '../../../src/services/redis/reply';
import { RecordingLogger } from '../../helpers/fakes';
import { TEST_REDIS } from '../../helpers/redis-servers';

// docker/compose.yml `redis` (V7.2): walking the seeded keys the way the tree does.
const opened: RedisSession[] = [];

async function open(overrides: Partial<ResolvedRedisConfig> = {}): Promise<RedisSession> {
  const session = await driver.openSession({
    id: 'it',
    name: 'it',
    driver: 'redis',
    host: TEST_REDIS.host,
    port: TEST_REDIS.port,
    user: TEST_REDIS.user.name,
    password: TEST_REDIS.user.password,
    ...overrides,
  });
  opened.push(session);
  return session;
}

const cluster = (): Promise<RedisSession> =>
  open({
    port: TEST_REDIS.cluster.ports[0],
    user: undefined,
    password: TEST_REDIS.cluster.password,
    redis: { mode: 'cluster' },
  });

function browserOver(session: RedisSession, perLoad = 5000, separator = ':'): RedisKeyBrowser {
  return new RedisKeyBrowser({
    manager: { acquireRedis: () => Promise.resolve(session) },
    settings: { separator: () => separator, keysPerLoad: () => perLoad },
    logger: new RecordingLogger(),
  });
}

afterEach(async () => {
  for (const session of opened.splice(0)) {
    await session.close();
  }
});

describe('Redis keys (V7.2)', () => {
  it('walks every key of the database step by step', async () => {
    const session = await open();
    const all = await scanFrom(session, SCAN_START, { want: 1_000_000, budgetMs: 30_000 });
    expect(all.position.done).toBe(true);
    const size = Number(replyText(await session.call(['DBSIZE'])));
    expect(new Set(all.keys.map((key) => Buffer.from(key).toString('hex'))).size).toBe(size);
  });

  it('groups the seeded keys into folders with their types', async () => {
    const browser = browserOver(await open());
    const top = await browser.children('c', 0, []);
    const folders = new Map(top.folders.map((folder) => [folder.name, folder.count]));
    expect(folders.get('big')).toBe(2005);
    expect(folders.get('user')).toBe(4);
    expect(top.more).toBe(false);
    const app = await browser.children('c', 0, ['app']);
    expect(app.keys.map((leaf) => [leaf.name, leaf.entry.type])).toEqual([
      ['big-counter', 'string'],
      ['binary', 'string'],
      ['counter', 'string'],
      ['empty', 'string'],
      ['json', 'string'],
      ['name', 'string'],
    ]);
    const deep = await browser.children('c', 0, ['a', 'b', 'c', 'd']);
    expect(deep.keys.map((leaf) => leaf.entry.key.text)).toEqual(['a:b:c:d:deep']);
    const types = new Map(top.keys.map((leaf) => [leaf.name, leaf.entry.type]));
    expect(types.get('leaderboard')).toBe('zset');
    expect(types.get('events')).toBe('stream');
    expect(types.get('tags')).toBe('set');
  });

  it('keeps binary and Unicode keys, so they are found again byte for byte', async () => {
    const session = await open();
    const browser = browserOver(session);
    const bin = (await browser.children('c', 0, ['bin'])).keys[0]?.entry.key;
    expect(bin).toEqual({ text: 'bin:\\xff\\xfe', hex: '62696e3afffe' });
    expect(replyText(await session.call(['GET', redisKeyBytes(bin ?? { text: '' })]))).toBe(
      'binary key',
    );
    const user = await browser.children('c', 0, ['user']);
    expect(user.keys.map((leaf) => leaf.name)).toContain('имя');
  });

  it('loads a portion at a time and filters on the server', async () => {
    const browser = browserOver(await open(), 500);
    const first = await browser.children('c', 0, []);
    expect(first.more).toBe(true);
    expect(first.loaded).toBeGreaterThanOrEqual(500);
    expect(first.loaded).toBeLessThan(2000);
    browser.setPattern('c', 0, 'user:*');
    const users = await browser.children('c', 0, []);
    expect(users.folders.map((folder) => folder.name)).toEqual(['user']);
    expect(users.keys).toEqual([]);
  });

  it('opens other databases on their own sessions', async () => {
    const other = browserOver(await open({ database: '1' }));
    const top = await other.children('c', 1, []);
    expect(top.folders.map((folder) => [folder.name, folder.count])).toEqual([['other', 2]]);
  });

  it('finds keys by part of the name or a pattern', async () => {
    const session = await open();
    const found = await findKeys(session, 'leader', { limit: 50, budgetMs: 5000 });
    expect(found.keys).toEqual([{ key: { text: 'leaderboard' }, type: 'zset' }]);
    expect(found.complete).toBe(true);
    const pattern = await findKeys(session, 'user:[12]', { limit: 50, budgetMs: 5000 });
    expect(pattern.keys.map((entry) => entry.key.text).sort()).toEqual(['user:1', 'user:2']);
    const literal = await findKeys(session, 'key with', { limit: 50, budgetMs: 5000 });
    expect(literal.keys.map((entry) => entry.key.text)).toEqual(['key with spaces']);
    const many = await findKeys(session, 'big:key:', { limit: 100, budgetMs: 5000 });
    expect(many.keys).toHaveLength(100);
  });

  it('walks every master of a cluster', async () => {
    const browser = browserOver(await cluster());
    const top = await browser.children('c', 0, []);
    expect(top.folders).toEqual([{ name: 'cluster', path: ['cluster'], count: 11 }]);
    expect(top.more).toBe(false);
    const found = await findKeys(await cluster(), 'echo', { limit: 10, budgetMs: 5000 });
    expect(found.keys).toEqual([{ key: { text: 'cluster:echo' }, type: 'string' }]);
  });
});
