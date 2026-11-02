import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  addRole,
  addUser,
  authEnabled,
  authEnableProblem,
  boundsOf,
  changePassword,
  deleteRole,
  deleteUser,
  disableAuth,
  enableAuth,
  grantPermission,
  grantRole,
  listRoles,
  listUsers,
  nameProblem,
  permissionText,
  revokePermission,
  revokeRole,
  roleView,
  scopeOf,
  userRoles,
  type EtcdPermission,
} from '../../../../src/services/etcd/etcd-auth';
import { prefixEnd } from '../../../../src/services/etcd/etcd-codec';
import { FakeEtcd } from '../../../helpers/fake-etcd';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

let etcd: FakeEtcd;

beforeEach(() => {
  etcd = new FakeEtcd();
});

async function failure(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error('It did not fail');
}

describe('users', () => {
  it('lists none, then the users in order', async () => {
    expect(await listUsers(etcd)).toEqual([]);
    await addUser(etcd, 'zed', 'pw');
    await addUser(etcd, 'amy', 'pw');
    expect(await listUsers(etcd)).toEqual(['amy', 'zed']);
  });

  it('adds a user with a password, and refuses a second one with that name', async () => {
    await addUser(etcd, 'amy', 'pw');
    expect(etcd.accountBook.get('amy')?.password).toBe('pw');
    expect((await failure(addUser(etcd, 'amy', 'pw'))).code).toBe('constraint');
  });

  it('refuses a name or a password that is empty before it asks the cluster', async () => {
    etcd.calls.length = 0;
    expect((await failure(addUser(etcd, '  ', 'pw'))).code).toBe('syntax');
    expect((await failure(addUser(etcd, 'amy', ''))).code).toBe('syntax');
    expect((await failure(addUser(etcd, 'x'.repeat(257), 'pw'))).code).toBe('syntax');
    expect((await failure(changePassword(etcd, 'amy', ''))).code).toBe('syntax');
    expect((await failure(changePassword(etcd, '', 'pw'))).code).toBe('syntax');
    expect((await failure(deleteUser(etcd, ''))).code).toBe('syntax');
    expect(etcd.calls).toEqual([]);
  });

  it('changes a password and deletes a user; a user that is not there is refused as FailedPrecondition, which is a constraint', async () => {
    await addUser(etcd, 'amy', 'one');
    await changePassword(etcd, 'amy', 'two');
    expect(etcd.accountBook.get('amy')?.password).toBe('two');
    await deleteUser(etcd, 'amy');
    expect(await listUsers(etcd)).toEqual([]);
    expect((await failure(deleteUser(etcd, 'amy'))).code).toBe('constraint');
    expect((await failure(changePassword(etcd, 'amy', 'x'))).code).toBe('constraint');
    expect((await failure(userRoles(etcd, 'amy'))).code).toBe('constraint');
  });

  it('grants and revokes roles, listing them sorted', async () => {
    await addUser(etcd, 'amy', 'pw');
    await addRole(etcd, 'writers');
    await addRole(etcd, 'admins');
    await grantRole(etcd, 'amy', 'writers');
    await grantRole(etcd, 'amy', 'admins');
    expect(await userRoles(etcd, 'amy')).toEqual(['admins', 'writers']);
    await revokeRole(etcd, 'amy', 'admins');
    expect(await userRoles(etcd, 'amy')).toEqual(['writers']);
    expect((await failure(revokeRole(etcd, 'amy', 'admins'))).code).toBe('constraint');
  });

  it('does not grant a role that is not there, or to a user that is not', async () => {
    await addUser(etcd, 'amy', 'pw');
    expect((await failure(grantRole(etcd, 'amy', 'ghost'))).code).toBe('constraint');
    await addRole(etcd, 'r');
    expect((await failure(grantRole(etcd, 'ghost', 'r'))).code).toBe('constraint');
    expect((await failure(grantRole(etcd, '', 'r'))).code).toBe('syntax');
    expect((await failure(grantRole(etcd, 'amy', ''))).code).toBe('syntax');
    expect((await failure(revokeRole(etcd, '', 'r'))).code).toBe('syntax');
    expect((await failure(revokeRole(etcd, 'amy', ''))).code).toBe('syntax');
  });

  it('names its problems', () => {
    expect(nameProblem('')).toBe('empty');
    expect(nameProblem('   ')).toBe('empty');
    expect(nameProblem('x'.repeat(257))).toBe('long');
    expect(nameProblem('x'.repeat(256))).toBeUndefined();
    expect(nameProblem('amy')).toBeUndefined();
  });
});

