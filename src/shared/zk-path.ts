// Paths and kinds of ZooKeeper znodes (V13.24). A path starts with a slash and has no
// empty, `.` or `..` part; `/` itself is the root. The kind of a znode is told by the owner
// in its stat: `0` for an ordinary one, a session id for an ephemeral one, and two special
// forms for containers and nodes with a time to live.

export const ROOT_PATH = '/';

/** `/a/b` + `c` → `/a/b/c`; `/` + `c` → `/c`. */
export function joinPath(parent: string, name: string): string {
  return parent === ROOT_PATH ? `/${name}` : `${parent}/${name}`;
}

/** `/a/b` → `/a`; `/a` and `/` → `/`. */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? ROOT_PATH : path.slice(0, cut);
}

/** `/a/b` → `b`; `/` → `/`. */
export function nameOf(path: string): string {
  if (path === ROOT_PATH) {
    return ROOT_PATH;
  }
  return path.slice(path.lastIndexOf('/') + 1);
}

export type NameProblem = 'empty' | 'slash' | 'dots' | 'null' | 'long';

/** Why a name cannot be the name of a znode; undefined when it can. */
export function nameProblem(name: string): NameProblem | undefined {
  if (name === '') {
    return 'empty';
  }
  if (name.includes('/')) {
    return 'slash';
  }
  if (name === '.' || name === '..') {
    return 'dots';
  }
  if (name.includes('\u0000')) {
    return 'null';
  }
  if (name.length > 1000) {
    return 'long';
  }
  return undefined;
}

/** Why a path is not one; undefined when it is. */
export function pathProblem(path: string): NameProblem | 'relative' | undefined {
  if (!path.startsWith('/')) {
    return 'relative';
  }
  if (path === ROOT_PATH) {
    return undefined;
  }
  for (const part of path.slice(1).split('/')) {
    const problem = nameProblem(part);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

/** A name that ends in the 10-digit counter the server adds to a sequential znode. */
export function isSequentialName(name: string): boolean {
  return /\d{10}$/u.test(name);
}

export type ZnodeKind = 'persistent' | 'ephemeral' | 'container' | 'ttl';

const CONTAINER_OWNER = 1n << 63n;
const TTL_PREFIX = 0xffn << 56n;

/** What the `ephemeralOwner` of a stat says the znode is. */
export function kindOfOwner(ephemeralOwner: string): ZnodeKind {
  let owner: bigint;
  try {
    owner = BigInt(ephemeralOwner);
  } catch {
    return 'persistent';
  }
  if (owner === 0n) {
    return 'persistent';
  }
  if (owner === CONTAINER_OWNER) {
    return 'container';
  }
  if ((owner & TTL_PREFIX) === TTL_PREFIX) {
    return 'ttl';
  }
  return 'ephemeral';
}

/** A session id the way ZooKeeper's tools print it: `0x1000a2b3c4d`. */
export function hexId(decimal: string): string {
  try {
    return `0x${BigInt(decimal).toString(16)}`;
  } catch {
    return decimal;
  }
}

/** The permissions of an ACL entry as the letters ZooKeeper's tools use: `rwcda`. */
export function permissionLetters(perms: number): string {
  return [
    (perms & 1) !== 0 ? 'r' : '-',
    (perms & 2) !== 0 ? 'w' : '-',
    (perms & 4) !== 0 ? 'c' : '-',
    (perms & 8) !== 0 ? 'd' : '-',
    (perms & 16) !== 0 ? 'a' : '-',
  ].join('');
}

/** The codes of two failures the page tells apart from the rest (`KeeperException.Code`). */
export const ZK_BAD_VERSION = -103;
export const ZK_NODE_EXISTS = -110;
