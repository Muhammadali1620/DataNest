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
  type ConnectionOptions,
  type DriverId,
  type ElasticSettings,
  type MongoSettings,
  type RedisSettings,
  filterSupport,
  optionSupport,
  type VisibilityFilter,
  type SshTunnelConfig,
  type SslSettings,
} from '../shared/connection';
import { connectionInputShape } from '../shared/connection-schema';
import { array, literal, object, type Schema, string, union } from '../shared/schema';
import type { ProjectConnections, ProjectFolder } from './project-connections';

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

/** Key of the password of a Redis connection's Sentinels (V7.1). */
export function sentinelSecretKey(connectionId: string): string {
  return `connection.${connectionId}.sentinel.password`;
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
  /** Connections shared through the workspace's `.vscode/datanest.json` (V4.7). */
  readonly projects?: ProjectConnections;
}

/** Where a new connection is saved: the user's own list, or a project file. */
export interface AddOptions {
  /** Key of the workspace folder whose project file gets the connection. */
  readonly project?: string;
  /** The password of the Sentinels of a Redis connection, when they have one. */
  readonly sentinelPassword?: string;
}

/**
 * Saved connections in the order the user keeps them, plus the connections of the
 * open project (V4.7). All writes go through this class, so `onDidChange` fires for
 * every mutation after it is persisted. Secrets of both kinds live in SecretStorage.
 */
export class ConnectionStore {
  private readonly state: KeyValueState;
  private readonly secrets: SecretState;
  private readonly logger: Logger;
  private readonly projects: ProjectConnections | undefined;
  private readonly listeners = new Set<() => void>();
  private items: ConnectionConfig[];
  private folderList: string[];

  constructor(deps: ConnectionStoreDeps) {
    this.state = deps.state;
    this.secrets = deps.secrets;
    this.logger = deps.logger.child('connections');
    this.projects = deps.projects;
    const loaded = this.load();
    this.items = loaded.items;
    this.folderList = withReferenced(loaded.folders, loaded.items);
    // Lives as long as the store: both are made once in activate().
    this.projects?.onDidChange(() => {
      this.notify();
    });
  }

  /** Workspace folders whose project file may take a connection (V4.7). */
  projectFolders(): ProjectFolder[] {
    return this.projects?.writableFolders() ?? [];
  }

