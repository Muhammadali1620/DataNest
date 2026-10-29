// Reading one Redis key for its page (V7.3): what it is (type, TTL, size, encoding) and
// its value, a page at a time for collections. Big values travel cut (`RedisValue`), so
// a 500 MB string or a hash of millions of fields never lands in the page whole.

import type { RedisReply, RedisSession } from '../../drivers/redis-driver';
import { isErrorReply } from '../../drivers/redis-driver';
import {
  MAX_ITEM_BYTES,
  MAX_STRING_BYTES,
  type RedisKeyItem,
} from '../../shared/protocols/redis-key';
import { type RedisValue, redisValueOf } from '../../shared/redis-value';
import { replyItems, replyNumber, replyText } from './reply';

export interface KeyOverview {
  readonly exists: boolean;
  readonly type: string;
  /** Milliseconds left, or null without an expiry. */
  readonly ttlMs: number | null;
  readonly length?: number;
  readonly memory?: number;
  readonly encoding?: string;
}

/** How each type tells its size. */
const LENGTH_COMMANDS: Readonly<Record<string, string>> = {
  string: 'STRLEN',
  hash: 'HLEN',
  list: 'LLEN',
  set: 'SCARD',
  zset: 'ZCARD',
  stream: 'XLEN',
};

function bytesOf(reply: RedisReply | undefined): Uint8Array {
  if (reply instanceof Uint8Array) {
    return reply;
  }
  return new TextEncoder().encode(typeof reply === 'string' ? reply : '');
}

/** A number from a reply, or undefined for an error reply or anything else. */
function numberOf(reply: RedisReply | undefined): number | undefined {
  return reply === undefined || isErrorReply(reply) ? undefined : replyNumber(reply);
}

/** Type, TTL, length, memory and encoding in two round trips; what is refused is left out. */
export async function readOverview(session: RedisSession, key: Uint8Array): Promise<KeyOverview> {
  const [type, pttl, encoding, memory] = await session.pipeline([
    ['TYPE', key],
    ['PTTL', key],
    ['OBJECT', 'ENCODING', key],
    ['MEMORY', 'USAGE', key],
  ]);
  const typeName = type === undefined || isErrorReply(type) ? 'none' : replyText(type);
  const ttl = numberOf(pttl);
  if (typeName === 'none' || ttl === -2) {
    return { exists: false, type: typeName, ttlMs: null };
  }
  const lengthCommand = LENGTH_COMMANDS[typeName];
  const [length] =
    lengthCommand === undefined ? [undefined] : await session.pipeline([[lengthCommand, key]]);
  const lengthNumber = numberOf(length);
  const memoryNumber = numberOf(memory);
  const encodingText =
    encoding === undefined || encoding === null || isErrorReply(encoding)
      ? undefined
      : replyText(encoding);
  return {
    exists: true,
    type: typeName,
    ttlMs: ttl === undefined || ttl < 0 ? null : ttl,
    ...(lengthNumber === undefined ? {} : { length: lengthNumber }),
    ...(memoryNumber === undefined ? {} : { memory: memoryNumber }),
    ...(encodingText === undefined || encodingText === '' ? {} : { encoding: encodingText }),
  };
}

/** A string value; one longer than MAX_STRING_BYTES comes as its start, marked as cut. */
export async function readString(session: RedisSession, key: Uint8Array): Promise<RedisValue> {
  const size = replyNumber(await session.call(['STRLEN', key])) ?? 0;
  if (size <= MAX_STRING_BYTES) {
    return redisValueOf(bytesOf(await session.call(['GET', key])));
  }
  const start = await session.call(['GETRANGE', key, '0', String(MAX_STRING_BYTES - 1)]);
  return redisValueOf(bytesOf(start), MAX_STRING_BYTES, size);
}

/** Where the next page of items starts: a SCAN cursor, a position, or a stream id. */
export type ItemCursor =
  { readonly scan: string } | { readonly index: number } | { readonly after: string };