describe('roles', () => {
  it('adds, lists and deletes roles; a role that is deleted leaves its users', async () => {
    await addRole(etcd, 'b');
    await addRole(etcd, 'a');
    expect(await listRoles(etcd)).toEqual(['a', 'b']);
    expect((await failure(addRole(etcd, 'a'))).code).toBe('constraint');
    await addUser(etcd, 'amy', 'pw');
    await grantRole(etcd, 'amy', 'a');
    await deleteRole(etcd, 'a');
    expect(await listRoles(etcd)).toEqual(['b']);
    expect(await userRoles(etcd, 'amy')).toEqual([]);
    expect((await failure(deleteRole(etcd, 'a'))).code).toBe('constraint');
    expect((await failure(addRole(etcd, ''))).code).toBe('syntax');
    expect((await failure(deleteRole(etcd, ''))).code).toBe('syntax');
  });

  it('shows a role without permissions as an empty list, and one that is not there as a constraint', async () => {
    await addRole(etcd, 'r');
    expect(await roleView(etcd, 'r')).toEqual({ name: 'r', permissions: [] });
    expect((await failure(roleView(etcd, 'ghost'))).code).toBe('constraint');
  });

  it('grants permissions of each type and reads them back, READ being the default the gateway omits', async () => {
    await addRole(etcd, 'r');
    const read: EtcdPermission = { type: 'read', key: text('/a'), end: new Uint8Array() };
    const write: EtcdPermission = {
      type: 'write',
      key: text('/app/'),
      end: prefixEnd(text('/app/')),
    };
    const both: EtcdPermission = {
      type: 'readwrite',
      key: Uint8Array.of(0),
      end: Uint8Array.of(0),
    };
    await grantPermission(etcd, 'r', read);
    await grantPermission(etcd, 'r', write);
    await grantPermission(etcd, 'r', both);
    expect((await roleView(etcd, 'r')).permissions).toEqual([read, write, both]);
    // The gateway was asked for READ by name and stores nothing for the default.
    expect(etcd.roleBook.get('r')?.[0]).not.toHaveProperty('permType');
  });

  it('changes the type of a permission on the same key instead of adding a second', async () => {
    await addRole(etcd, 'r');
    const key = text('/a');
    await grantPermission(etcd, 'r', { type: 'read', key, end: new Uint8Array() });
    await grantPermission(etcd, 'r', { type: 'readwrite', key, end: new Uint8Array() });
    const { permissions } = await roleView(etcd, 'r');
    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.type).toBe('readwrite');
  });

  it('revokes one permission by its key and range, and says when it is not granted', async () => {
    await addRole(etcd, 'r');
    const one: EtcdPermission = { type: 'read', key: text('/a'), end: new Uint8Array() };
    const two: EtcdPermission = {
      type: 'write',
      key: text('/b/'),
      end: prefixEnd(text('/b/')),
    };
    await grantPermission(etcd, 'r', one);
    await grantPermission(etcd, 'r', two);
    await revokePermission(etcd, 'r', two);
    expect((await roleView(etcd, 'r')).permissions).toEqual([one]);
    expect((await failure(revokePermission(etcd, 'r', two))).code).toBe('constraint');
    expect((await failure(revokePermission(etcd, 'ghost', one))).code).toBe('constraint');
    expect((await failure(revokePermission(etcd, '', one))).code).toBe('syntax');
    expect((await failure(grantPermission(etcd, '', one))).code).toBe('syntax');
  });
});