  /** The project folder whose file holds the connection; undefined for the user's own. */
  projectOf(id: string): ProjectFolder | undefined {
    return this.projects?.folderOf(id);
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

  /** Replaces the database and schema filter of a connection (V4.10). */
  async setFilter(id: string, filter: VisibilityFilter | undefined): Promise<void> {
    const current = this.get(id);
    if (current === undefined) {
      throw new DbError('not-found', `Connection "${id}" does not exist`);
    }
    const { id: _id, filter: _old, ...input } = current;
    await this.update(id, filter === undefined ? input : { ...input, filter });
  }

  async setColor(id: string, color: ConnectionColor | undefined): Promise<void> {
    const project = this.projects?.get(id);
    if (project !== undefined) {
      const { color: _old, id: _id, ...rest } = project;
      await this.projects?.update(id, color === undefined ? rest : { ...rest, color });
      return;
    }
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

  /** The user's connections, then those of the open project. */
  list(): ConnectionConfig[] {
    return [...this.items, ...(this.projects?.list() ?? [])];
  }

  get(id: string): ConnectionConfig | undefined {
    return this.items.find((item) => item.id === id) ?? this.projects?.get(id);
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
    options: AddOptions = {},
  ): Promise<ConnectionConfig> {
    let config: ConnectionConfig;
    if (options.project === undefined) {
      config = { ...normalizeInput(input), id: crypto.randomUUID() };
      await this.save([...this.items, config]);
    } else {
      config = await this.projectsOrThrow().add(options.project, normalizeInput(input));
    }
    if (password !== undefined && password !== '') {
      await this.secrets.store(passwordSecretKey(config.id), password);
    }
    if (usesSentinels(config) && (options.sentinelPassword ?? '') !== '') {
      await this.secrets.store(sentinelSecretKey(config.id), options.sentinelPassword ?? '');
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
    sentinelPassword: PasswordChange = { kind: 'keep' },
  ): Promise<ConnectionConfig> {
    const index = this.items.findIndex((item) => item.id === id);
    const before = this.items[index] ?? this.projects?.get(id);
    if (before === undefined) {
      throw new DbError('not-found', `Connection "${id}" does not exist`);
    }
    let config: ConnectionConfig;
    if (index === -1) {
      config = await this.projectsOrThrow().update(id, normalizeInput(input));
    } else {
      config = { ...normalizeInput(input), id };
      const items = [...this.items];
      items[index] = config;
      await this.save(items);
    }
    await this.applySecret(passwordSecretKey(id), password);
    // A connection that no longer asks Sentinels has no use for their password.
    await this.applySecret(
      sentinelSecretKey(id),
      usesSentinels(config) ? sentinelPassword : { kind: 'clear' },
    );
    const kept = new Set(sshHopsOf(config).map((hop) => hop.id));
    for (const hop of sshHopsOf(config)) {
      for (const kind of SSH_SECRET_KINDS) {
        await this.applySecret(sshSecretKey(id, hop.id, kind), ssh[hop.id]?.[kind]);
      }
    }
    // A hop that is gone takes its secrets with it.
    for (const hop of sshHopsOf(before)) {
      if (!kept.has(hop.id)) {
        await this.deleteHopSecrets(id, hop);
      }
    }
    this.notify();
    return config;
  }

  /** Removes the config and its secrets. Removing a missing id is a no-op. */
  async remove(id: string): Promise<void> {
    const removed = this.get(id);
    if (removed === undefined) {
      return;
    }
    if (this.projects?.folderOf(id) === undefined) {
      await this.save(this.items.filter((item) => item.id !== id));
    } else {
      await this.projects.remove(id);
    }
    await this.deleteSecrets(removed);
    this.notify();
  }

  /**
   * Moves a connection of the user's into a project file, with its secrets, which
   * stay on this computer. The connection gets the project's id for it.
   */
  async moveToProject(id: string, folderKey: string): Promise<ConnectionConfig> {
    const source = this.items.find((item) => item.id === id);
    if (source === undefined) {
      throw new DbError('not-found', `Connection "${id}" is not one of your own`);
    }
    const { id: _id, folder: _folder, ...input } = source;
    const moved = await this.projectsOrThrow().add(folderKey, input);
    await this.copySecrets(source, moved.id);
    await this.save(this.items.filter((item) => item.id !== id));
    await this.deleteSecrets(source);
    this.notify();
    return moved;
  }

  /** Takes a connection out of its project file and keeps it as the user's own. */
  async moveToUser(id: string): Promise<ConnectionConfig> {
    const source = this.projects?.get(id);
    if (source === undefined) {
      throw new DbError('not-found', `Connection "${id}" is not a project connection`);
    }
    const moved: ConnectionConfig = { ...source, id: crypto.randomUUID() };
    await this.save([...this.items, moved]);
    await this.copySecrets(source, moved.id);
    await this.projectsOrThrow().remove(id);
    await this.deleteSecrets(source);
    this.notify();
    return moved;
  }

  private projectsOrThrow(): ProjectConnections {
    if (this.projects === undefined) {
      throw new DbError('unsupported', 'Project connections are not available');
    }
    return this.projects;
  }

  private async copySecrets(source: ConnectionConfig, targetId: string): Promise<void> {
    const password = await this.secrets.get(passwordSecretKey(source.id));
    if (password !== undefined) {
      await this.secrets.store(passwordSecretKey(targetId), password);
    }
    const sentinel = await this.secrets.get(sentinelSecretKey(source.id));
    if (sentinel !== undefined) {
      await this.secrets.store(sentinelSecretKey(targetId), sentinel);
    }
    for (const hop of sshHopsOf(source)) {
      for (const kind of SSH_SECRET_KINDS) {
        const value = await this.secrets.get(sshSecretKey(source.id, hop.id, kind));
        if (value !== undefined) {
          await this.secrets.store(sshSecretKey(targetId, hop.id, kind), value);
        }
      }
    }
  }

  private async deleteSecrets(config: ConnectionConfig): Promise<void> {
    await this.secrets.delete(passwordSecretKey(config.id));
    await this.secrets.delete(sentinelSecretKey(config.id));
    for (const hop of sshHopsOf(config)) {
      await this.deleteHopSecrets(config.id, hop);
    }
  }

  /**
   * Copies a connection, including its secrets, under a new id. The copy is always
   * the user's own, even when the source is a project connection.
   */
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
    await this.copySecrets(source, copy.id);
    this.notify();
    return copy;
  }

  async getPassword(id: string): Promise<string | undefined> {
    return await this.secrets.get(passwordSecretKey(id));
  }

  /** The password of a Redis connection's Sentinels, if one is stored. */
  async getSentinelPassword(id: string): Promise<string | undefined> {
    return await this.secrets.get(sentinelSecretKey(id));
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
    const taken = new Set(this.list().map((item) => item.name));
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
    // Only a set flag is stored, so configs stay the same as before for everyone else.
    production: input.production === true ? true : undefined,
    readOnly: input.readOnly === true ? true : undefined,
    options: normalizeOptions(input.options, input.driver),
    filter: normalizeFilter(input.filter, input.driver),
    redis: input.driver === 'redis' ? normalizeRedis(input.redis) : undefined,
    mongo: input.driver === 'mongodb' ? normalizeMongo(input.mongo) : undefined,
    elastic: input.driver === 'elasticsearch' ? normalizeElastic(input.elastic) : undefined,
  };
  const problems = connectionProblems(normalized);
  if (problems.length > 0) {
    throw new DbError('unsupported', `Invalid connection: ${problems.join(', ')}`);
  }
  return normalized;
}

/** Trimmed patterns without blanks and repeats; a list or filter left empty goes away. */
function normalizeFilter(
  filter: VisibilityFilter | undefined,
  driver: DriverId,
): VisibilityFilter | undefined {
  const support = filterSupport(driver);
  const clean = (patterns: readonly string[] | undefined): string[] | undefined => {
    const kept = [...new Set((patterns ?? []).map((pattern) => pattern.trim()))].filter(
      (pattern) => pattern !== '',
    );
    return kept.length === 0 ? undefined : kept;
  };
  const databases = support.databases ? clean(filter?.databases) : undefined;
  const schemas = support.schemas ? clean(filter?.schemas) : undefined;
  if (databases === undefined && schemas === undefined) {
    return undefined;
  }
  return {
    ...(databases === undefined ? {} : { databases }),
    ...(schemas === undefined ? {} : { schemas }),
  };
}

/**
 * Options the driver honours, with text trimmed; empty ones are dropped, and no
 * options at all is `undefined`, so plain connections are stored as before.
 */
function normalizeOptions(
  options: ConnectionOptions | undefined,
  driver: DriverId,
): ConnectionOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  const support = optionSupport(driver);
  const text = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const initSql = text(options.initSql);
  const timeZone = support.timeZone ? text(options.timeZone) : undefined;
  const charset = support.charset ? text(options.charset) : undefined;
  const kept: ConnectionOptions = {
    ...(support.connectTimeout && options.connectTimeout !== undefined
      ? { connectTimeout: options.connectTimeout }
      : {}),
    ...(options.queryTimeout === undefined ? {} : { queryTimeout: options.queryTimeout }),
    // 0 is "never", the same as leaving it out.
    ...(support.keepAlive && options.keepAlive !== undefined && options.keepAlive > 0
      ? { keepAlive: options.keepAlive }
      : {}),
    ...(initSql === undefined ? {} : { initSql }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(charset === undefined ? {} : { charset }),
  };
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * Standalone is the default and is not stored; the master name belongs to Sentinel
 * mode and the Sentinel user too, and blank node rows are dropped.
 */
function normalizeRedis(redis: RedisSettings | undefined): RedisSettings | undefined {
  if (redis === undefined || redis.mode === 'standalone') {
    return undefined;
  }
  const trim = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const nodes = (redis.nodes ?? [])
    .filter((node) => node.host.trim() !== '' || node.port !== undefined)
    .map((node) => ({
      host: node.host.trim(),
      ...(node.port === undefined ? {} : { port: node.port }),
    }));
  const masterName = redis.mode === 'sentinel' ? trim(redis.masterName) : undefined;
  const sentinelUser = redis.mode === 'sentinel' ? trim(redis.sentinelUser) : undefined;
  return {
    mode: redis.mode,
    ...(masterName === undefined ? {} : { masterName }),
    ...(nodes.length === 0 ? {} : { nodes }),
    ...(sentinelUser === undefined ? {} : { sentinelUser }),
  };
}

/**
 * A direct connection with nothing else set is the default and is not stored; the set
 * name and the other members belong to replica set mode, and blank rows are dropped.
 */
function normalizeMongo(mongo: MongoSettings | undefined): MongoSettings | undefined {
  if (mongo === undefined) {
    return undefined;
  }
  const trim = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const replicaSet = mongo.mode === 'replicaSet' ? trim(mongo.replicaSet) : undefined;
  const nodes =
    mongo.mode === 'replicaSet'
      ? (mongo.nodes ?? [])
          .filter((node) => node.host.trim() !== '' || node.port !== undefined)
          .map((node) => ({
            host: node.host.trim(),
            ...(node.port === undefined ? {} : { port: node.port }),
          }))
      : [];
  const authSource = trim(mongo.authSource);
  const normalized: MongoSettings = {
    mode: mongo.mode,
    ...(replicaSet === undefined ? {} : { replicaSet }),
    ...(nodes.length === 0 ? {} : { nodes }),
    ...(authSource === undefined ? {} : { authSource }),
    ...(mongo.authMechanism === undefined ? {} : { authMechanism: mongo.authMechanism }),
  };
  return Object.keys(normalized).length === 1 && normalized.mode === 'direct'
    ? undefined
    : normalized;
}

/** Basic sign-in at the root is the default and is not stored. */
function normalizeElastic(elastic: ElasticSettings | undefined): ElasticSettings | undefined {
  const prefix = elastic?.pathPrefix?.trim().replace(/\/+$/, '') ?? '';
  if (elastic === undefined || (elastic.auth === 'basic' && prefix === '')) {
    return undefined;
  }
  return { auth: elastic.auth, ...(prefix === '' ? {} : { pathPrefix: prefix }) };
}

/** True for a Redis connection that finds its master through Sentinels. */
function usesSentinels(config: ConnectionInput): boolean {
  return config.driver === 'redis' && config.redis?.mode === 'sentinel';
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
