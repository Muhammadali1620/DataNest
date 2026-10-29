import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RedisReply } from '../../../../src/drivers/redis-driver';
import {
  nextStreamId,
  readItems,
  readOverview,
  readString,
} from '../../../../src/services/redis/key-values';
import { MAX_STRING_BYTES } from '../../../../src/shared/protocols/redis-key';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

const KEY = bulk('k');

function server(replies: Record<string, RedisReply | Error>): FakeRedisSession {
  return new FakeRedisSession((words) => {
    const exact = replies[words.join(' ')];
    if (exact !== undefined) {
      return exact;
    }
    return replies[words[0] ?? ''] ?? null;
  });
}

describe('readOverview', () => {
  it('reads type, TTL, length, memory and encoding', async () => {
    const session = server({
      TYPE: bulk('hash'),
      PTTL: '5000',
      OBJECT: bulk('listpack'),
      MEMORY: '120',
      HLEN: '3',
    });
    expect(await readOverview(session, KEY)).toEqual({
      exists: true,
      type: 'hash',
      ttlMs: 5000,
      length: 3,
      memory: 120,
      encoding: 'listpack',
    });
  });

  it('has no TTL for -1 and leaves out what the server refused', async () => {
    const session = server({
      TYPE: bulk('string'),
      PTTL: '-1',
      OBJECT: new DbError('permission-denied', 'NOPERM'),
      MEMORY: new DbError('syntax', 'ERR unknown command'),
      STRLEN: '4',
    });
    expect(await readOverview(session, KEY)).toEqual({
      exists: true,
      type: 'string',
      ttlMs: null,
      length: 4,
    });
  });

  it('says a missing key, or one that expired meanwhile, does not exist', async () => {
    expect(await readOverview(server({ TYPE: bulk('none'), PTTL: '-2' }), KEY)).toEqual({
      exists: false,
      type: 'none',
      ttlMs: null,
    });
    expect((await readOverview(server({ TYPE: bulk('set'), PTTL: '-2' }), KEY)).exists).toBe(false);
  });

  it('asks no length of a type it does not know', async () => {
    const session = server({ TYPE: bulk('ReJSON-RL'), PTTL: '-1' });
    expect(await readOverview(session, KEY)).toEqual({
      exists: true,
      type: 'ReJSON-RL',
      ttlMs: null,
    });
    expect(session.calls.map((call) => call[0])).toEqual(['TYPE', 'PTTL', 'OBJECT', 'MEMORY']);
  });
});

describe('readString', () => {
  it('reads a value whole', async () => {
    expect(await readString(server({ STRLEN: '2', GET: bulk('hi') }), KEY)).toEqual({ text: 'hi' });
  });

  it('reads only the start of a huge value', async () => {
    const session = server({ STRLEN: String(MAX_STRING_BYTES + 5), GETRANGE: bulk('abc') });
    expect(await readString(session, KEY)).toEqual({
      text: 'abc',
      truncated: true,
      size: MAX_STRING_BYTES + 5,
    });
    expect(session.calls.at(-1)).toEqual(['GETRANGE', 'k', '0', String(MAX_STRING_BYTES - 1)]);
  });
});

