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
  keepAliveLease,
  leaseInfo,
  putEntry,
  revokeLease,
} from '../../services/etcd/etcd-client';
import { type EtcdWatcher, type EtcdWatchEvent, watchKeys } from '../../services/etcd/etcd-watch';
import { type EtcdKeyState, type EtcdWatchEventView } from '../../shared/protocols/etcd-key';
import { MAX_STRING_BYTES } from '../../shared/protocols/redis-key';
import { type RedisKeyRef, redisKeyBytes } from '../../shared/redis-key';
import { redisValueBytes, type RedisValue, redisValueOf } from '../../shared/redis-value';

export interface EtcdKeyModelDeps {
  readonly key: RedisKeyRef;
  readonly connectionName: string;
  readonly readOnly: boolean;
  /** The session of the key's connection; one that can `watch` lets the page follow the key. */
  readonly session: () => Promise<EtcdCaller & Partial<EtcdWatcher>>;
  /** Milliseconds changes are gathered before the page hears of them. */
  readonly watchFlushMs?: number;
}

/** How long the changes of a watch are gathered before the page is told. */
export const DEFAULT_WATCH_FLUSH_MS = 200;

/** Changes the page keeps; the oldest go first. */
export const MAX_WATCH_EVENTS = 200;

const PREVIEW_CHARS = 200;

function textOf(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** The start of a value for the list of changes: text when it is text, else hex. */
function previewOf(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 400));
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  } catch {
    const head = Array.from(bytes.subarray(0, 32), (byte) => byte.toString(16).padStart(2, '0'));
    return `0x${head.join('')}${bytes.length > 32 ? '…' : ''}`;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
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
  private keeping = false;
  private watch: AbortController | undefined;
  private watchPrefix = false;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchPending: EtcdWatchEvent[] = [];
  private events: EtcdWatchEventView[] = [];
  private watchNotice: string | undefined;

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
      ...(this.keeping && this.lease !== undefined ? { keepingAlive: true } : {}),
      ...(this.watch === undefined ? {} : { watching: true, watchPrefix: this.watchPrefix }),
      ...(this.events.length === 0 ? {} : { events: this.events.map((event) => ({ ...event })) }),
      ...(this.watchNotice === undefined ? {} : { watchNotice: this.watchNotice }),
    };
  }

  /** True while the key is watched. */
  get watching(): boolean {
    return this.watch !== undefined;
  }

  /**
   * Watches the key (and, with `prefix`, every key below it): changes are gathered for a
   * moment, added to the list the page shows, and the key is read again when it is one of
   * them; `onChange` is called after each batch. The first read after the cluster accepts
   * the watch closes the gap between the page's last read and the watch. A failure ends the
   * watch and says why.
   */
  async startWatch(prefix: boolean, onChange: () => void): Promise<EtcdKeyState> {
    this.stopWatch();
    const session = await this.deps.session();
    if (session.watch === undefined) {
      throw new DbError('unsupported', msg('This cluster connection cannot be watched'));
    }
    const watcher: EtcdWatcher = { watch: session.watch.bind(session) };
    const abort = new AbortController();
    this.watch = abort;
    this.watchPrefix = prefix;
    this.watchNotice = undefined;
    const key = redisKeyBytes(this.deps.key);
    let again = false;
    const flush = (): void => {
      this.watchTimer = undefined;
      const batch = this.takeWatched();
      const touched = again || batch.some((event) => sameBytes(event.key, key));
      again = false;
      if (!touched) {
        onChange();
        return;
      }
      void this.reread(session).then(
        () => {
          if (this.watch === abort) {
            onChange();
          }
        },
        (error: unknown) => {
          if (this.watch === abort) {
            this.endWatch(abort, error);
            onChange();
          }
        },
      );
    };
    const schedule = (): void => {
      this.watchTimer ??= setTimeout(flush, this.deps.watchFlushMs ?? DEFAULT_WATCH_FLUSH_MS);
    };
    void watchKeys(
      watcher,
      key,
      {
        prefix,
        onCreated: () => {
          again = true;
          schedule();
        },
      },
      (events) => {
        if (this.watch !== abort) {
          return;
        }
        this.watchPending.push(...events);
        schedule();
      },
      abort.signal,
    ).then(
      () => {
        // The cluster closed the stream: the same as a failure, unless the user stopped it.
        if (this.watch === abort) {
          this.endWatch(
            abort,
            new DbError('connection-failed', msg('The cluster closed the watch')),
          );
          onChange();
        }
      },
      (error: unknown) => {
        if (this.watch === abort) {
          this.endWatch(abort, error);
          onChange();
        }
      },
    );
    return this.state();
  }

  /** Stops watching; the changes seen stay in the list. */
  stopWatch(): EtcdKeyState {
    const running = this.watch;
    this.watch = undefined;
    running?.abort();
    if (this.watchTimer !== undefined) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    this.takeWatched();
    return this.state();
  }

  /** Empties the list of changes. */
  clearEvents(): EtcdKeyState {
    this.events = [];
    this.watchNotice = undefined;
    return this.state();
  }

  private endWatch(abort: AbortController, error: unknown): void {
    this.stopWatch();
    abort.abort();
    this.watchNotice = msg(
      'Watching stopped: {0}',
      error instanceof Error ? error.message : String(error),
    );
  }

  /** Moves the changes gathered so far into the list; returns them. */
  private takeWatched(): EtcdWatchEvent[] {
    const batch = this.watchPending;
    this.watchPending = [];
    const at = Date.now();
    this.events = [
      ...this.events,
      ...batch.map((event): EtcdWatchEventView => ({
        at,
        type: event.type,
        key: textOf(event.key),
        revision: event.modRevision,
        size: event.value.length,
        preview: event.type === 'delete' ? '' : previewOf(event.value),
      })),
    ].slice(-MAX_WATCH_EVENTS);
    return batch;
  }

  /** Reads the key and its lease again without touching the flags of a save. */
  private async reread(session: EtcdCaller): Promise<void> {
    this.entry = await getEntry(session, redisKeyBytes(this.deps.key));
    this.lease = await this.leaseOf(session, this.entry);
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

  /** Is the lease being renewed? False once it has nothing to renew. */
  get keepingAlive(): boolean {
    return this.keeping && this.lease !== undefined;
  }

  /** Switches the renewal of the key's lease on or off (V13.27); needs a lease to renew. */
  setKeepAlive(on: boolean): EtcdKeyState {
    if (on) {
      this.requireWritable();
      if (this.lease === undefined || this.lease.ttl <= 0) {
        throw new DbError('not-found', msg('The key has no lease to renew'));
      }
    }
    this.keeping = on;
    return this.state();
  }

  /**
   * Renews the lease once and shows the time it has now. A lease that is gone (or a key
   * that is) ends the renewal; the page then shows what is left.
   */
  async renew(): Promise<EtcdKeyState> {
    const session = await this.deps.session();
    const current = await getEntry(session, redisKeyBytes(this.deps.key));
    if (current === undefined || current.lease === '0') {
      this.keeping = false;
      return await this.refresh();
    }
    const ttl = await keepAliveLease(session, current.lease);
    if (ttl <= 0) {
      this.keeping = false;
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
