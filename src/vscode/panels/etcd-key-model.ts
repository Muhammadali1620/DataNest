// What the etcd key page (V13.19) shows and does, free of `vscode`: it reads the key and
// its lease, and runs the changes the page asks for, then reads again — the cluster is
// the source of truth, and other clients change keys too. Every save checks the revision
// the page read, so it never overwrites a change it has not seen.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { EtcdEntry } from '../../services/etcd/etcd-codec';
import {
  deleteEntry,
  type EtcdCaller,
  getEntry,
  grantLease,
  leaseInfo,
  putEntry,
  revokeLease,
} from '../../services/etcd/etcd-client';
import { type EtcdKeyState } from '../../shared/protocols/etcd-key';
import { MAX_STRING_BYTES } from '../../shared/protocols/redis-key';
import { type RedisKeyRef, redisKeyBytes } from '../../shared/redis-key';
import { redisValueBytes, type RedisValue, redisValueOf } from '../../shared/redis-value';

export interface EtcdKeyModelDeps {
  readonly key: RedisKeyRef;
  readonly connectionName: string;
  readonly readOnly: boolean;
  /** The session of the key's connection. */
  readonly session: () => Promise<EtcdCaller>;
}

interface LeaseView {
  readonly id: string;
  readonly ttl: number;
  readonly grantedTtl: number;
}

export class EtcdKeyModel {
  private entry: EtcdEntry | undefined;
  private lease: LeaseView | undefined;
  private conflict = false;

  constructor(private readonly deps: EtcdKeyModelDeps) {}

  get currentKey(): RedisKeyRef {
    return this.deps.key;
  }

  /** What the page renders. */
  state(): EtcdKeyState {
    const { entry } = this;
    return {
      key: this.deps.key,
      connectionName: this.deps.connectionName,
      readOnly: this.deps.readOnly,
      exists: entry !== undefined,
      ...(entry === undefined
        ? {}
        : { value: redisValueOf(entry.value, MAX_STRING_BYTES, entry.value.length) }),
      size: entry?.value.length ?? 0,
      modRevision: entry?.modRevision ?? '0',
      createRevision: entry?.createRevision ?? '0',
      version: entry?.version ?? 0,
      lease: this.lease ?? null,
      ...(this.conflict ? { conflict: true } : {}),
    };
  }

  /** Reads the key and its lease again. */
  async refresh(): Promise<EtcdKeyState> {
    const session = await this.deps.session();
    this.entry = await getEntry(session, redisKeyBytes(this.deps.key));
    this.lease = await this.leaseOf(session, this.entry);
    this.conflict = false;
    return this.state();
  }

  /**
   * Saves the value. `modRevision` is the revision the page read (`"0"` when the key was
   * not there). A key that changed since is refused (`saved: false`, the new content is
   * read) unless `overwrite` is set, which replaces whatever is there now.
   */
  async save(
    value: RedisValue,
    modRevision: string,
    overwrite = false,
  ): Promise<{ readonly saved: boolean; readonly state: EtcdKeyState }> {
    this.requireWritable();
    const bytes = redisValueBytes(value);
    if (bytes === undefined) {
      throw new DbError(
        'syntax',
        msg('The value cannot be saved: it is cut short, or its hex digits do not come in pairs'),
      );
    }
    const session = await this.deps.session();
    const key = redisKeyBytes(this.deps.key);
    // "Replace it anyway" still checks: against the revision that is there right now.
    const base = overwrite ? await getEntry(session, key) : undefined;
    const expectedRevision = overwrite ? (base?.modRevision ?? '0') : modRevision;
    const existing = expectedRevision !== '0';
    const result = await putEntry(session, key, {
      value: bytes,
      // An edit keeps the lease the key has; a key made now has none.
      lease: existing ? 'keep' : 'none',
      expect: existing ? { kind: 'revision', modRevision: expectedRevision } : { kind: 'absent' },
    });
    if (!result.done) {
      this.entry = result.current;
      this.lease = await this.leaseOf(session, this.entry);
      this.conflict = true;
      return { saved: false, state: this.state() };
    }
    return { saved: true, state: await this.refresh() };
  }

  /** Attaches a lease: a new one of `ttl` seconds, or an existing one. */
  async attachLease(options: {
    readonly ttl?: number;
    readonly id?: string;
  }): Promise<EtcdKeyState> {
    this.requireWritable();
    const session = await this.deps.session();
    const key = redisKeyBytes(this.deps.key);
    const current = await getEntry(session, key);
    if (current === undefined) {
      throw new DbError('not-found', msg('The key is gone: save it first'));
    }
    let id: string;
    let created = false;
    if (options.id !== undefined && options.id !== '') {
      const info = await leaseInfo(session, options.id);
      if (info === undefined || info.ttl < 0) {
        throw new DbError(
          'not-found',
          msg('The lease {0} does not exist or has ended', options.id),
        );
      }
      id = info.id;
    } else {
      id = (await grantLease(session, options.ttl ?? 0)).id;
      created = true;
    }
    const result = await putEntry(session, key, {
      value: 'keep',
      lease: id,
      expect: { kind: 'revision', modRevision: current.modRevision },
    });
    if (!result.done) {
      // The key moved on: a lease made for it would only linger until it ends.
      if (created) {
        await revokeLease(session, id).catch(() => undefined);
      }
      this.entry = result.current;
      this.lease = await this.leaseOf(session, this.entry);
      this.conflict = true;
      return this.state();
    }
    return await this.refresh();
  }

  /** Lets go of the key's lease; the key stays until somebody deletes it. */
  async detachLease(): Promise<EtcdKeyState> {
    this.requireWritable();
    const session = await this.deps.session();
    const key = redisKeyBytes(this.deps.key);
    const current = await getEntry(session, key);
    if (current !== undefined && current.lease !== '0') {
      await putEntry(session, key, {
        value: 'keep',
        lease: 'none',
        expect: { kind: 'revision', modRevision: current.modRevision },
      });
    }
    return await this.refresh();
  }

  /** Revokes the lease: every key attached to it goes with it. */
  async revokeLease(): Promise<EtcdKeyState> {
    this.requireWritable();
    const session = await this.deps.session();
    const current = await getEntry(session, redisKeyBytes(this.deps.key));
    if (current !== undefined && current.lease !== '0') {
      await revokeLease(session, current.lease);
    }
    return await this.refresh();
  }

  async deleteKey(): Promise<EtcdKeyState> {
    this.requireWritable();
    await deleteEntry(await this.deps.session(), redisKeyBytes(this.deps.key));
    return await this.refresh();
  }

  private requireWritable(): void {
    if (this.deps.readOnly) {
      throw new DbError(
        'permission-denied',
        msg('The connection is read-only: nothing may change'),
      );
    }
  }

  private async leaseOf(
    session: EtcdCaller,
    entry: EtcdEntry | undefined,
  ): Promise<LeaseView | undefined> {
    if (entry === undefined || entry.lease === '0') {
      return undefined;
    }
    try {
      const info = await leaseInfo(session, entry.lease);
      return info;
    } catch {
      // The key is the page's business; a lease that cannot be read is shown by its id.
      return { id: entry.lease, ttl: -1, grantedTtl: 0 };
    }
  }
}
