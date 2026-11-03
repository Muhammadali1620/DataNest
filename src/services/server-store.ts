// Saved SSH servers for the file browser (V13.16). Like the connections they sit in the
// extension's state, and the passwords and key passphrases of their hops live only in
// SecretStorage (CLAUDE.md, ARCHITECTURE.md §8). The service never imports vscode.

import { type Disposable, toDisposable } from '../core/disposable';
import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { msg } from '../core/user-message';
import type { SshHopSecrets } from '../shared/connection';
import {
  type ServerProblem,
  serverHops,
  serverProblems,
  type SshServerConfig,
  type SshServerInput,
  sshServerSchema,
} from '../shared/ssh-server';
import { array, literal, object } from '../shared/schema';
import {
  type KeyValueState,
  normalizeProxy,
  normalizeTunnel,
  type PasswordChange,
  type SecretState,
  type SshSecretChanges,
  type SshSecretValues,
} from './connection-store';

export const SERVERS_STATE_KEY = 'servers';

/** Keys of an SSH hop's password and key passphrase of a server in SecretStorage. */
export function serverSecretKey(
  serverId: string,
  hopId: string,
  kind: keyof SshHopSecrets,
): string {
  return `server.${serverId}.ssh.${hopId}.${kind}`;
}

/** Key of the password of a server's proxy. */
export function serverProxySecretKey(serverId: string): string {
  return `server.${serverId}.proxy.password`;
}

const SECRET_KINDS = ['password', 'passphrase'] as const satisfies (keyof SshHopSecrets)[];

const stateSchema = object({
  version: literal(1),
  items: array(sshServerSchema, { maxLength: 1000 }),
});

export interface ServerStoreDeps {
  readonly state: KeyValueState;
  readonly secrets: SecretState;
  readonly logger: Logger;
}

/** What to tell the user about a server that cannot be saved. */
export function describeServerProblem(problem: ServerProblem): string {
  switch (problem) {
    case 'name-empty':
      return msg('the name is empty');
    case 'too-long':
      return msg('the name or the start folder is too long');
    case 'ssh-host-empty':
      return msg('the SSH host is empty');
    case 'ssh-port-invalid':
      return msg('the SSH port must be 1–65535');
    case 'ssh-user-empty':
      return msg('the SSH user is empty');
    case 'ssh-key-empty':
      return msg('the key file is not named');
    case 'ssh-id-invalid':
      return msg('the SSH server id is not valid');
    case 'ssh-too-many-jumps':
      return msg('too many jump hosts');
    case 'ssh-algorithms-invalid':
      return msg('the SSH algorithm rules are not valid');
    case 'proxy-host-empty':
      return msg('the proxy host is empty');
    case 'proxy-port-invalid':
      return msg('the proxy port must be 1–65535');
  }
}

export class ServerStore {
  private readonly state: KeyValueState;
  private readonly secrets: SecretState;
  private readonly logger: Logger;
  private items: SshServerConfig[];
  private readonly listeners = new Set<() => void>();

  constructor(deps: ServerStoreDeps) {
    this.state = deps.state;
    this.secrets = deps.secrets;
    this.logger = deps.logger.child('servers');
    this.items = this.load();
  }

  list(): SshServerConfig[] {
    return [...this.items];
  }

