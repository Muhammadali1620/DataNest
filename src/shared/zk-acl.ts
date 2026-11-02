// Editing the ACL of a znode (V13.27): which schemes the page offers, what makes an entry
// valid, and how a digest entry typed as `user:password` becomes the `user:hash` the server
// stores. Free of `vscode` and of Node, so the page checks entries as they are typed.

import type { ZnodeAclEntry } from './protocols/zookeeper-node';

export const ACL_SCHEMES = ['world', 'auth', 'digest', 'ip', 'x509', 'sasl'] as const;

export const PERM_READ = 1;
export const PERM_WRITE = 2;
export const PERM_CREATE = 4;
export const PERM_DELETE = 8;
export const PERM_ADMIN = 16;

/** The five permission bits with the letters the page shows, in ZooKeeper's order. */
export const ACL_PERMS = [
  { bit: PERM_READ, letter: 'r' },
  { bit: PERM_WRITE, letter: 'w' },
  { bit: PERM_CREATE, letter: 'c' },
  { bit: PERM_DELETE, letter: 'd' },
  { bit: PERM_ADMIN, letter: 'a' },
] as const;

export type AclProblem = 'scheme' | 'perms' | 'world-id' | 'auth-id' | 'digest-id' | 'id-empty';

/** What a SHA-1 digest looks like in base64: 27 characters and one `=`. */
export const DIGEST_HASH = /^[A-Za-z0-9+/]{27}=$/u;

/** The first thing wrong with an entry, or undefined when the server can take it. */
export function aclProblem(entry: ZnodeAclEntry): AclProblem | undefined {
  if (!(ACL_SCHEMES as readonly string[]).includes(entry.scheme)) {
    return 'scheme';
  }
  if (!Number.isInteger(entry.perms) || entry.perms < 1 || entry.perms > 31) {
    return 'perms';
  }
  switch (entry.scheme) {
    case 'world':
      return entry.id === 'anyone' ? undefined : 'world-id';
    // `auth` stands for whoever is signed in; its id is ignored by the server.
    case 'auth':
      return entry.id === '' ? undefined : 'auth-id';
    case 'digest': {
      const colon = entry.id.indexOf(':');
      return colon > 0 && colon < entry.id.length - 1 ? undefined : 'digest-id';
    }
    default:
      return entry.id.trim() === '' ? 'id-empty' : undefined;
  }
}

/** Does the ACL leave nobody with the right to change it again? */
export function aclLocksOut(acl: readonly ZnodeAclEntry[]): boolean {
  return !acl.some((entry) => (entry.perms & PERM_ADMIN) !== 0);
}

/** Is the part after the colon of a digest id already a hash? */
export function isDigestHash(password: string): boolean {
  return DIGEST_HASH.test(password);
}
