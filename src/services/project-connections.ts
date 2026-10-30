// Connections a project shares through `.vscode/datanest.json` (V4.7). The file is
// committed with the code, so it never holds a password: each person keeps theirs in
// SecretStorage under the connection's id, which stays the same while the file's `id`
// does. Knows nothing about vscode: files come through the `ProjectFiles` interface.

import { isAbsolute, join, relative, sep } from 'node:path';
import { type Disposable, toDisposable } from '../core/disposable';
import { DbError, errorMessage } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { ConnectionConfig, ConnectionInput, SshHop } from '../shared/connection';
import {
  type ConnectionFile,
  entryJson,
  localIdFor,
  readConnectionFile,
  writeConnectionFile,
} from '../shared/connection-file';
import { msg } from '../core/user-message';

/** Where a project keeps its connections, relative to the workspace folder. */
export const PROJECT_FILE_PATH = '.vscode/datanest.json';

/** A workspace folder that may have a project file. */
export interface ProjectFolder {
  /** Identifies the folder, e.g. its URI; part of every connection id in it. */
  readonly key: string;
  readonly name: string;
  /** File system path of the folder; relative paths in the file start here. */
  readonly root: string;
}

/** The slice of the editor's file system the service needs. */
export interface ProjectFiles {
  /** The text of the folder's project file, or undefined when there is none. */
  read(folder: ProjectFolder): Promise<string | undefined>;
  write(folder: ProjectFolder, text: string): Promise<void>;
}

/** `untrusted`: the workspace is in Restricted Mode, so its connections are not used. */
export type ProjectStatus = 'ok' | 'broken' | 'untrusted';

/** A connection of the file that could not be used, by its position (from 1). */
export interface EntryProblem {
  readonly position: number;
  readonly problem: string;
}

/** What the tree shows for one project file. */
export interface ProjectView {
  readonly folder: ProjectFolder;
  readonly status: ProjectStatus;
  /** Usable connections in file order; empty unless `ok`. */
  readonly connections: readonly ConnectionConfig[];
  readonly problems: readonly EntryProblem[];
  /** Why the file could not be read; with `broken`. */
  readonly error?: string;
  /** How many connections the file lists, usable or not. */
  readonly listed: number;
}

export interface ProjectConnectionsDeps {
  readonly files: ProjectFiles;
  readonly logger: Logger;
}

interface Loaded {
  readonly view: ProjectView;
  /** Local id per connection id, to find the entry again when writing. */
  readonly localIds: ReadonlyMap<string, string>;
}

/** The id a project connection has on this computer: folder hash + its id in the file. */
export function projectConnectionId(folderKey: string, localId: string): string {
  return `p-${fnv1a(folderKey)}-${localId}`;
}

/**
 * Project files of the open workspace folders. Changes are written to the file at
 * once and read back from it, so the file is always what everyone else sees.
 */
export class ProjectConnections {
  private readonly files: ProjectFiles;
  private readonly logger: Logger;
  private readonly listeners = new Set<() => void>();
  private folderList: ProjectFolder[] = [];
  private loaded = new Map<string, Loaded>();
  private trusted = false;
  /** Loads and writes run one after another, so a write never races a reload. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ProjectConnectionsDeps) {
    this.files = deps.files;
    this.logger = deps.logger.child('project');
  }

  /** Replaces the set of folders and reads their files. */
  async load(folders: readonly ProjectFolder[], trusted: boolean): Promise<void> {
    await this.serial(async () => {
      this.folderList = [...folders];
      this.trusted = trusted;
      const loaded = new Map<string, Loaded>();
      for (const folder of folders) {
        const one = await this.read(folder);
        if (one !== undefined) {
          loaded.set(folder.key, one);
        }
      }
      this.loaded = loaded;
    });
    this.notify();
  }

  /** Reads every file again, e.g. on Refresh, in case a change on disk went unnoticed. */
  async reloadAll(): Promise<void> {
    await this.load(this.folderList, this.trusted);
  }

  /** Reads the file of one folder again, e.g. after it changed on disk. */
  async reload(key: string): Promise<void> {
    await this.serial(async () => {
      await this.refresh(key);
    });
    this.notify();
  }

  /** Every workspace folder, with a project file or not. */
  folders(): ProjectFolder[] {
    return [...this.folderList];
  }

  /** Folders a connection may be written to; none while the workspace is not trusted. */
  writableFolders(): ProjectFolder[] {
    return this.trusted ? this.folders() : [];
  }

  /** Folders that have a project file, in workspace order. */
  views(): ProjectView[] {
    return this.folderList.flatMap((folder) => {
      const one = this.loaded.get(folder.key);
      return one === undefined ? [] : [one.view];
    });
  }

