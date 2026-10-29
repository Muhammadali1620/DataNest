// A Redis session over ioredis (V7.1). Replies come back as the server wrote them —
// bytes, integers as text — so binary values and 64-bit numbers survive (D24, D81).

import { Cluster, Redis } from 'ioredis';
import { DbError, errorMessage } from '../../core/errors';
import type { RedisMode } from '../../shared/connection';
import { tlsFailure, tlsMaterial } from '../common/tls';
import type {
  RedisArg,
  RedisCommand,
  RedisReply,
  RedisSession,
  ResolvedRedisConfig,
} from '../redis-driver';
import { isReplyError, toRedisDbError } from './errors';
import { redisTarget } from './options';

type Client = Redis | Cluster;

function toBuffer(arg: RedisArg): string | Buffer {
  return typeof arg === 'string' ? arg : Buffer.from(arg.buffer, arg.byteOffset, arg.byteLength);
}

/** ioredis values as `RedisReply`: nested errors become `{ error }`, numbers text. */
export function normalizeReply(value: unknown): RedisReply {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Uint8Array || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Error) {
    return { error: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => normalizeReply(item));
  }
  // RESP2 has nothing else; a new client version might, and it should show, not crash.
  return typeof value === 'boolean' ? String(value) : Object.prototype.toString.call(value);
}

function nameOf(command: RedisCommand): string {
  const [name] = command;
  if (name === undefined) {
    throw new DbError('syntax', 'No command to run');
  }
  return typeof name === 'string' ? name : new TextDecoder().decode(name);
}

class IoredisSession implements RedisSession {
  /** The last error the client reported on its own; it explains "Connection is closed". */
  private lastError: unknown;

  constructor(
    private readonly client: Client,
    readonly mode: RedisMode,
    readonly database: number,
  ) {
    client.on('error', (error: unknown) => {
      this.lastError = error;
    });
  }

  async call(command: RedisCommand): Promise<RedisReply> {
    const name = nameOf(command);
    try {
      return normalizeReply(await this.client.callBuffer(name, ...command.slice(1).map(toBuffer)));
    } catch (error) {
      throw this.failure(error);
    }
  }

  async pipeline(commands: readonly RedisCommand[]): Promise<RedisReply[]> {
    if (commands.length === 0) {
      return [];
    }
    if (this.client instanceof Cluster) {
      // Sent at once, each to the node of its key: they travel without waiting for each other.
      return await Promise.all(commands.map((command) => this.callKeepingErrors(command)));
    }
    const pipeline = this.client.pipeline();
    for (const command of commands) {
      pipeline.callBuffer(nameOf(command), ...command.slice(1).map(toBuffer));
    }
    let results: [Error | null, unknown][] | null;
    try {
      results = await pipeline.exec();
    } catch (error) {
      throw this.failure(error);
    }
    if (results === null) {
      throw this.failure(new Error('Connection is closed.'));
    }
    return results.map(([error, value]) => {
      if (error === null) {
        return normalizeReply(value);
      }
      if (isReplyError(error)) {
        return { error: error.message };
      }
      throw this.failure(error);
    });
  }

  async onMasters(command: RedisCommand): Promise<RedisReply[]> {
    if (!(this.client instanceof Cluster)) {
      return [await this.call(command)];
    }
    const name = nameOf(command);
    try {
      return await Promise.all(
        this.client
          .nodes('master')
          .map(async (node) =>
            normalizeReply(await node.callBuffer(name, ...command.slice(1).map(toBuffer))),
          ),
      );
    } catch (error) {
      throw this.failure(error);
    }
  }

  async close(): Promise<void> {
    this.client.disconnect();
    await Promise.resolve();
  }

  private async callKeepingErrors(command: RedisCommand): Promise<RedisReply> {
    try {
      return normalizeReply(
        await this.client.callBuffer(nameOf(command), ...command.slice(1).map(toBuffer)),
      );
    } catch (error) {
      if (isReplyError(error)) {
        return { error: errorMessage(error) };
      }
      throw this.failure(error);
    }
  }

  /** A failed call; a closed link says why it closed when the client knows. */
  private failure(error: unknown): DbError {
    const mapped = toRedisDbError(error);
    if (mapped.code === 'connection-failed' && this.lastError !== undefined) {
      const cause = toRedisDbError(this.lastError);
      return new DbError('connection-failed', `${mapped.message} ${errorMessage(cause)}`, {
        cause: error,
      });
    }
    return mapped;
  }
}

/** Why a connect failed: the client's last reported error says more than "closed". */
function connectFailure(error: unknown, lastError: unknown, serverName: string): DbError {
  const nodeError = (error as { lastNodeError?: unknown } | null)?.lastNodeError;
  const reason = lastError ?? nodeError ?? error;
  const tls = tlsFailure(reason, serverName);
  if (tls !== undefined) {
    return tls;
  }
  const mapped = toRedisDbError(reason);
  // A refused password or an unknown host is about connecting, whatever the reply says.
  return mapped.code === 'internal' || mapped.code === 'busy'
    ? new DbError('connection-failed', mapped.message, { cause: reason })
    : mapped;
}

export async function openRedisSession(config: ResolvedRedisConfig): Promise<RedisSession> {
  const tls = await tlsMaterial(config);
  const target = redisTarget(config, tls);
  const client: Client =
    target.mode === 'cluster'
      ? new Cluster(target.nodes, target.options)
      : new Redis(target.options);
  let lastError: unknown;
  const remember = (error: unknown): void => {
    lastError = error;
  };
  // Without a listener ioredis prints every error to the console.
  client.on('error', remember);
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    throw connectFailure(error, lastError, tls?.serverName ?? '');
  }
  const database = Number((config.database ?? '').trim() || '0');
  const session = new IoredisSession(client, target.mode, database);
  client.off('error', remember);
  if (database !== 0) {
    // ioredis selects the database without saying when the server refuses the number.
    try {
      await session.call(['SELECT', String(database)]);
    } catch (error) {
      await session.close();
      const cause = toRedisDbError(error);
      throw new DbError('not-found', `Database ${database} does not exist: ${cause.message}`, {
        cause,
      });
    }
  }
  return session;
}
