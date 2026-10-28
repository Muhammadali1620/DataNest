// CRUD for saved connections. Configs live in globalState, passwords only in
// SecretStorage (CLAUDE.md, ARCHITECTURE.md §8). The service never imports vscode:
// it receives narrow interfaces over Memento and SecretStorage.

import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import { type Disposable, toDisposable } from '../core/disposable';
import {
  CONNECTION_LIMITS,
  type ConnectionConfig,
  type ConnectionInput,
  connectionProblems,
  isFileDriver,
  type SshHop,
  type SshHopSecrets,
  sshHopsOf,
  type ConnectionColor,
  type SshTunnelConfig,
  type SslSettings,
} from '../shared/connection';
import { connectionInputShape } from '../shared/connection-schema';
import { array, literal, object, type Schema, string, union } from '../shared/schema';

/** The slice of `vscode.Memento` the store needs. */
export interface KeyValueState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** The slice of `vscode.SecretStorage` the store needs. */
export interface SecretState {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export const CONNECTIONS_STATE_KEY = 'connections';

/** Key of a connection's password in SecretStorage. */
export function passwordSecretKey(connectionId: string): string {
  return `connection.${connectionId}.password`;
}

/** Keys of an SSH hop's password and key passphrase in SecretStorage. */
export function sshSecretKey(
  connectionId: string,
  hopId: string,
  kind: keyof SshHopSecrets,
): string {
  return `connection.${connectionId}.ssh.${hopId}.${kind}`;
}

const SSH_SECRET_KINDS = ['password', 'passphrase'] as const satisfies (keyof SshHopSecrets)[];

const connectionConfigSchema: Schema<ConnectionConfig> = object({
  ...connectionInputShape,
  id: string({ minLength: 1, maxLength: 100 }),
  name: string({ minLength: 1, maxLength: CONNECTION_LIMITS.name }),
});

const folderSchema = string({ minLength: 1, maxLength: CONNECTION_LIMITS.folder });

/** Version 1 had no folders; it is read as is and written back as version 2. */
const stateSchema = union(
  object({
    version: literal(2),
    items: array(connectionConfigSchema, { maxLength: 10_000 }),
    folders: array(folderSchema, { maxLength: 10_000 }),
  }),
  object({
    version: literal(1),
    items: array(connectionConfigSchema, { maxLength: 10_000 }),
  }),
);

/** Where moved connections go: a folder (or the top level) and, optionally, before whom. */
export interface MoveDestination {
  readonly folder?: string;
  /** A connection in that folder to put them in front of; the end of it when absent. */
  readonly before?: string;
}

/** How a password changes on update: keep the stored one, replace it, or erase it. */
export type PasswordChange =
  | { readonly kind: 'keep' }
  | { readonly kind: 'set'; readonly value: string }
  | { readonly kind: 'clear' };

/** Secret changes per SSH hop id; hops left out keep what is stored. */
export type SshSecretChanges = Readonly<
  Record<string, { readonly password?: PasswordChange; readonly passphrase?: PasswordChange }>
>;

/** Secret values per SSH hop id, for a new connection. */
export type SshSecretValues = Readonly<Record<string, SshHopSecrets>>;

export interface ConnectionStoreDeps {
  readonly state: KeyValueState;
  readonly secrets: SecretState;
  readonly logger: Logger;
}

/**
 * Saved connections in the order the user keeps them. All writes go through this
 * class, so `onDidChange` fires for every mutation after it is persisted.
 */
export class ConnectionStore {
  private readonly state: KeyValueState;
  private readonly secrets: SecretState;
  private readonly logger: Logger;
  private readonly listeners = new Set<() => void>();
  private items: ConnectionConfig[];
  private folderList: string[];

  constructor(deps: ConnectionStoreDeps) {
    this.state = deps.state;
    this.secrets = deps.secrets;
    this.logger = deps.logger.child('connections');
    const loaded = this.load();
    this.items = loaded.items;
    this.folderList = withReferenced(loaded.folders, loaded.items);
  }

  /** Folder names in the order the tree shows them. */
  folders(): string[] {
    return [...this.folderList];
  }

