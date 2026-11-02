// Users, roles and the permissions of roles in etcd (V13.27): the calls of the gateway's
// `auth/user/*` and `auth/role/*` family, one function each, in plain values. They work
// whether authentication is on or off; with it on, etcd lets only a user with the `root`
// role change anything. The functions take anything that can `call`, like the key calls
// in `etcd-client.ts`. No `vscode`.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import { displayKey } from '../../shared/redis-key';
import { fromBase64, prefixEnd, toBase64 } from './etcd-codec';
import type { EtcdCaller } from './etcd-client';

export type PermissionType = 'read' | 'write' | 'readwrite';

/** What a permission covers: one key, a prefix, every key, or a range of keys. */
export type PermissionScope = 'key' | 'prefix' | 'all' | 'range';

export interface EtcdPermission {
  readonly type: PermissionType;
  /** The first key (bytes), or the zero byte for "from the start". */
  readonly key: Uint8Array;
  /** The first key after the range; empty for a single key. */
  readonly end: Uint8Array;
}

export interface EtcdRoleView {
  readonly name: string;
  readonly permissions: readonly EtcdPermission[];
}

/** The role etcd needs for a user to change users, roles and the cluster. */
export const ROOT_ROLE = 'root';

const ZERO = Uint8Array.of(0);

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').sort()
    : [];
}

function field(answer: unknown, name: string): unknown {
  return typeof answer === 'object' && answer !== null
    ? (answer as Record<string, unknown>)[name]
    : undefined;
}

/** A name of a user or role: etcd refuses an empty one. */
export function nameProblem(name: string): 'empty' | 'long' | undefined {
  if (name.trim() === '') {
    return 'empty';
  }
  return name.length > 256 ? 'long' : undefined;
}

function requireName(name: string, what: string): void {
  if (nameProblem(name) !== undefined) {
    throw new DbError('syntax', msg('The name of a {0} must be 1 to 256 characters', what));
  }
}

export async function listUsers(session: EtcdCaller): Promise<string[]> {
  return strings(field(await session.call('auth/user/list', {}), 'users'));
}

export async function listRoles(session: EtcdCaller): Promise<string[]> {
  return strings(field(await session.call('auth/role/list', {}), 'roles'));
}

/** The roles a user has. */
export async function userRoles(session: EtcdCaller, name: string): Promise<string[]> {
  return strings(field(await session.call('auth/user/get', { name }), 'roles'));
}

function permissionOf(wire: unknown): EtcdPermission {
  const type = field(wire, 'permType');
  return {
    // The gateway leaves out the default, which is READ.
    type: type === 'WRITE' ? 'write' : type === 'READWRITE' ? 'readwrite' : 'read',
    key: fromBase64(field(wire, 'key')),
    end: fromBase64(field(wire, 'range_end')),
  };
}

export async function roleView(session: EtcdCaller, name: string): Promise<EtcdRoleView> {
  const wire = field(await session.call('auth/role/get', { role: name }), 'perm');
  return { name, permissions: Array.isArray(wire) ? wire.map(permissionOf) : [] };
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.length === 1 && bytes[0] === 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** How a permission is bounded, from its key and the end of its range. */
export function scopeOf(permission: Pick<EtcdPermission, 'key' | 'end'>): PermissionScope {
  if (permission.end.length === 0) {
    return 'key';
  }
  if (isZero(permission.key) && isZero(permission.end)) {
    return 'all';
  }
  return permission.key.length > 0 && sameBytes(permission.end, prefixEnd(permission.key))
    ? 'prefix'
    : 'range';
}

/** A permission in words the user can read: `readwrite /app/ (prefix)`. */
export function permissionText(permission: EtcdPermission): string {
  const scope = scopeOf(permission);
  switch (scope) {
    case 'all':
      return `${permission.type}: *`;
    case 'key':
      return `${permission.type}: ${displayKey(permission.key)}`;
    case 'prefix':
      return `${permission.type}: ${displayKey(permission.key)}*`;
    case 'range':
      return `${permission.type}: ${displayKey(permission.key)} … ${displayKey(permission.end)}`;
  }
}

/** The key and range end the gateway wants for a scope. */
export function boundsOf(
  scope: PermissionScope,
  key: Uint8Array,
  end?: Uint8Array,
): { readonly key: Uint8Array; readonly end: Uint8Array } {
  switch (scope) {
    case 'all':
      return { key: ZERO, end: ZERO };
    case 'key':
      return { key: requireKey(key), end: new Uint8Array() };
    case 'prefix':
      return { key: requireKey(key), end: prefixEnd(requireKey(key)) };
    case 'range':
      if (end === undefined || end.length === 0) {
        throw new DbError('syntax', msg('A range needs an end'));
      }
      return { key: requireKey(key), end };
  }
}

function requireKey(key: Uint8Array): Uint8Array {
  if (key.length === 0) {
    throw new DbError('syntax', msg('A permission needs a key; for every key choose "All keys"'));
  }
  return key;
}

export async function addUser(session: EtcdCaller, name: string, password: string): Promise<void> {
  requireName(name, 'user');
  // etcd takes a user without a password only when it has no password to check
  // (a certificate sign-in); asking for one avoids a user nobody can sign in as.
  if (password === '') {
    throw new DbError('syntax', msg('A user needs a password'));
  }
  await session.call('auth/user/add', { name, password });
}

export async function changePassword(
  session: EtcdCaller,
  name: string,
  password: string,
): Promise<void> {
  requireName(name, 'user');
  if (password === '') {
    throw new DbError('syntax', msg('A user needs a password'));
  }
  await session.call('auth/user/changepw', { name, password });
}

export async function deleteUser(session: EtcdCaller, name: string): Promise<void> {
  requireName(name, 'user');
  await session.call('auth/user/delete', { name });
}

export async function grantRole(session: EtcdCaller, user: string, role: string): Promise<void> {
  requireName(user, 'user');
  requireName(role, 'role');
  await session.call('auth/user/grant', { user, role });
}

export async function revokeRole(session: EtcdCaller, user: string, role: string): Promise<void> {
  requireName(user, 'user');
  requireName(role, 'role');
  await session.call('auth/user/revoke', { name: user, role });
}

export async function addRole(session: EtcdCaller, name: string): Promise<void> {
  requireName(name, 'role');
  await session.call('auth/role/add', { name });
}

export async function deleteRole(session: EtcdCaller, name: string): Promise<void> {
  requireName(name, 'role');
  await session.call('auth/role/delete', { role: name });
}

export async function grantPermission(
  session: EtcdCaller,
  role: string,
  permission: EtcdPermission,
): Promise<void> {
  requireName(role, 'role');
  await session.call('auth/role/grant', {
    name: role,
    perm: {
      permType: permission.type.toUpperCase(),
      key: toBase64(permission.key),
      ...(permission.end.length === 0 ? {} : { range_end: toBase64(permission.end) }),
    },
  });
}

export async function revokePermission(
  session: EtcdCaller,
  role: string,
  permission: Pick<EtcdPermission, 'key' | 'end'>,
): Promise<void> {
  requireName(role, 'role');
  await session.call('auth/role/revoke', {
    role,
    key: toBase64(permission.key),
    ...(permission.end.length === 0 ? {} : { range_end: toBase64(permission.end) }),
  });
}
