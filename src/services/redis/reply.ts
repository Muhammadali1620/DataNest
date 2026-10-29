// Reading replies of the Redis driver: bytes as UTF-8 text, integers as numbers.

import type { RedisReply } from '../../drivers/redis-driver';
import { isErrorReply } from '../../drivers/redis-driver';

const UTF8 = new TextDecoder('utf-8');

/** A reply as plain text: bytes decoded as UTF-8, an integer as its digits; '' for nil. */
export function replyText(reply: RedisReply): string {
  if (reply === null) {
    return '';
  }
  if (typeof reply === 'string') {
    return reply;
  }
  if (reply instanceof Uint8Array) {
    return UTF8.decode(reply);
  }
  if (isErrorReply(reply)) {
    return reply.error;
  }
  return reply.map((item) => replyText(item)).join(' ');
}

/** An integer reply (or a number sent as text) as a number; undefined when it is none. */
export function replyNumber(reply: RedisReply): number | undefined {
  if (typeof reply !== 'string' && !(reply instanceof Uint8Array)) {
    return undefined;
  }
  const text = replyText(reply).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return undefined;
  }
  return Number(text);
}

/** The items of an array reply; empty for anything else. */
export function replyItems(reply: RedisReply): readonly RedisReply[] {
  return Array.isArray(reply) ? (reply as readonly RedisReply[]) : [];
}