  async createFolder(name: string): Promise<string> {
    const folder = folderName(name);
    if (this.folderList.includes(folder)) {
      throw new DbError('unsupported', `A folder named "${folder}" already exists`);
    }
    await this.save(this.items, [...this.folderList, folder]);
    this.notify();
    return folder;
  }

  /** Renames a folder; its connections go along. */
  async renameFolder(from: string, to: string): Promise<string> {
    const target = folderName(to);
    this.requireFolder(from);
    if (target === from) {
      return target;
    }
    if (this.folderList.includes(target)) {
      throw new DbError('unsupported', `A folder named "${target}" already exists`);
    }
    await this.save(
      this.items.map((item) => (item.folder === from ? { ...item, folder: target } : item)),
      this.folderList.map((folder) => (folder === from ? target : folder)),
    );
    this.notify();
    return target;
  }

  /** Removes a folder; its connections move to the top level, none is deleted. */
  async removeFolder(name: string): Promise<void> {
    this.requireFolder(name);
    await this.save(
      this.items.map((item) => (item.folder === name ? withoutFolder(item) : item)),
      this.folderList.filter((folder) => folder !== name),
    );
    this.notify();
  }

  /** Puts a folder in front of another one, or last. */
  async moveFolder(name: string, before?: string): Promise<void> {
    this.requireFolder(name);
    if (before === name) {
      return;
    }
    const rest = this.folderList.filter((folder) => folder !== name);
    const index = before === undefined ? -1 : rest.indexOf(before);
    rest.splice(index === -1 ? rest.length : index, 0, name);
    await this.save(this.items, rest);
    this.notify();
  }

  /**
   * Moves connections, keeping their order, into a folder (or the top level) and in
   * front of one connection there, or after the last one. Unknown ids are ignored.
   */
  async moveConnections(ids: readonly string[], destination: MoveDestination): Promise<void> {
    const { folder } = destination;
    if (folder !== undefined) {
      this.requireFolder(folder);
    }
    const moving = new Set(ids);
    const moved = this.items
      .filter((item) => moving.has(item.id))
      .map((item) => (folder === undefined ? withoutFolder(item) : { ...item, folder }));
    if (moved.length === 0) {
      return;
    }
    const rest = this.items.filter((item) => !moving.has(item.id));
    let index =
      destination.before === undefined
        ? -1
        : rest.findIndex((item) => item.id === destination.before);
    if (index === -1) {
      // After the last connection of the folder, or at the very end.
      const last = rest.findLastIndex((item) => item.folder === folder);
      index = last === -1 ? rest.length : last + 1;
    }
    rest.splice(index, 0, ...moved);
    await this.save(rest);
    this.notify();
  }

  async setColor(id: string, color: ConnectionColor | undefined): Promise<void> {
    const index = this.items.findIndex((item) => item.id === id);
    const current = this.items[index];
    if (current === undefined) {
      throw new DbError('not-found', `Connection "${id}" does not exist`);
    }
    const { color: _old, ...rest } = current;
    const items = [...this.items];
    items[index] = color === undefined ? rest : { ...rest, color };
    await this.save(items);
    this.notify();
  }

  private requireFolder(name: string): void {
    if (!this.folderList.includes(name)) {
      throw new DbError('not-found', `Folder "${name}" does not exist`);
    }
  }

  list(): ConnectionConfig[] {
    return [...this.items];
  }

  get(id: string): ConnectionConfig | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** Fires after any change is persisted. */
  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  async add(
    input: ConnectionInput,
    password?: string,
    ssh: SshSecretValues = {},
  ): Promise<ConnectionConfig> {
    const config: ConnectionConfig = { ...normalizeInput(input), id: crypto.randomUUID() };
    await this.save([...this.items, config]);
    if (password !== undefined && password !== '') {
      await this.secrets.store(passwordSecretKey(config.id), password);
    }
    for (const hop of sshHopsOf(config)) {
      for (const kind of SSH_SECRET_KINDS) {
        const value = ssh[hop.id]?.[kind];
        if (value !== undefined && value !== '') {
          await this.secrets.store(sshSecretKey(config.id, hop.id, kind), value);
        }
      }
    }
    this.notify();
    return config;
  }

