import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RedisReply } from '../../../../src/drivers/redis-driver';
import {
  addEntry,
  createKey,
  deleteEntry,
  deleteField,
  deleteKeys,
  deleteMember,
  isScore,
  isStreamId,
  pushListItem,
  removeListItem,
  renameKey,
  setField,
  setListItem,
  setMember,
  setScoredMember,
  setString,
  setTtl,
  valueBytes,
} from '../../../../src/services/redis/key-edits';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

const KEY = bulk('k');
const text = (value: string) => ({ text: value });

function server(answer: (words: string[]) => RedisReply | Error | undefined = () => bulk('OK')) {
  return new FakeRedisSession(answer);
}

describe('valueBytes', () => {
  it('refuses a cut value and broken hex with a reason', () => {
    expect(() => valueBytes({ text: 'a', truncated: true })).toThrow(/too big to edit/);
    expect(() => valueBytes({ text: '', hex: 'xyz' }, 'field')).toThrow(
      /The field is not valid hex/,
    );
    expect(valueBytes({ text: '', hex: '00' })).toEqual(Uint8Array.of(0));
  });
});

describe('isScore / isStreamId', () => {
  it('accepts what Redis accepts', () => {
    for (const score of ['1', '-2.5', '+3', '.5', '1e3', 'inf', '-INF', ' 4 ']) {
      expect(isScore(score), score).toBe(true);
    }
    for (const score of ['', 'abc', '1,5', 'infinity', '--1']) {
      expect(isScore(score), score).toBe(false);
    }
    for (const id of ['*', '5', '5-1', '5-*']) {
      expect(isStreamId(id), id).toBe(true);
    }
    for (const id of ['', 'a', '5-', '-1', '5-1-2']) {
      expect(isStreamId(id), id).toBe(false);
    }
  });
});

describe('setString', () => {
  it('keeps the TTL with KEEPTTL', async () => {
    const session = server();
    await setString(session, KEY, text('v'));
    expect(session.calls).toEqual([['SET', 'k', 'v', 'KEEPTTL']]);
  });

  it('keeps the TTL in a script on servers without KEEPTTL', async () => {
    const session = server((words) =>
      words[0] === 'SET' ? new DbError('syntax', 'ERR syntax error') : '1',
    );
    await setString(session, KEY, text('v'));
    expect(session.calls[1]?.[0]).toBe('EVAL');
    expect(session.calls[1]?.slice(2)).toEqual(['1', 'k', 'v']);
  });

  it('passes other failures on', async () => {
    const session = server(() => new DbError('constraint', 'OOM'));
    await expect(setString(session, KEY, text('v'))).rejects.toMatchObject({ code: 'constraint' });
  });
});

describe('hash fields', () => {
  it('sets a field with HSET when it keeps its name', async () => {
    const session = server();
    await setField(session, KEY, text('f'), text('v'));
    await setField(session, KEY, text('f'), text('w'), text('f'));
    expect(session.calls).toEqual([
      ['HSET', 'k', 'f', 'v'],
      ['HSET', 'k', 'f', 'w'],
    ]);
  });

  it('renames a field in a script that refuses a taken name', async () => {
    const session = server(() => '1');
    await setField(session, KEY, text('new'), text('v'), text('old'));
    expect(session.calls[0]?.slice(2)).toEqual(['1', 'k', 'new', 'v', 'old']);
    const taken = server(() => '0');
    await expect(setField(taken, KEY, text('new'), text('v'), text('old'))).rejects.toMatchObject({
      code: 'constraint',
    });
  });

  it('deletes a field', async () => {
    const session = server();
    await deleteField(session, KEY, text('f'));
    expect(session.calls).toEqual([['HDEL', 'k', 'f']]);
  });
});

describe('list elements', () => {
  it('sets and removes by position only while the element is what was shown', async () => {
    const session = server(() => '1');
    await setListItem(session, KEY, 3, text('old'), text('new'));
    expect(session.calls[0]?.slice(2)).toEqual(['1', 'k', '3', 'old', 'new']);
    await removeListItem(session, KEY, 2, text('x'), 'MARK');
    expect(session.calls[1]?.slice(2)).toEqual(['1', 'k', '2', 'x', 'MARK']);
    const moved = server(() => '0');
    await expect(setListItem(moved, KEY, 0, text('a'), text('b'))).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(removeListItem(moved, KEY, 0, text('a'))).rejects.toMatchObject({ code: 'busy' });
  });

  it('uses a marker no client wrote', async () => {
    const session = server(() => '1');
    await removeListItem(session, KEY, 0, text('a'));
    expect(session.calls[0]?.at(-1)).toMatch(/^__datanest_removed_[0-9a-f-]{36}$/);
  });

  it('pushes to either end', async () => {
    const session = server();
    await pushListItem(session, KEY, 'head', text('a'));
    await pushListItem(session, KEY, 'tail', text('b'));
    expect(session.calls).toEqual([
      ['LPUSH', 'k', 'a'],
      ['RPUSH', 'k', 'b'],
    ]);
  });
});

