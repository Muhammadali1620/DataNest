// A Redis session for unit tests: replies are answered by a function of the command,
// and every call is recorded as text.

import { DbError } from '../../src/core/errors';
import type {
  RedisCommand,
  RedisReply,
  RedisSession,
  ResolvedRedisConfig,
  ScanOptions,
  ScanStep,
} from '../../src/drivers/redis-driver';
import type { RedisMode } from '../../src/shared/connection';

export type FakeRedisAnswer = (words: string[]) => RedisReply | Error | undefined;

const UTF8 = new TextDecoder();

export function commandWords(command: RedisCommand): string[] {
  return command.map((word) => (typeof word === 'string' ? word : UTF8.decode(word)));
}

/** Bytes of a text, as the server sends bulk strings. */
export function bulk(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export class FakeRedisSession implements RedisSession {
  readonly calls: string[][] = [];
  closed = false;
  /** Replies of `onMasters`, one per master; by default the one `call` gives. */
  masters: ((words: string[]) => RedisReply[]) | undefined;
  /** The keys `scanStep` walks, per master; the cursor is a position in the list. */
  keyspace: string[][] = [[]];
  /** Every scan step asked for: master, cursor, match, count. */
  readonly scans: { master: number; cursor: string; match?: string; count: number }[] = [];
  /** Thrown by scanStep() when set. */
  scanError: Error | undefined;

  constructor(
    private readonly answer: FakeRedisAnswer = () => bulk('OK'),
    readonly mode: RedisMode = 'standalone',
    readonly database = 0,
  ) {}

  async call(command: RedisCommand): Promise<RedisReply> {
    const words = commandWords(command);
    this.calls.push(words);
    if (this.closed) {
      throw new DbError('connection-failed', 'Connection is closed.');
    }
    const reply = this.answer(words);
    if (reply instanceof Error) {
      throw reply;
    }
    return await Promise.resolve(reply ?? null);
  }

  async pipeline(commands: readonly RedisCommand[]): Promise<RedisReply[]> {
    const replies: RedisReply[] = [];
    for (const command of commands) {
      try {
        replies.push(await this.call(command));
      } catch (error) {
        if (error instanceof DbError && error.code === 'connection-failed') {
          throw error;
        }
        replies.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    return replies;
  }

  async onMasters(command: RedisCommand): Promise<RedisReply[]> {
    if (this.masters !== undefined) {
      const words = commandWords(command);
      this.calls.push(words);
      return await Promise.resolve(this.masters(words));
    }
    return [await this.call(command)];
  }

  async scanStep(master: number, cursor: string, options: ScanOptions): Promise<ScanStep> {
    this.scans.push({
      master,
      cursor,
      ...(options.match === undefined ? {} : { match: options.match }),
      count: options.count,
    });
    if (this.scanError !== undefined) {
      throw this.scanError;
    }
    const keys = this.keyspace[master] ?? [];
    const start = Number(cursor);
    const end = Math.min(keys.length, start + options.count);
    const pattern = options.match === undefined ? undefined : globRegex(options.match);
    return await Promise.resolve({
      cursor: end >= keys.length ? '0' : String(end),
      keys: keys
        .slice(start, end)
        .filter((key) => pattern === undefined || pattern.test(key))
        .map(bulk),
      masters: this.keyspace.length,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.resolve();
  }
}

/** Redis glob (`*`, `?`, `[…]`, `\\x`) as a regular expression, enough for the fakes. */
export function globRegex(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] ?? '';
    if (char === '\\' && index + 1 < glob.length) {
      source += (glob[++index] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else if (char === '[') {
      const end = glob.indexOf(']', index);
      source +=
        end === -1
          ? '\\['
          : glob
              .slice(index, end + 1)
              .replace('[^', '[^')
              .replace('[!', '[^');
      index = end === -1 ? index : end;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 's');
}

/** A Redis driver that opens fake sessions and remembers what it was asked. */
export class FakeRedisDriver {
  readonly id = 'redis' as const;
  readonly opened: ResolvedRedisConfig[] = [];
  readonly sessions: FakeRedisSession[] = [];
  /** Thrown by openSession() when set. */
  openError: Error | undefined;

  constructor(private readonly answer: FakeRedisAnswer = () => bulk('OK')) {}

  openSession(config: ResolvedRedisConfig): Promise<RedisSession> {
    this.opened.push(config);
    if (this.openError !== undefined) {
      return Promise.reject(this.openError);
    }
    const mode = config.redis?.mode ?? 'standalone';
    const session = new FakeRedisSession(this.answer, mode, Number(config.database ?? '0'));
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}
