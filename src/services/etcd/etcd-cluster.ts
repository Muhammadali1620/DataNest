// The cluster side of etcd (V13.35): who the members are, how the member the session talks
// to is doing, the alarms it raised, and a snapshot of the whole store. One function each
// over the JSON gateway, taking anything that can `call` (and `watch` for the snapshot, the
// one answer that streams), so a test hands them a small fake cluster. No `vscode`.

import { createHash } from 'node:crypto';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import { count, fromBase64, int64 } from './etcd-codec';
import type { EtcdCaller } from './etcd-client';
import { type EtcdWatcher, kindOf } from './etcd-watch';

export interface EtcdMember {
  /** The member's id, a decimal number (64 bits do not fit a JavaScript number). */
  readonly id: string;
  /** Empty for a member that was added and has not started yet. */
  readonly name: string;
  readonly peerUrls: readonly string[];
  readonly clientUrls: readonly string[];
  /** A learner follows the log but does not vote yet. */
  readonly learner: boolean;
}

/** How the member the session is connected to is doing. */
export interface EtcdMemberStatus {
  readonly memberId: string;
  readonly leaderId: string;
  readonly version: string;
  /** Bytes the store's file takes on disk. */
  readonly dbSize: number;
  /** Bytes of it that hold data (the rest is free space the file keeps). */
  readonly dbSizeInUse: number;
  readonly raftIndex: string;
  readonly raftAppliedIndex: string;
  readonly raftTerm: string;
  readonly learner: boolean;
  /** Problems the member reports about itself. */
  readonly errors: readonly string[];
}

export interface EtcdAlarm {
  readonly memberId: string;
  /** `NOSPACE` (the store is full: writes are refused) or `CORRUPT`. */
  readonly kind: string;
}

// The shape of an answer is the caller's to name; the gateway sends what it sends.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function objectOf<T extends object>(value: unknown): T {
  return (typeof value === 'object' && value !== null ? value : {}) as T;
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((one): one is string => typeof one === 'string')
    : [];
}

export async function listMembers(session: EtcdCaller): Promise<readonly EtcdMember[]> {
  const answer = objectOf<{ members?: unknown }>(await session.call('cluster/member/list', {}));
  const members = Array.isArray(answer.members) ? (answer.members as unknown[]) : [];
  return members.map((raw) => {
    const member = objectOf<{
      ID?: unknown;
      name?: unknown;
      peerURLs?: unknown;
      clientURLs?: unknown;
      isLearner?: unknown;
    }>(raw);
    return {
      id: int64(member.ID),
      name: typeof member.name === 'string' ? member.name : '',
      peerUrls: texts(member.peerURLs),
      clientUrls: texts(member.clientURLs),
      learner: member.isLearner === true,
    };
  });
}

export async function memberStatus(session: EtcdCaller): Promise<EtcdMemberStatus> {
  const answer = objectOf<{
    header?: { member_id?: unknown };
    version?: unknown;
    dbSize?: unknown;
    dbSizeInUse?: unknown;
    leader?: unknown;
    raftIndex?: unknown;
    raftAppliedIndex?: unknown;
    raftTerm?: unknown;
    isLearner?: unknown;
    errors?: unknown;
  }>(await session.call('maintenance/status', {}));
  return {
    memberId: int64(answer.header?.member_id),
    leaderId: int64(answer.leader),
    version: typeof answer.version === 'string' ? answer.version : '',
    dbSize: count(answer.dbSize),
    dbSizeInUse: count(answer.dbSizeInUse),
    raftIndex: int64(answer.raftIndex),
    raftAppliedIndex: int64(answer.raftAppliedIndex),
    raftTerm: int64(answer.raftTerm),
    learner: answer.isLearner === true,
    errors: texts(answer.errors),
  };
}

/** The alarms the cluster has raised; none is the healthy answer. */
export async function listAlarms(session: EtcdCaller): Promise<readonly EtcdAlarm[]> {
  const answer = objectOf<{ alarms?: unknown }>(
    await session.call('maintenance/alarm', { action: 'GET' }),
  );
  const alarms = Array.isArray(answer.alarms) ? (answer.alarms as unknown[]) : [];
  return alarms
    .map((raw) => objectOf<{ memberID?: unknown; alarm?: unknown }>(raw))
    .filter((alarm) => typeof alarm.alarm === 'string' && alarm.alarm !== 'NONE')
    .map((alarm) => ({ memberId: int64(alarm.memberID), kind: alarm.alarm as string }));
}

/** Bytes of the checksum etcd appends to the end of a snapshot file. */
export const SNAPSHOT_HASH_BYTES = 32;

/** A file being written, piece by piece. */
export interface SnapshotSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Ends the file; `keep` false removes what was written (the snapshot failed). */
  close(keep: boolean): Promise<void>;
}

export interface SnapshotResult {
  /** Bytes written, the checksum included. */
  readonly bytes: number;
  /** True when the checksum at the end of the file matches what was written before it. */
  readonly verified: boolean;
}

/**
 * Streams a snapshot of the whole store from the member the session talks to. `write`
 * gets the file piece by piece (it may be async: the next piece waits for it). A snapshot
 * ends with a SHA-256 of everything before it; the function checks it, so a file cut short
 * or garbled on the way is reported rather than kept as a good backup.
 */
export async function takeSnapshot(
  session: EtcdCaller & EtcdWatcher,
  write: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<SnapshotResult> {
  const hash = createHash('sha256');
  // The last 32 bytes are the checksum, not data: hold the tail back until more arrives.
  let tail = new Uint8Array();
  let bytes = 0;
  // `watch` hands the messages to a synchronous callback; the writes run in order behind it,
  // and the first one that fails ends the stream.
  const stop = new AbortController();
  const relay = (): void => {
    stop.abort();
  };
  signal.addEventListener('abort', relay, { once: true });
  let chain: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  try {
    await session.watch(
      'maintenance/snapshot',
      {},
      (message) => {
        const wire = objectOf<{
          result?: { blob?: unknown };
          error?: { code?: unknown; message?: unknown };
        }>(message);
        if (wire.error !== undefined) {
          throw new DbError(
            kindOf(wire.error.code),
            typeof wire.error.message === 'string'
              ? wire.error.message
              : msg('The cluster ended the snapshot'),
          );
        }
        const piece = fromBase64(wire.result?.blob);
        if (piece.length === 0) {
          return;
        }
        bytes += piece.length;
        const joined = new Uint8Array(tail.length + piece.length);
        joined.set(tail);
        joined.set(piece, tail.length);
        const keep = Math.min(SNAPSHOT_HASH_BYTES, joined.length);
        const data = joined.subarray(0, joined.length - keep);
        tail = joined.slice(joined.length - keep);
        if (data.length > 0) {
          hash.update(data);
          chain = chain.then(async () => {
            if (failure !== undefined) {
              return;
            }
            try {
              await write(data);
            } catch (error) {
              failure = error instanceof Error ? error : new Error(String(error));
              stop.abort();
            }
          });
        }
      },
      stop.signal,
    );
  } finally {
    signal.removeEventListener('abort', relay);
  }
  await chain;
  if (failure !== undefined) {
    throw failure;
  }
  if (signal.aborted) {
    throw new DbError('cancelled', msg('The snapshot was cancelled'));
  }
  if (tail.length < SNAPSHOT_HASH_BYTES) {
    throw new DbError('connection-failed', msg('The cluster sent too little to be a snapshot'));
  }
  const verified = Buffer.from(tail).equals(hash.digest());
  // The checksum goes to the file as well: etcdutl checks it when the snapshot is restored.
  await write(tail);
  return { bytes, verified };
}
