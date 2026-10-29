// A Redis session for unit tests: replies are answered by a function of the command,
// and every call is recorded as text.

import { DbError } from '../../src/core/errors';
import type {
  RedisCommand,
  RedisReply,
  RedisSession,
  ResolvedRedisConfig,
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

  async close(): Promise<void> {
    this.closed = true;
    await Promise.resolve();
  }
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
