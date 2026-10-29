// What a Redis driver offers (V7.1). Redis is not SQL: it has no dialect, tables or
// statements, so it does not implement `Driver` and `Session` (D81). The connection
// manager still opens, keeps and drops its sessions like any other, and the Redis
// UI (key tree, value editor, console) talks to it through these types only.

import type { RedisMode, ResolvedConnectionConfig } from '../shared/connection';

/** An argument of a command: text, or bytes for binary-safe keys and values. */
export type RedisArg = string | Uint8Array;

/** A command and its arguments, e.g. `['HGET', key, field]`. */
export type RedisCommand = readonly RedisArg[];

/**
 * An error the server returned in place of one reply, inside an array (a pipeline or
 * `EXEC`). A plain object, not a class: the driver is a bundle of its own.
 */
export interface RedisErrorReply {
  readonly error: string;
}

/**
 * A reply as the server sent it (RESP2): bulk and status strings as bytes, because
 * values are binary-safe; an integer as decimal text, because it is 64-bit and a double
 * would round it; arrays nested; `null` for a missing value.
 */
export type RedisReply = null | string | Uint8Array | RedisErrorReply | readonly RedisReply[];

export function isErrorReply(reply: RedisReply): reply is RedisErrorReply {
  return (
    typeof reply === 'object' &&
    reply !== null &&
    !(reply instanceof Uint8Array) &&
    !Array.isArray(reply)
  );
}

/** What the Sentinel password adds to a resolved config; it is a secret of its own. */
export interface ResolvedRedisConfig extends ResolvedConnectionConfig {
  readonly sentinelPassword?: string;
}

/** One live Redis connection: a server, the master a Sentinel names, or a whole cluster. */
export interface RedisSession {
  readonly mode: RedisMode;
  /** The database the session works in; a cluster has only 0. */
  readonly database: number;
  /**
   * Runs one command. An error reply rejects with a DbError; a lost link with code
   * `connection-failed`, after which the session is unusable (D26).
   */
  call(command: RedisCommand): Promise<RedisReply>;
  /**
   * Runs several commands in one round trip (in a cluster, one per node) and returns
   * their replies in order; an error reply stays in its place as `RedisErrorReply`.
   * Not atomic: other clients' commands may come in between.
   */
  pipeline(commands: readonly RedisCommand[]): Promise<RedisReply[]>;
  /**
   * Runs a keyless command on every master that holds keys and returns each reply,
   * e.g. `DBSIZE` of a cluster. A server or a Sentinel's master has one.
   */
  onMasters(command: RedisCommand): Promise<RedisReply[]>;
  /** Closes the connection; the session is unusable afterwards. */
  close(): Promise<void>;
}

/** Opens Redis sessions; holds no connections itself. */
export interface RedisDriver {
  readonly id: 'redis';
  openSession(config: ResolvedRedisConfig): Promise<RedisSession>;
}

/** The shape of the lazily loaded bundle dist/drivers/redis.js. */
export interface RedisDriverModule {
  readonly driver: RedisDriver;
}
