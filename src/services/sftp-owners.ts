// Names for the numeric owner and group of a file on a server (V13.36). SFTP (protocol 3)
// only carries numbers, so the names come from the server's own `/etc/passwd` and `/etc/group`,
// read as ordinary files: nothing is run on the server. A server without those files (or a
// user who may not read them) simply has no names, and the numbers stay what is shown.

import type { SftpSession } from './sftp-types';

/** A name for each id, and an id for each name. */
export interface OwnerNames {
  readonly users: ReadonlyMap<number, string>;
  readonly groups: ReadonlyMap<number, string>;
  readonly userIds: ReadonlyMap<string, number>;
  readonly groupIds: ReadonlyMap<string, number>;
}

export const NO_OWNER_NAMES: OwnerNames = {
  users: new Map(),
  groups: new Map(),
  userIds: new Map(),
  groupIds: new Map(),
};

/** More than this is not a passwd file worth reading (a directory service can make it huge). */
const MAX_NAME_FILE_BYTES = 2 * 1024 * 1024;

/** The `[name, id]` of each line of `/etc/passwd` (id in the third field) or `/etc/group`. */
function nameLines(text: string): [string, number][] {
  const lines: [string, number][] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const fields = line.split(':');
    const name = fields[0];
    const id = fields[2];
    if (name === undefined || name === '' || id === undefined || !/^\d+$/u.test(id)) {
      continue;
    }
    lines.push([name, Number(id)]);
  }
  return lines;
}

/** The name of each id; the first line for an id wins, as it does for the system's lookup. */
export function parseNameFile(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const [name, id] of nameLines(text)) {
    if (!names.has(id)) {
      names.set(id, name);
    }
  }
  return names;
}

/** The id of each name; an alias (a second name for an id) is found too. */
function parseIdFile(text: string): Map<string, number> {
  const ids = new Map<string, number>();
  for (const [name, id] of nameLines(text)) {
    if (!ids.has(name)) {
      ids.set(name, id);
    }
  }
  return ids;
}

export function ownerNamesOf(passwd: string, group: string): OwnerNames {
  return {
    users: parseNameFile(passwd),
    groups: parseNameFile(group),
    userIds: parseIdFile(passwd),
    groupIds: parseIdFile(group),
  };
}

async function readSmallFile(session: SftpSession, path: string): Promise<string> {
  try {
    const { stream, size } = await session.openRead(path);
    if (size > MAX_NAME_FILE_BYTES) {
      stream.destroy();
      return '';
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += part.length;
      if (total > MAX_NAME_FILE_BYTES) {
        stream.destroy();
        return '';
      }
      chunks.push(part);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

/** Reads the two files; a missing or unreadable one gives no names, never an error. */
export async function loadOwnerNames(session: SftpSession): Promise<OwnerNames> {
  const [passwd, group] = await Promise.all([
    readSmallFile(session, '/etc/passwd'),
    readSmallFile(session, '/etc/group'),
  ]);
  return ownerNamesOf(passwd, group);
}

/** `deploy:www`, or the number when the server has no name for it. */
export function ownerText(
  uid: number | undefined,
  gid: number | undefined,
  names: OwnerNames = NO_OWNER_NAMES,
): string {
  if (uid === undefined && gid === undefined) {
    return '';
  }
  const user = uid === undefined ? '' : (names.users.get(uid) ?? String(uid));
  const group = gid === undefined ? '' : (names.groups.get(gid) ?? String(gid));
  return `${user}:${group}`;
}

/** The largest user or group number SFTP can carry (an unsigned 32-bit number). */
const MAX_ID = 0xffff_ffff;

export type OwnerRequest =
  | { readonly uid?: number; readonly gid?: number }
  | { readonly unknown: 'user' | 'group'; readonly name: string };

/**
 * `1000:1000`, `deploy:www`, `deploy`, `:www` — numbers or names, each part either. A name is
 * looked up in the server's own files; a name it does not know is reported, not guessed.
 * Undefined when the text is not an owner at all.
 */
export function resolveOwner(
  text: string,
  names: OwnerNames = NO_OWNER_NAMES,
): OwnerRequest | undefined {
  const match = /^\s*([^:\s]+)?\s*(?::\s*([^:\s]+)?)?\s*$/u.exec(text);
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    return undefined;
  }
  const out: { uid?: number; gid?: number } = {};
  const user = match[1];
  if (user !== undefined) {
    const id = /^\d+$/u.test(user) ? Number(user) : names.userIds.get(user);
    if (id !== undefined && id > MAX_ID) {
      return undefined;
    }
    if (id === undefined) {
      return { unknown: 'user', name: user };
    }
    out.uid = id;
  }
  const group = match[2];
  if (group !== undefined) {
    const id = /^\d+$/u.test(group) ? Number(group) : names.groupIds.get(group);
    if (id !== undefined && id > MAX_ID) {
      return undefined;
    }
    if (id === undefined) {
      return { unknown: 'group', name: group };
    }
    out.gid = id;
  }
  return out;
}
