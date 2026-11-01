// Queries kept in the project (V12.3): `.vscode/datanest-queries/<name>.sql` in a
// workspace folder, next to the connections file, so they are committed with the code
// and the whole team opens the same ones. They are plain SQL files. The first lines
// may say where a query runs, as comments no server minds:
//   -- datanest: connection=staging     (the id in .vscode/datanest.json)
//   -- datanest: database=shop
// A connection that is not in the project file is never named: its id means nothing
// to anyone else.

import { DbError } from '../core/errors';
import { msg } from '../core/user-message';
import { projectConnectionId, type ProjectFolder } from './project-connections';
import { savedQueryName, savedQueryNameProblem, SAVED_QUERY_EXTENSION } from './saved-queries';

export const PROJECT_QUERIES_PATH = '.vscode/datanest-queries';

/** Queries listed from one folder; the rest are not read. */
export const MAX_PROJECT_QUERIES = 500;

/** Where the queries of a folder are, by name; implemented over the editor's file system. */
export interface ProjectQueryFiles {
  /** Names (without `.sql`) of the files in the folder, none when it does not exist. */
  list(folder: ProjectFolder): Promise<string[]>;
  read(folder: ProjectFolder, name: string): Promise<string | undefined>;
  write(folder: ProjectFolder, name: string, text: string): Promise<void>;
  remove(folder: ProjectFolder, name: string): Promise<void>;
}

export interface QueryPlace {
  /** Id of the connection in the project file. */
  readonly connection?: string;
  readonly database?: string;
}

export interface ProjectQuery {
  readonly folder: ProjectFolder;
  readonly name: string;
  readonly place: QueryPlace;
}

/** The byte order mark some editors put at the start of a file. */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const HEADER_LINE = /^--[ \t]*datanest:[ \t]*(connection|database)[ \t]*=[ \t]*(.*?)[ \t]*$/iu;

/** The place a query says it runs in, from the comment lines at its start. */
export function parseQueryPlace(text: string): QueryPlace {
  let connection: string | undefined;
  let database: string | undefined;
  for (const line of withoutBom(text).split(/\r?\n/u)) {
    const match = HEADER_LINE.exec(line);
    if (match === null) {
      break;
    }
    const value = match[2] ?? '';
    if (value === '') {
      continue;
    }
    if (match[1]?.toLowerCase() === 'connection') {
      connection = value;
    } else {
      database = value;
    }
  }
  return {
    ...(connection === undefined ? {} : { connection }),
    ...(database === undefined ? {} : { database }),
  };
}

/** The query without the lines that name its place. */
export function stripQueryPlace(text: string): string {
  const lines = withoutBom(text).split(/\r?\n/u);
  let skipped = 0;
  while (skipped < lines.length && HEADER_LINE.test(lines[skipped] ?? '')) {
    skipped++;
  }
  return lines.slice(skipped).join('\n');
}

/** The query with its place named at the start, replacing any named before. */
export function withQueryPlace(text: string, place: QueryPlace): string {
  const header = [
    place.connection === undefined ? undefined : `-- datanest: connection=${place.connection}`,
    place.database === undefined ? undefined : `-- datanest: database=${place.database}`,
  ].filter((line) => line !== undefined);
  const body = stripQueryPlace(text).replace(/^\n+/u, '');
  return header.length === 0 ? body : `${header.join('\n')}\n${body}`;
}

/**
 * The id a connection has in the project file of a folder, or undefined when the
 * connection is not one of that folder's.
 */
export function projectLocalId(folder: ProjectFolder, connectionId: string): string | undefined {
  const prefix = projectConnectionId(folder.key, '');
  const local = connectionId.startsWith(prefix) ? connectionId.slice(prefix.length) : '';
  return local === '' ? undefined : local;
}

export class ProjectQueries {
  constructor(private readonly files: ProjectQueryFiles) {}

  /** The queries of the folders, sorted by name within each folder. */
  async list(folders: readonly ProjectFolder[]): Promise<ProjectQuery[]> {
    const queries: ProjectQuery[] = [];
    for (const folder of folders) {
      const names = (await this.files.list(folder))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .slice(0, MAX_PROJECT_QUERIES);
      for (const name of names) {
        const text = await this.files.read(folder, name);
        queries.push({
          folder,
          name,
          place: text === undefined ? {} : parseQueryPlace(text.slice(0, 2000)),
        });
      }
    }
    return queries;
  }

  async exists(folder: ProjectFolder, rawName: string): Promise<boolean> {
    return (await this.files.read(folder, savedQueryName(rawName))) !== undefined;
  }

  /** Writes a query under a name, replacing the one that has it. Returns the name used. */
  async save(
    folder: ProjectFolder,
    rawName: string,
    sql: string,
    place: QueryPlace = {},
  ): Promise<string> {
    const name = savedQueryName(rawName);
    const problem = savedQueryNameProblem(name);
    if (problem !== undefined) {
      throw new DbError('syntax', problem);
    }
    if (sql.trim() === '') {
      throw new DbError('syntax', msg('There is nothing to save: the query is empty'));
    }
    const text = withQueryPlace(sql, place);
    await this.files.write(folder, name, text.endsWith('\n') ? text : `${text}\n`);
    return name;
  }

  async remove(folder: ProjectFolder, name: string): Promise<void> {
    await this.files.remove(folder, name);
  }
}

export { SAVED_QUERY_EXTENSION as PROJECT_QUERY_EXTENSION };
