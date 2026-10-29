import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RedisReply } from '../../../../src/drivers/redis-driver';
import { RedisKeyModel } from '../../../../src/vscode/panels/redis-key-model';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

/** A server with one key of `type`, whose LRANGE pages come from `list`. */
function server(type: string, options: { list?: string[]; exists?: boolean } = {}) {
  const list = options.list ?? [];
  const session = new FakeRedisSession((words): RedisReply | Error | undefined => {
    switch (words[0] ?? '') {
      case 'TYPE':
        return bulk(options.exists === false ? 'none' : type);
      case 'PTTL':
        return options.exists === false ? '-2' : '-1';
      case 'LLEN':
      case 'HLEN':
        return String(list.length);
      case 'STRLEN':
        return '5';
      case 'OBJECT':
      case 'MEMORY':
        return null;
      case 'GET':
        return bulk('value');
      case 'LRANGE': {
        const start = Number(words[2]);
        const stop = Number(words[3]);
        return list.slice(start, stop + 1).map(bulk);
      }
      case 'HSCAN':
        return words[2] === '0'
          ? [bulk('5'), [bulk('a'), bulk('1'), bulk('b'), bulk('2')]]
          : [bulk('0'), [bulk('b'), bulk('2'), bulk('c'), bulk('3')]];
      case 'EVAL':
      case 'RENAMENX':
      case 'UNLINK':
        return '1';
      default:
        return bulk('OK');
    }
  });
  return session;
}

function model(session: FakeRedisSession, readOnly = false, pageSize = 2) {
  return new RedisKeyModel({
    key: { text: 'k' },
    database: 3,
    connectionName: 'Cache',
    readOnly,
    session: () => Promise.resolve(session),
    pageSize,
  });
}

describe('RedisKeyModel', () => {
  it('reads a string key', async () => {
    const state = await model(server('string')).refresh();
    expect(state).toEqual({
      key: { text: 'k' },
      database: 3,
      connectionName: 'Cache',
      readOnly: false,
      exists: true,
      type: 'string',
      ttlMs: null,
      length: 5,
      value: { text: 'value' },
    });
  });

  it('says a key does not exist', async () => {
    const state = await model(server('none', { exists: false })).refresh();
    expect(state).toMatchObject({ exists: false, type: 'none' });
    expect(state.items).toBeUndefined();
  });

  it('reads the first page of a collection and the next ones on demand', async () => {
    const keyModel = model(server('list', { list: ['a', 'b', 'c'] }));
    expect(await keyModel.refresh()).toMatchObject({
      items: [{ index: 0 }, { index: 1 }],
      more: true,
    });
    expect(await keyModel.loadMore()).toMatchObject({ items: [{}, {}, { index: 2 }], more: false });
    // Nothing more to read: loadMore keeps what there is.
    expect((await keyModel.loadMore()).items).toHaveLength(3);
  });

  it('drops an item a SCAN page repeats', async () => {
    const keyModel = model(server('hash'));
    await keyModel.refresh();
    const state = await keyModel.loadMore();
    expect(state.items?.map((item) => item.field?.text)).toEqual(['a', 'b', 'c']);
  });

  it('filters and clears the filter', async () => {
    const session = server('hash');
    const keyModel = model(session);
    expect((await keyModel.filter(' a* ')).filter).toBe('a*');
    expect(session.calls.find((call) => call[0] === 'HSCAN')).toContain('MATCH');
    expect((await keyModel.filter('*')).filter).toBeUndefined();
  });

  it('keeps as many items after a change as were shown', async () => {
    const session = server('list', { list: ['a', 'b', 'c', 'd', 'e'] });
    const keyModel = model(session);
    await keyModel.refresh();
    await keyModel.loadMore();
    const state = await keyModel.apply({
      kind: 'setListItem',
      index: 3,
      expected: { text: 'd' },
      value: { text: 'D' },
    });
    expect(state.items).toHaveLength(4);
    expect(session.calls.some((call) => call[0] === 'EVAL')).toBe(true);
  });

  it('runs each change through the right command', async () => {
    const session = server('hash');
    const keyModel = model(session);
    await keyModel.refresh();
    const edits = [
      { kind: 'setString', value: { text: 'v' } },
      { kind: 'setField', field: { text: 'f' }, value: { text: 'v' } },
      { kind: 'deleteField', field: { text: 'f' } },
      { kind: 'pushListItem', end: 'head', value: { text: 'v' } },
      { kind: 'removeListItem', index: 0, expected: { text: 'v' } },
      { kind: 'setMember', value: { text: 'm' } },
      { kind: 'deleteMember', value: { text: 'm' } },
      { kind: 'setScoredMember', value: { text: 'm' }, score: '1' },
      { kind: 'addEntry', id: '*', fields: [{ field: { text: 'f' }, value: { text: 'v' } }] },
      { kind: 'deleteEntry', id: '1-1' },
      { kind: 'setTtl', seconds: 10 },
    ] as const;
    for (const edit of edits) {
      await keyModel.apply(edit);
    }
    const commands = session.calls.map((call) => call[0]);
    for (const name of [
      'SET',
      'HSET',
      'HDEL',
      'LPUSH',
      'EVAL',
      'SADD',
      'HDEL',
      'ZADD',
      'XADD',
      'XDEL',
      'EXPIRE',
    ]) {
      expect(commands, name).toContain(name);
    }
    // A member of a hash key is deleted as the key's type says (SREM for others).
    expect(commands).toContain('SREM');
  });

  it('follows the key to its new name', async () => {
    const session = server('string');
    const keyModel = model(session);
    expect(await keyModel.rename('k2', false)).toBe(true);
    expect(keyModel.currentKey).toEqual({ text: 'k2' });
    expect(session.calls.find((call) => call[0] === 'RENAMENX')).toEqual(['RENAMENX', 'k', 'k2']);
  });

  it('stays on the old name when the new one is taken', async () => {
    const session = new FakeRedisSession((words) =>
      words[0] === 'RENAMENX' ? '0' : bulk('string'),
    );
    const keyModel = model(session);
    expect(await keyModel.rename('k2', false)).toBe(false);
    expect(keyModel.currentKey).toEqual({ text: 'k' });
  });

  it('deletes the key and reads it as gone', async () => {
    const session = server('string');
    const keyModel = model(session);
    await keyModel.deleteKey();
    expect(session.calls[0]).toEqual(['UNLINK', 'k']);
  });

  it('refuses every change on a read-only connection, before the server sees it', async () => {
    const session = server('string');
    const keyModel = model(session, true);
    await expect(keyModel.apply({ kind: 'setTtl', seconds: null })).rejects.toBeInstanceOf(DbError);
    await expect(keyModel.rename('x', false)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(keyModel.deleteKey()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(session.calls).toEqual([]);
    expect((await keyModel.refresh()).readOnly).toBe(true);
  });
});
