import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  escapeGlob,
  findKeys,
  SCAN_START,
  scanFrom,
  searchPattern,
  withTypes,
} from '../../../../src/services/redis/key-scan';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

const names = (count: number, prefix = 'k'): string[] =>
  Array.from({ length: count }, (_value, index) => `${prefix}:${index}`);

function typed(types: Record<string, string> = {}): FakeRedisSession {
  return new FakeRedisSession((words) =>
    words[0] === 'TYPE' ? bulk(types[words[1] ?? ''] ?? 'string') : null,
  );
}

describe('scanFrom', () => {
  it('walks until it has enough keys and says where it stopped', async () => {
    const session = typed();
    session.keyspace = [names(2500)];
    const first = await scanFrom(session, SCAN_START, { want: 1500, budgetMs: 10_000 });
    expect(first.keys).toHaveLength(2000);
    expect(first.position).toEqual({ master: 0, cursor: '2000', done: false });
    const rest = await scanFrom(session, first.position, { want: 1500, budgetMs: 10_000 });
    expect(rest.keys).toHaveLength(500);
    expect(rest.position.done).toBe(true);
    expect(session.scans.map((scan) => scan.count)).toEqual([1000, 1000, 1000]);
  });

  it('passes the pattern to the server', async () => {
    const session = typed();
    session.keyspace = [['user:1', 'app:1', 'user:2']];
    const result = await scanFrom(session, SCAN_START, {
      match: 'user:*',
      want: 10,
      budgetMs: 1000,
    });
    expect(result.keys.map((key) => new TextDecoder().decode(key))).toEqual(['user:1', 'user:2']);
    expect(session.scans[0]?.match).toBe('user:*');
  });

  it('walks every master of a cluster in turn', async () => {
    const session = typed();
    session.keyspace = [['a'], [], ['b', 'c']];
    const result = await scanFrom(session, SCAN_START, { want: 10, budgetMs: 1000 });
    expect(result.keys).toHaveLength(3);
    expect(result.position).toEqual({ master: 3, cursor: '0', done: true });
    expect(session.scans.map((scan) => scan.master)).toEqual([0, 1, 2]);
  });

  it('stops at the time budget with what it has, ready to go on', async () => {
    const session = typed();
    session.keyspace = [names(5000)];
    let clock = 0;
    const result = await scanFrom(session, SCAN_START, {
      match: 'nothing*',
      want: 10,
      budgetMs: 100,
      now: () => (clock += 60),
    });
    expect(result.keys).toEqual([]);
    expect(result.position.done).toBe(false);
    expect(session.scans.length).toBeLessThan(5);
  });

  it('does nothing once the walk is done', async () => {
    const session = typed();
    const result = await scanFrom(
      session,
      { master: 1, cursor: '0', done: true },
      { want: 5, budgetMs: 10 },
    );
    expect(result.keys).toEqual([]);
    expect(session.scans).toEqual([]);
  });

  it('passes a failure on', async () => {
    const session = typed();
    session.scanError = new DbError('connection-failed', 'gone');
    await expect(scanFrom(session, SCAN_START, { want: 1, budgetMs: 10 })).rejects.toMatchObject({
      code: 'connection-failed',
    });
  });
});

describe('withTypes', () => {
  it('asks the type of every key in one pipeline per thousand', async () => {
    const session = typed({ 'h:1': 'hash' });
    const keys = names(1500).map(bulk);
    keys[0] = bulk('h:1');
    const result = await withTypes(session, keys);
    expect(result).toHaveLength(1500);
    expect(result[0]).toEqual({ key: { text: 'h:1' }, type: 'hash' });
    expect(result[1]?.type).toBe('string');
  });

  it('leaves out keys deleted meanwhile and keeps keys whose type failed', async () => {
    const session = new FakeRedisSession((words) =>
      words[1] === 'gone'
        ? bulk('none')
        : words[1] === 'odd'
          ? new DbError('internal', 'ERR')
          : bulk('list'),
    );
    expect(await withTypes(session, [bulk('gone'), bulk('odd'), bulk('l')])).toEqual([
      { key: { text: 'odd' } },
      { key: { text: 'l' }, type: 'list' },
    ]);
  });

  it('keeps the bytes of binary keys', async () => {
    const [entry] = await withTypes(typed(), [Uint8Array.of(0x62, 0xff)]);
    expect(entry?.key).toEqual({ text: 'b\\xff', hex: '62ff' });
  });
});

describe('searchPattern', () => {
  it('finds plain text anywhere in the name, literally', () => {
    expect(searchPattern(' user ')).toBe('*user*');
    expect(searchPattern('a\\b')).toBe('*a\\\\b*');
  });

  it('takes a pattern as it is', () => {
    expect(searchPattern('user:*:name')).toBe('user:*:name');
    expect(searchPattern('user:?')).toBe('user:?');
    expect(searchPattern('[ab]*')).toBe('[ab]*');
  });

  it('finds nothing for blank text', () => {
    expect(searchPattern('  ')).toBeUndefined();
  });

  it('escapes every glob character', () => {
    expect(escapeGlob('a*b?c[d]e\\f')).toBe('a\\*b\\?c\\[d\\]e\\\\f');
  });
});

describe('findKeys', () => {
  it('finds matches with their types, at most the limit', async () => {
    const session = typed({ 'user:1': 'hash' });
    session.keyspace = [['user:1', 'app:1', 'user:2', 'x:user']];
    const found = await findKeys(session, 'user', { limit: 2, budgetMs: 1000 });
    expect(found.keys.map((entry) => entry.key.text)).toEqual(['user:1', 'user:2']);
    expect(found.keys[0]?.type).toBe('hash');
  });

  it('says whether it saw every key', async () => {
    const session = typed();
    session.keyspace = [['a', 'b']];
    expect((await findKeys(session, 'a', { limit: 10, budgetMs: 1000 })).complete).toBe(true);
    session.keyspace = [names(3000)];
    expect((await findKeys(session, 'k', { limit: 10, budgetMs: 1000 })).complete).toBe(false);
  });

  it('drops a key SCAN returned twice', async () => {
    const session = typed();
    session.keyspace = [['a', 'a']];
    expect((await findKeys(session, 'a', { limit: 10, budgetMs: 1000 })).keys).toHaveLength(1);
  });

  it('finds nothing without text, and does not ask the server', async () => {
    const session = typed();
    expect(await findKeys(session, ' ', { limit: 10, budgetMs: 1000 })).toEqual({
      keys: [],
      complete: true,
    });
    expect(session.scans).toEqual([]);
  });
});