  get(id: string): SshServerConfig | undefined {
    return this.items.find((item) => item.id === id);
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  async add(
    input: SshServerInput,
    ssh: SshSecretValues = {},
    proxyPassword?: string,
  ): Promise<SshServerConfig> {
    const config: SshServerConfig = { ...normalizeInput(input), id: crypto.randomUUID() };
    await this.save([...this.items, config]);
    for (const hop of serverHops(config)) {
      for (const kind of SECRET_KINDS) {
        const value = ssh[hop.id]?.[kind];
        if (value !== undefined && value !== '') {
          await this.secrets.store(serverSecretKey(config.id, hop.id, kind), value);
        }
      }
    }
    if (config.proxy !== undefined && proxyPassword !== undefined && proxyPassword !== '') {
      await this.secrets.store(serverProxySecretKey(config.id), proxyPassword);
    }
    this.notify();
    return config;
  }

  async update(
    id: string,
    input: SshServerInput,
    ssh: SshSecretChanges = {},
    proxyPassword: PasswordChange = { kind: 'keep' },
  ): Promise<SshServerConfig> {
    const index = this.items.findIndex((item) => item.id === id);
    const before = this.items[index];
    if (before === undefined) {
      throw new DbError('not-found', msg('The server "{0}" does not exist', id));
    }
    const config: SshServerConfig = { ...normalizeInput(input), id };
    const items = [...this.items];
    items[index] = config;
    await this.save(items);
    const kept = new Set(serverHops(config).map((hop) => hop.id));
    for (const hop of serverHops(config)) {
      for (const kind of SECRET_KINDS) {
        await this.applySecret(serverSecretKey(id, hop.id, kind), ssh[hop.id]?.[kind]);
      }
    }
    // A hop that is gone takes its secrets with it.
    for (const hop of serverHops(before)) {
      if (!kept.has(hop.id)) {
        await this.deleteHopSecrets(id, hop.id);
      }
    }
    await this.applySecret(
      serverProxySecretKey(id),
      config.proxy === undefined ? { kind: 'clear' } : proxyPassword,
    );
    this.notify();
    return config;
  }

  /** Removes the server and its secrets. Removing a missing id is a no-op. */
  async remove(id: string): Promise<void> {
    const removed = this.get(id);
    if (removed === undefined) {
      return;
    }
    await this.save(this.items.filter((item) => item.id !== id));
    for (const hop of serverHops(removed)) {
      await this.deleteHopSecrets(id, hop.id);
    }
    await this.secrets.delete(serverProxySecretKey(id));
    this.notify();
  }

  /** Puts the server in or out of read-only mode without touching anything else. */
  async setReadOnly(id: string, readOnly: boolean): Promise<void> {
    const index = this.items.findIndex((item) => item.id === id);
    const before = this.items[index];
    if (before === undefined) {
      throw new DbError('not-found', msg('The server "{0}" does not exist', id));
    }
    const { readOnly: _was, ...rest } = before;
    const items = [...this.items];
    items[index] = readOnly ? { ...rest, readOnly: true } : rest;
    await this.save(items);
    this.notify();
  }

  /** The stored password and passphrase of every SSH hop of a server, by hop id. */
  async getSshSecrets(id: string): Promise<Record<string, SshHopSecrets>> {
    const config = this.get(id);
    const result: Record<string, SshHopSecrets> = {};
    for (const hop of config === undefined ? [] : serverHops(config)) {
      const password = await this.secrets.get(serverSecretKey(id, hop.id, 'password'));
      const passphrase = await this.secrets.get(serverSecretKey(id, hop.id, 'passphrase'));
      result[hop.id] = {
        ...(password === undefined ? {} : { password }),
        ...(passphrase === undefined ? {} : { passphrase }),
      };
    }
    return result;
  }

  async getProxyPassword(id: string): Promise<string | undefined> {
    return await this.secrets.get(serverProxySecretKey(id));
  }

  private async applySecret(key: string, change: PasswordChange | undefined): Promise<void> {
    if (change === undefined || change.kind === 'keep') {
      return;
    }
    if (change.kind === 'set' && change.value !== '') {
      await this.secrets.store(key, change.value);
    } else {
      await this.secrets.delete(key);
    }
  }

  private async deleteHopSecrets(serverId: string, hopId: string): Promise<void> {
    for (const kind of SECRET_KINDS) {
      await this.secrets.delete(serverSecretKey(serverId, hopId, kind));
    }
  }

  private load(): SshServerConfig[] {
    const raw = this.state.get(SERVERS_STATE_KEY);
    if (raw === undefined) {
      return [];
    }
    try {
      return stateSchema.parse(raw).items;
    } catch (error) {
      // Broken state must not brick the extension: start empty, keep the log loud.
      this.logger.error('Saved servers are corrupted and were ignored', error);
      return [];
    }
  }

  private async save(items: SshServerConfig[]): Promise<void> {
    await this.state.update(SERVERS_STATE_KEY, { version: 1, items });
    this.items = items;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn('A server change listener failed', error);
      }
    }
  }
}

/** Trimmed, with only the fields that mean something; refuses what cannot be saved. */
function normalizeInput(input: SshServerInput): SshServerInput {
  const startPath = input.startPath?.trim();
  const normalized: SshServerInput = {
    name: input.name.trim(),
    ssh: normalizeTunnel(input.ssh),
    ...(input.proxy === undefined ? {} : { proxy: normalizeProxy(input.proxy) }),
    ...(startPath === undefined || startPath === '' ? {} : { startPath }),
    ...(input.readOnly === true ? { readOnly: true } : {}),
    ...(input.color === undefined ? {} : { color: input.color }),
  };
  const problems = serverProblems(normalized);
  if (problems.length > 0) {
    throw new DbError(
      'unsupported',
      msg('Invalid server: {0}', problems.map(describeServerProblem).join(', ')),
    );
  }
  return normalized;
}
