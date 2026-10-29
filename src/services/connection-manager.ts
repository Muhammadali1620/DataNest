// Owns live connections: who is connected, which editor holds which session, and
// what happens when a link drops (ARCHITECTURE.md §3). Knows nothing about vscode.

import { type Disposable, toDisposable } from '../core/disposable';
import { DbError, errorMessage, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type {
  ConnectionConfig,
  ConnectionInput,
  ResolvedConnectionConfig,
  SshHopSecrets,
} from '../shared/connection';
import {
  type DriverFamily,
  driverFamily,
  isSqlDriver,
  optionSupport,
  type SqlDriverId,
} from '../shared/connection';
import { setUpSession } from './session-setup';
import type { Driver, Session, TransactionState } from '../drivers/driver';
import type { MongoDriver, MongoSession } from '../drivers/mongo-driver';
import type { RedisDriver, RedisSession } from '../drivers/redis-driver';
import type { ConnectionStore } from './connection-store';
import { ManagedSession } from './managed-session';
import { ManagedMongoSession } from './mongodb/managed-mongo-session';
import { ManagedRedisSession } from './redis/managed-redis-session';
import { setUpRedisSession } from './redis/redis-setup';
import {
  type HostKeyCheck,
  type Tunnel,
  type TunnelLease,
  tunnelKeyOf,
  type TunnelSpec,
  tunnelSpecOf,
} from './tunnels';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionState {
  readonly status: ConnectionStatus;
  /** Short message of the last failure; only with status `error`. */
  readonly error?: string;
}

/** Which connection (and database) a session should talk to. */
export interface SessionTarget {
  readonly connectionId: string;
  /** Overrides the connection's own database, e.g. after switching it in the editor. */
  readonly database?: string;
}

/** The slice of DriverRegistry the manager needs (`DriverRegistry` satisfies it). */
export interface DriverProvider {
  get(id: SqlDriverId): Promise<Driver>;
  /** Needed only by Redis connections. */
  getRedis?(): Promise<RedisDriver>;
  /** Needed only by MongoDB connections. */
  getMongo?(): Promise<MongoDriver>;
}

/** The slice of TunnelPool the manager needs. */
export interface TunnelProvider {
  acquire(key: string, spec: TunnelSpec): Promise<TunnelLease>;
  openPrivate(spec: TunnelSpec): Promise<Tunnel>;
}

export interface ConnectionManagerDeps {
  readonly store: ConnectionStore;
  readonly drivers: DriverProvider;
  readonly logger: Logger;
  /** Needed only by connections that go through SSH. */
  readonly tunnels?: TunnelProvider;
  /** Asked before trusting an SSH server's key; without it every key is refused. */
  readonly checkHostKey?: HostKeyCheck;
}

const REFUSE_HOST_KEY: HostKeyCheck = () => Promise.resolve(false);

/** Where a driver should connect instead of the saved host: a local tunnel port. */
interface Endpoint {
  readonly port: number;
}

/** A live session of an owner: SQL, Redis (D81) or MongoDB (D88). */
type Holder =
  | { readonly family: 'sql'; readonly target: SessionTarget; readonly session: Session }
  | { readonly family: 'redis'; readonly target: SessionTarget; readonly session: RedisSession }
  | { readonly family: 'mongodb'; readonly target: SessionTarget; readonly session: MongoSession };

const DISCONNECTED: ConnectionState = { status: 'disconnected' };

/** A session's transaction changed: a statement opened or ended it, or the session went. */
export interface TransactionChange {
  readonly owner: string;
  readonly connectionId: string;
  readonly state: TransactionState;
  /**
   * Set when the session closed (`closed`) or its link dropped (`lost`) while a
   * transaction was open: the server rolled it back.
   */
  readonly ended?: 'closed' | 'lost';
}

/**
 * Sessions are per owner: each SQL editor gets its own, so a slow query in one tab
 * never blocks another. The tree shares one session per connection (owner `tree:<id>`).
 */
export class ConnectionManager implements Disposable {
  private readonly store: ConnectionStore;
  private readonly drivers: DriverProvider;
  private readonly logger: Logger;
  private readonly tunnels: TunnelProvider | undefined;
  private readonly checkHostKey: HostKeyCheck;
  private readonly holders = new Map<string, Holder>();
  private readonly opening = new Map<string, Promise<Holder>>();
  private readonly states = new Map<string, ConnectionState>();
  private readonly listeners = new Set<(connectionId: string) => void>();
  private readonly transactionListeners = new Set<(change: TransactionChange) => void>();
  private disposed = false;

  constructor(deps: ConnectionManagerDeps) {
    this.store = deps.store;
    this.drivers = deps.drivers;
    this.logger = deps.logger.child('connections');
    this.tunnels = deps.tunnels;
    this.checkHostKey = deps.checkHostKey ?? REFUSE_HOST_KEY;
  }

  /**
   * Owner key of the session the tree and completion share. Drivers whose session
   * sees only its own database get one session per database, so browsing does not
   * reconnect on every switch; `disconnect` still closes all of them together.
   */
  static treeOwner(connectionId: string, database?: string): string {
    return database === undefined ? `tree:${connectionId}` : `tree:${connectionId}:${database}`;
  }

  /**
   * Owner key of a session a long task keeps to itself (running a file, a dump),
   * so the task never waits for an editor and an editor never waits for it.
   */
  static taskOwner(name: string): string {
    return `task:${name}`;
  }

  /** Owner key of the session belonging to one SQL editor. */
  static editorOwner(documentUri: string): string {
    return `editor:${documentUri}`;
  }

  getState(connectionId: string): ConnectionState {
    return this.states.get(connectionId) ?? DISCONNECTED;
  }

  /** Fires with the connection id whose state changed. */
  onDidChangeState(listener: (connectionId: string) => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  /** Fires when the transaction of a session changes (V4.8). */
  onDidChangeTransaction(listener: (change: TransactionChange) => void): Disposable {
    this.transactionListeners.add(listener);
    return toDisposable(() => this.transactionListeners.delete(listener));
  }

  /**
   * The transaction state of an owner's session as the server last reported it;
   * undefined when it holds no session or the driver cannot tell.
   */
  transactionState(owner: string): TransactionState | undefined {
    return transactionOf(this.holders.get(owner));
  }

  /** Owners of a connection whose session has a transaction open or failed. */
  ownersInTransaction(connectionId: string): string[] {
    return [...this.holders.entries()]
      .filter(([, held]) => held.target.connectionId === connectionId)
      .filter(([, held]) => {
        const state = transactionOf(held);
        return state === 'open' || state === 'failed';
      })
      .map(([owner]) => owner);
  }

  /** The live SQL session of an owner, or undefined when it holds none. */
  sessionOf(owner: string): Session | undefined {
    const held = this.holders.get(owner);
    return held?.family === 'sql' ? held.session : undefined;
  }

  /** The live Redis session of an owner, or undefined when it holds none. */
  redisSessionOf(owner: string): RedisSession | undefined {
    const held = this.holders.get(owner);
    return held?.family === 'redis' ? held.session : undefined;
  }

  /** The live MongoDB session of an owner, or undefined when it holds none. */
  mongoSessionOf(owner: string): MongoSession | undefined {
    const held = this.holders.get(owner);
    return held?.family === 'mongodb' ? held.session : undefined;
  }

  /** Connection ids that currently hold at least one live session. */
  connectedIds(): string[] {
    return [...new Set([...this.holders.values()].map((held) => held.target.connectionId))];
  }

  /**
   * The session of `owner`, opening it on first use. When the owner already holds a
   * session for a different target, that one is closed first. A session whose link
   * dropped is replaced here, before the next statement — a failed statement is
   * never retried silently, because repeating a write is not safe.
   */
  async acquire(owner: string, target: SessionTarget): Promise<Session> {
    const held = await this.acquireHolder(owner, target, 'sql');
    if (held.family !== 'sql') {
      throw new DbError('internal', 'Expected a SQL session');
    }
    return held.session;
  }

  /** Like `acquire`, for a Redis connection (D81). */
  async acquireRedis(owner: string, target: SessionTarget): Promise<RedisSession> {
    const held = await this.acquireHolder(owner, target, 'redis');
    if (held.family !== 'redis') {
      throw new DbError('internal', 'Expected a Redis session');
    }
    return held.session;
  }

  /** Like `acquire`, for a MongoDB connection (D88). */
  async acquireMongo(owner: string, target: SessionTarget): Promise<MongoSession> {
    const held = await this.acquireHolder(owner, target, 'mongodb');
    if (held.family !== 'mongodb') {
      throw new DbError('internal', 'Expected a MongoDB session');
    }
    return held.session;
  }

  /** What the connection speaks; a SQL command never gets a Redis session, nor the reverse. */
  familyOf(connectionId: string): DriverFamily {
    return driverFamily(this.configOf(connectionId).driver);
  }

  private async acquireHolder(
    owner: string,
    target: SessionTarget,
    family: DriverFamily,
  ): Promise<Holder> {
    if (this.disposed) {
      throw new DbError('internal', 'The connection manager is disposed');
    }
    const config = this.configOf(target.connectionId);
    if (driverFamily(config.driver) !== family) {
      throw new DbError('unsupported', familyMismatch(config, family));
    }
    const held = this.holders.get(owner);
    if (held) {
      if (sameTarget(held.target, target)) {
        return held;
      }
      await this.release(owner);
    }
    let pending = this.opening.get(owner);
    if (!pending) {
      pending = this.open(owner, target);
      this.opening.set(owner, pending);
      pending.catch(() => undefined);
    }
    try {
      return await pending;
    } finally {
      if (this.opening.get(owner) === pending) {
        this.opening.delete(owner);
      }
    }
  }

  /** Opens a session for the tree, so the UI can show a connection as connected. */
  async connect(connectionId: string): Promise<Session> {
    return await this.acquire(ConnectionManager.treeOwner(connectionId), { connectionId });
  }

  /**
   * Connects a connection of either kind, for the tree's Connect command; a Redis
   * connection opens its tree session on the database it names.
   */
  async connectAny(connectionId: string): Promise<void> {
    if (this.familyOf(connectionId) === 'mongodb') {
      await this.acquireMongo(ConnectionManager.treeOwner(connectionId), { connectionId });
      return;
    }
    if (this.familyOf(connectionId) === 'redis') {
      await this.acquireRedis(
        ConnectionManager.treeOwner(connectionId, redisDatabaseOf(this.configOf(connectionId))),
        {
          connectionId,
        },
      );
      return;
    }
    await this.connect(connectionId);
  }

  /** Closes every session of a connection. Disconnecting an idle connection is a no-op. */
  async disconnect(connectionId: string): Promise<void> {
    const owners = [...this.holders.entries()]
      .filter(([, held]) => held.target.connectionId === connectionId)
      .map(([owner]) => owner);
    for (const owner of owners) {
      await this.release(owner);
    }
    this.setState(connectionId, DISCONNECTED);
  }

  /** Closes the session of one owner, e.g. when its editor is closed. */
  async release(owner: string): Promise<void> {
    const held = this.holders.get(owner);
    if (!held) {
      return;
    }
    this.holders.delete(owner);
    const transaction = transactionOf(held);
    try {
      await held.session.close();
    } catch (error) {
      // A failed close must not stop the caller: the socket is gone either way.
      this.logger.warn(`Closing the session of "${owner}" failed`, error);
    }
    const { connectionId } = held.target;
    this.endTransaction(owner, connectionId, transaction, 'closed');
    if (!this.connectedIds().includes(connectionId)) {
      this.setState(connectionId, DISCONNECTED);
    }
  }

  /**
   * Opens a throwaway session to check settings the user has not saved yet
   * ("Test connection" in the form). Never touches stored state or statuses.
   */
  async test(
    input: ConnectionInput,
    password?: string,
    ssh: Readonly<Record<string, SshHopSecrets>> = {},
    sentinelPassword?: string,
  ): Promise<void> {
    if (input.driver === 'redis') {
      await this.testRedis(input, password, ssh, sentinelPassword);
      return;
    }
    if (input.driver === 'mongodb') {
      await this.testMongo(input, password, ssh);
      return;
    }
    const driver = await this.drivers.get(input.driver);
    const spec = tunnelSpecOf(input, ssh, this.checkHostKey);
    const tunnel = spec === undefined ? undefined : await this.tunnelProvider().openPrivate(spec);
    try {
      const resolved = resolve({ ...input, id: 'test' }, {}, password, tunnel);
      let session: Session;
      try {
        session = await driver.openSession(resolved);
      } catch (error) {
        throw tunnel?.forwardError() ?? error;
      }
      try {
        // The time zone and init SQL are part of what "Test" checks.
        await setUpSession(session, input, driver.dialect);
        // Opening alone can succeed lazily; one statement proves the link works.
        await drain(session.execute('SELECT 1', { rowLimit: 1 }));
      } finally {
        await session.close().catch(() => undefined);
      }
    } finally {
      await tunnel?.close();
    }
  }

  private async testRedis(
    input: ConnectionInput,
    password: string | undefined,
    ssh: Readonly<Record<string, SshHopSecrets>>,
    sentinelPassword: string | undefined,
  ): Promise<void> {
    const driver = await this.redisDriver();
    const spec = tunnelSpecOf(input, ssh, this.checkHostKey);
    const tunnel = spec === undefined ? undefined : await this.tunnelProvider().openPrivate(spec);
    try {
      const resolved = {
        ...resolve({ ...input, id: 'test' }, {}, password, tunnel),
        ...(sentinelPassword === undefined || sentinelPassword === '' ? {} : { sentinelPassword }),
      };
      let session: RedisSession;
      try {
        session = await driver.openSession(resolved);
      } catch (error) {
        throw tunnel?.forwardError() ?? error;
      }
      try {
        // Init commands are part of what "Test" checks; PING proves the link answers.
        await setUpRedisSession(session, input);
        await session.call(['PING']);
      } finally {
        await session.close().catch(() => undefined);
      }
    } finally {
      await tunnel?.close();
    }
  }

  private async testMongo(
    input: ConnectionInput,
    password: string | undefined,
    ssh: Readonly<Record<string, SshHopSecrets>>,
  ): Promise<void> {
    const driver = await this.mongoDriver();
    const spec = tunnelSpecOf(input, ssh, this.checkHostKey);
    const tunnel = spec === undefined ? undefined : await this.tunnelProvider().openPrivate(spec);
    try {
      let session: MongoSession;
      try {
        // Opening signs in and asks the server who it is: that proves the link works.
        session = await driver.openSession(resolve({ ...input, id: 'test' }, {}, password, tunnel));
      } catch (error) {
        throw tunnel?.forwardError() ?? error;
      }
      await session.close().catch(() => undefined);
    } finally {
      await tunnel?.close();
    }
  }

  /** True when the saved connection refuses every change (V4.6). */
  isReadOnly(connectionId: string): boolean {
    return this.store.get(connectionId)?.readOnly === true;
  }

  /** The SQL driver of a saved connection, for its dialect and capabilities. */
  async driverOf(connectionId: string): Promise<Driver> {
    const config = this.configOf(connectionId);
    if (!isSqlDriver(config.driver)) {
      throw new DbError('unsupported', familyMismatch(config, 'sql'));
    }
    return await this.drivers.get(config.driver);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const holders = [...this.holders.values()];
    this.holders.clear();
    this.states.clear();
    this.listeners.clear();
    this.transactionListeners.clear();
    for (const held of holders) {
      // Fire and forget: dispose must not be async, and the host is going away.
      held.session.close().catch(() => undefined);
    }
  }

  private async open(owner: string, target: SessionTarget): Promise<Holder> {
    const { connectionId } = target;
    const config = this.configOf(connectionId);
    this.setState(connectionId, { status: 'connecting' });
    try {
      const holder =
        config.driver === 'redis'
          ? await this.openRedis(owner, target, config)
          : config.driver === 'mongodb'
            ? await this.openMongo(owner, target, config)
            : await this.openSql(owner, target, config, config.driver);
      this.holders.set(owner, holder);
      this.setState(connectionId, { status: 'connected' });
      this.logger.info(`Connected "${config.name}" for ${owner}`);
      return holder;
    } catch (error) {
      const dbError = toDbError(error, 'connection-failed');
      this.logger.error(`Could not connect "${config.name}"`, dbError);
      this.setState(connectionId, { status: 'error', error: errorMessage(dbError) });
      throw dbError;
    }
  }

  private async openSql(
    owner: string,
    target: SessionTarget,
    config: ConnectionConfig,
    driverId: SqlDriverId,
  ): Promise<Holder> {
    const { connectionId } = target;
    const driver = await this.drivers.get(driverId);
    const password = await this.store.getPassword(connectionId);
    const lease = await this.leaseTunnel(config);
    let opened: Session;
    try {
      opened = await driver.openSession(resolve(config, target, password, lease));
    } catch (error) {
      await lease?.release();
      // "Connection reset" says little; the SSH server's reason says what is wrong.
      throw lease?.forwardError() ?? error;
    }
    try {
      await setUpSession(opened, config, driver.dialect);
    } catch (error) {
      await opened.close().catch(() => undefined);
      await lease?.release();
      throw error;
    }
    await this.closeIfDisposed(opened, lease);
    const session = new ManagedSession(opened, {
      onLinkLost: (error) => {
        this.forget(owner, error);
      },
      onClosed: async () => {
        await lease?.release();
      },
      onTransaction: (state) => {
        this.notifyTransaction({ owner, connectionId, state });
      },
      keepAliveMs: keepAliveMsOf(config),
    });
    session.scheduleKeepAlive();
    return { family: 'sql', target, session };
  }

  private async openRedis(
    owner: string,
    target: SessionTarget,
    config: ConnectionConfig,
  ): Promise<Holder> {
    const driver = await this.redisDriver();
    const password = await this.store.getPassword(config.id);
    const sentinelPassword = await this.store.getSentinelPassword(config.id);
    const lease = await this.leaseTunnel(config);
    let opened: RedisSession;
    try {
      opened = await driver.openSession({
        ...resolve(config, target, password, lease),
        ...(sentinelPassword === undefined || sentinelPassword === '' ? {} : { sentinelPassword }),
      });
    } catch (error) {
      await lease?.release();
      throw lease?.forwardError() ?? error;
    }
    try {
      await setUpRedisSession(opened, config);
    } catch (error) {
      await opened.close().catch(() => undefined);
      await lease?.release();
      throw error;
    }
    await this.closeIfDisposed(opened, lease);
    const session = new ManagedRedisSession(opened, {
      onLinkLost: (error) => {
        this.forget(owner, error);
      },
      onClosed: async () => {
        await lease?.release();
      },
      keepAliveMs: keepAliveMsOf(config),
    });
    session.scheduleKeepAlive();
    return { family: 'redis', target, session };
  }

  private async openMongo(
    owner: string,
    target: SessionTarget,
    config: ConnectionConfig,
  ): Promise<Holder> {
    const driver = await this.mongoDriver();
    const password = await this.store.getPassword(config.id);
    const lease = await this.leaseTunnel(config);
    let opened: MongoSession;
    try {
      opened = await driver.openSession(resolve(config, target, password, lease));
    } catch (error) {
      await lease?.release();
      throw lease?.forwardError() ?? error;
    }
    await this.closeIfDisposed(opened, lease);
    const session = new ManagedMongoSession(opened, {
      onLinkLost: (error) => {
        this.forget(owner, error);
      },
      onClosed: async () => {
        await lease?.release();
      },
      keepAliveMs: keepAliveMsOf(config),
    });
    session.scheduleKeepAlive();
    return { family: 'mongodb', target, session };
  }

  /** A connect that finished after dispose() must not leave a live link behind. */
  private async closeIfDisposed(
    opened: { close(): Promise<void> },
    lease: TunnelLease | undefined,
  ): Promise<void> {
    if (this.disposed) {
      await opened.close().catch(() => undefined);
      await lease?.release();
      throw new DbError('internal', 'The connection manager is disposed');
    }
  }

  private async redisDriver(): Promise<RedisDriver> {
    if (this.drivers.getRedis === undefined) {
      throw new DbError('unsupported', 'Redis is not available');
    }
    return await this.drivers.getRedis();
  }

  private async mongoDriver(): Promise<MongoDriver> {
    if (this.drivers.getMongo === undefined) {
      throw new DbError('unsupported', 'MongoDB is not available');
    }
    return await this.drivers.getMongo();
  }

  /**
   * Drops a session whose link is gone. The statement that hit the broken link
   * still fails — repeating it could repeat a write — but the next acquire()
   * for this owner opens a fresh connection.
   */
  private forget(owner: string, error: unknown): void {
    const held = this.holders.get(owner);
    if (!held) {
      return;
    }
    this.holders.delete(owner);
    const { connectionId } = held.target;
    this.logger.warn(`The connection of "${owner}" was lost`, error);
    // The driver still remembers the last state it saw; the server rolled it back.
    this.endTransaction(owner, connectionId, transactionOf(held), 'lost');
    held.session.close().catch(() => undefined);
    if (!this.connectedIds().includes(connectionId)) {
      this.setState(connectionId, { status: 'error', error: errorMessage(error) });
    }
  }

  private async leaseTunnel(config: ConnectionConfig): Promise<TunnelLease | undefined> {
    const spec = tunnelSpecOf(
      config,
      config.ssh === undefined ? {} : await this.store.getSshSecrets(config.id),
      this.checkHostKey,
    );
    if (spec === undefined) {
      return undefined;
    }
    return await this.tunnelProvider().acquire(tunnelKeyOf(config.id, config), spec);
  }

  private tunnelProvider(): TunnelProvider {
    if (this.tunnels === undefined) {
      throw new DbError('unsupported', 'SSH tunnels are not available');
    }
    return this.tunnels;
  }

  private configOf(connectionId: string): ConnectionConfig {
    const config = this.store.get(connectionId);
    if (!config) {
      throw new DbError('not-found', `Connection "${connectionId}" does not exist`);
    }
    return config;
  }

  private endTransaction(
    owner: string,
    connectionId: string,
    state: TransactionState | undefined,
    ended: 'closed' | 'lost',
  ): void {
    if (state === 'open' || state === 'failed') {
      this.logger.warn(`The open transaction of "${owner}" ended with its session (${ended})`);
      this.notifyTransaction({ owner, connectionId, state: 'idle', ended });
    }
  }

  private notifyTransaction(change: TransactionChange): void {
    for (const listener of [...this.transactionListeners]) {
      try {
        listener(change);
      } catch (error) {
        this.logger.warn('A transaction listener failed', error);
      }
    }
  }

  private setState(connectionId: string, state: ConnectionState): void {
    const previous = this.getState(connectionId);
    if (previous.status === state.status && previous.error === state.error) {
      return;
    }
    if (state.status === 'disconnected') {
      this.states.delete(connectionId);
    } else {
      this.states.set(connectionId, state);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(connectionId);
      } catch (error) {
        this.logger.warn('A connection state listener failed', error);
      }
    }
  }
}

/** Why a connection cannot give the session a command asked for. */
function familyMismatch(config: ConnectionConfig, wanted: DriverFamily): string {
  const actual = driverFamily(config.driver);
  if (wanted === 'sql') {
    return actual === 'redis'
      ? `"${config.name}" is a Redis connection: it runs Redis commands, not SQL`
      : `"${config.name}" is a MongoDB connection: it has collections, not SQL tables`;
  }
  return wanted === 'redis'
    ? `"${config.name}" is not a Redis connection`
    : `"${config.name}" is not a MongoDB connection`;
}

/** What the driver last said about the transaction; Redis has none to report. */
function transactionOf(held: Holder | undefined): TransactionState | undefined {
  return held?.family === 'sql' ? held.session.transactionState?.() : undefined;
}

function keepAliveMsOf(config: ConnectionConfig): number {
  return optionSupport(config.driver).keepAlive ? (config.options?.keepAlive ?? 0) * 1000 : 0;
}

/** The database a Redis connection opens: the number it names, or 0. */
export function redisDatabaseOf(config: Pick<ConnectionInput, 'database'>): string {
  const database = (config.database ?? '').trim();
  return database === '' ? '0' : String(Number(database));
}

function sameTarget(a: SessionTarget, b: SessionTarget): boolean {
  return a.connectionId === b.connectionId && a.database === b.database;
}

function resolve(
  config: ConnectionConfig,
  target: Partial<SessionTarget>,
  password: string | undefined,
  endpoint: Endpoint | undefined,
): ResolvedConnectionConfig {
  return {
    ...config,
    ...(target.database === undefined ? {} : { database: target.database }),
    ...(password === undefined || password === '' ? {} : { password }),
    // Through a tunnel the driver talks to a local port, but TLS still checks the
    // certificate against the server's own name.
    ...(endpoint === undefined
      ? {}
      : {
          host: '127.0.0.1',
          port: endpoint.port,
          ...(config.host === undefined ? {} : { tlsServerName: config.host }),
        }),
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // The values do not matter: reaching the end proves the session answers.
  }
}
