// The drivers other extensions have registered (V12.7), by their ids. Registering is the
// whole of the public API's work: the rest of DataNest asks this list when a connection
// of the `plugin` kind opens, and the connection commands list it for the user.

import type { PluginDriver, PluginField, PluginRegistration } from '../../api/types';
import { type Disposable, toDisposable } from '../../core/disposable';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { Driver } from '../driver';
import { createPluginDriver, pluginProblem } from './adapter';

/** What the connection commands need to know about a registered driver. */
export interface PluginInfo {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly PluginField[];
  readonly defaultPort?: number;
}

const FIELDS: readonly PluginField[] = ['host', 'port', 'user', 'password', 'database', 'file'];

interface Entry {
  readonly descriptor: PluginDriver;
  readonly driver: Driver;
  readonly info: PluginInfo;
}

export class PluginDrivers {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();

  /** Adds a driver; throws a DbError for a bad descriptor or an id that is taken. */
  register(descriptor: PluginDriver): PluginRegistration {
    const problem = pluginProblem(descriptor);
    if (problem !== undefined) {
      throw new DbError('unsupported', problem);
    }
    if (this.entries.has(descriptor.id)) {
      throw new DbError(
        'unsupported',
        msg('A driver with the id "{0}" is already registered', descriptor.id),
      );
    }
    const info: PluginInfo = {
      id: descriptor.id,
      label: descriptor.label.trim(),
      // Unknown names are dropped and repeats counted once, in the form's order.
      fields: FIELDS.filter((field) => descriptor.fields.includes(field)),
      ...(typeof descriptor.defaultPort === 'number' &&
      Number.isInteger(descriptor.defaultPort) &&
      descriptor.defaultPort >= 1 &&
      descriptor.defaultPort <= 65_535
        ? { defaultPort: descriptor.defaultPort }
        : {}),
    };
    const entry: Entry = { descriptor, driver: createPluginDriver(descriptor), info };
    this.entries.set(descriptor.id, entry);
    this.notify();
    return toDisposable(() => {
      // Only the registration that made the entry may take it away.
      if (this.entries.get(descriptor.id) === entry) {
        this.entries.delete(descriptor.id);
        this.notify();
      }
    });
  }

  /** The driver for an id, or a DbError that says the plugin is not there. */
  get(id: string): Driver {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new DbError(
        'unsupported',
        msg('The driver "{0}" is not available: its extension is not installed or not active', id),
      );
    }
    return entry.driver;
  }

  describe(id: string): PluginInfo | undefined {
    return this.entries.get(id)?.info;
  }

  list(): PluginInfo[] {
    return [...this.entries.values()].map((entry) => entry.info);
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
