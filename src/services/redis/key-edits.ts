// Changing one Redis key from its page (V7.3). Each change is one command or one atomic
// step: renaming a hash field, replacing a member, editing a list element by position.
// A list element is changed only while it is still the one the page showed — positions
// move when other clients push or pop — so those steps are small Lua scripts that check
// first (D86). Values are bytes; the page's view of them never decides what is written.

import { randomUUID } from 'node:crypto';
import { DbError } from '../../core/errors';
import type { RedisCommand, RedisReply, RedisSession } from '../../drivers/redis-driver';
import { isErrorReply } from '../../drivers/redis-driver';
import { type RedisValue, redisValueBytes } from '../../shared/redis-value';
import { replyNumber } from './reply';
import { msg } from '../../core/user-message';

/** Bytes to write; a cut value or broken hex is refused rather than written short. */
export function valueBytes(value: RedisValue, what: 'value' | 'field' = 'value'): Uint8Array {
  const bytes = redisValueBytes(value);
  if (bytes === undefined) {
    // Whole sentences for each, so a translation never has to agree with a pasted noun.
    const cut = value.truncated === true;
    throw new DbError(
      'unsupported',
      what === 'field'
        ? cut
          ? msg('The field is too big to edit here: only its start was shown')
          : msg('The field is not valid hex')
        : cut
          ? msg('The value is too big to edit here: only its start was shown')
          : msg('The value is not valid hex'),
    );
  }
  return bytes;
}

/** A score Redis accepts: a number, or inf with a sign. */
export function isScore(text: string): boolean {
  return (
    /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text.trim()) || /^[+-]?inf$/i.test(text.trim())
  );
}

/** A stream id XADD accepts: `*`, `ms`, `ms-seq` or `ms-*`. */
export function isStreamId(text: string): boolean {
  return /^(\*|\d+(-(\d+|\*))?)$/.test(text.trim());
}

/** Translated where it is thrown: a constant would be English before a translator is set. */
function changed(): string {
  return msg('The value changed since it was shown: refresh and try again');
}

/** The first error reply of an atomic block, as an error. */
function firstError(replies: readonly RedisReply[]): void {
  for (const reply of replies) {
    if (isErrorReply(reply)) {
      throw new DbError('constraint', reply.error);
    }
  }
}

async function script(
  session: RedisSession,
  body: string,
  key: Uint8Array,
  args: readonly (string | Uint8Array)[],
): Promise<number | undefined> {
  return replyNumber(await session.call(['EVAL', body, '1', key, ...args]));
}

/** SET that keeps the TTL; servers before 6.0 without KEEPTTL do it in a script. */
export async function setString(
  session: RedisSession,
  key: Uint8Array,
  value: RedisValue,
): Promise<void> {
  const bytes = valueBytes(value);
  try {
    await session.call(['SET', key, bytes, 'KEEPTTL']);
  } catch (error) {
    if (!(error instanceof DbError) || error.code !== 'syntax') {
      throw error;
    }
    await script(
      session,
      "local t = redis.call('PTTL', KEYS[1]) redis.call('SET', KEYS[1], ARGV[1]) if t > 0 then redis.call('PEXPIRE', KEYS[1], t) end return 1",
      key,
      [bytes],
    );
  }
}

/** HSET; renaming the field to one that exists is refused, not merged. */
export async function setField(
  session: RedisSession,
  key: Uint8Array,
  field: RedisValue,
  value: RedisValue,
  previous?: RedisValue,
): Promise<void> {
  const name = valueBytes(field, 'field');
  const bytes = valueBytes(value);
  const old = previous === undefined ? undefined : valueBytes(previous, 'field');
  if (old === undefined || Buffer.compare(Buffer.from(old), Buffer.from(name)) === 0) {
    await session.call(['HSET', key, name, bytes]);
    return;
  }
  const done = await script(
    session,
    "if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) redis.call('HDEL', KEYS[1], ARGV[3]) return 1",
    key,
    [name, bytes, old],
  );
  if (done !== 1) {
    throw new DbError('constraint', msg('The hash already has a field with that name'));
  }
}

export async function deleteField(
  session: RedisSession,
  key: Uint8Array,
  field: RedisValue,
): Promise<void> {
  await session.call(['HDEL', key, valueBytes(field, 'field')]);
}

/** LSET while the element at `index` is still `expected`. */
export async function setListItem(
  session: RedisSession,
  key: Uint8Array,
  index: number,
  expected: RedisValue,
  value: RedisValue,
): Promise<void> {
  const done = await script(
    session,
    "if redis.call('LINDEX', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end redis.call('LSET', KEYS[1], ARGV[1], ARGV[3]) return 1",
    key,
    [String(index), valueBytes(expected), valueBytes(value)],
  );
  if (done !== 1) {
    throw new DbError('busy', changed());
  }
}

/**
 * Removes the element at `index` while it is still `expected`: it becomes a marker no
 * client wrote, which LREM then removes — Redis has no "remove at position".
 */
export async function removeListItem(
  session: RedisSession,
  key: Uint8Array,
  index: number,
  expected: RedisValue,
  marker = `__datanest_removed_${randomUUID()}`,
): Promise<void> {
  const done = await script(
    session,
    "if redis.call('LINDEX', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end redis.call('LSET', KEYS[1], ARGV[1], ARGV[3]) redis.call('LREM', KEYS[1], 1, ARGV[3]) return 1",
    key,
    [String(index), valueBytes(expected), marker],
  );
  if (done !== 1) {
    throw new DbError('busy', changed());
  }
}

