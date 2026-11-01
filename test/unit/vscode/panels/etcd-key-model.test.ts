import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { grantLease } from '../../../../src/services/etcd/etcd-client';
import { redisKeyRef } from '../../../../src/shared/redis-key';
import { EtcdKeyModel } from '../../../../src/vscode/panels/etcd-key-model';
import { FakeEtcd } from '../../../helpers/fake-etcd';

let etcd: FakeEtcd;

beforeEach(() => {
  etcd = new FakeEtcd();
});

function model(key: string, readOnly = false): EtcdKeyModel {
  return new EtcdKeyModel({
    key: redisKeyRef(new TextEncoder().encode(key)),
    connectionName: 'etcd one',
    readOnly,
    session: () => Promise.resolve(etcd),
  });
}

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

describe('reading', () => {
  it('shows a key with its revisions, version, size and no lease', async () => {
    etcd.seed('/k', 'héllo');
    const state = await model('/k').refresh();
    expect(state).toMatchObject({
      key: { text: '/k' },
      connectionName: 'etcd one',
      readOnly: false,
      exists: true,
      size: 6,
      version: 1,
      lease: null,
      value: { text: 'héllo' },
    });
    expect(Number(state.modRevision)).toBeGreaterThan(0);
    expect(state.createRevision).toBe(state.modRevision);
    expect(state.conflict).toBeUndefined();
  });

  it('shows a key that is not there as not existing', async () => {
    const state = await model('/missing').refresh();
    expect(state).toMatchObject({ exists: false, size: 0, modRevision: '0', version: 0 });
    expect(state.value).toBeUndefined();
  });

  it('shows bytes that are not text as hex', async () => {
    await etcd.call('kv/put', { key: Buffer.from('/b').toString('base64'), value: '/wA=' });
    const state = await model('/b').refresh();
    expect(state.value?.hex).toBe('ff00');
  });

  it('cuts a big value and says how big it is', async () => {
    etcd.seed('/big', 'a'.repeat(1_200_000));
    const state = await model('/big').refresh();
    expect(state.value?.truncated).toBe(true);
    expect(state.value?.size).toBe(1_200_000);
    expect(state.size).toBe(1_200_000);
  });

  it('shows the lease with the time it has left', async () => {
    const lease = await grantLease(etcd, 120);
    etcd.seed('/k', 'v', 0);
    await etcd.call('kv/put', { key: Buffer.from('/k').toString('base64'), lease: lease.id });
    etcd.setLeaseTtl(lease.id, 100);
    const state = await model('/k').refresh();
    expect(state.lease).toEqual({ id: lease.id, ttl: 100, grantedTtl: 120 });
  });

  it('shows a lease that cannot be read by its id and as ended', async () => {
    const lease = await grantLease(etcd, 60);
    await etcd.call('kv/put', { key: Buffer.from('/k').toString('base64'), lease: lease.id });
    const original = etcd.call;
    etcd.call = (path, body, options) =>
      path === 'lease/timetolive'
        ? Promise.reject(new Error('cannot read'))
        : original(path, body, options);
    const state = await model('/k').refresh();
    expect(state.lease).toEqual({ id: lease.id, ttl: -1, grantedTtl: 0 });
  });

  it('renders the state it last read without asking again', async () => {
    etcd.seed('/k', 'v');
    const page = model('/k');
    await page.refresh();
    const reads = etcd.calls.length;
    expect(page.state().value?.text).toBe('v');
    expect(etcd.calls.length).toBe(reads);
    expect(page.currentKey.text).toBe('/k');
  });

  it('renders the state before anything was read as a key that is not there', () => {
    expect(model('/k').state().exists).toBe(false);
  });
});