  async update(
    id: string,
    input: ConnectionInput,
    password: PasswordChange = { kind: 'keep' },
    ssh: SshSecretChanges = {},
  ): Promise<ConnectionConfig> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new DbError('not-found', `Connection "${id}" does not exist`);
    }
    const before = this.items[index];
    const config: ConnectionConfig = { ...normalizeInput(input), id };
    const items = [...this.items];
    items[index] = config;
    await this.save(items);
    await this.applySecret(passwordSecretKey(id), password);
    const kept = new Set(sshHopsOf(config).map((hop) => hop.id));
    for (const hop of sshHopsOf(config)) {
      for (const kind of SSH_SECRET_KINDS) {
        await this.applySecret(sshSecretKey(id, hop.id, kind), ssh[hop.id]?.[kind]);
      }
    }
    // A hop that is gone takes its secrets with it.
    for (const hop of before === undefined ? [] : sshHopsOf(before)) {
      if (!kept.has(hop.id)) {
        await this.deleteHopSecrets(id, hop);
      }
    }
    this.notify();
    return config;
  }

  /** Removes the config and its password. Removing a missing id is a no-op. */
  async remove(id: string): Promise<void> {
    const items = this.items.filter((item) => item.id !== id);
    if (items.length === this.items.length) {
      return;
    }
    const removed = this.get(id);
    await this.save(items);
    await this.secrets.delete(passwordSecretKey(id));
    for (const hop of removed === undefined ? [] : sshHopsOf(removed)) {
      await this.deleteHopSecrets(id, hop);
    }
    this.notify();
  }

  /** Copies a connection, including its password, under a new id. */
  async duplicate(id: string, newName?: string): Promise<ConnectionConfig> {
    const source = this.get(id);
    if (!source) {
      throw new DbError('not-found', `Connection "${id}" does not exist`);
    }
    const copy: ConnectionConfig = {
      ...source,
      id: crypto.randomUUID(),
      name: newName ?? this.copyName(source.name),
    };
    await this.save([...this.items, copy]);
    const password = await this.secrets.get(passwordSecretKey(id));
    if (password !== undefined) {
      await this.secrets.store(passwordSecretKey(copy.id), password);
    }
    for (const hop of sshHopsOf(source)) {
      for (const kind of SSH_SECRET_KINDS) {
        const value = await this.secrets.get(sshSecretKey(id, hop.id, kind));
        if (value !== undefined) {
          await this.secrets.store(sshSecretKey(copy.id, hop.id, kind), value);
        }
      }
    }
    this.notify();
    return copy;
  }

  async getPassword(id: string): Promise<string | undefined> {
    return await this.secrets.get(passwordSecretKey(id));
  }

  /** The stored password and passphrase of every SSH hop of a connection, by hop id. */
  async getSshSecrets(id: string): Promise<Record<string, SshHopSecrets>> {
    const config = this.get(id);
    const result: Record<string, SshHopSecrets> = {};
    for (const hop of config === undefined ? [] : sshHopsOf(config)) {
      const password = await this.secrets.get(sshSecretKey(id, hop.id, 'password'));
      const passphrase = await this.secrets.get(sshSecretKey(id, hop.id, 'passphrase'));
      result[hop.id] = {
        ...(password === undefined ? {} : { password }),
        ...(passphrase === undefined ? {} : { passphrase }),
      };
    }
    return result;
  }

  /** Writes, erases or keeps one secret; an empty value erases it. */
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

  private async deleteHopSecrets(connectionId: string, hop: SshHop): Promise<void> {
    for (const kind of SSH_SECRET_KINDS) {
      await this.secrets.delete(sshSecretKey(connectionId, hop.id, kind));
    }
  }

  private copyName(name: string): string {
    const taken = new Set(this.items.map((item) => item.name));
    for (let attempt = 1; ; attempt++) {
      const candidate = attempt === 1 ? `${name} (copy)` : `${name} (copy ${attempt})`;
      if (!taken.has(candidate)) {
        return candidate.slice(0, CONNECTION_LIMITS.name);
      }
    }
  }

  private load(): { items: ConnectionConfig[]; folders: string[] } {
    const raw = this.state.get(CONNECTIONS_STATE_KEY);
    if (raw === undefined) {
      return { items: [], folders: [] };
    }
    try {
      const parsed = stateSchema.parse(raw);
      return { items: parsed.items, folders: parsed.version === 2 ? parsed.folders : [] };
    } catch (error) {
      // Broken state must not brick the extension: start empty, keep the log loud.
      this.logger.error('Saved connections are corrupted and were ignored', error);
      return { items: [], folders: [] };
    }
  }

  private async save(
    items: ConnectionConfig[],
    folders: string[] = this.folderList,
  ): Promise<void> {
    const kept = withReferenced(folders, items);
    await this.state.update(CONNECTIONS_STATE_KEY, { version: 2, items, folders: kept });
    this.items = items;
    this.folderList = kept;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn('A connection change listener failed', error);
      }
    }
  }
}

function folderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > CONNECTION_LIMITS.folder) {
    throw new DbError('unsupported', 'A folder needs a name of up to 200 characters');
  }
  return trimmed;
}

function withoutFolder(config: ConnectionConfig): ConnectionConfig {
  const { folder: _folder, ...rest } = config;
  return rest;
}

/** Every folder a connection names is listed, even if the list lost it. */
function withReferenced(folders: readonly string[], items: readonly ConnectionConfig[]): string[] {
  const result = [...new Set(folders)];
  for (const item of items) {
    if (item.folder !== undefined && !result.includes(item.folder)) {
      result.push(item.folder);
    }
  }
  return result;
}

/** Trims text fields and drops empty optional ones, with a final validity check. */
function normalizeInput(input: ConnectionInput): ConnectionInput {
  const trim = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  // Fields that do not apply to the driver kind are dropped, not stored.
  const file = isFileDriver(input.driver);
  const normalized: ConnectionInput = {
    name: input.name.trim(),
    driver: input.driver,
    host: file ? undefined : trim(input.host),
    port: file ? undefined : input.port,
    user: file ? undefined : trim(input.user),
    database: file ? undefined : trim(input.database),
    file: file ? trim(input.file) : undefined,
    ssh: file || input.ssh === undefined ? undefined : normalizeTunnel(input.ssh),
    ssl: file || input.ssl === undefined ? undefined : normalizeSsl(input.ssl),
    folder: trim(input.folder),
    color: input.color,
  };
  const problems = connectionProblems(normalized);
  if (problems.length > 0) {
    throw new DbError('unsupported', `Invalid connection: ${problems.join(', ')}`);
  }
  return normalized;
}

function normalizeSsl(ssl: SslSettings): SslSettings {
  const ca = ssl.ca?.trim();
  const cert = ssl.cert?.trim();
  const key = ssl.key?.trim();
  return {
    mode: ssl.mode,
    ...(ca === undefined || ca === '' ? {} : { ca }),
    ...(cert === undefined || cert === '' ? {} : { cert }),
    ...(key === undefined || key === '' ? {} : { key }),
  };
}

function normalizeTunnel(ssh: SshTunnelConfig): SshTunnelConfig {
  const jumps = (ssh.jumps ?? []).map(normalizeHop);
  return { ...normalizeHop(ssh), ...(jumps.length === 0 ? {} : { jumps }) };
}

/** Only the fields of the hop's auth method are kept: a key path is not stored for `agent`. */
function normalizeHop(hop: SshHop): SshHop {
  const trim = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const keyFile = hop.auth === 'key' ? trim(hop.keyFile) : undefined;
  const agentSocket = hop.auth === 'agent' ? trim(hop.agentSocket) : undefined;
  return {
    id: hop.id,
    host: hop.host.trim(),
    ...(hop.port === undefined ? {} : { port: hop.port }),
    user: hop.user.trim(),
    auth: hop.auth,
    ...(keyFile === undefined ? {} : { keyFile }),
    ...(agentSocket === undefined ? {} : { agentSocket }),
  };
}