export async function pushListItem(
  session: RedisSession,
  key: Uint8Array,
  end: 'head' | 'tail',
  value: RedisValue,
): Promise<void> {
  await session.call([end === 'head' ? 'LPUSH' : 'RPUSH', key, valueBytes(value)]);
}

/** SADD, removing `previous` in the same step when the member was edited. */
export async function setMember(
  session: RedisSession,
  key: Uint8Array,
  value: RedisValue,
  previous?: RedisValue,
): Promise<void> {
  const add: RedisCommand = ['SADD', key, valueBytes(value)];
  if (previous === undefined) {
    await session.call(add);
    return;
  }
  firstError(await session.atomic([['SREM', key, valueBytes(previous)], add]));
}

/** ZADD with a checked score, removing `previous` in the same step when renamed. */
export async function setScoredMember(
  session: RedisSession,
  key: Uint8Array,
  value: RedisValue,
  score: string,
  previous?: RedisValue,
): Promise<void> {
  if (!isScore(score)) {
    throw new DbError(
      'constraint',
      msg('"{0}" is not a score: write a number, inf or -inf', score),
    );
  }
  const add: RedisCommand = ['ZADD', key, score.trim(), valueBytes(value)];
  if (previous === undefined) {
    await session.call(add);
    return;
  }
  firstError(await session.atomic([['ZREM', key, valueBytes(previous)], add]));
}

/** SREM or ZREM, as the type of the key says. */
export async function deleteMember(
  session: RedisSession,
  key: Uint8Array,
  type: string,
  value: RedisValue,
): Promise<void> {
  await session.call([type === 'zset' ? 'ZREM' : 'SREM', key, valueBytes(value)]);
}

export async function addEntry(
  session: RedisSession,
  key: Uint8Array,
  id: string,
  fields: readonly { field: RedisValue; value: RedisValue }[],
): Promise<void> {
  if (!isStreamId(id)) {
    throw new DbError('constraint', msg('"{0}" is not a stream id: write *, or ms-seq', id));
  }
  if (fields.length === 0) {
    throw new DbError('constraint', msg('A stream entry needs at least one field'));
  }
  await session.call([
    'XADD',
    key,
    id.trim(),
    ...fields.flatMap((pair) => [valueBytes(pair.field, 'field'), valueBytes(pair.value)]),
  ]);
}

export async function deleteEntry(
  session: RedisSession,
  key: Uint8Array,
  id: string,
): Promise<void> {
  await session.call(['XDEL', key, id]);
}

/** EXPIRE in seconds, or PERSIST for null. */
export async function setTtl(
  session: RedisSession,
  key: Uint8Array,
  seconds: number | null,
): Promise<void> {
  await session.call(seconds === null ? ['PERSIST', key] : ['EXPIRE', key, String(seconds)]);
}

/** RENAMENX; false when the new name is taken. With `replace`, RENAME over it. */
export async function renameKey(
  session: RedisSession,
  key: Uint8Array,
  name: Uint8Array,
  replace: boolean,
): Promise<boolean> {
  if (replace) {
    await session.call(['RENAME', key, name]);
    return true;
  }
  return replyNumber(await session.call(['RENAMENX', key, name])) === 1;
}

/** UNLINK frees memory in the background; servers before 4.0 only know DEL. */
export async function deleteKeys(
  session: RedisSession,
  keys: readonly Uint8Array[],
): Promise<number> {
  let deleted = 0;
  for (const key of keys) {
    try {
      deleted += replyNumber(await session.call(['UNLINK', key])) ?? 0;
    } catch (error) {
      if (!(error instanceof DbError) || error.code !== 'syntax') {
        throw error;
      }
      deleted += replyNumber(await session.call(['DEL', key])) ?? 0;
    }
  }
  return deleted;
}

/** What a new key starts with: Redis keeps no empty collections. */
export type NewKeyContent =
  | { readonly type: 'string'; readonly value: RedisValue }
  | { readonly type: 'hash'; readonly field: RedisValue; readonly value: RedisValue }
  | { readonly type: 'list' | 'set'; readonly value: RedisValue }
  | { readonly type: 'zset'; readonly value: RedisValue; readonly score: string }
  | { readonly type: 'stream'; readonly field: RedisValue; readonly value: RedisValue };

function firstCommand(content: NewKeyContent): (string | Uint8Array)[] {
  switch (content.type) {
    case 'string':
      return ['SET', valueBytes(content.value)];
    case 'hash':
      return ['HSET', valueBytes(content.field, 'field'), valueBytes(content.value)];
    case 'list':
      return ['RPUSH', valueBytes(content.value)];
    case 'set':
      return ['SADD', valueBytes(content.value)];
    case 'zset':
      if (!isScore(content.score)) {
        throw new DbError(
          'constraint',
          msg('"{0}" is not a score: write a number, inf or -inf', content.score),
        );
      }
      return ['ZADD', content.score.trim(), valueBytes(content.value)];
    case 'stream':
      return ['XADD', '*', valueBytes(content.field, 'field'), valueBytes(content.value)];
  }
}

/** Creates a key with its first content, refusing a name that is taken, in one step. */
export async function createKey(
  session: RedisSession,
  key: Uint8Array,
  content: NewKeyContent,
): Promise<void> {
  const [command = '', ...args] = firstCommand(content);
  const done = await script(
    session,
    "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end redis.call(ARGV[1], KEYS[1], unpack(ARGV, 2)) return 1",
    key,
    [command, ...args],
  );
  if (done !== 1) {
    throw new DbError('constraint', msg('A key with that name already exists'));
  }
}
