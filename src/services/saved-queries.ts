// The "Query" folder of a database or schema in the tree (V11.12): SQL files the user
// keeps for that place. They are ordinary files, so the editor saves them with Ctrl+S
// and the connection they talk to is remembered like that of any saved file
// (binding-memory.ts). Kept free of `vscode`: the host passes the folder.

import type { Dirent } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DbError } from '../core/errors';
import type { ObjectScope } from '../core/model/objects';
import { msg } from '../core/user-message';

export const SAVED_QUERY_EXTENSION = '.sql';

/** Most characters of a name: what file systems take, with room for the extension. */
export const SAVED_QUERY_NAME_LIMIT = 100;

/** A path segment that cannot collide with another name or climb out of the folder. */
function segment(prefix: string, name: string): string {
  return `${prefix}${encodeURIComponent(name).replaceAll('%', '~').replaceAll('.', '~2E')}`;
}

/** The problem with a name for a saved query, or undefined when it is fine. */
export function savedQueryNameProblem(raw: string): string | undefined {
  const name = raw.trim();
  if (name === '') {
    return msg('Enter a name');
  }
  if (name.length > SAVED_QUERY_NAME_LIMIT) {
    return msg('A name can be at most {0} characters long', SAVED_QUERY_NAME_LIMIT);
  }
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(name) || name === '.' || name === '..') {
    return msg(
      'A file cannot have this name: it has a character that file names cannot hold, or it is "." or ".."',
    );
  }
  return undefined;
}

/** `report.sql` and `report` are the same query. */
export function savedQueryName(raw: string): string {
  const name = raw.trim();
  return name.toLowerCase().endsWith(SAVED_QUERY_EXTENSION)
    ? name.slice(0, -SAVED_QUERY_EXTENSION.length).trim()
    : name;
}

export class SavedQueryStore {
  constructor(private readonly root: string) {}

  /** The folder of a connection's database or schema. */
  folderOf(connectionId: string, scope: ObjectScope): string {
    return join(
      this.root,
      segment('c-', connectionId),
      ...(scope.database === undefined ? [] : [segment('d-', scope.database)]),
      ...(scope.schema === undefined ? [] : [segment('s-', scope.schema)]),
    );
  }

  pathOf(connectionId: string, scope: ObjectScope, name: string): string {
    return join(this.folderOf(connectionId, scope), `${name}${SAVED_QUERY_EXTENSION}`);
  }

  /** The names of the saved queries, sorted; a place never used has none. */
  async list(connectionId: string, scope: ObjectScope): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.folderOf(connectionId, scope), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(SAVED_QUERY_EXTENSION))
      .map((entry) => entry.name.slice(0, -SAVED_QUERY_EXTENSION.length))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /** A new file with `content`, named `wanted` or the first free `wanted-2`, `wanted-3`, … */
  async create(
    connectionId: string,
    scope: ObjectScope,
    wanted = 'query',
    content = '',
  ): Promise<{ readonly name: string; readonly path: string }> {
    const base = savedQueryName(wanted);
    const problem = savedQueryNameProblem(base);
    if (problem !== undefined) {
      throw new DbError('syntax', problem);
    }
    await mkdir(this.folderOf(connectionId, scope), { recursive: true });
    for (let number = 1; ; number += 1) {
      const name = number === 1 ? base : `${base}-${number}`;
      const path = this.pathOf(connectionId, scope, name);
      if (!(await this.exists(path))) {
        // `wx` never overwrites: a file made between the check and the write stays.
        try {
          await writeFile(path, content, { flag: 'wx' });
          return { name, path };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
        }
      }
    }
  }

  async rename(
    connectionId: string,
    scope: ObjectScope,
    from: string,
    to: string,
  ): Promise<string> {
    const name = savedQueryName(to);
    const problem = savedQueryNameProblem(name);
    if (problem !== undefined) {
      throw new DbError('syntax', problem);
    }
    const target = this.pathOf(connectionId, scope, name);
    if (name !== from && (await this.exists(target))) {
      throw new DbError('constraint', msg('A saved query named "{0}" already exists', name));
    }
    await rename(this.pathOf(connectionId, scope, from), target);
    return target;
  }

  async remove(connectionId: string, scope: ObjectScope, name: string): Promise<void> {
    await rm(this.pathOf(connectionId, scope, name), { force: true });
  }
}