  /** Usable connections of every project. */
  list(): ConnectionConfig[] {
    return this.views().flatMap((view) => view.connections);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((config) => config.id === id);
  }

  /** The folder whose file holds the connection, or undefined for any other id. */
  folderOf(id: string): ProjectFolder | undefined {
    return this.views().find((view) => view.connections.some((config) => config.id === id))?.folder;
  }

  /** Fires after files were read or written. */
  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  /** Appends a connection to a folder's file, creating the file if needed. */
  async add(folderKey: string, input: ConnectionInput): Promise<ConnectionConfig> {
    const folder = this.folderList.find((one) => one.key === folderKey);
    if (folder === undefined) {
      throw new DbError('not-found', msg('This workspace folder is not open'));
    }
    const id = await this.serial(async () => {
      this.requireTrust();
      const file = await this.readForWrite(folder);
      const taken = new Set(assignIds(file).values());
      const localId = localIdFor(input.name, taken);
      const entry = entryJson({ id: localId, input: toRelative(input, folder.root) });
      const connections = [...rawConnections(file), entry];
      await this.files.write(folder, writeConnectionFile({ raw: file?.raw ?? {}, connections }));
      await this.refresh(folder.key);
      return projectConnectionId(folder.key, localId);
    });
    this.notify();
    return this.require(id);
  }

  /** Puts new settings in place of a connection's entry; its id in the file stays. */
  async update(id: string, input: ConnectionInput): Promise<ConnectionConfig> {
    await this.rewrite(id, (connections, index, localId, folder) => {
      connections[index] = entryJson({ id: localId, input: toRelative(input, folder.root) });
    });
    return this.require(id);
  }

  /** Removes a connection from its file. */
  async remove(id: string): Promise<void> {
    await this.rewrite(id, (connections, index) => {
      connections.splice(index, 1);
    });
  }

  private async rewrite(
    id: string,
    change: (connections: unknown[], index: number, localId: string, folder: ProjectFolder) => void,
  ): Promise<void> {
    await this.serial(async () => {
      this.requireTrust();
      const folder = this.folderOf(id);
      const localId =
        folder === undefined ? undefined : this.loaded.get(folder.key)?.localIds.get(id);
      if (folder === undefined || localId === undefined) {
        throw new DbError('not-found', msg('Project connection "{0}" does not exist', id));
      }
      // The file may have changed since it was read (a pull, a teammate's edit):
      // the entry is found again by its id, not by its old position.
      const file = await this.readForWrite(folder);
      const index = [...assignIds(file).entries()].find(([, local]) => local === localId)?.[0];
      if (file === undefined || index === undefined) {
        throw new DbError('not-found', msg('The connection is no longer in the project file'));
      }
      const connections = rawConnections(file);
      change(connections, index, localId, folder);
      await this.files.write(folder, writeConnectionFile({ raw: file.raw, connections }));
      await this.refresh(folder.key);
    });
    this.notify();
  }

  private requireTrust(): void {
    if (!this.trusted) {
      throw new DbError(
        'unsupported',
        msg('Trust this workspace to change its project connections'),
      );
    }
  }

  /** The current file for a write; a file that does not read must be fixed by hand first. */
  private async readForWrite(folder: ProjectFolder): Promise<ConnectionFile | undefined> {
    const text = await this.files.read(folder);
    if (text === undefined) {
      return undefined;
    }
    const result = readConnectionFile(text);
    if (!result.ok) {
      throw new DbError(
        'unsupported',
        msg('{0} cannot be read: {1}', PROJECT_FILE_PATH, result.error),
      );
    }
    return result.file;
  }

  private require(id: string): ConnectionConfig {
    const config = this.get(id);
    if (config === undefined) {
      throw new DbError(
        'internal',
        msg('Project connection "{0}" was written but not read back', id),
      );
    }
    return config;
  }

  private async refresh(key: string): Promise<void> {
    const folder = this.folderList.find((one) => one.key === key);
    if (folder === undefined) {
      return;
    }
    const one = await this.read(folder);
    if (one === undefined) {
      this.loaded.delete(key);
    } else {
      this.loaded.set(key, one);
    }
  }