describe('readItems', () => {
  it('pages a hash with HSCAN and follows the cursor', async () => {
    const session = server({
      'HSCAN k 0 COUNT 2': [bulk('7'), [bulk('a'), bulk('1'), bulk('b'), bulk('2')]],
      'HSCAN k 7 MATCH x* COUNT 2': [bulk('0'), [bulk('x'), bulk('3')]],
    });
    const first = await readItems(session, KEY, 'hash', undefined, { pageSize: 2 });
    expect(first).toEqual({
      items: [
        { field: { text: 'a' }, value: { text: '1' } },
        { field: { text: 'b' }, value: { text: '2' } },
      ],
      next: { scan: '7' },
    });
    const last = await readItems(session, KEY, 'hash', first.next, { pageSize: 2, match: 'x*' });
    expect(last).toEqual({
      items: [{ field: { text: 'x' }, value: { text: '3' } }],
      next: undefined,
    });
  });

  it('pages a set with SSCAN', async () => {
    const session = server({ SSCAN: [bulk('0'), [bulk('m')]] });
    expect(await readItems(session, KEY, 'set', undefined, { pageSize: 5 })).toEqual({
      items: [{ value: { text: 'm' } }],
      next: undefined,
    });
  });

  it('reads a sorted set by rank, or with ZSCAN when filtered', async () => {
    const session = server({
      'ZRANGE k 0 1 WITHSCORES': [bulk('a'), bulk('1'), bulk('b'), bulk('2.5')],
      'ZRANGE k 2 3 WITHSCORES': [bulk('c'), bulk('inf')],
      ZSCAN: [bulk('0'), [bulk('a'), bulk('1')]],
    });
    const first = await readItems(session, KEY, 'zset', undefined, { pageSize: 2 });
    expect(first.items).toEqual([
      { index: 0, value: { text: 'a' }, score: '1' },
      { index: 1, value: { text: 'b' }, score: '2.5' },
    ]);
    expect(first.next).toEqual({ index: 2 });
    expect(await readItems(session, KEY, 'zset', first.next, { pageSize: 2 })).toEqual({
      items: [{ index: 2, value: { text: 'c' }, score: 'inf' }],
      next: undefined,
    });
    expect(
      (await readItems(session, KEY, 'zset', undefined, { pageSize: 2, match: 'a' })).items,
    ).toEqual([{ value: { text: 'a' }, score: '1' }]);
  });

  it('reads a list by position', async () => {
    const session = server({ 'LRANGE k 0 1': [bulk('x'), bulk('y')], 'LRANGE k 2 3': [] });
    const first = await readItems(session, KEY, 'list', undefined, { pageSize: 2 });
    expect(first).toEqual({
      items: [
        { index: 0, value: { text: 'x' } },
        { index: 1, value: { text: 'y' } },
      ],
      next: { index: 2 },
    });
    expect(await readItems(session, KEY, 'list', first.next, { pageSize: 2 })).toEqual({
      items: [],
      next: undefined,
    });
  });

  it('reads a stream from just past the last id', async () => {
    const entry = (id: string): RedisReply => [bulk(id), [bulk('f'), bulk('v')]];
    const session = server({
      'XRANGE k - + COUNT 2': [entry('1-0'), entry('1-1')],
      'XRANGE k 1-2 + COUNT 2': [entry('5-0')],
    });
    const first = await readItems(session, KEY, 'stream', undefined, { pageSize: 2 });
    expect(first.items[0]).toEqual({
      id: '1-0',
      fields: [{ field: { text: 'f' }, value: { text: 'v' } }],
    });
    expect(first.next).toEqual({ after: '1-2' });
    const last = await readItems(session, KEY, 'stream', first.next, { pageSize: 2 });
    expect(last.items.map((item) => item.id)).toEqual(['5-0']);
    expect(last.next).toBeUndefined();
  });

  it('cuts items that are too big', async () => {
    const session = server({ SSCAN: [bulk('0'), [bulk('x'.repeat(70_000))]] });
    const [item] = (await readItems(session, KEY, 'set', undefined, { pageSize: 1 })).items;
    expect(item?.value).toMatchObject({ truncated: true, size: 70_000 });
  });

  it('has no items for a type without them', async () => {
    expect(await readItems(server({}), KEY, 'string', undefined, { pageSize: 5 })).toEqual({
      items: [],
      next: undefined,
    });
  });
});

describe('nextStreamId', () => {
  it('moves to the next sequence, beyond what a double holds', () => {
    expect(nextStreamId('5-0')).toBe('5-1');
    expect(nextStreamId('1-18446744073709551614')).toBe('1-18446744073709551615');
    expect(nextStreamId('7')).toBe('7-1');
  });
});
