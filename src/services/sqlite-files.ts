// "Open in DataNest" on a SQLite file of the Explorer (V10.2.3): the connection that
// already opens that file, or a new one named after it.

import { basename, normalize } from 'node:path';
import type { ConnectionConfig, ConnectionInput } from '../shared/connection';

/** File extensions the Explorer offers the command for. */
export const SQLITE_FILE_EXTENSIONS: readonly string[] = ['.db', '.sqlite', '.sqlite3', '.db3'];

/** Paths compare without case on Windows and macOS, whose file systems ignore it. */
function samePath(a: string, b: string, ignoreCase: boolean): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return ignoreCase ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The SQLite connection that opens this file, if there is one. */
export function connectionOfFile(
  file: string,
  connections: readonly ConnectionConfig[],
  ignoreCase: boolean,
): ConnectionConfig | undefined {
  return connections.find(
    (config) =>
      config.driver === 'sqlite' &&
      config.file !== undefined &&
      samePath(config.file, file, ignoreCase),
  );
}

/** A new connection for the file, named after it; a taken name gets ` (2)`, ` (3)`, … */
export function connectionForFile(
  file: string,
  connections: readonly ConnectionConfig[],
): ConnectionInput {
  const base = basename(file) || file;
  const taken = new Set(connections.map((config) => config.name.toLowerCase()));
  let name = base;
  for (let attempt = 2; taken.has(name.toLowerCase()); attempt++) {
    name = `${base} (${attempt})`;
  }
  return { name, driver: 'sqlite', file };
}
