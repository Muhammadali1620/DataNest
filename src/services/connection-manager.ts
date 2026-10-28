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
import type { DriverId } from '../shared/connection';
import type { Driver, Session, TransactionState } from '../drivers/driver';
import type { ConnectionStore } from './connection-store';
import { ManagedSession } from './managed-session';
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
  get(id: DriverId): Promise<Driver>;
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

interface Holder {
  readonly target: SessionTarget;
  readonly session: Session;
}

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
  private readonly opening = new Map<string, Promise<Session>>();
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
    return this.holders.get(owner)?.session.transactionState?.();
  }

  /** Owners of a connection whose session has a transaction open or failed. */
  ownersInTransaction(connectionId: string): string[] {
    return [...this.holders.entries()]
      .filter(([, held]) => held.target.connectionId === connectionId)
      .filter(([, held]) => {
        const state = held.session.transactionState?.();
        return state === 'open' || state === 'failed';
      })
      .map(([owner]) => owner);
  }

  /** The live session of an owner, or undefined when it holds none. */
  sessionOf(owner: string): Session | undefined {
    return this.holders.get(owner)?.session;
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
    if (this.disposed) {
      throw new DbError('internal', 'The connection manager is disposed');
    }
    const held = this.holders.get(owner);
    if (held) {
      if (sameTarget(held.target, target)) {
        return held.session;
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
    const transaction = held.session.transactionState?.();
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
  ): Promise<void> {
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
        // Opening alone can succeed lazily; one statement proves the link works.
        await drain(session.execute('SELECT 1', { rowLimit: 1 }));
      } finally {
        await session.close().catch(() => undefined);
      }
    } finally {
      await tunnel?.close();
    }
  }

  /** True when the saved connection refuses every change (V4.6). */
  isReadOnly(connectionId: string): boolean {
    return this.store.get(connectionId)?.readOnly === true;
  }

  /** The driver of a saved connection, for its dialect and capabilities. */
  async driverOf(connectionId: string): Promise<Driver> {
    return await this.drivers.get(this.configOf(connectionId).driver);
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

  private async open(owner: string, target: SessionTarget): Promise<Session> {
    const { connectionId } = target;
    const config = this.configOf(connectionId);
    this.setState(connectionId, { status: 'connecting' });
    try {
      const driver = await this.drivers.get(config.driver);
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
      if (this.disposed) {
        await opened.close().catch(() => undefined);
        await lease?.release();
        throw new DbError('internal', 'The connection manager is disposed');
      }
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
      });
      this.holders.set(owner, { target, session });
      this.setState(connectionId, { status: 'connected' });
      this.logger.info(`Connected "${config.name}" for ${owner}`);
      return session;
    } catch (error) {
      const dbError = toDbError(error, 'connection-failed');
      this.logger.error(`Could not connect "${config.name}"`, dbError);
      this.setState(connectionId, { status: 'error', error: errorMessage(dbError) });
      throw dbError;
    }
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
    this.endTransaction(owner, connectionId, held.session.transactionState?.(), 'lost');
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