export interface ItemsPage {
  readonly items: RedisKeyItem[];
  /** Undefined once every item was read. */
  readonly next: ItemCursor | undefined;
}

const item = (reply: RedisReply | undefined): RedisValue =>
  redisValueOf(bytesOf(reply), MAX_ITEM_BYTES);

/** Pairs of a flat reply: `[f1, v1, f2, v2]`. */
function pairs(reply: RedisReply): [RedisReply, RedisReply][] {
  const flat = replyItems(reply);
  const result: [RedisReply, RedisReply][] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    result.push([flat[index] ?? null, flat[index + 1] ?? null]);
  }
  return result;
}

/** The id right after a stream id, so the next XRANGE starts past it on every version. */
export function nextStreamId(id: string): string {
  const [ms = '0', seq = '0'] = id.split('-');
  return `${ms}-${(BigInt(seq) + 1n).toString()}`;
}

/**
 * One page of a collection's items from `from` (the start when undefined). A pattern
 * filters hash fields and set or sorted set members on the server (`HSCAN … MATCH`);
 * lists and streams are read in order and are not filtered.
 */
export async function readItems(
  session: RedisSession,
  key: Uint8Array,
  type: string,
  from: ItemCursor | undefined,
  options: { readonly pageSize: number; readonly match?: string },
): Promise<ItemsPage> {
  const count = String(options.pageSize);
  const match = options.match === undefined ? [] : ['MATCH', options.match];
  const cursor = from !== undefined && 'scan' in from ? from.scan : '0';
  const start = from !== undefined && 'index' in from ? from.index : 0;
  switch (type) {
    case 'hash':
    case 'set':
    case 'zset': {
      if (type === 'zset' && options.match === undefined) {
        return await zsetByRank(session, key, start, options.pageSize);
      }
      const command = type === 'hash' ? 'HSCAN' : type === 'set' ? 'SSCAN' : 'ZSCAN';
      const [next = null, found = null] = replyItems(
        await session.call([command, key, cursor, ...match, 'COUNT', count]),
      );
      const items: RedisKeyItem[] =
        type === 'set'
          ? replyItems(found).map((member) => ({ value: item(member) }))
          : pairs(found).map(([first, second]) =>
              type === 'hash'
                ? { field: item(first), value: item(second) }
                : { value: item(first), score: replyText(second) },
            );
      const nextCursor = replyText(next);
      return {
        items,
        next: nextCursor === '0' || nextCursor === '' ? undefined : { scan: nextCursor },
      };
    }
    case 'list': {
      const values = replyItems(
        await session.call(['LRANGE', key, String(start), String(start + options.pageSize - 1)]),
      );
      return {
        items: values.map((value, offset) => ({ index: start + offset, value: item(value) })),
        next: values.length < options.pageSize ? undefined : { index: start + values.length },
      };
    }
    case 'stream': {
      const after = from !== undefined && 'after' in from ? from.after : '-';
      const entries = replyItems(await session.call(['XRANGE', key, after, '+', 'COUNT', count]));
      const items = entries.map((entry) => {
        const [id = null, fields = null] = replyItems(entry);
        return {
          id: replyText(id),
          fields: pairs(fields).map(([field, value]) => ({
            field: item(field),
            value: item(value),
          })),
        };
      });
      const last = items.at(-1)?.id;
      return {
        items,
        next:
          last === undefined || items.length < options.pageSize
            ? undefined
            : { after: nextStreamId(last) },
      };
    }
    default:
      return { items: [], next: undefined };
  }
}

async function zsetByRank(
  session: RedisSession,
  key: Uint8Array,
  start: number,
  pageSize: number,
): Promise<ItemsPage> {
  const found = pairs(
    await session.call(['ZRANGE', key, String(start), String(start + pageSize - 1), 'WITHSCORES']),
  );
  return {
    items: found.map(([member, score], offset) => ({
      index: start + offset,
      value: item(member),
      score: replyText(score),
    })),
    next: found.length < pageSize ? undefined : { index: start + found.length },
  };
}
