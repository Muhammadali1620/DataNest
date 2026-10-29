import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/redis';
import type { RedisSession, ResolvedRedisConfig } from '../../../src/drivers/redis-driver';
import {
  addEntry,
  createKey,
  deleteEntry,
  deleteField,
  deleteKeys,
  deleteMember,
  pushListItem,
  removeListItem,
  renameKey,
  setField,
  setListItem,
  setMember,
  setScoredMember,
  setString,
  setTtl,
} from '../../../src/services/redis/key-edits';
import {
  type ItemCursor,
  readItems,
  readOverview,
  readString,
} from '../../../src/services/redis/key-values';
import { replyItems, replyText } from '../../../src/services/redis/reply';
import { MAX_STRING_BYTES } from '../../../src/shared/protocols/redis-key';
import { type RedisValue, redisValueOf } from '../../../src/shared/redis-value';
import { TEST_REDIS } from '../../helpers/redis-servers';

// docker/compose.yml `redis` (V7.3): reading and changing values on a real server.
const text = (value: string): RedisValue => ({ text: value });
const key = (name: string): Uint8Array => new TextEncoder().encode(name);

async function open(overrides: Partial<ResolvedRedisConfig> = {}): Promise<RedisSession> {
  return await driver.openSession({
    id: 'it',
    name: 'it',
    driver: 'redis',
    host: TEST_REDIS.host,
    port: TEST_REDIS.port,
    user: TEST_REDIS.user.name,
    password: TEST_REDIS.user.password,
    ...overrides,
  });
}

let session: RedisSession;

beforeAll(async () => {
  session = await open();
});

afterAll(async () => {
  const leftovers = replyItems(await session.call(['KEYS', 'it:val:*']));
  if (leftovers.length > 0) {
    await session.call(['DEL', ...leftovers.map((item) => item as Uint8Array)]);
  }
  await session.close();
});

