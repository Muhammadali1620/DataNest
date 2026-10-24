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
  DRIVER_IDS,
  isFileDriver,
} from '../core/model/connection';
import { array, literal, number, object, optional, type Schema, string } from '../shared/schema';

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

const connectionConfigSchema: Schema<ConnectionConfig> = object({
  id: string({ minLength: 1, maxLength: 100 }),
  name: string({ minLength: 1, maxLength: CONNECTION_LIMITS.name }),
  driver: literal(...DRIVER_IDS),
  host: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  port: optional(number({ integer: true, min: 1, max: 65_535 })),
  user: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  database: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  file: optional(string({ maxLength: CONNECTION_LIMITS.file })),
});

const stateSchema = object({
  version: literal(1),
  items: array(connectionConfigSchema, { maxLength: 10_000 }),
});

/** How a password changes on update: keep the stored one, replace it, or erase it. */
export type PasswordChange =
  | { readonly kind: 'keep' }
  | { readonly kind: 'set'; readonly value: string }
  | { readonly kind: 'clear' };

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

  constructor(deps: ConnectionStoreDeps) {
    this.state = deps.state;
    this.secrets = deps.secrets;
    this.logger = deps.logger.child('connections');
    this.items = this.load();
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

  async add(input: ConnectionInput, password?: string): Promise<ConnectionConfig> {
    const config: ConnectionConfig = { ...normalizeInput(input), id: crypto.randomUUID() };
    await this.save([...this.items, config]);
    if (password !== undefined && password !== '') {
      await this.secrets.store(passwordSecretKey(config.id), password);
    }
    this.notify();
    return config;
  }

  async update(
    id: string,
    input: ConnectionInput,
    password: PasswordChange = { kind: 'keep' },
  ): Promise<ConnectionConfig> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new DbError('not-found', `Connection "${id}" does not exist`);
    }
    const config: ConnectionConfig = { ...normalizeInput(input), id };
    const items = [...this.items];
    items[index] = config;
    await this.save(items);
    if (password.kind === 'set') {
      if (password.value === '') {
        await this.secrets.delete(passwordSecretKey(id));
      } else {
        await this.secrets.store(passwordSecretKey(id), password.value);
      }
    } else if (password.kind === 'clear') {
      await this.secrets.delete(passwordSecretKey(id));
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
    await this.save(items);
    await this.secrets.delete(passwordSecretKey(id));
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
    this.notify();
    return copy;
  }

  async getPassword(id: string): Promise<string | undefined> {
    return await this.secrets.get(passwordSecretKey(id));
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

  private load(): ConnectionConfig[] {
    const raw = this.state.get(CONNECTIONS_STATE_KEY);
    if (raw === undefined) {
      return [];
    }
    try {
      return stateSchema.parse(raw).items;
    } catch (error) {
      // Broken state must not brick the extension: start empty, keep the log loud.
      this.logger.error('Saved connections are corrupted and were ignored', error);
      return [];
    }
  }

  private async save(items: ConnectionConfig[]): Promise<void> {
    await this.state.update(CONNECTIONS_STATE_KEY, { version: 1, items });
    this.items = items;
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
  };
  const problems = connectionProblems(normalized);
  if (problems.length > 0) {
    throw new DbError('unsupported', `Invalid connection: ${problems.join(', ')}`);
  }
  return normalized;
}