describe('saving', () => {
  it('saves a value over the revision it read', async () => {
    etcd.seed('/k', 'one');
    const page = model('/k');
    const first = await page.refresh();
    const result = await page.save({ text: 'two' }, first.modRevision);
    expect(result.saved).toBe(true);
    expect(result.state.value?.text).toBe('two');
    expect(result.state.version).toBe(2);
    expect(etcd.valueOf('/k')).toBe('two');
  });

  it('refuses a save over a change made meanwhile, keeps it, and shows the new value', async () => {
    etcd.seed('/k', 'one');
    const page = model('/k');
    const first = await page.refresh();
    etcd.seed('/k', 'theirs');
    const result = await page.save({ text: 'mine' }, first.modRevision);
    expect(result.saved).toBe(false);
    expect(result.state.conflict).toBe(true);
    expect(result.state.value?.text).toBe('theirs');
    expect(etcd.valueOf('/k')).toBe('theirs');
    // The conflict goes with the next read.
    expect((await page.refresh()).conflict).toBeUndefined();
  });

  it('overwrites on purpose, against what is there now', async () => {
    etcd.seed('/k', 'one');
    const page = model('/k');
    const first = await page.refresh();
    etcd.seed('/k', 'theirs');
    const result = await page.save({ text: 'mine' }, first.modRevision, true);
    expect(result.saved).toBe(true);
    expect(etcd.valueOf('/k')).toBe('mine');
  });

  it('overwrites a key that was deleted meanwhile by making it again', async () => {
    etcd.seed('/k', 'one');
    const page = model('/k');
    const first = await page.refresh();
    await etcd.call('kv/deleterange', { key: Buffer.from('/k').toString('base64') });
    const result = await page.save({ text: 'mine' }, first.modRevision, true);
    expect(result.saved).toBe(true);
    expect(etcd.valueOf('/k')).toBe('mine');
  });

  it('refuses to save over a key that was deleted meanwhile, without overwrite', async () => {
    etcd.seed('/k', 'one');
    const page = model('/k');
    const first = await page.refresh();
    await etcd.call('kv/deleterange', { key: Buffer.from('/k').toString('base64') });
    const result = await page.save({ text: 'mine' }, first.modRevision);
    expect(result.saved).toBe(false);
    expect(result.state.exists).toBe(false);
    expect(result.state.conflict).toBe(true);
  });

  it('keeps the key’s lease when its value is saved', async () => {
    const lease = await grantLease(etcd, 300);
    await etcd.call('kv/put', {
      key: Buffer.from('/k').toString('base64'),
      value: Buffer.from('v').toString('base64'),
      lease: lease.id,
    });
    const page = model('/k');
    const first = await page.refresh();
    const result = await page.save({ text: 'w' }, first.modRevision);
    expect(result.state.lease?.id).toBe(lease.id);
    expect(etcd.leaseOf('/k')).toBe(lease.id);
  });

  it('creates a key that was not there, and refuses a second creation', async () => {
    const page = model('/new');
    await page.refresh();
    const made = await page.save({ text: 'fresh' }, '0');
    expect(made.saved).toBe(true);
    expect(made.state.exists).toBe(true);
    expect(etcd.leaseOf('/new')).toBe('0');
    const late = await model('/new').save({ text: 'late' }, '0');
    expect(late.saved).toBe(false);
    expect(etcd.valueOf('/new')).toBe('fresh');
  });

  it('saves bytes written as hex, byte for byte', async () => {
    etcd.seed('/k', 'x');
    const page = model('/k');
    const first = await page.refresh();
    await page.save({ text: '', hex: 'ff00fe' }, first.modRevision);
    const read = (await page.refresh()).value;
    expect(read?.hex).toBe('ff00fe');
  });

  it('refuses a value that is cut or whose hex is broken', async () => {
    etcd.seed('/k', 'x');
    const page = model('/k');
    const first = await page.refresh();
    expect(
      (await failure(page.save({ text: 'x', truncated: true, size: 9 }, first.modRevision))).code,
    ).toBe('syntax');
    expect((await failure(page.save({ text: '', hex: 'abc' }, first.modRevision))).code).toBe(
      'syntax',
    );
    expect(etcd.valueOf('/k')).toBe('x');
  });

  it('saves a key whose name is not text', async () => {
    const name = Uint8Array.from([0x2f, 0xff, 0x41]);
    await etcd.call('kv/put', { key: Buffer.from(name).toString('base64') });
    const page = new EtcdKeyModel({
      key: redisKeyRef(name),
      connectionName: 'c',
      readOnly: false,
      session: () => Promise.resolve(etcd),
    });
    const first = await page.refresh();
    expect(first.key.hex).toBe('2fff41');
    const result = await page.save({ text: 'bin' }, first.modRevision);
    expect(result.saved).toBe(true);
    expect(etcd.size).toBe(1);
  });
});

