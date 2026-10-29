// The numbered databases of a Redis connection (V7.1), with how many keys each holds.
// `INFO keyspace` lists only databases that have keys; `CONFIG GET databases` says how
// many there are, but managed servers and restricted users often may not ask it.

import type { RedisSession } from '../../drivers/redis-driver';
import { replyItems, replyText } from './reply';

export interface RedisDatabaseInfo {
  readonly index: number;
  readonly keys: number;
  /** Keys with a time to live. */
  readonly expires: number;
}

/** What a server has when it does not say: Redis's own default. */
export const DEFAULT_DATABASE_COUNT = 16;

/** More databases than this are listed only when they hold keys. */
const LIST_ALL_UP_TO = 16;

/** `db0:keys=12,expires=1,avg_ttl=0` lines of `INFO keyspace`, by database. */
export function parseKeyspace(info: string): Map<number, { keys: number; expires: number }> {
  const result = new Map<number, { keys: number; expires: number }>();
  for (const line of info.split(/\r?\n/)) {
    const match = /^db(\d+):(.*)$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    const fields = new Map(
      (match[2] ?? '').split(',').map((pair) => {
        const [name = '', value = ''] = pair.split('=');
        return [name, Number(value)] as const;
      }),
    );
    const keys = fields.get('keys');
    if (keys === undefined || !Number.isFinite(keys)) {
      continue;
    }
    const expires = fields.get('expires');
    result.set(Number(match[1]), {
      keys,
      expires: expires !== undefined && Number.isFinite(expires) ? expires : 0,
    });
  }
  return result;
}

/** How many databases the server has, or undefined when it will not say. */
async function databaseCount(session: RedisSession): Promise<number | undefined> {
  try {
    const [, value] = replyItems(await session.call(['CONFIG', 'GET', 'databases']));
    const count = Number(replyText(value ?? null));
    return Number.isInteger(count) && count > 0 ? count : undefined;
  } catch {
    // CONFIG is often refused (ACL, managed services): the keyspace still tells enough.
    return undefined;
  }
}

/**
 * The databases to show: all of them on a usual server (16), only those with keys on
 * one that has hundreds — plus database 0 and the one the connection opens. A cluster
 * has database 0 only, with the keys of every master added up.
 */
export async function listRedisDatabases(
  session: RedisSession,
  opened: number,
): Promise<RedisDatabaseInfo[]> {
  const totals = new Map<number, { keys: number; expires: number }>();
  for (const reply of await session.onMasters(['INFO', 'keyspace'])) {
    for (const [index, counts] of parseKeyspace(replyText(reply))) {
      const sum = totals.get(index) ?? { keys: 0, expires: 0 };
      totals.set(index, { keys: sum.keys + counts.keys, expires: sum.expires + counts.expires });
    }
  }
  const info = (index: number): RedisDatabaseInfo => ({
    index,
    keys: totals.get(index)?.keys ?? 0,
    expires: totals.get(index)?.expires ?? 0,
  });
  if (session.mode === 'cluster') {
    return [info(0)];
  }
  const count = (await databaseCount(session)) ?? DEFAULT_DATABASE_COUNT;
  const indexes =
    count <= LIST_ALL_UP_TO
      ? Array.from({ length: count }, (_value, index) => index)
      : [...new Set([0, opened, ...totals.keys()])].sort((a, b) => a - b);
  // A database beyond the count still shows when it holds keys or is the one opened.
  return [...new Set([...indexes, opened, ...totals.keys()])].sort((a, b) => a - b).map(info);
}
