// Owns live connections: who is connected, which editor holds which session, and
// what happens when a link drops (ARCHITECTURE.md §3). Knows nothing about vscode.

import { type Disposable, toDisposable } from '../core/disposable';
import { DbError, errorMessage, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type {
  ConnectionConfig,
  ConnectionInput,
  ResolvedConnectionConfig,
} from '../core/model/connection';
import type { DriverId } from '../core/model/connection';
import type { Driver, Session } from '../drivers/driver';
import type { ConnectionStore } from './connection-store';
import { ManagedSession } from './managed-session';

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

export interface ConnectionManagerDeps {
  readonly store: ConnectionStore;
  readonly drivers: DriverProvider;
  readonly logger: Logger;
}

interface Holder {
  readonly target: SessionTarget;
  readonly session: Session;
}

const DISCONNECTED: ConnectionState = { status: 'disconnected' };

/**
 * Sessions are per owner: each SQL editor gets its own, so a slow query in one tab
 * never blocks another. The tree shares one session per connection (owner `tree:<id>`).
 */
export class ConnectionManager implements Disposable {
  private readonly store: ConnectionStore;
  private readonly drivers: DriverProvider;
  private readonly logger: Logger;
  private readonly holders = new Map<string, Holder>();
  private readonly opening = new Map<string, Promise<Session>>();
  private readonly states = new Map<string, ConnectionState>();
  private readonly listeners = new Set<(connectionId: string) => void>();
  private disposed = false;

  constructor(deps: ConnectionManagerDeps) {
    this.store = deps.store;
    this.drivers = deps.drivers;
    this.logger = deps.logger.child('connections');
  }

  /** Owner key of the session the tree and completion share. */
  static treeOwner(connectionId: string): string {
    return `tree:${connectionId}`;
  }

  getState(connectionId: string): ConnectionState {
    return this.states.get(connectionId) ?? DISCONNECTED;
  }

  /** Fires with the connection id whose state changed. */
  onDidChangeState(listener: (connectionId: string) => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
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
    try {
      await held.session.close();
    } catch (error) {
      // A failed close must not stop the caller: the socket is gone either way.
      this.logger.warn(`Closing the session of "${owner}" failed`, error);
    }
    const { connectionId } = held.target;
    if (!this.connectedIds().includes(connectionId)) {
      this.setState(connectionId, DISCONNECTED);
    }
  }

  /**
   * Opens a throwaway session to check settings the user has not saved yet
   * ("Test connection" in the form). Never touches stored state or statuses.
   */
  async test(input: ConnectionInput, password?: string): Promise<void> {
    const driver = await this.drivers.get(input.driver);
    const resolved: ResolvedConnectionConfig = {
      ...input,
      id: 'test',
      ...(password === undefined || password === '' ? {} : { password }),
    };
    const session = await driver.openSession(resolved);
    try {
      // Opening alone can succeed lazily; one statement proves the link works.
      await drain(session.execute('SELECT 1', { rowLimit: 1 }));
    } finally {
      await session.close().catch(() => undefined);
    }
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
      const opened = await driver.openSession(resolve(config, target, password));
      if (this.disposed) {
        await opened.close().catch(() => undefined);
        throw new DbError('internal', 'The connection manager is disposed');
      }
      const session = new ManagedSession(opened, (error) => {
        this.forget(owner, error);
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
    held.session.close().catch(() => undefined);
    if (!this.connectedIds().includes(connectionId)) {
      this.setState(connectionId, { status: 'error', error: errorMessage(error) });
    }
  }

  private configOf(connectionId: string): ConnectionConfig {
    const config = this.store.get(connectionId);
    if (!config) {
      throw new DbError('not-found', `Connection "${connectionId}" does not exist`);
    }
    return config;
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
  target: SessionTarget,
  password: string | undefined,
): ResolvedConnectionConfig {
  return {
    ...config,
    ...(target.database === undefined ? {} : { database: target.database }),
    ...(password === undefined || password === '' ? {} : { password }),
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // The values do not matter: reaching the end proves the session answers.
  }
}
