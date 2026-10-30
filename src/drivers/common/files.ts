// Files the user points a connection at: private keys, certificates. Read at
// connect time, so a renewed certificate is picked up without editing anything.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';

/** `~/…` paths are what people copy from their SSH and client configs. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') {
    return home;
  }
  return path.startsWith('~/') || path.startsWith('~\\') ? home + path.slice(1) : path;
}

/** Reads a file the user chose; `what` names it in the error ("the CA certificate"). */
export async function readUserFile(path: string, what: string): Promise<Buffer> {
  const file = expandHome(path.trim());
  try {
    return await readFile(file);
  } catch (error) {
    throw new DbError('not-found', msg('Cannot read {0} "{1}"', what, file), { cause: error });
  }
}
