// SSH tunnels in front of database connections. The tunnel itself (ssh2) is a
// bundle of its own, dist/ssh.js, loaded on the first SSH connection (§7); this
// file holds what the rest of the extension sees of it and shares one tunnel
// between all sessions of a connection.

import { createRequire } from 'node:module';
import { DbError, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import {
  type ConnectionInput,
  effectivePort,
  effectiveSshPort,
  type SshAuthMethod,
  type SshHopSecrets,
  sshHopsOf,
} from '../shared/connection';

/** How long each SSH server may take to answer and log us in. */
export const SSH_TIMEOUT_MS = 10_000;

/** One SSH server of the chain, with its secrets resolved. */
export interface TunnelHop {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SshAuthMethod;
  readonly password?: string;
  readonly keyFile?: string;
  readonly passphrase?: string;
  readonly agentSocket?: string;
}

/** What the user is asked to trust before the first connection to a server. */
export interface HostKeyInfo {
  readonly host: string;
  readonly port: number;
  /** e.g. `ssh-ed25519`. */
  readonly algorithm: string;
  /** OpenSSH style: `SHA256:` + unpadded base64 of the key's SHA-256. */
  readonly fingerprint: string;
}

/** Resolves true when the server's key may be trusted. */
export type HostKeyCheck = (key: HostKeyInfo) => Promise<boolean>;

export interface TunnelSpec {
  /** Connected in order: each later hop is reached through the one before it. */
  readonly hops: readonly TunnelHop[];
  /** The database server, as the last hop sees it. */
  readonly target: { readonly host: string; readonly port: number };
  readonly checkHostKey: HostKeyCheck;
  /** Per hop: how long the SSH handshake and login may take. */
  readonly timeoutMs: number;
}

export interface Tunnel {
  /** A port on 127.0.0.1 that leads to the target. */
  readonly port: number;
  /** Settles once the tunnel is gone, closed on purpose or not. */
  readonly closed: Promise<void>;
  /** Why the last forwarded connection failed, so a driver error can be explained. */
  forwardError(): DbError | undefined;
  close(): Promise<void>;
}

/**
 * The tunnel a config asks for, with secrets joined in by hop id; undefined when
 * the config connects directly.
 */
export function tunnelSpecOf(
  config: ConnectionInput,
  secrets: Readonly<Record<string, SshHopSecrets>>,
  checkHostKey: HostKeyCheck,
): TunnelSpec | undefined {
  const hops = sshHopsOf(config);
  const port = effectivePort(config);
  if (hops.length === 0 || config.host === undefined || port === undefined) {
    return undefined;
  }
  return {
    hops: hops.map((hop) => {
      const secret = secrets[hop.id] ?? {};
      return {
        host: hop.host,
        port: effectiveSshPort(hop),
        user: hop.user,
        auth: hop.auth,
        ...(hop.auth === 'password' && secret.password !== undefined
          ? { password: secret.password }
          : {}),
        ...(hop.auth === 'key' && hop.keyFile !== undefined ? { keyFile: hop.keyFile } : {}),
        ...(hop.auth === 'key' && secret.passphrase !== undefined
          ? { passphrase: secret.passphrase }
          : {}),
        ...(hop.auth === 'agent' && hop.agentSocket !== undefined
          ? { agentSocket: hop.agentSocket }
          : {}),
      };
    }),
    target: { host: config.host, port },
    checkHostKey,
    timeoutMs: (config.options?.connectTimeout ?? SSH_TIMEOUT_MS / 1000) * 1000,
  };
}

/**
 * Names the shared tunnel of a saved connection. Built from everything that decides
 * where the tunnel leads, so editing the settings never reuses an old tunnel.
 */
export function tunnelKeyOf(connectionId: string, config: ConnectionInput): string {
  return JSON.stringify([connectionId, config.host, effectivePort(config), sshHopsOf(config)]);
}

/** The shape of dist/ssh.js. */
export interface SshModule {
  openTunnel(spec: TunnelSpec, logger: Logger): Promise<Tunnel>;
}

export type SshLoader = () => Promise<SshModule>;

/** Resolves `./ssh.js` next to the running bundle, like the drivers. */
export function createBundleSshLoader(bundlePath: string): SshLoader {
  const requireFromBundle = createRequire(bundlePath);
  return () => Promise.resolve(requireFromBundle('./ssh.js') as SshModule);
}

/** A tunnel handed to one session; `release` is safe to call more than once. */
export interface TunnelLease {
  readonly port: number;
  forwardError(): DbError | undefined;
  release(): Promise<void>;
}

export interface TunnelPoolDeps {
  readonly load: SshLoader;
  readonly logger: Logger;
}

interface Shared {
  readonly tunnel: Promise<Tunnel>;
  users: number;
}

/**
 * Sessions of the same connection share one tunnel: it opens with the first and
 * closes with the last. A tunnel that drops is forgotten at once, so the next
 * session opens a fresh one instead of reusing a dead port.
 */
export class TunnelPool {
  private readonly load: SshLoader;
  private readonly logger: Logger;
  private readonly shared = new Map<string, Shared>();
  private module: Promise<SshModule> | undefined;
  private disposed = false;

  constructor(deps: TunnelPoolDeps) {
    this.load = deps.load;
    this.logger = deps.logger.child('ssh');
  }

  /** Number of tunnels currently open or opening; for tests and diagnostics. */
  get size(): number {
    return this.shared.size;
  }

  /**
   * A lease on the tunnel stored under `key`. The key must change whenever the
   * spec does (it is built from the saved settings), so an edited connection
   * never reuses a tunnel to the old place.
   */
  async acquire(key: string, spec: TunnelSpec): Promise<TunnelLease> {
    if (this.disposed) {
      throw new DbError('internal', 'The tunnel pool is disposed');
    }
    let entry = this.shared.get(key);
    if (entry === undefined) {
      const opening = this.open(spec);
      const created: Shared = { tunnel: opening, users: 0 };
      entry = created;
      this.shared.set(key, created);
      void this.forgetWhenClosed(key, created);
    }
    entry.users += 1;
    let tunnel: Tunnel;
    try {
      tunnel = await entry.tunnel;
    } catch (error) {
      entry.users -= 1;
      throw error;
    }
    const held = entry;
    let released = false;
    return {
      port: tunnel.port,
      forwardError: () => tunnel.forwardError(),
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        held.users -= 1;
        if (held.users === 0 && this.shared.get(key) === held) {
          this.shared.delete(key);
          await tunnel.close();
        }
      },
    };
  }

  /** A tunnel of its own, for "Test connection": never shared, closed by the caller. */
  async openPrivate(spec: TunnelSpec): Promise<Tunnel> {
    return await this.open(spec);
  }

  dispose(): void {
    this.disposed = true;
    const entries = [...this.shared.values()];
    this.shared.clear();
    for (const entry of entries) {
      void this.closeWhenOpen(entry);
    }
  }

  private async open(spec: TunnelSpec): Promise<Tunnel> {
    let module: SshModule;
    try {
      this.module ??= this.load();
      module = await this.module;
    } catch (error) {
      this.module = undefined;
      this.logger.error('The SSH module failed to load', error);
      throw toDbError(error, 'internal');
    }
    return await module.openTunnel(spec, this.logger);
  }

  private async forgetWhenClosed(key: string, entry: Shared): Promise<void> {
    try {
      const tunnel = await entry.tunnel;
      await tunnel.closed;
    } catch (_error) {
      // A failed open is reported to whoever acquired it; here it only ends the entry.
    }
    if (this.shared.get(key) === entry) {
      this.shared.delete(key);
    }
  }

  private async closeWhenOpen(entry: Shared): Promise<void> {
    try {
      const tunnel = await entry.tunnel;
      await tunnel.close();
    } catch (error) {
      this.logger.debug(`A tunnel did not close cleanly: ${String(error)}`);
    }
  }
}
