// What the server says about its commands (`COMMAND INFO`), and what DataNest makes of
// it: whether a command may change data. The server's own flags are better than a
// list of ours — they cover modules and commands newer than DataNest (D83).

import type { RedisReply } from '../../drivers/redis-driver';
import { isErrorReply } from '../../drivers/redis-driver';
import { replyText } from './reply';

export interface RedisCommandInfo {
  /** Lowercase; a subcommand is `container|sub`, e.g. `config|get`. */
  readonly name: string;
  /** Number of words with the name; negative means "at least" that many. */
  readonly arity: number;
  /** `write`, `readonly`, `admin`, `noscript`, … */
  readonly flags: readonly string[];
  /** ACL categories (Redis 6+): `@read`, `@write`, `@dangerous`, … */
  readonly categories: readonly string[];
  readonly subcommands: readonly RedisCommandInfo[];
}

function texts(reply: RedisReply | undefined): string[] {
  return Array.isArray(reply) ? reply.map((item: RedisReply) => replyText(item)) : [];
}

/** One entry of `COMMAND INFO`; undefined for an unknown command (a nil entry). */
export function parseCommandEntry(entry: RedisReply | undefined): RedisCommandInfo | undefined {
  if (!Array.isArray(entry) || entry.length < 3) {
    return undefined;
  }
  const items = entry as readonly RedisReply[];
  const subcommands = Array.isArray(items[9])
    ? (items[9] as readonly RedisReply[]).flatMap((sub: RedisReply) => {
        const parsed = parseCommandEntry(sub);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  return {
    name: replyText(items[0] ?? null).toLowerCase(),
    arity: Number(replyText(items[1] ?? null)),
    flags: texts(items[2]).map((flag) => flag.toLowerCase()),
    categories: texts(items[6]).map((category) => category.toLowerCase()),
    subcommands,
  };
}

/** Every entry of a `COMMAND INFO …` or `COMMAND` reply, in order. */
export function parseCommandInfo(reply: RedisReply): (RedisCommandInfo | undefined)[] {
  if (!Array.isArray(reply) || isErrorReply(reply)) {
    return [];
  }
  return (reply as readonly RedisReply[]).map((entry: RedisReply) => parseCommandEntry(entry));
}

/** What running a command does to the server, as far as its flags tell. */
export type CommandEffect = 'read' | 'write' | 'unknown';

/**
 * A command changes something when the server flags it so, or when it administers the
 * server (`CONFIG SET` carries no `write` flag), runs scripts that may write, or is
 * replicated (`PUBLISH`). Read-only scripts (`EVAL_RO`) are flagged `readonly`.
 */
export function commandEffect(info: RedisCommandInfo | undefined): CommandEffect {
  if (info === undefined) {
    return 'unknown';
  }
  const flag = (name: string): boolean => info.flags.includes(name);
  const category = (name: string): boolean => info.categories.includes(name);
  if (
    flag('write') ||
    flag('admin') ||
    flag('may_replicate') ||
    category('@write') ||
    category('@admin') ||
    (category('@scripting') && !flag('readonly'))
  ) {
    return 'write';
  }
  return 'read';
}

/**
 * Commands that change what the connection is rather than the data: another database,
 * user or protocol, a transaction, a subscription. The connection settings decide
 * these, so init commands may not use them.
 */
export const SESSION_COMMANDS: ReadonlySet<string> = new Set([
  'select',
  'swapdb',
  'auth',
  'hello',
  'reset',
  'quit',
  'multi',
  'exec',
  'discard',
  'watch',
  'unwatch',
  'subscribe',
  'psubscribe',
  'ssubscribe',
  'monitor',
  'sync',
  'psync',
  'replconf',
]);

/**
 * The entry for the words typed: a subcommand's own (`config|get`) where the server
 * lists subcommands (Redis 7), the container's otherwise.
 */
export function commandFor(
  info: RedisCommandInfo | undefined,
  words: readonly string[],
): RedisCommandInfo | undefined {
  const sub = words[1]?.toLowerCase();
  if (info === undefined || sub === undefined || info.subcommands.length === 0) {
    return info;
  }
  return info.subcommands.find((one) => one.name === `${info.name}|${sub}`) ?? info;
}
