import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { driver } from '../../../src/drivers/etcd';
import type { EtcdSession } from '../../../src/drivers/etcd-driver';
import {
  countPrefix,
  deleteEntry,
  deletePrefix,
  getEntry,
  grantLease,
  keepAliveLease,
  leaseInfo,
  putEntry,
  range,
  revokeLease,
} from '../../../src/services/etcd/etcd-client';
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
  permissionText,
  revokePermission,
  revokeRole,
  roleView,
  scopeOf,
  userRoles,
} from '../../../src/services/etcd/etcd-auth';
import { listPage } from '../../../src/services/etcd/key-listing';
import { type EtcdWatchEvent, watchKeys } from '../../../src/services/etcd/etcd-watch';
import { prefixEnd } from '../../../src/services/etcd/etcd-codec';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { redisKeyBytes, redisKeyRef } from '../../../src/shared/redis-key';
import { redisValueOf } from '../../../src/shared/redis-value';
import { EtcdKeyModel } from '../../../src/vscode/panels/etcd-key-model';
import { TEST_ETCD } from '../../helpers/etcd-servers';

// docker/compose.yml `etcd` (V13.19): one member, plain HTTP, no sign-in until a test
// switches authentication on; that test switches it off again before it ends.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'test-etcd',
    name: 'etcd',
    driver: 'etcd',
    host: TEST_ETCD.host,
    port: TEST_ETCD.port,
    ...overrides,
  };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const ROOT = encode('/dn-it/');

async function failure(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error('The call did not fail');
}

