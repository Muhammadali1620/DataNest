import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  countPrefix,
  deleteEntry,
  deletePrefix,
  getEntry,
  grantLease,
  keepAliveLease,
  leaseInfo,
  MAX_RANGE_LIMIT,
  putEntry,
  range,
  revokeLease,
} from '../../../../src/services/etcd/etcd-client';
import { prefixEnd } from '../../../../src/services/etcd/etcd-codec';
import { FakeEtcd } from '../../../helpers/fake-etcd';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const read = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

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

describe('range', () => {
  beforeEach(() => {
    for (const name of ['/a/1', '/a/2', '/a/3', '/b/1', '/c']) {
      etcd.seed(name, name.toUpperCase());
    }
  });

  it('reads one key', async () => {
    const result = await range(etcd, text('/a/2'));
    expect(result.entries.map((entry) => read(entry.key))).toEqual(['/a/2']);
    expect(read(result.entries[0]?.value)).toBe('/A/2');
    expect(result.more).toBe(false);
    expect(result.count).toBe(1);
  });

  it('reads a prefix, in key order, with values left out when only names are wanted', async () => {
    const prefix = text('/a/');
    const result = await range(etcd, prefix, { end: prefixEnd(prefix), keysOnly: true });
    expect(result.entries.map((entry) => read(entry.key))).toEqual(['/a/1', '/a/2', '/a/3']);
    expect(result.entries.every((entry) => entry.value.length === 0)).toBe(true);
  });

  it('says there is more when the limit cuts the range, and counts the whole range', async () => {
    const prefix = text('/a/');
    const result = await range(etcd, prefix, { end: prefixEnd(prefix), limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.more).toBe(true);
    expect(result.count).toBe(3);
  });

  it('only counts when asked to', async () => {
    const prefix = text('/a/');
    const result = await range(etcd, prefix, { end: prefixEnd(prefix), countOnly: true });
    expect(result.entries).toHaveLength(0);
    expect(result.count).toBe(3);
    expect(etcd.bodies.at(-1)).toMatchObject({ count_only: true });
  });

  it('reads the whole key space from an empty key', async () => {
    const result = await range(etcd, new Uint8Array(), { end: prefixEnd(new Uint8Array()) });
    expect(result.entries).toHaveLength(5);
    // The gateway never sees an empty key: it is a single zero byte.
    expect(etcd.bodies.at(-1)).toMatchObject({ key: 'AA==', range_end: 'AA==' });
  });

  it('never asks for more than the cluster is willing to send, nor for less than one', async () => {
    await range(etcd, text('/a/1'), { limit: 1_000_000 });
    expect(etcd.bodies.at(-1)).toMatchObject({ limit: MAX_RANGE_LIMIT });
    await range(etcd, text('/a/1'), { limit: 0 });
    expect(etcd.bodies.at(-1)).toMatchObject({ limit: 1 });
    await range(etcd, text('/a/1'), { limit: 2.9 });
    expect(etcd.bodies.at(-1)).toMatchObject({ limit: 2 });
  });

  it('reads a range of no keys as empty', async () => {
    const result = await range(etcd, text('/zzz'));
    expect(result.entries).toEqual([]);
    expect(result.more).toBe(false);
    expect(result.count).toBe(0);
  });

  it('reads an answer that is not an object as empty', async () => {
    const result = await range({ call: () => Promise.resolve(null) }, text('/a'));
    expect(result.entries).toEqual([]);
  });
});

describe('countPrefix and getEntry', () => {
  it('counts the keys under a prefix, and only those', async () => {
    for (const name of ['/p/a', '/p/b/c', '/pp/d', '/p']) {
      etcd.seed(name);
    }
    expect(await countPrefix(etcd, text('/p/'))).toBe(2);
    expect(await countPrefix(etcd, text('/none/'))).toBe(0);
  });

  it('gets a key with its revisions, or nothing', async () => {
    etcd.seed('/k', 'v');
    const entry = await getEntry(etcd, text('/k'));
    expect(read(entry?.value)).toBe('v');
    expect(entry?.version).toBe(1);
    expect(await getEntry(etcd, text('/missing'))).toBeUndefined();
  });
});

describe('putEntry', () => {
  it('writes without a condition', async () => {
    expect(await putEntry(etcd, text('/k'), { value: text('1') })).toEqual({ done: true });
    expect(etcd.valueOf('/k')).toBe('1');
    expect(etcd.calls.at(-1)).toBe('kv/put');
  });

  it('writes an empty value', async () => {
    await putEntry(etcd, text('/k'), { value: new Uint8Array() });
    expect(etcd.valueOf('/k')).toBe('');
  });

  it('creates a key only when it is absent', async () => {
    const first = await putEntry(etcd, text('/k'), {
      value: text('1'),
      expect: { kind: 'absent' },
    });
    expect(first.done).toBe(true);
    const second = await putEntry(etcd, text('/k'), {
      value: text('2'),
      expect: { kind: 'absent' },
    });
    expect(second.done).toBe(false);
    expect(read(second.current?.value)).toBe('1');
    expect(etcd.valueOf('/k')).toBe('1');
  });

  it('writes only over the revision it expects', async () => {
    etcd.seed('/k', 'a');
    const read1 = await getEntry(etcd, text('/k'));
    etcd.seed('/k', 'b');
    const refused = await putEntry(etcd, text('/k'), {
      value: text('mine'),
      expect: { kind: 'revision', modRevision: read1?.modRevision ?? '0' },
    });
    expect(refused.done).toBe(false);
    expect(read(refused.current?.value)).toBe('b');
    expect(etcd.valueOf('/k')).toBe('b');
    const accepted = await putEntry(etcd, text('/k'), {
      value: text('mine'),
      expect: { kind: 'revision', modRevision: refused.current?.modRevision ?? '0' },
    });
    expect(accepted.done).toBe(true);
    expect(etcd.valueOf('/k')).toBe('mine');
  });

  it('reports a key that is gone as refused with nothing current', async () => {
    const result = await putEntry(etcd, text('/gone'), {
      value: text('x'),
      expect: { kind: 'revision', modRevision: '5' },
    });
    expect(result).toEqual({ done: false });
  });

  it('keeps the value when only the lease changes', async () => {
    etcd.seed('/k', 'keep me');
    const lease = await grantLease(etcd, 60);
    await putEntry(etcd, text('/k'), { value: 'keep', lease: lease.id });
    expect(etcd.valueOf('/k')).toBe('keep me');
    expect(etcd.leaseOf('/k')).toBe(lease.id);
    await putEntry(etcd, text('/k'), { value: 'keep', lease: 'none' });
    expect(etcd.valueOf('/k')).toBe('keep me');
    expect(etcd.leaseOf('/k')).toBe('0');
  });

  it('keeps the lease when only the value changes', async () => {
    const lease = await grantLease(etcd, 60);
    await putEntry(etcd, text('/k'), { value: text('1'), lease: lease.id });
    await putEntry(etcd, text('/k'), { value: text('2'), lease: 'keep' });
    expect(etcd.valueOf('/k')).toBe('2');
    expect(etcd.leaseOf('/k')).toBe(lease.id);
  });

  it('drops the lease of a plain write, as etcd does', async () => {
    const lease = await grantLease(etcd, 60);
    await putEntry(etcd, text('/k'), { value: text('1'), lease: lease.id });
    await putEntry(etcd, text('/k'), { value: text('2') });
    expect(etcd.leaseOf('/k')).toBe('0');
    await putEntry(etcd, text('/k'), { value: text('3'), lease: '0' });
    expect(etcd.leaseOf('/k')).toBe('0');
  });

  it('attaches a lease inside a checked write', async () => {
    etcd.seed('/k', 'a');
    const lease = await grantLease(etcd, 60);
    const read1 = await getEntry(etcd, text('/k'));
    const result = await putEntry(etcd, text('/k'), {
      value: 'keep',
      lease: lease.id,
      expect: { kind: 'revision', modRevision: read1?.modRevision ?? '0' },
    });
    expect(result.done).toBe(true);
    expect(etcd.leaseOf('/k')).toBe(lease.id);
  });

  it('fails with the cluster’s own error when it refuses', async () => {
    const error = await failure(
      putEntry(etcd, text('/k'), { value: text('v'), lease: '4611686018427387000' }),
    );
    expect(error.code).toBe('not-found');
    expect((await failure(putEntry(etcd, new Uint8Array(), { value: text('v') }))).code).toBe(
      'syntax',
    );
  });
});

describe('deleteEntry and deletePrefix', () => {
  it('deletes a key', async () => {
    etcd.seed('/k');
    expect(await deleteEntry(etcd, text('/k'))).toEqual({ done: true });
    expect(etcd.size).toBe(0);
  });

  it('deletes only the revision it read', async () => {
    etcd.seed('/k', 'a');
    const read1 = await getEntry(etcd, text('/k'));
    etcd.seed('/k', 'b');
    const refused = await deleteEntry(etcd, text('/k'), {
      kind: 'revision',
      modRevision: read1?.modRevision ?? '0',
    });
    expect(refused.done).toBe(false);
    expect(read(refused.current?.value)).toBe('b');
    expect(etcd.size).toBe(1);
    expect(
      (
        await deleteEntry(etcd, text('/k'), {
          kind: 'revision',
          modRevision: refused.current?.modRevision ?? '0',
        })
      ).done,
    ).toBe(true);
    expect(etcd.size).toBe(0);
  });

  it('says a key that is already gone could not be deleted by revision', async () => {
    expect(await deleteEntry(etcd, text('/gone'), { kind: 'absent' })).toEqual({ done: true });
    expect(await deleteEntry(etcd, text('/gone'), { kind: 'revision', modRevision: '3' })).toEqual({
      done: false,
    });
  });

  it('deletes a prefix and counts what went', async () => {
    for (const name of ['/d/a', '/d/b/c', '/dd/x', '/d']) {
      etcd.seed(name);
    }
    expect(await deletePrefix(etcd, text('/d/'))).toBe(2);
    expect(etcd.keyNames().sort()).toEqual(['/d', '/dd/x']);
    expect(await deletePrefix(etcd, text('/d/'))).toBe(0);
  });

  it('refuses an empty prefix: that is every key', async () => {
    etcd.seed('/k');
    expect((await failure(deletePrefix(etcd, new Uint8Array()))).code).toBe('syntax');
    expect(etcd.size).toBe(1);
  });
});

describe('leases', () => {
  it('grants, reads and revokes a lease, and the keys on it go', async () => {
    const lease = await grantLease(etcd, 90);
    expect(lease).toMatchObject({ ttl: 90, grantedTtl: 90 });
    expect(lease.id).toMatch(/^\d+$/u);
    await putEntry(etcd, text('/k'), { value: text('v'), lease: lease.id });
    expect(await leaseInfo(etcd, lease.id)).toEqual({ id: lease.id, ttl: 90, grantedTtl: 90 });
    await revokeLease(etcd, lease.id);
    expect(etcd.size).toBe(0);
    expect((await leaseInfo(etcd, lease.id))?.ttl).toBe(-1);
  });

  it('keeps a 64-bit lease id exactly', async () => {
    const lease = await grantLease(etcd, 5);
    expect(lease.id).toBe('7000000000000000001');
    expect(etcd.bodies.at(-1)).toMatchObject({ TTL: '5', ID: '0' });
  });

  it('has nothing to say about the id 0', async () => {
    expect(await leaseInfo(etcd, '0')).toBeUndefined();
    expect(etcd.calls).toEqual([]);
  });

  it('refuses a lease that does not live a whole second', async () => {
    for (const ttl of [0, -3, 1.5, Number.NaN]) {
      expect((await failure(grantLease(etcd, ttl))).code).toBe('syntax');
    }
    expect(etcd.calls).toEqual([]);
  });

  it('fails to revoke a lease that is not there', async () => {
    expect((await failure(revokeLease(etcd, '12345'))).code).toBe('not-found');
  });

  it('sends the lease id as the text it was given', async () => {
    await leaseInfo(etcd, '7000000000000000042');
    expect(etcd.bodies.at(-1)).toEqual({ ID: '7000000000000000042' });
  });
});

describe('keepAliveLease (V13.27)', () => {
  it('renews a lease and says the time it has now', async () => {
    const etcd = new FakeEtcd();
    const lease = await grantLease(etcd, 40);
    etcd.setLeaseTtl(lease.id, 5);
    expect(await keepAliveLease(etcd, lease.id)).toBe(40);
    expect((await leaseInfo(etcd, lease.id))?.ttl).toBe(40);
  });

  it('answers 0 for a lease that is gone', async () => {
    const etcd = new FakeEtcd();
    const lease = await grantLease(etcd, 40);
    etcd.expire(lease.id);
    expect(await keepAliveLease(etcd, lease.id)).toBe(0);
    expect(await keepAliveLease(etcd, '123')).toBe(0);
  });

  it('reads an answer that is not wrapped in a result as well', async () => {
    const session = { call: () => Promise.resolve({ ID: '7', TTL: '12' }) };
    expect(await keepAliveLease(session, '7')).toBe(12);
  });
});
