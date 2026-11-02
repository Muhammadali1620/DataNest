// Watching keys of etcd (V13.31): one function over the gateway's `watch` stream, which
// turns the cluster's JSON lines into plain events. Takes anything that can `watch`, so a
// test hands it a small fake cluster. No `vscode`, no session handling.

import { DbError, type DbErrorCode } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { EtcdSession } from '../../drivers/etcd-driver';
import { entryOf, int64, prefixEnd, toBase64 } from './etcd-codec';

export type EtcdWatcher = Pick<EtcdSession, 'watch'>;

/** One change the cluster reported: a put (a new key or a new value) or a delete. */
export interface EtcdWatchEvent {
  readonly type: 'put' | 'delete';
  readonly key: Uint8Array;
  /** The value after a put; empty after a delete. */
  readonly value: Uint8Array;
  /** The value before the change, when the cluster knew it; absent for a new key. */
  readonly previous?: Uint8Array;
  readonly modRevision: string;
  /** Changes since the key was created, after this one (0 after a delete). */
  readonly version: number;
}

export interface WatchOptions {
  /** Watch every key that starts with `key`, not only `key`. */
  readonly prefix?: boolean;
  /** Start at this revision (history is replayed); absent: from now on. */
  readonly startRevision?: string;
  /** Called once the cluster has accepted the watch: changes from here on are seen. */
  readonly onCreated?: () => void;
}

interface WireWatch {
  readonly result?: {
    readonly created?: unknown;
    readonly canceled?: unknown;
    readonly cancel_reason?: unknown;
    readonly compact_revision?: unknown;
    readonly events?: unknown;
  };
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

// The shape of a message is the caller's to name; the gateway sends what it sends.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function objectOf<T extends object>(value: unknown): T {
  return (typeof value === 'object' && value !== null ? value : {}) as T;
}

/** The kinds of failure a stream reports, from gRPC's codes. */
function kindOf(code: unknown): DbErrorCode {
  switch (code) {
    case 7:
      return 'permission-denied';
    case 16:
      return 'auth-failed';
    case 14:
      return 'busy';
    case 3:
      return 'syntax';
    default:
      return 'constraint';
  }
}

function watchEventOf(wire: unknown): EtcdWatchEvent {
  const event = objectOf<{ type?: unknown; kv?: unknown; prev_kv?: unknown }>(wire);
  const entry = entryOf(event.kv);
  const deleted = event.type === 'DELETE';
  return {
    type: deleted ? 'delete' : 'put',
    key: entry.key,
    value: deleted ? new Uint8Array() : entry.value,
    ...(event.prev_kv === undefined ? {} : { previous: entryOf(event.prev_kv).value }),
    modRevision: entry.modRevision,
    version: deleted ? 0 : entry.version,
  };
}

/**
 * Watches a key or a prefix and hands every batch of changes to `onEvents` until `signal`
 * aborts. A stream the cluster cancels (the revision was compacted, the user lost the
 * right to read the key) or fails rejects with the cluster's reason.
 */
export async function watchKeys(
  session: EtcdWatcher,
  key: Uint8Array,
  options: WatchOptions,
  onEvents: (events: readonly EtcdWatchEvent[]) => void,
  signal: AbortSignal,
): Promise<void> {
  // The gateway has no empty key; a single zero byte starts at the very first key.
  const from = key.length === 0 ? Uint8Array.of(0) : key;
  const request = {
    key: toBase64(from),
    ...(options.prefix === true ? { range_end: toBase64(prefixEnd(key)) } : {}),
    ...(options.startRevision === undefined ? {} : { start_revision: options.startRevision }),
    prev_kv: true,
  };
  await session.watch(
    'watch',
    { create_request: request },
    (message) => {
      const wire = objectOf<WireWatch>(message);
      if (wire.error !== undefined) {
        throw new DbError(
          kindOf(wire.error.code),
          typeof wire.error.message === 'string'
            ? wire.error.message
            : msg('The cluster ended the watch'),
        );
      }
      const result = wire.result ?? {};
      if (result.canceled === true) {
        throw new DbError(
          'constraint',
          typeof result.cancel_reason === 'string' && result.cancel_reason !== ''
            ? result.cancel_reason
            : // The gateway names no reason for a revision it has compacted, but this field.
              int64(result.compact_revision) !== '0'
              ? msg(
                  'The history up to revision {0} was compacted: watch from a later revision',
                  int64(result.compact_revision),
                )
              : msg('The cluster ended the watch'),
        );
      }
      if (result.created === true) {
        options.onCreated?.();
      }
      if (Array.isArray(result.events) && result.events.length > 0) {
        onEvents((result.events as unknown[]).map(watchEventOf));
      }
    },
    signal,
  );
}