describe('what a permission covers', () => {
  const key = text('/app/');

  it.each([
    ['key', { key, end: new Uint8Array() }],
    ['prefix', { key, end: prefixEnd(key) }],
    ['all', { key: Uint8Array.of(0), end: Uint8Array.of(0) }],
    ['range', { key, end: text('/zzz') }],
    ['range', { key: Uint8Array.of(0), end: text('/m') }],
  ] as const)('is %s', (scope, bounds) => {
    expect(scopeOf(bounds)).toBe(scope);
  });

  it('turns a scope and a key into the bounds the gateway wants', () => {
    expect(boundsOf('key', key)).toEqual({ key, end: new Uint8Array() });
    expect(boundsOf('prefix', key)).toEqual({ key, end: prefixEnd(key) });
    expect(boundsOf('all', new Uint8Array())).toEqual({
      key: Uint8Array.of(0),
      end: Uint8Array.of(0),
    });
    expect(boundsOf('range', key, text('/b'))).toEqual({ key, end: text('/b') });
  });

  it('refuses a scope without the key or the end it needs', () => {
    expect(() => boundsOf('key', new Uint8Array())).toThrow(DbError);
    expect(() => boundsOf('prefix', new Uint8Array())).toThrow(DbError);
    expect(() => boundsOf('range', key)).toThrow(DbError);
    expect(() => boundsOf('range', key, new Uint8Array())).toThrow(DbError);
  });

  it('says it in words', () => {
    const base = { end: new Uint8Array() };
    expect(permissionText({ type: 'read', key, ...base })).toBe('read: /app/');
    expect(permissionText({ type: 'write', key, end: prefixEnd(key) })).toBe('write: /app/*');
    expect(
      permissionText({ type: 'readwrite', key: Uint8Array.of(0), end: Uint8Array.of(0) }),
    ).toBe('readwrite: *');
    expect(permissionText({ type: 'read', key, end: text('/b') })).toBe('read: /app/ … /b');
  });
});

describe('turning authentication on and off', () => {
  it('says authentication is off on a cluster that has it off', async () => {
    expect(await authEnabled(etcd)).toBe(false);
  });

  it('says it is on when the cluster says so', async () => {
    const on = { call: () => Promise.resolve({ enabled: true }) };
    expect(await authEnabled(on)).toBe(true);
  });

  it('leaves it undefined when the cluster does not answer the question', async () => {
    const old = { call: () => Promise.reject(new DbError('not-found', 'Not Found')) };
    expect(await authEnabled(old)).toBeUndefined();
  });

  it('does not hide a failure that is not the cluster answering', async () => {
    const broken = { call: () => Promise.reject(new TypeError('boom')) };
    await expect(authEnabled(broken)).rejects.toThrow('boom');
  });

  it('says what the cluster wants first: a root user, then the root role', async () => {
    expect(await authEnableProblem(etcd)).toBe('no-root-user');
    await addUser(etcd, 'amy', 'pw');
    expect(await authEnableProblem(etcd)).toBe('no-root-user');
    await addUser(etcd, 'root', 'pw');
    expect(await authEnableProblem(etcd)).toBe('no-root-role');
    await addRole(etcd, 'root');
    await grantRole(etcd, 'root', 'root');
    expect(await authEnableProblem(etcd)).toBeUndefined();
  });

  it('turns it on once the root user has the root role, and off again', async () => {
    await addUser(etcd, 'root', 'pw');
    await addRole(etcd, 'root');
    await grantRole(etcd, 'root', 'root');
    await enableAuth(etcd);
    expect(etcd.users?.get('root')).toBe('pw');
    // The fake asks for a token from now on; the call for turning it off gets one.
    etcd.users = undefined;
    await disableAuth(etcd);
    expect(etcd.calls).toContain('auth/disable');
    expect(etcd.users).toBeUndefined();
  });

  it('shows the refusal of the cluster when it is turned on without a root user', async () => {
    const error = await enableAuth(etcd).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'constraint' });
    expect((error as DbError).message).toContain('root user does not exist');
  });
});