async function allItems(name: string, type: string, match?: string) {
  const items = [];
  let cursor: ItemCursor | undefined;
  do {
    const page = await readItems(session, key(name), type, cursor, {
      pageSize: 300,
      ...(match === undefined ? {} : { match }),
    });
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

describe('reading a key (V7.3)', () => {
  it('tells type, TTL, length and encoding of each seeded type', async () => {
    expect(await readOverview(session, key('session:abc'))).toMatchObject({
      exists: true,
      type: 'string',
      length: 5,
    });
    expect((await readOverview(session, key('session:abc'))).ttlMs).toBeGreaterThan(80_000_000);
    expect(await readOverview(session, key('user:1'))).toMatchObject({
      type: 'hash',
      ttlMs: null,
      length: 3,
      encoding: 'listpack',
    });
    expect((await readOverview(session, key('big:hash'))).length).toBe(1000);
    expect((await readOverview(session, key('queue:jobs'))).type).toBe('list');
    expect((await readOverview(session, key('leaderboard'))).length).toBe(4);
    expect((await readOverview(session, key('events'))).length).toBe(3);
    expect((await readOverview(session, key('user:1'))).memory).toBeGreaterThan(0);
  });

  it('says a missing key does not exist', async () => {
    expect(await readOverview(session, key('no:such:key'))).toEqual({
      exists: false,
      type: 'none',
      ttlMs: null,
    });
  });

  it('reads all of it with read permissions only', async () => {
    const reader = await open({
      user: TEST_REDIS.reader.name,
      password: TEST_REDIS.reader.password,
    });
    try {
      const overview = await readOverview(reader, key('user:1'));
      expect(overview).toMatchObject({ exists: true, type: 'hash', length: 3 });
      expect(overview.memory).toBeGreaterThan(0);
    } finally {
      await reader.close();
    }
  });

  it('reads strings as text, binary as hex, and cuts a huge one', async () => {
    expect(await readString(session, key('user:имя'))).toEqual({ text: 'Привет' });
    expect(await readString(session, key('app:binary'))).toMatchObject({ hex: '00ff1080' });
    await session.call(['SET', 'it:val:huge', 'x'.repeat(MAX_STRING_BYTES + 10)]);
    const huge = await readString(session, key('it:val:huge'));
    expect(huge.text).toHaveLength(MAX_STRING_BYTES);
    expect(huge).toMatchObject({ truncated: true, size: MAX_STRING_BYTES + 10 });
  });

  it('pages through every type to the end', async () => {
    expect(await allItems('big:hash', 'hash')).toHaveLength(1000);
    expect(await allItems('big:set', 'set')).toHaveLength(1000);
    const zset = await allItems('big:zset', 'zset');
    expect(zset).toHaveLength(1000);
    expect(zset[0]).toEqual({ index: 0, value: text('member:1'), score: '1' });
    const list = await allItems('big:list', 'list');
    expect(list.map((item) => item.index)).toEqual([...Array(1000).keys()]);
    const stream = await allItems('big:stream', 'stream');
    expect(stream).toHaveLength(1000);
    expect(new Set(stream.map((item) => item.id)).size).toBe(1000);
    expect(stream[0]?.fields).toEqual([{ field: text('n'), value: text('1') }]);
  });

  it('filters fields and members on the server', async () => {
    const fields = await allItems('big:hash', 'hash', 'field:1?');
    expect(fields.map((item) => item.field?.text).sort()).toEqual(
      Array.from({ length: 10 }, (_v, i) => `field:1${i}`).sort(),
    );
    const members = await allItems('leaderboard', 'zset', 'a*');
    expect(members).toEqual([{ value: text('alice'), score: '100' }]);
  });
});

describe('changing a key (V7.3)', () => {
  it('sets a string and keeps its TTL', async () => {
    await session.call(['SET', 'it:val:s', 'old', 'EX', '1000']);
    await setString(session, key('it:val:s'), text('new\nline'));
    expect(await readString(session, key('it:val:s'))).toEqual({ text: 'new\nline' });
    expect(replyText(await session.call(['TTL', 'it:val:s']))).not.toBe('-1');
    await setString(session, key('it:val:s'), { text: '', hex: '00ff' });
    expect((await readString(session, key('it:val:s'))).hex).toBe('00ff');
  });

  it('refuses to write a value that was shown cut', async () => {
    await expect(
      setString(session, key('it:val:s'), { text: 'x', truncated: true, size: 5 }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('adds, edits, renames and deletes hash fields', async () => {
    const name = key('it:val:h');
    await setField(session, name, text('a'), text('1'));
    await setField(session, name, text('b'), text('2'));
    await setField(session, name, text('a'), text('one'), text('a'));
    await setField(session, name, text('c'), text('3'), text('b'));
    expect(replyItems(await session.call(['HGETALL', name])).map(replyText)).toEqual([
      'a',
      'one',
      'c',
      '3',
    ]);
    await expect(setField(session, name, text('a'), text('x'), text('c'))).rejects.toMatchObject({
      code: 'constraint',
    });
    await deleteField(session, name, text('a'));
    expect(replyText(await session.call(['HLEN', name]))).toBe('1');
  });

  it('edits and removes list elements only while they are what the page saw', async () => {
    const name = key('it:val:l');
    await pushListItem(session, name, 'tail', text('b'));
    await pushListItem(session, name, 'head', text('a'));
    await pushListItem(session, name, 'tail', text('c'));
    await setListItem(session, name, 1, text('b'), text('B'));
    await expect(setListItem(session, name, 1, text('b'), text('x'))).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(setListItem(session, name, 9, text('b'), text('x'))).rejects.toMatchObject({
      code: 'busy',
    });
    await session.call(['RPUSH', name, 'B']);
    await removeListItem(session, name, 1, text('B'));
    expect(replyItems(await session.call(['LRANGE', name, '0', '-1'])).map(replyText)).toEqual([
      'a',
      'c',
      'B',
    ]);
    await expect(removeListItem(session, name, 0, text('zzz'))).rejects.toMatchObject({
      code: 'busy',
    });
  });

  it('replaces set members and scored members in one step', async () => {
    await setMember(session, key('it:val:set'), text('x'));
    await setMember(session, key('it:val:set'), text('y'), text('x'));
    expect(replyItems(await session.call(['SMEMBERS', 'it:val:set'])).map(replyText)).toEqual([
      'y',
    ]);
    await deleteMember(session, key('it:val:set'), 'set', text('y'));
    expect(replyText(await session.call(['EXISTS', 'it:val:set']))).toBe('0');

    await setScoredMember(session, key('it:val:z'), text('m'), '1.5');
    await setScoredMember(session, key('it:val:z'), text('n'), '-inf', text('m'));
    expect(
      replyItems(await session.call(['ZRANGE', 'it:val:z', '0', '-1', 'WITHSCORES'])).map(
        replyText,
      ),
    ).toEqual(['n', '-inf']);
    await expect(
      setScoredMember(session, key('it:val:z'), text('n'), 'lots'),
    ).rejects.toMatchObject({
      code: 'constraint',
    });
    await deleteMember(session, key('it:val:z'), 'zset', text('n'));
  });

  it('adds and deletes stream entries', async () => {
    const name = key('it:val:x');
    await addEntry(session, name, '*', [{ field: text('a'), value: text('1') }]);
    await addEntry(session, name, '9999999999999-5', [{ field: text('b'), value: text('2') }]);
    const entries = await allItems('it:val:x', 'stream');
    expect(entries).toHaveLength(2);
    await deleteEntry(session, name, '9999999999999-5');
    expect(await allItems('it:val:x', 'stream')).toHaveLength(1);
    await expect(
      addEntry(session, name, '1-1', [{ field: text('c'), value: text('3') }]),
    ).rejects.toMatchObject({
      name: 'DbError',
    });
  });

  it('sets and clears the TTL', async () => {
    await session.call(['SET', 'it:val:t', '1']);
    await setTtl(session, key('it:val:t'), 100);
    expect((await readOverview(session, key('it:val:t'))).ttlMs).toBeGreaterThan(90_000);
    await setTtl(session, key('it:val:t'), null);
    expect((await readOverview(session, key('it:val:t'))).ttlMs).toBeNull();
  });

  it('renames without replacing a taken name unless asked', async () => {
    await session.call(['SET', 'it:val:r1', '1']);
    await session.call(['SET', 'it:val:r2', '2']);
    expect(await renameKey(session, key('it:val:r1'), key('it:val:r3'), false)).toBe(true);
    expect(await renameKey(session, key('it:val:r3'), key('it:val:r2'), false)).toBe(false);
    expect(await renameKey(session, key('it:val:r3'), key('it:val:r2'), true)).toBe(true);
    expect(replyText(await session.call(['GET', 'it:val:r2']))).toBe('1');
  });

  it('creates keys of every type and refuses a taken name', async () => {
    await createKey(session, key('it:val:new:s'), { type: 'string', value: text('v') });
    await createKey(session, key('it:val:new:h'), {
      type: 'hash',
      field: text('f'),
      value: text('v'),
    });
    await createKey(session, key('it:val:new:l'), { type: 'list', value: text('v') });
    await createKey(session, key('it:val:new:set'), { type: 'set', value: text('v') });
    await createKey(session, key('it:val:new:z'), { type: 'zset', value: text('v'), score: '2' });
    await createKey(session, key('it:val:new:x'), {
      type: 'stream',
      field: text('f'),
      value: text('v'),
    });
    for (const [name, type] of [
      ['s', 'string'],
      ['h', 'hash'],
      ['l', 'list'],
      ['set', 'set'],
      ['z', 'zset'],
      ['x', 'stream'],
    ]) {
      expect((await readOverview(session, key(`it:val:new:${name}`))).type).toBe(type);
    }
    await expect(
      createKey(session, key('it:val:new:s'), { type: 'list', value: text('v') }),
    ).rejects.toMatchObject({ code: 'constraint' });
    expect(await deleteKeys(session, [key('it:val:new:s'), key('it:val:new:h'), key('nope')])).toBe(
      2,
    );
  });

  it('works on binary keys and values in a cluster too', async () => {
    const cluster = await open({
      port: TEST_REDIS.cluster.ports[0],
      user: undefined,
      password: TEST_REDIS.cluster.password,
      redis: { mode: 'cluster' },
    });
    try {
      const name = Uint8Array.of(0x69, 0x74, 0xff, 0x00);
      await setScoredMember(cluster, name, redisValueOf(Uint8Array.of(0xfe)), '1');
      await setScoredMember(cluster, name, text('ok'), '2', redisValueOf(Uint8Array.of(0xfe)));
      const items = await readItems(cluster, name, 'zset', undefined, { pageSize: 10 });
      expect(items.items).toEqual([{ index: 0, value: text('ok'), score: '2' }]);
      expect(await deleteKeys(cluster, [name])).toBe(1);
    } finally {
      await cluster.close();
    }
  });
});
