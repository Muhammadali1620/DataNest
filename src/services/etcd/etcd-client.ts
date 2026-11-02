// The calls DataNest makes to etcd's JSON gateway (V13.19), one function each: range,
// put, delete, the compare-and-swap transactions that keep an edit from overwriting a
// change somebody else made, and leases. The functions take anything that can `call`, so
// a test hands them a small fake cluster. No `vscode`, no session handling.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { EtcdSession } from '../../drivers/etcd-driver';
import { count, type EtcdEntry, entryOf, int64, prefixEnd, toBase64 } from './etcd-codec';

export type EtcdCaller = Pick<EtcdSession, 'call'>;

/** Keys one range call asks for at most; the cluster refuses an unlimited range on a big store. */
export const MAX_RANGE_LIMIT = 5000;

export interface RangeOptions {
  /** The first key after the range (`range_end`); absent: just the key. */
  readonly end?: Uint8Array;
  readonly limit?: number;
  /** Leave out the values: far less to read when only names are wanted. */
  readonly keysOnly?: boolean;
  /** Only count, no keys. */
  readonly countOnly?: boolean;
}

export interface RangeResult {
  readonly entries: readonly EtcdEntry[];
  /** More keys follow the last one. */
  readonly more: boolean;
  /** The number of keys in the whole range, not only the page. */
  readonly count: number;
}

interface WireRange {
  readonly kvs?: unknown;
  readonly more?: unknown;
  readonly count?: unknown;
}

// The shape of an answer is the caller's to name; the gateway sends what it sends.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function asObject<T extends object>(answer: unknown): T {
  return (typeof answer === 'object' && answer !== null ? answer : {}) as T;
}

export async function range(
  session: EtcdCaller,
  key: Uint8Array,
  options: RangeOptions = {},
): Promise<RangeResult> {
  // The gateway has no empty key; a single zero byte starts at the very first key.
  const from = key.length === 0 ? Uint8Array.of(0) : key;
  const answer = asObject<WireRange>(
    await session.call('kv/range', {
      key: toBase64(from),
      ...(options.end === undefined ? {} : { range_end: toBase64(options.end) }),
      ...(options.limit === undefined
        ? {}
        : { limit: Math.min(Math.max(1, Math.floor(options.limit)), MAX_RANGE_LIMIT) }),
      ...(options.keysOnly === true ? { keys_only: true } : {}),
      ...(options.countOnly === true ? { count_only: true } : {}),
    }),
  );
  const entries = Array.isArray(answer.kvs) ? (answer.kvs as unknown[]).map(entryOf) : [];
  return { entries, more: answer.more === true, count: count(answer.count) };
}

/** The number of keys under a prefix, counted by the cluster without sending them. */
export async function countPrefix(session: EtcdCaller, prefix: Uint8Array): Promise<number> {
  return (await range(session, prefix, { end: prefixEnd(prefix), countOnly: true })).count;
}

/** One key with its value, or undefined when it is not there. */
export async function getEntry(
  session: EtcdCaller,
  key: Uint8Array,
): Promise<EtcdEntry | undefined> {
  return (await range(session, key)).entries[0];
}

/** What a change requires of the key before it goes ahead. */
export type Expectation =
  { readonly kind: 'absent' } | { readonly kind: 'revision'; readonly modRevision: string };

/** The result of a change that may have been refused. */
export interface WriteResult {
  readonly done: boolean;
  /** When refused: what is there now, or undefined when the key is gone. */
  readonly current?: EtcdEntry;
}

export interface PutOptions {
  /** The new value; `'keep'` leaves the stored one (to change only the lease). */
  readonly value: Uint8Array | 'keep';
  /**
   * A lease id to attach (digits); `'keep'` leaves the key's lease alone; `'none'`, or
   * nothing, detaches it, as a plain put does.
   */
  readonly lease?: string;
  readonly expect?: Expectation;
}

function putRequest(key: Uint8Array, options: PutOptions): Record<string, unknown> {
  const { value } = options;
  const lease = options.lease ?? 'none';
  return {
    key: toBase64(key),
    ...(value === 'keep' ? { ignore_value: true } : { value: toBase64(value) }),
    ...(lease === 'keep'
      ? { ignore_lease: true }
      : lease === 'none' || lease === '0'
        ? {}
        : { lease }),
  };
}

function compareOf(key: Uint8Array, expect: Expectation): Record<string, unknown> {
  return expect.kind === 'absent'
    ? { key: toBase64(key), target: 'VERSION', result: 'EQUAL', version: '0' }
    : {
        key: toBase64(key),
        target: 'MOD',
        result: 'EQUAL',
        mod_revision: int64(expect.modRevision),
      };
}