describe('leases', () => {
  it('attaches a new lease of the given seconds', async () => {
    etcd.seed('/k', 'v');
    const state = await model('/k').attachLease({ ttl: 90 });
    expect(state.lease).toMatchObject({ ttl: 90, grantedTtl: 90 });
    expect(etcd.valueOf('/k')).toBe('v');
  });

  it('attaches a lease that exists, by its id', async () => {
    etcd.seed('/k', 'v');
    const lease = await grantLease(etcd, 200);
    const state = await model('/k').attachLease({ id: lease.id });
    expect(state.lease?.id).toBe(lease.id);
  });

  it('does not attach a lease that is gone, and makes none', async () => {
    etcd.seed('/k', 'v');
    const lease = await grantLease(etcd, 60);
    await etcd.call('lease/revoke', { ID: lease.id });
    const error = await failure(model('/k').attachLease({ id: lease.id }));
    expect(error.code).toBe('not-found');
    expect(etcd.leaseOf('/k')).toBe('0');
  });

  it('refuses a lease of no seconds', async () => {
    etcd.seed('/k', 'v');
    expect((await failure(model('/k').attachLease({ ttl: 0 }))).code).toBe('syntax');
    expect((await failure(model('/k').attachLease({}))).code).toBe('syntax');
  });

  it('does not attach a lease to a key that is gone', async () => {
    expect((await failure(model('/gone').attachLease({ ttl: 10 }))).code).toBe('not-found');
    expect(etcd.leaseIds).toEqual([]);
  });

  it('revokes the lease it just made when the key moved on under it', async () => {
    etcd.seed('/k', 'v');
    const original = etcd.call;
    let raced = false;
    etcd.call = async (path, body, options) => {
      // Between the read and the write somebody else changes the key.
      if (path === 'kv/txn' && !raced) {
        raced = true;
        etcd.seed('/k', 'theirs');
      }
      return await original(path, body, options);
    };
    const state = await model('/k').attachLease({ ttl: 30 });
    expect(state.conflict).toBe(true);
    expect(state.value?.text).toBe('theirs');
    expect(etcd.leaseOf('/k')).toBe('0');
    expect(etcd.calls.filter((path) => path === 'lease/revoke')).toHaveLength(1);
  });

  it('lets go of the lease and keeps the value', async () => {
    etcd.seed('/k', 'v');
    const page = model('/k');
    await page.attachLease({ ttl: 60 });
    const state = await page.detachLease();
    expect(state.lease).toBeNull();
    expect(state.value?.text).toBe('v');
  });

  it('has nothing to let go of on a key without a lease', async () => {
    etcd.seed('/k', 'v');
    const before = etcd.calls.filter((path) => path === 'kv/txn').length;
    const state = await model('/k').detachLease();
    expect(state.lease).toBeNull();
    expect(etcd.calls.filter((path) => path === 'kv/txn').length).toBe(before);
  });

  it('revokes the lease and the keys on it go', async () => {
    const lease = await grantLease(etcd, 60);
    for (const name of ['/a', '/b']) {
      await etcd.call('kv/put', { key: Buffer.from(name).toString('base64'), lease: lease.id });
    }
    const state = await model('/a').revokeLease();
    expect(state.exists).toBe(false);
    expect(etcd.size).toBe(0);
  });

  it('has nothing to revoke on a key without a lease', async () => {
    etcd.seed('/a', 'v');
    const state = await model('/a').revokeLease();
    expect(state.exists).toBe(true);
    expect(etcd.calls).not.toContain('lease/revoke');
  });
});

describe('deleting and read-only', () => {
  it('deletes the key', async () => {
    etcd.seed('/k', 'v');
    const state = await model('/k').deleteKey();
    expect(state.exists).toBe(false);
    expect(etcd.size).toBe(0);
  });

  it('refuses every change on a read-only connection and writes nothing', async () => {
    etcd.seed('/k', 'v');
    const page = model('/k', true);
    const first = await page.refresh();
    expect(first.readOnly).toBe(true);
    const writes = (): number => etcd.calls.filter((path) => path !== 'kv/range').length;
    for (const change of [
      page.save({ text: 'x' }, first.modRevision),
      page.save({ text: 'x' }, first.modRevision, true),
      page.attachLease({ ttl: 5 }),
      page.detachLease(),
      page.revokeLease(),
      page.deleteKey(),
    ]) {
      expect((await failure(change)).code).toBe('permission-denied');
    }
    expect(writes()).toBe(0);
    expect(etcd.valueOf('/k')).toBe('v');
  });
});