describe('etcd driver on an etcd cluster', () => {
  let session: EtcdSession;

  /** Puts many keys, a hundred to a transaction (the cluster allows 128 operations). */
  async function putMany(names: readonly string[]): Promise<void> {
    for (let at = 0; at < names.length; at += 100) {
      await session.call('kv/txn', {
        success: names.slice(at, at + 100).map((name) => ({
          request_put: { key: Buffer.from(name).toString('base64'), value: '' },
        })),
      });
    }
  }

  beforeAll(async () => {
    session = await driver.openSession(config());
    await deletePrefix(session, ROOT);
  });

  afterAll(async () => {
    await deletePrefix(session, ROOT);
    await session.close();
  });

  describe('the session', () => {
    it('says who the cluster is', () => {
      expect(session.server.version).toMatch(/^3\.\d+\.\d+/u);
      expect(session.server.clusterId).toMatch(/^\d+$/u);
      expect(session.server.authenticated).toBe(false);
    });

    it('refuses a port nobody listens on as a lost link', async () => {
      const error = await failure(driver.openSession(config({ port: 7238 })));
      expect(error.code).toBe('connection-failed');
    });

    it('refuses an answer that is not etcd', async () => {
      // The Redis port of the test servers speaks something else entirely.
      const error = await failure(driver.openSession(config({ port: 7379 })));
      expect(['connection-failed', 'internal']).toContain(error.code);
    });

    it('turns a bad request into an error of the right kind', async () => {
      const error = await failure(session.call('kv/range', { key: '' }));
      expect(error.code).toBe('syntax');
    });
  });

  describe('keys', () => {
    it('writes and reads a key with all it knows about it', async () => {
      const key = encode('/dn-it/basic/a');
      await putEntry(session, key, { value: encode('héllo') });
      const entry = await getEntry(session, key);
      expect(decode(entry?.value ?? new Uint8Array())).toBe('héllo');
      expect(entry?.version).toBe(1);
      expect(entry?.lease).toBe('0');
      expect(Number(entry?.modRevision)).toBeGreaterThan(0);
      expect(entry?.createRevision).toBe(entry?.modRevision);
      await putEntry(session, key, { value: encode('again') });
      const second = await getEntry(session, key);
      expect(second?.version).toBe(2);
      expect(second?.createRevision).toBe(entry?.createRevision);
      expect(Number(second?.modRevision)).toBeGreaterThan(Number(entry?.modRevision));
    });

    it('keeps an empty value and every byte of a binary one', async () => {
      const empty = encode('/dn-it/bytes/empty');
      const binary = encode('/dn-it/bytes/binary');
      const bytes = Uint8Array.from([0, 1, 2, 0xfe, 0xff, 0x80, 0x0a]);
      await putEntry(session, empty, { value: new Uint8Array() });
      await putEntry(session, binary, { value: bytes });
      expect((await getEntry(session, empty))?.value.length).toBe(0);
      expect(Array.from((await getEntry(session, binary))?.value ?? [])).toEqual(Array.from(bytes));
    });

    it('keeps a key whose name is not text, byte for byte', async () => {
      const name = Uint8Array.from([...encode('/dn-it/bin/'), 0xff, 0xfe, 0x00, 0x41]);
      await putEntry(session, name, { value: encode('x') });
      const ref = redisKeyRef(name);
      expect(ref.hex).toBeDefined();
      expect((await getEntry(session, redisKeyBytes(ref)))?.value).toEqual(encode('x'));
      const page = await listPage(session, encode('/dn-it/bin/'), undefined, 50);
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]?.kind).toBe('key');
    });

    it('counts and lists a prefix, and counts without sending the keys', async () => {
      for (const name of ['a', 'b', 'c']) {
        await putEntry(session, encode(`/dn-it/range/${name}`), { value: encode(name) });
      }
      const prefix = encode('/dn-it/range/');
      expect(await countPrefix(session, prefix)).toBe(3);
      const names = await range(session, prefix, { end: prefixEnd(prefix), keysOnly: true });
      expect(names.entries.map((entry) => decode(entry.key))).toEqual([
        '/dn-it/range/a',
        '/dn-it/range/b',
        '/dn-it/range/c',
      ]);
      expect(names.entries.every((entry) => entry.value.length === 0)).toBe(true);
      const limited = await range(session, prefix, { end: prefixEnd(prefix), limit: 2 });
      expect(limited.entries).toHaveLength(2);
      expect(limited.more).toBe(true);
      expect(limited.count).toBe(3);
    });

    it('reaches the end of the key space with a prefix of 0xFF bytes', async () => {
      const high = Uint8Array.from([0xff, 0xff, 0x01]);
      await putEntry(session, high, { value: encode('top') });
      expect(await countPrefix(session, Uint8Array.from([0xff, 0xff]))).toBe(1);
      await deleteEntry(session, high);
    });
  });

  describe('compare-and-swap', () => {
    it('creates a key only when it is absent', async () => {
      const key = encode('/dn-it/cas/new');
      expect(
        (await putEntry(session, key, { value: encode('1'), expect: { kind: 'absent' } })).done,
      ).toBe(true);
      const second = await putEntry(session, key, {
        value: encode('2'),
        expect: { kind: 'absent' },
      });
      expect(second.done).toBe(false);
      expect(decode(second.current?.value ?? new Uint8Array())).toBe('1');
    });

    it('writes over the revision it read and over no other', async () => {
      const key = encode('/dn-it/cas/rev');
      await putEntry(session, key, { value: encode('a') });
      const read = await getEntry(session, key);
      await putEntry(session, key, { value: encode('b') });
      const stale = await putEntry(session, key, {
        value: encode('mine'),
        expect: { kind: 'revision', modRevision: read?.modRevision ?? '0' },
      });
      expect(stale.done).toBe(false);
      expect(decode(stale.current?.value ?? new Uint8Array())).toBe('b');
      const fresh = await putEntry(session, key, {
        value: encode('mine'),
        expect: { kind: 'revision', modRevision: stale.current?.modRevision ?? '0' },
      });
      expect(fresh.done).toBe(true);
      expect(decode((await getEntry(session, key))?.value ?? new Uint8Array())).toBe('mine');
    });

    it('reports a key that went away when a write expected it', async () => {
      const key = encode('/dn-it/cas/gone');
      await putEntry(session, key, { value: encode('a') });
      const read = await getEntry(session, key);
      await deleteEntry(session, key);
      const result = await putEntry(session, key, {
        value: encode('b'),
        expect: { kind: 'revision', modRevision: read?.modRevision ?? '0' },
      });
      expect(result).toEqual({ done: false });
    });

    it('deletes only the revision it read', async () => {
      const key = encode('/dn-it/cas/delete');
      await putEntry(session, key, { value: encode('a') });
      const read = await getEntry(session, key);
      await putEntry(session, key, { value: encode('b') });
      const refused = await deleteEntry(session, key, {
        kind: 'revision',
        modRevision: read?.modRevision ?? '0',
      });
      expect(refused.done).toBe(false);
      expect(await getEntry(session, key)).toBeDefined();
      const deleted = await deleteEntry(session, key, {
        kind: 'revision',
        modRevision: refused.current?.modRevision ?? '0',
      });
      expect(deleted.done).toBe(true);
      expect(await getEntry(session, key)).toBeUndefined();
    });

    it('deletes everything under a prefix and says how many', async () => {
      for (const name of ['x', 'y', 'z']) {
        await putEntry(session, encode(`/dn-it/gone/${name}`), { value: encode(name) });
      }
      expect(await deletePrefix(session, encode('/dn-it/gone/'))).toBe(3);
      expect(await countPrefix(session, encode('/dn-it/gone/'))).toBe(0);
    });
  });

  describe('users and roles (V13.27)', () => {
    afterAll(async () => {
      for (const user of await listUsers(session)) {
        if (user.startsWith('dn-it-')) {
          await deleteUser(session, user);
        }
      }
      for (const role of await listRoles(session)) {
        if (role.startsWith('dn-it-')) {
          await deleteRole(session, role);
        }
      }
    });

    it('adds a role with permissions of each shape and reads them back as the cluster stores them', async () => {
      await addRole(session, 'dn-it-role');
      const prefix = boundsOf('prefix', encode('/dn-it/app/'));
      const all = boundsOf('all', new Uint8Array());
      await grantPermission(session, 'dn-it-role', { type: 'readwrite', ...prefix });
      await grantPermission(session, 'dn-it-role', {
        type: 'read',
        ...boundsOf('key', encode('/dn-it/one')),
      });
      await grantPermission(session, 'dn-it-role', { type: 'write', ...all });
      const { permissions } = await roleView(session, 'dn-it-role');
      expect(permissions.map(permissionText).sort()).toEqual(
        ['read: /dn-it/one', 'readwrite: /dn-it/app/*', 'write: *'].sort(),
      );
      expect(permissions.map((one) => scopeOf(one)).sort()).toEqual(['all', 'key', 'prefix']);
      await revokePermission(session, 'dn-it-role', all);
      expect((await roleView(session, 'dn-it-role')).permissions).toHaveLength(2);
    });

    it('adds a user, grants and revokes a role, changes the password and deletes the user', async () => {
      await addUser(session, 'dn-it-user', 'one');
      expect(await listUsers(session)).toContain('dn-it-user');
      await grantRole(session, 'dn-it-user', 'dn-it-role');
      expect(await userRoles(session, 'dn-it-user')).toEqual(['dn-it-role']);
      await changePassword(session, 'dn-it-user', 'two');
      await revokeRole(session, 'dn-it-user', 'dn-it-role');
      expect(await userRoles(session, 'dn-it-user')).toEqual([]);
      await deleteUser(session, 'dn-it-user');
      expect(await listUsers(session)).not.toContain('dn-it-user');
    });

    it('reports a missing user, a duplicate role and a role that is not granted', async () => {
      // etcd answers FailedPrecondition for a name that is not there or is taken.
      expect((await failure(deleteUser(session, 'dn-it-nobody'))).code).toBe('constraint');
      expect((await failure(userRoles(session, 'dn-it-nobody'))).code).toBe('constraint');
      expect((await failure(addRole(session, 'dn-it-role'))).code).toBe('constraint');
      expect((await failure(roleView(session, 'dn-it-nope'))).code).toBe('constraint');
      await addUser(session, 'dn-it-plain', 'pw');
      // etcd refuses to take back a role the user does not have.
      await failure(revokeRole(session, 'dn-it-plain', 'dn-it-role'));
      await deleteUser(session, 'dn-it-plain');
      await deleteRole(session, 'dn-it-role');
      expect(await listRoles(session)).not.toContain('dn-it-role');
    });
  });

  describe('leases', () => {
    it('renews a lease with keepalive, and says 0 for one that is gone (V13.27)', async () => {
      const lease = await grantLease(session, 120);
      expect(await keepAliveLease(session, lease.id)).toBe(120);
      await revokeLease(session, lease.id);
      expect(await keepAliveLease(session, lease.id)).toBe(0);
    });

    it('is renewed by the page model while it keeps the lease alive', async () => {
      const key = redisKeyRef(encode('/dn-it/lease/kept'));
      const lease = await grantLease(session, 120);
      await putEntry(session, redisKeyBytes(key), { value: encode('v'), lease: lease.id });
      const model = new EtcdKeyModel({
        key,
        connectionName: 'etcd',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      await model.refresh();
      expect(model.setKeepAlive(true).keepingAlive).toBe(true);
      const renewed = await model.renew();
      expect(renewed.lease).toMatchObject({ id: lease.id, grantedTtl: 120 });
      expect(renewed.keepingAlive).toBe(true);
      await revokeLease(session, lease.id);
      const ended = await model.renew();
      expect(ended.exists).toBe(false);
      expect(ended.keepingAlive).toBeUndefined();
    });

    it('grants a lease, attaches it, lets go of it and revokes it', async () => {
      const key = encode('/dn-it/lease/a');
      const lease = await grantLease(session, 120);
      expect(lease.id).toMatch(/^\d+$/u);
      expect(lease.ttl).toBe(120);
      await putEntry(session, key, { value: encode('v'), lease: lease.id });
      expect((await getEntry(session, key))?.lease).toBe(lease.id);
      const info = await leaseInfo(session, lease.id);
      expect(info?.grantedTtl).toBe(120);
      expect(info?.ttl).toBeGreaterThan(0);
      expect(info?.ttl).toBeLessThanOrEqual(120);
      // An edit that keeps the lease, then one that lets go of it.
      await putEntry(session, key, { value: encode('w'), lease: 'keep' });
      expect((await getEntry(session, key))?.lease).toBe(lease.id);
      await putEntry(session, key, { value: 'keep', lease: 'none' });
      const detached = await getEntry(session, key);
      expect(detached?.lease).toBe('0');
      expect(decode(detached?.value ?? new Uint8Array())).toBe('w');
      await putEntry(session, key, { value: 'keep', lease: lease.id });
      await revokeLease(session, lease.id);
      expect(await getEntry(session, key)).toBeUndefined();
    });

    it('reports a lease that is gone as ended', async () => {
      const lease = await grantLease(session, 60);
      await revokeLease(session, lease.id);
      expect((await leaseInfo(session, lease.id))?.ttl).toBe(-1);
      expect(await leaseInfo(session, '0')).toBeUndefined();
    });

    it('lets a short lease run out and takes the key with it', async () => {
      const key = encode('/dn-it/lease/short');
      const lease = await grantLease(session, 2);
      await putEntry(session, key, { value: encode('v'), lease: lease.id });
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(await getEntry(session, key)).toBeUndefined();
    }, 15_000);

    it('refuses a lease that does not live a whole second', async () => {
      expect((await failure(grantLease(session, 0))).code).toBe('syntax');
    });

    it('refuses to attach a lease that does not exist', async () => {
      const error = await failure(
        putEntry(session, encode('/dn-it/lease/none'), {
          value: encode('v'),
          lease: '4611686018427387000',
        }),
      );
      expect(error.code).toBe('not-found');
    });
  });

  describe('folders made of key names', () => {
    beforeAll(async () => {
      const names = [
        '/dn-it/tree/readme',
        '/dn-it/tree/app/one',
        '/dn-it/tree/app/two',
        '/dn-it/tree/app/deep/a',
        '/dn-it/tree/app/deep/b',
        '/dn-it/tree/db/host',
        '/dn-it/tree/zeta',
      ];
      for (const name of names) {
        await putEntry(session, encode(name), { value: encode(name) });
      }
    });

    it('lists the folders and keys of one level, with the keys below each folder', async () => {
      const page = await listPage(session, encode('/dn-it/tree/'), undefined, 50);
      expect(page.next).toBeUndefined();
      expect(
        page.entries.map((entry) =>
          entry.kind === 'folder' ? `${entry.label}/ ${entry.count ?? '?'}` : entry.label,
        ),
      ).toEqual(['app/ 4', 'db/ 1', 'readme', 'zeta']);
    });

    it('goes one level down from a folder', async () => {
      const page = await listPage(session, encode('/dn-it/tree/app/'), undefined, 50);
      expect(page.entries.map((entry) => entry.label)).toEqual(['deep', 'one', 'two']);
    });

    it('lists the top of the key space: a name that starts with a slash sits in the folder "/"', async () => {
      const page = await listPage(session, new Uint8Array(), undefined, 500);
      const slash = page.entries.find((entry) => entry.kind === 'folder' && entry.label === '');
      expect(slash?.kind === 'folder' ? slash.prefix.text : undefined).toBe('/');
      const inside = await listPage(session, encode('/'), undefined, 500);
      expect(
        inside.entries.some((entry) => entry.kind === 'folder' && entry.label === 'dn-it'),
      ).toBe(true);
    });

    it('reads a big folder in pages and never reads below a folder it jumps over', async () => {
      const calls: string[] = [];
      const counting = {
        call: async (path: string, body: Readonly<Record<string, unknown>>) => {
          calls.push(path);
          return await session.call(path, body);
        },
      };
      // 2600 keys in one folder, a key before it and a key after.
      const big = Array.from(
        { length: 2600 },
        (_, index) => `/dn-it/big/pile/k${String(index).padStart(5, '0')}`,
      );
      await putMany(big);
      await putEntry(session, encode('/dn-it/big/a-first'), { value: encode('1') });
      await putEntry(session, encode('/dn-it/big/z-last'), { value: encode('1') });
      const page = await listPage(counting, encode('/dn-it/big/'), undefined, 50);
      expect(page.entries.map((entry) => entry.label)).toEqual(['a-first', 'pile', 'z-last']);
      const pile = page.entries[1];
      expect(pile?.kind === 'folder' ? pile.count : undefined).toBe(2600);
      // Three reads of the level (before, the first 1000 of the pile, after the jump) and
      // one count; nothing near 2600 keys' worth of calls.
      expect(calls.filter((path) => path === 'kv/range').length).toBeLessThanOrEqual(5);
    });

    it('stops at a page and continues where it stopped', async () => {
      const names = Array.from(
        { length: 30 },
        (_, index) => `/dn-it/paged/k${String(index).padStart(2, '0')}`,
      );
      await putMany(names);
      // A read-ahead of 1000 takes all 30 at once, so the page is whole.
      const whole = await listPage(session, encode('/dn-it/paged/'), undefined, 10);
      expect(whole.entries).toHaveLength(30);
      expect(whole.next).toBeUndefined();
    });
  });

  describe('the key page model', () => {
    function model(key: string, readOnly = false): EtcdKeyModel {
      return new EtcdKeyModel({
        key: redisKeyRef(encode(key)),
        connectionName: 'etcd',
        readOnly,
        session: () => Promise.resolve(session),
      });
    }

    it('reads a key, saves it, and refuses a save over a change it has not seen', async () => {
      const key = '/dn-it/model/a';
      await putEntry(session, encode(key), { value: encode('one') });
      const page = model(key);
      const first = await page.refresh();
      expect(first.exists).toBe(true);
      expect(first.value?.text).toBe('one');
      // Somebody else changes the key.
      await putEntry(session, encode(key), { value: encode('theirs') });
      const refused = await page.save({ text: 'mine' }, first.modRevision);
      expect(refused.saved).toBe(false);
      expect(refused.state.conflict).toBe(true);
      expect(refused.state.value?.text).toBe('theirs');
      // After the user chooses to overwrite, it goes through.
      const overwritten = await page.save({ text: 'mine' }, first.modRevision, true);
      expect(overwritten.saved).toBe(true);
      expect(overwritten.state.value?.text).toBe('mine');
      expect(overwritten.state.conflict).toBeUndefined();
    });

    it('keeps the lease of a key when its value is saved', async () => {
      const key = '/dn-it/model/leased';
      const lease = await grantLease(session, 300);
      await putEntry(session, encode(key), { value: encode('v'), lease: lease.id });
      const page = model(key);
      const state = await page.refresh();
      expect(state.lease?.id).toBe(lease.id);
      const saved = await page.save({ text: 'w' }, state.modRevision);
      expect(saved.state.lease?.id).toBe(lease.id);
      expect(saved.state.lease?.ttl).toBeGreaterThan(0);
    });

    it('attaches a new lease, an existing one, detaches it and revokes it', async () => {
      const key = '/dn-it/model/leases';
      await putEntry(session, encode(key), { value: encode('v') });
      const page = model(key);
      const attached = await page.attachLease({ ttl: 90 });
      expect(attached.lease?.grantedTtl).toBe(90);
      const detached = await page.detachLease();
      expect(detached.lease).toBeNull();
      expect(detached.value?.text).toBe('v');
      const other = await grantLease(session, 200);
      const again = await page.attachLease({ id: other.id });
      expect(again.lease?.id).toBe(other.id);
      const revoked = await page.revokeLease();
      expect(revoked.exists).toBe(false);
    });

    it('does not attach a lease that is not there', async () => {
      const key = '/dn-it/model/noLease';
      await putEntry(session, encode(key), { value: encode('v') });
      const lease = await grantLease(session, 60);
      await revokeLease(session, lease.id);
      const error = await failure(model(key).attachLease({ id: lease.id }));
      expect(error.code).toBe('not-found');
    });

    it('shows a key that is not there and makes it when asked', async () => {
      const key = '/dn-it/model/new';
      const page = model(key);
      const state = await page.refresh();
      expect(state.exists).toBe(false);
      const made = await page.save({ text: 'fresh' }, '0');
      expect(made.saved).toBe(true);
      expect(made.state.exists).toBe(true);
      // A second page opened on the same new key would find it taken.
      const late = await model(key).save({ text: 'late' }, '0');
      expect(late.saved).toBe(false);
    });

    it('refuses every change on a read-only connection', async () => {
      const key = '/dn-it/model/readonly';
      await putEntry(session, encode(key), { value: encode('v') });
      const page = model(key, true);
      await page.refresh();
      expect((await failure(page.save({ text: 'x' }, '1'))).code).toBe('permission-denied');
      expect((await failure(page.deleteKey())).code).toBe('permission-denied');
      expect((await failure(page.attachLease({ ttl: 5 }))).code).toBe('permission-denied');
      expect(decode((await getEntry(session, encode(key)))?.value ?? new Uint8Array())).toBe('v');
    });

    it('deletes the key', async () => {
      const key = '/dn-it/model/delete';
      await putEntry(session, encode(key), { value: encode('v') });
      const state = await model(key).deleteKey();
      expect(state.exists).toBe(false);
    });

    it('shows a big value cut and does not let it be saved back', async () => {
      const key = '/dn-it/model/big';
      await putEntry(session, encode(key), { value: new Uint8Array(1_200_000).fill(0x61) });
      const state = await model(key).refresh();
      expect(state.value?.truncated).toBe(true);
      expect(state.size).toBe(1_200_000);
      const error = await failure(model(key).save(state.value ?? { text: '' }, state.modRevision));
      expect(error.code).toBe('syntax');
      expect(redisValueOf(new Uint8Array(3)).text).toBeDefined();
    });
  });

  // V13.31: the gateway's `watch` stream, read the way the key page reads it.
  describe('watching', () => {
    /** Opens a watch and waits until the cluster has accepted it. */
    async function watch(
      key: string,
      options: { prefix?: boolean; startRevision?: string } = {},
    ): Promise<{
      events: EtcdWatchEvent[];
      stop: () => Promise<void>;
      done: Promise<unknown>;
    }> {
      const events: EtcdWatchEvent[] = [];
      const abort = new AbortController();
      let created = false;
      const done = watchKeys(
        session,
        encode(key),
        {
          ...options,
          onCreated: () => {
            created = true;
          },
        },
        (batch) => {
          events.push(...batch);
        },
        abort.signal,
      ).catch((error: unknown) => error);
      await vi.waitFor(() => {
        expect(created).toBe(true);
      });
      return {
        events,
        stop: async () => {
          abort.abort();
          await done;
        },
        done,
      };
    }

    it('sees a new key, a change with the value before it, and a delete', async () => {
      const key = '/dn-it/watch/one';
      const watching = await watch(key);
      await putEntry(session, encode(key), { value: encode('a') });
      await putEntry(session, encode(key), { value: encode('b') });
      await deleteEntry(session, encode(key));
      await vi.waitFor(() => {
        expect(watching.events).toHaveLength(3);
      });
      await watching.stop();
      const [created, changed, deleted] = watching.events;
      expect(created).toMatchObject({ type: 'put', version: 1 });
      expect(created?.previous).toBeUndefined();
      expect(decode(changed?.value ?? new Uint8Array())).toBe('b');
      expect(decode(changed?.previous ?? new Uint8Array())).toBe('a');
      expect(changed).toMatchObject({ type: 'put', version: 2 });
      expect(deleted).toMatchObject({ type: 'delete', version: 0 });
      expect(decode(deleted?.previous ?? new Uint8Array())).toBe('b');
      expect(Number(deleted?.modRevision)).toBeGreaterThan(Number(changed?.modRevision));
    });

    it('sees the keys below a prefix and none outside it', async () => {
      const watching = await watch('/dn-it/watch/tree/', { prefix: true });
      await putEntry(session, encode('/dn-it/watch/tree/a'), { value: encode('1') });
      await putEntry(session, encode('/dn-it/watch/tree/b/c'), { value: encode('2') });
      await putEntry(session, encode('/dn-it/watch/other'), { value: encode('3') });
      await vi.waitFor(() => {
        expect(watching.events).toHaveLength(2);
      });
      await watching.stop();
      expect(watching.events.map((event) => decode(event.key)).sort()).toEqual([
        '/dn-it/watch/tree/a',
        '/dn-it/watch/tree/b/c',
      ]);
    });

    it('replays history from a revision', async () => {
      const key = '/dn-it/watch/replay';
      const first = await putEntry(session, encode(key), { value: encode('old') });
      expect(first.done).toBe(true);
      const at = (await getEntry(session, encode(key)))?.modRevision ?? '0';
      await putEntry(session, encode(key), { value: encode('new') });
      const watching = await watch(key, { startRevision: at });
      await vi.waitFor(() => {
        expect(watching.events).toHaveLength(2);
      });
      await watching.stop();
      expect(watching.events.map((event) => decode(event.value))).toEqual(['old', 'new']);
    });

    it('sees the key a lease takes with it when it ends', async () => {
      const key = '/dn-it/watch/leased';
      const lease = await grantLease(session, 60);
      await putEntry(session, encode(key), { value: encode('x'), lease: lease.id });
      const watching = await watch(key);
      await revokeLease(session, lease.id);
      await vi.waitFor(() => {
        expect(watching.events).toHaveLength(1);
      });
      await watching.stop();
      expect(watching.events[0]).toMatchObject({ type: 'delete' });
    });

    it('ends without an error when it is stopped, and hears nothing after', async () => {
      const key = '/dn-it/watch/stopped';
      const watching = await watch(key);
      await watching.stop();
      expect(await watching.done).toBeUndefined();
      await putEntry(session, encode(key), { value: encode('late') });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(watching.events).toEqual([]);
    });

    it('is cancelled with a reason when it asks for history the cluster has compacted', async () => {
      const key = '/dn-it/watch/compacted';
      for (const value of ['1', '2', '3']) {
        await putEntry(session, encode(key), { value: encode(value) });
      }
      const head = (await getEntry(session, encode(key)))?.modRevision ?? '0';
      await session.call('kv/compaction', { revision: head, physical: true });
      const result = await watchKeys(
        session,
        encode(key),
        { startRevision: '1' },
        () => undefined,
        AbortSignal.timeout(5000),
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(DbError);
      expect((result as DbError).message).toMatch(/compacted/iu);
    });

    it('follows a key on the key page: the value, the version and the list of changes', async () => {
      const key = '/dn-it/watch/page';
      await putEntry(session, encode(key), { value: encode('start') });
      const page = new EtcdKeyModel({
        key: redisKeyRef(encode(key)),
        connectionName: 'etcd',
        readOnly: false,
        session: () => Promise.resolve(session),
        watchFlushMs: 20,
      });
      await page.refresh();
      const changed = vi.fn();
      await page.startWatch(false, changed);
      // The first call comes once the cluster has the watch: changes after it are listed.
      await vi.waitFor(() => {
        expect(changed).toHaveBeenCalled();
      });
      await putEntry(session, encode(key), { value: encode('later') });
      await vi.waitFor(() => {
        expect(page.state().value).toEqual({ text: 'later' });
      });
      expect(page.state()).toMatchObject({ watching: true, version: 2 });
      expect(page.state().events?.at(-1)).toMatchObject({ type: 'put', preview: 'later' });
      await deleteEntry(session, encode(key));
      await vi.waitFor(() => {
        expect(page.state().exists).toBe(false);
      });
      expect(page.state().events?.at(-1)).toMatchObject({ type: 'delete' });
      page.stopWatch();
      expect(page.state().watching).toBeUndefined();
    });
  });
});

describe('etcd driver with authentication on', () => {
  const root = { user: 'root', password: 'rootpw-1' };

  async function authCall(
    session: EtcdSession,
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await session.call(path, body);
  }

  /** Puts the cluster back as the other tests expect it: no users, no authentication. */
  async function switchOff(): Promise<void> {
    let signedIn: EtcdSession | undefined;
    try {
      signedIn = await driver.openSession(config(root));
    } catch {
      // Authentication was not on, or root is not there: nothing to undo.
      return;
    }
    try {
      await authCall(signedIn, 'auth/disable', {});
    } catch {
      // Already off.
    }
    for (const [path, body] of [
      ['auth/user/delete', { name: 'reader' }],
      ['auth/user/delete', { name: 'root' }],
      ['auth/role/delete', { role: 'root' }],
      ['auth/role/delete', { role: 'readonly-roleX' }],
    ] as const) {
      await authCall(signedIn, path, body).catch(() => undefined);
    }
    await signedIn.close();
  }

  beforeAll(async () => {
    await switchOff();
    const plain = await driver.openSession(config());
    try {
      await plain.call('auth/user/add', { name: root.user, password: root.password });
      await plain.call('auth/role/add', { name: 'root' });
      await plain.call('auth/user/grant', { user: root.user, role: 'root' });
      await plain.call('auth/enable', {});
    } finally {
      await plain.close();
    }
  });

  afterAll(async () => {
    await switchOff();
  });

  it('asks for a user when none is given', async () => {
    const error = await failure(driver.openSession(config()));
    expect(error.code).toBe('auth-failed');
  });

  it('refuses a wrong password', async () => {
    const error = await failure(driver.openSession(config({ user: 'root', password: 'nope' })));
    expect(error.code).toBe('auth-failed');
  });

  it('refuses a user that does not exist', async () => {
    const error = await failure(driver.openSession(config({ user: 'ghost', password: 'x' })));
    expect(error.code).toBe('auth-failed');
  });

  it('signs in and works with the token', async () => {
    const session = await driver.openSession(config(root));
    try {
      expect(session.server.authenticated).toBe(true);
      await putEntry(session, encode('/dn-it-auth/a'), { value: encode('secret') });
      expect(
        decode((await getEntry(session, encode('/dn-it-auth/a')))?.value ?? new Uint8Array()),
      ).toBe('secret');
      await deletePrefix(session, encode('/dn-it-auth/'));
    } finally {
      await session.close();
    }
  });

  it('refuses a user who may not read, with the right kind of error', async () => {
    const admin = await driver.openSession(config(root));
    try {
      await admin.call('auth/user/add', { name: 'reader', password: 'readerpw' });
    } finally {
      await admin.close();
    }
    const reader = await driver.openSession(config({ user: 'reader', password: 'readerpw' }));
    try {
      const error = await failure(getEntry(reader, encode('/dn-it-auth/a')));
      expect(error.code).toBe('permission-denied');
    } finally {
      await reader.close();
    }
  });

  // V13.31: turning authentication off and on again from the app, as root.
  it('is seen as on by a signed-in session, which has the root user and role', async () => {
    const session = await driver.openSession(config(root));
    try {
      expect(await authEnabled(session)).toBe(true);
      expect(await authEnableProblem(session)).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('is turned off by root, and on again once there is a root user with the root role', async () => {
    const session = await driver.openSession(config(root));
    try {
      await disableAuth(session);
    } finally {
      await session.close();
    }
    const open = await driver.openSession(config());
    try {
      expect(await authEnabled(open)).toBe(false);
      expect(await authEnableProblem(open)).toBeUndefined();
      await enableAuth(open);
    } finally {
      await open.close();
    }
    const again = await driver.openSession(config(root));
    try {
      expect(await authEnabled(again)).toBe(true);
    } finally {
      await again.close();
    }
  });
});