interface WireTxn {
  readonly succeeded?: unknown;
  readonly responses?: readonly { response_range?: { kvs?: unknown } }[];
}

/** The key as a refused transaction found it, from the range its failure branch asked for. */
function currentOf(answer: WireTxn): EtcdEntry | undefined {
  const kvs = answer.responses?.[0]?.response_range?.kvs;
  return Array.isArray(kvs) && kvs.length > 0 ? entryOf(kvs[0]) : undefined;
}

/**
 * Writes a key. With an expectation the write is a transaction that checks the key's
 * revision (or that it is absent) first, so an edit never replaces a change made since
 * the page read the key; without one, the write is unconditional.
 */
export async function putEntry(
  session: EtcdCaller,
  key: Uint8Array,
  options: PutOptions,
): Promise<WriteResult> {
  if (options.expect === undefined) {
    await session.call('kv/put', putRequest(key, options));
    return { done: true };
  }
  const answer = asObject<WireTxn>(
    await session.call('kv/txn', {
      compare: [compareOf(key, options.expect)],
      success: [{ request_put: putRequest(key, options) }],
      failure: [{ request_range: { key: toBase64(key) } }],
    }),
  );
  if (answer.succeeded === true) {
    return { done: true };
  }
  const current = currentOf(answer);
  return current === undefined ? { done: false } : { done: false, current };
}

/** Deletes a key, only if it is still the revision the page read when one is given. */
export async function deleteEntry(
  session: EtcdCaller,
  key: Uint8Array,
  expect?: Expectation,
): Promise<WriteResult> {
  if (expect === undefined) {
    await session.call('kv/deleterange', { key: toBase64(key) });
    return { done: true };
  }
  const answer = asObject<WireTxn>(
    await session.call('kv/txn', {
      compare: [compareOf(key, expect)],
      success: [{ request_delete_range: { key: toBase64(key) } }],
      failure: [{ request_range: { key: toBase64(key) } }],
    }),
  );
  if (answer.succeeded === true) {
    return { done: true };
  }
  const current = currentOf(answer);
  return current === undefined ? { done: false } : { done: false, current };
}

/** Deletes every key under a prefix and says how many there were. */
export async function deletePrefix(session: EtcdCaller, prefix: Uint8Array): Promise<number> {
  if (prefix.length === 0) {
    // The prefix of every key: never a folder anyone meant to delete.
    throw new DbError('syntax', msg('A key prefix to delete cannot be empty'));
  }
  const answer = asObject<{ deleted?: unknown }>(
    await session.call('kv/deleterange', {
      key: toBase64(prefix),
      range_end: toBase64(prefixEnd(prefix)),
    }),
  );
  return count(answer.deleted);
}

/** A lease, as the cluster reports it. */
export interface LeaseInfo {
  /** The decimal id. */
  readonly id: string;
  /** Seconds left; -1 when the lease is gone (it expired, was revoked, or never existed). */
  readonly ttl: number;
  /** The seconds it was granted for. */
  readonly grantedTtl: number;
}

export async function grantLease(session: EtcdCaller, ttlSeconds: number): Promise<LeaseInfo> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new DbError('syntax', msg('A lease lives for a whole number of seconds, at least 1'));
  }
  const answer = asObject<{ ID?: unknown; TTL?: unknown }>(
    await session.call('lease/grant', { TTL: String(ttlSeconds), ID: '0' }),
  );
  const ttl = count(answer.TTL);
  return { id: int64(answer.ID), ttl, grantedTtl: ttl };
}

export async function revokeLease(session: EtcdCaller, id: string): Promise<void> {
  await session.call('lease/revoke', { ID: int64(id) });
}

/**
 * Renews a lease (the `lease/keepalive` stream asked once, V13.27): the seconds it has now,
 * `0` when the lease is gone (it ended, was revoked, or never existed).
 */
export async function keepAliveLease(session: EtcdCaller, id: string): Promise<number> {
  const answer = asObject<{ result?: unknown; TTL?: unknown }>(
    await session.call('lease/keepalive', { ID: int64(id) }),
  );
  // The gateway wraps a stream's message in `result`.
  const message = answer.result === undefined ? answer : asObject<{ TTL?: unknown }>(answer.result);
  return count(message.TTL);
}

/** How long a lease has left, or undefined for the id `0` (no lease). */
export async function leaseInfo(session: EtcdCaller, id: string): Promise<LeaseInfo | undefined> {
  if (id === '0') {
    return undefined;
  }
  const answer = asObject<{ ID?: unknown; TTL?: unknown; grantedTTL?: unknown }>(
    await session.call('lease/timetolive', { ID: int64(id) }),
  );
  return {
    id: int64(answer.ID ?? id),
    ttl: count(answer.TTL),
    grantedTtl: count(answer.grantedTTL),
  };
}