describe('members', () => {
  it('adds, replaces in one block, and deletes set members', async () => {
    const session = server(() => '1');
    await setMember(session, KEY, text('a'));
    await setMember(session, KEY, text('b'), text('a'));
    await deleteMember(session, KEY, 'set', text('b'));
    expect(session.blocks).toEqual([
      [
        ['SREM', 'k', 'a'],
        ['SADD', 'k', 'b'],
      ],
    ]);
    expect(session.calls.at(-1)).toEqual(['SREM', 'k', 'b']);
  });

  it('checks scores and replaces scored members in one block', async () => {
    const session = server(() => '1');
    await setScoredMember(session, KEY, text('a'), ' 2 ');
    expect(session.calls[0]).toEqual(['ZADD', 'k', '2', 'a']);
    await setScoredMember(session, KEY, text('b'), 'inf', text('a'));
    expect(session.blocks[0]).toEqual([
      ['ZREM', 'k', 'a'],
      ['ZADD', 'k', 'inf', 'b'],
    ]);
    await expect(setScoredMember(session, KEY, text('b'), 'x')).rejects.toMatchObject({
      code: 'constraint',
    });
    await deleteMember(session, KEY, 'zset', text('b'));
    expect(session.calls.at(-1)).toEqual(['ZREM', 'k', 'b']);
  });

  it('turns an error reply inside a block into an error', async () => {
    const session = server((words) =>
      words[0] === 'SADD' ? new DbError('constraint', 'WRONGTYPE') : '1',
    );
    await expect(setMember(session, KEY, text('b'), text('a'))).rejects.toMatchObject({
      code: 'constraint',
      message: 'WRONGTYPE',
    });
  });
});

describe('streams, TTL, rename, delete', () => {
  it('adds an entry with checked id and fields, and deletes by id', async () => {
    const session = server();
    await addEntry(session, KEY, ' * ', [{ field: text('f'), value: text('v') }]);
    await deleteEntry(session, KEY, '1-1');
    expect(session.calls).toEqual([
      ['XADD', 'k', '*', 'f', 'v'],
      ['XDEL', 'k', '1-1'],
    ]);
    await expect(
      addEntry(session, KEY, 'nope', [{ field: text('f'), value: text('v') }]),
    ).rejects.toMatchObject({
      code: 'constraint',
    });
    await expect(addEntry(session, KEY, '*', [])).rejects.toMatchObject({ code: 'constraint' });
  });

  it('sets or removes the TTL', async () => {
    const session = server();
    await setTtl(session, KEY, 60);
    await setTtl(session, KEY, null);
    expect(session.calls).toEqual([
      ['EXPIRE', 'k', '60'],
      ['PERSIST', 'k'],
    ]);
  });

  it('renames without replacing unless asked', async () => {
    const free = server(() => '1');
    expect(await renameKey(free, KEY, bulk('n'), false)).toBe(true);
    const taken = server(() => '0');
    expect(await renameKey(taken, KEY, bulk('n'), false)).toBe(false);
    await renameKey(taken, KEY, bulk('n'), true);
    expect(taken.calls.at(-1)).toEqual(['RENAME', 'k', 'n']);
  });

  it('deletes with UNLINK, or DEL on servers that do not know it', async () => {
    const session = server(() => '1');
    expect(await deleteKeys(session, [bulk('a'), bulk('b')])).toBe(2);
    expect(session.calls).toEqual([
      ['UNLINK', 'a'],
      ['UNLINK', 'b'],
    ]);
    const old = server((words) =>
      words[0] === 'UNLINK' ? new DbError('syntax', 'ERR unknown command') : '1',
    );
    expect(await deleteKeys(old, [bulk('a')])).toBe(1);
    expect(old.calls.at(-1)).toEqual(['DEL', 'a']);
    const broken = server(() => new DbError('connection-failed', 'gone'));
    await expect(deleteKeys(broken, [bulk('a')])).rejects.toMatchObject({
      code: 'connection-failed',
    });
  });
});

describe('createKey', () => {
  it('writes the first content of each type only when the name is free', async () => {
    const session = server(() => '1');
    await createKey(session, KEY, { type: 'string', value: text('v') });
    await createKey(session, KEY, { type: 'hash', field: text('f'), value: text('v') });
    await createKey(session, KEY, { type: 'list', value: text('v') });
    await createKey(session, KEY, { type: 'set', value: text('v') });
    await createKey(session, KEY, { type: 'zset', value: text('v'), score: ' 1 ' });
    await createKey(session, KEY, { type: 'stream', field: text('f'), value: text('v') });
    expect(session.calls.map((call) => call.slice(3))).toEqual([
      ['k', 'SET', 'v'],
      ['k', 'HSET', 'f', 'v'],
      ['k', 'RPUSH', 'v'],
      ['k', 'SADD', 'v'],
      ['k', 'ZADD', '1', 'v'],
      ['k', 'XADD', '*', 'f', 'v'],
    ]);
  });

  it('refuses a taken name and a bad score', async () => {
    await expect(
      createKey(
        server(() => '0'),
        KEY,
        { type: 'set', value: text('v') },
      ),
    ).rejects.toMatchObject({
      code: 'constraint',
    });
    await expect(
      createKey(
        server(() => '1'),
        KEY,
        { type: 'zset', value: text('v'), score: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'constraint' });
  });
});