  /** Reads and checks one folder's file; undefined when it has none. */
  private async read(folder: ProjectFolder): Promise<Loaded | undefined> {
    let text: string | undefined;
    try {
      text = await this.files.read(folder);
    } catch (error) {
      this.logger.warn(`Could not read ${PROJECT_FILE_PATH} of ${folder.name}`, error);
      return broken(folder, errorMessage(error));
    }
    if (text === undefined) {
      return undefined;
    }
    const result = readConnectionFile(text);
    if (!result.ok) {
      this.logger.warn(`${PROJECT_FILE_PATH} of ${folder.name} is broken: ${result.error}`);
      return broken(folder, result.error);
    }
    const { file } = result;
    const listed = file.entries.length;
    if (!this.trusted) {
      return {
        view: { folder, status: 'untrusted', connections: [], problems: [], listed },
        localIds: new Map(),
      };
    }
    const ids = assignIds(file);
    const connections: ConnectionConfig[] = [];
    const localIds = new Map<string, string>();
    const problems: EntryProblem[] = [];
    file.entries.forEach((result, index) => {
      const localId = ids.get(index);
      if (!result.ok || localId === undefined) {
        problems.push({
          position: index + 1,
          problem: result.ok ? `id "${result.entry.id ?? ''}" is used twice` : result.problem,
        });
        return;
      }
      const id = projectConnectionId(folder.key, localId);
      connections.push({ ...toAbsolute(withoutFolder(result.entry.input), folder.root), id });
      localIds.set(id, localId);
    });
    return { view: { folder, status: 'ok', connections, problems, listed }, localIds };
  }

  private async serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return await run;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn('A project change listener failed', error);
      }
    }
  }
}

function broken(folder: ProjectFolder, error: string): Loaded {
  return {
    view: { folder, status: 'broken', connections: [], problems: [], error, listed: 0 },
    localIds: new Map(),
  };
}

/**
 * Local id per entry position. Ids written in the file come first; a connection
 * without one gets an id made from its name, which is stable as long as the name is.
 * A repeated id leaves its later entry without one.
 */
function assignIds(file: ConnectionFile | undefined): Map<number, string> {
  const ids = new Map<number, string>();
  const taken = new Set<string>();
  const entries = file?.entries ?? [];
  entries.forEach((result, index) => {
    const id = result.ok ? result.entry.id : undefined;
    if (id !== undefined && !taken.has(id)) {
      taken.add(id);
      ids.set(index, id);
    }
  });
  entries.forEach((result, index) => {
    if (result.ok && result.entry.id === undefined) {
      const id = localIdFor(result.entry.input.name, taken);
      taken.add(id);
      ids.set(index, id);
    }
  });
  return ids;
}

function rawConnections(file: ConnectionFile | undefined): unknown[] {
  const list: unknown = file?.raw.connections;
  return Array.isArray(list) ? [...(list as unknown[])] : [];
}

/** Projects have no folders of their own: the project is the folder. */
function withoutFolder(input: ConnectionInput): ConnectionInput {
  const { folder: _folder, ...rest } = input;
  return rest;
}

/** Applies `map` to every path a connection names: its file, certificates and SSH keys. */
function mapPaths<T extends ConnectionInput>(input: T, map: (path: string) => string): T {
  const hop = <H extends SshHop>(one: H): H =>
    one.keyFile === undefined ? one : { ...one, keyFile: map(one.keyFile) };
  const ssl = input.ssl;
  return {
    ...input,
    ...(input.file === undefined ? {} : { file: map(input.file) }),
    ...(ssl === undefined
      ? {}
      : {
          ssl: {
            mode: ssl.mode,
            ...(ssl.ca === undefined ? {} : { ca: map(ssl.ca) }),
            ...(ssl.cert === undefined ? {} : { cert: map(ssl.cert) }),
            ...(ssl.key === undefined ? {} : { key: map(ssl.key) }),
          },
        }),
    ...(input.ssh === undefined
      ? {}
      : {
          ssh: {
            ...hop(input.ssh),
            ...(input.ssh.jumps === undefined ? {} : { jumps: input.ssh.jumps.map(hop) }),
          },
        }),
  };
}

/** Relative paths in the file start at the workspace folder; `~` is left to the tunnel. */
export function toAbsolute<T extends ConnectionInput>(input: T, root: string): T {
  return mapPaths(input, (path) =>
    path === '' || path.startsWith('~') || isAbsolute(path) ? path : join(root, path),
  );
}

/** Paths inside the workspace folder are written relative, with `/`, so they work for everyone. */
export function toRelative(input: ConnectionInput, root: string): ConnectionInput {
  return withoutFolder(
    mapPaths(input, (path) => {
      if (!isAbsolute(path)) {
        return path;
      }
      const inside = relative(root, path);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        return path;
      }
      return inside.split(sep).join('/');
    }),
  );
}

/** 32-bit FNV-1a as 8 hex digits: short, stable, and enough to tell folders apart. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
