// Redis keys to a file and back (V13.9). The file is our own, portable format: one JSON
// object per line, so it streams, diffs and survives any Redis version. Keys and values are
// bytes: text that is valid UTF-8 stays text, anything else is `{"b64": "…"}`. A big
// collection is cut into records of a few hundred items (the later ones marked `append`),
// so neither the export nor the restore holds a whole key in memory. A type this format has
// no shape for (a module's) travels as its DUMP payload, which only the same Redis family
// restores.

import { errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { RedisCommand, RedisReply, RedisSession } from '../../drivers/redis-driver';
import { isErrorReply } from '../../drivers/redis-driver';
import type { TextSink } from '../file-sink';
import { escapeGlob } from './key-scan';
import { nextStreamId } from './key-values';
import { replyItems, replyNumber, replyText } from './reply';

/** The first line of a file, so another file is not taken for ours. */
export const FILE_MARK = 'redis-keys';
export const FILE_VERSION = 1;

/** Items of a collection per record. */
export const ITEMS_PER_RECORD = 500;
/** Keys looked at together (types, TTLs) in one round trip. */
export const KEY_BATCH = 100;
/** A string longer than this is not exported: one line of that size is no help to anyone. */
export const MAX_STRING_BYTES = 64 * 1024 * 1024;
/** Keys remembered to drop the repeats SCAN may return. */
const SEEN_WINDOW = 200_000;
/** Problems listed in a report; past that only counted. */
export const MAX_REPORTED_PROBLEMS = 100;

/** Bytes in the file: text when it is UTF-8, else base64. */
export type FileBytes = string | { readonly b64: string };

const FATAL = new TextDecoder('utf-8', { fatal: true });
const ENCODER = new TextEncoder();

export function encodeBytes(bytes: Uint8Array): FileBytes {
  try {
    return FATAL.decode(bytes);
  } catch {
    return { b64: Buffer.from(bytes).toString('base64') };
  }
}

/** Bytes of a file value; undefined when it is neither text nor `{b64}`. */
export function decodeBytes(value: unknown): Uint8Array | undefined {
  if (typeof value === 'string') {
    return ENCODER.encode(value);
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const b64 = (value as { b64?: unknown }).b64;
    if (typeof b64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
  }
  return undefined;
}

/** The glob that matches the keys under a folder's prefix; every key for no prefix. */
export function prefixPattern(prefix: string): string | undefined {
  return prefix === '' ? undefined : `${escapeGlob(prefix)}*`;
}

export interface ExportRequest {
  readonly session: RedisSession;
  /** A glob to walk the database with; ignored when `keys` is given. */
  readonly match?: string;
  /** Export exactly these keys instead of walking. */
  readonly keys?: readonly Uint8Array[];
  readonly sink: TextSink;
  readonly signal?: { readonly aborted: boolean };
  /** Told the number of keys written so far. */
  readonly onProgress?: (keys: number) => void;
}

export interface ExportReport {
  readonly keys: number;
  /** Keys left out, with why (too big, gone meanwhile is not listed). */
  readonly skipped: readonly { readonly key: string; readonly reason: string }[];
  readonly cancelled: boolean;
}

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

function bytesOf(reply: RedisReply | undefined): Uint8Array {
  if (reply instanceof Uint8Array) {
    return reply;
  }
  return ENCODER.encode(typeof reply === 'string' ? reply : '');
}

const pairsOf = (reply: RedisReply): [RedisReply, RedisReply][] => {
  const flat = replyItems(reply);
  const result: [RedisReply, RedisReply][] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    result.push([flat[index] ?? null, flat[index + 1] ?? null]);
  }
  return result;
};

/** Records of one key: the first carries the TTL, the next ones are marked `append`. */
async function* keyRecords(
  session: RedisSession,
  key: Uint8Array,
  type: string,
  ttl: number | null,
): AsyncGenerator<Record<string, unknown>> {
  const head = { key: encodeBytes(key), type, ttl };
  let first = true;
  const record = (value: unknown): Record<string, unknown> => {
    const out = first ? { ...head, value } : { key: head.key, type, append: true, value };
    first = false;
    return out;
  };
  const size = String(ITEMS_PER_RECORD);
  switch (type) {
    case 'hash':
    case 'set': {
      const command = type === 'hash' ? 'HSCAN' : 'SSCAN';
      let cursor = '0';
      do {
        const [next = null, found = null] = replyItems(
          await session.call([command, key, cursor, 'COUNT', size]),
        );
        cursor = replyText(next);
        const items =
          type === 'hash'
            ? pairsOf(found).map(([field, value]) => [
                encodeBytes(bytesOf(field)),
                encodeBytes(bytesOf(value)),
              ])
            : replyItems(found).map((member) => encodeBytes(bytesOf(member)));
        if (items.length > 0) {
          yield record(items);
        }
      } while (cursor !== '0' && cursor !== '');
      return;
    }
    case 'zset': {
      for (let start = 0; ; start += ITEMS_PER_RECORD) {
        const found = pairsOf(
          await session.call([
            'ZRANGE',
            key,
            String(start),
            String(start + ITEMS_PER_RECORD - 1),
            'WITHSCORES',
          ]),
        );
        if (found.length > 0) {
          yield record(
            found.map(([member, score]) => [encodeBytes(bytesOf(member)), replyText(score)]),
          );
        }
        if (found.length < ITEMS_PER_RECORD) {
          return;
        }
      }
    }
    case 'list': {
      for (let start = 0; ; start += ITEMS_PER_RECORD) {
        const values = replyItems(
          await session.call(['LRANGE', key, String(start), String(start + ITEMS_PER_RECORD - 1)]),
        );
        if (values.length > 0) {
          yield record(values.map((value) => encodeBytes(bytesOf(value))));
        }
        if (values.length < ITEMS_PER_RECORD) {
          return;
        }
      }
    }
    case 'stream': {
      let after = '-';
      for (;;) {
        const entries = replyItems(await session.call(['XRANGE', key, after, '+', 'COUNT', size]));
        const items = entries.map((entry) => {
          const [id = null, fields = null] = replyItems(entry);
          return [
            replyText(id),
            pairsOf(fields ?? null).map(([field, value]) => [
              encodeBytes(bytesOf(field)),
              encodeBytes(bytesOf(value)),
            ]),
          ];
        });
        if (items.length > 0) {
          yield record(items);
        }
        const last = items.at(-1)?.[0];
        if (typeof last !== 'string' || items.length < ITEMS_PER_RECORD) {
          return;
        }
        after = nextStreamId(last);
      }
    }
    default: {
      // Not a shape of this format: the server's own serialization.
      const dump = await session.call(['DUMP', key]);
      if (dump instanceof Uint8Array) {
        yield { ...head, dump: Buffer.from(dump).toString('base64') };
      }
    }
  }
}

/** Writes the keys of a database, a prefix or a list to the sink; SCAN, never KEYS. */
export async function exportKeys(request: ExportRequest): Promise<ExportReport> {
  const { session, sink } = request;
  await sink.write(line({ datanest: FILE_MARK, version: FILE_VERSION }));
  const skipped: { key: string; reason: string }[] = [];
  let written = 0;
  const seen = new Set<string>();
  const cancelled = (): boolean => request.signal?.aborted === true;

  const exportBatch = async (batch: readonly Uint8Array[]): Promise<void> => {
    const info = await session.pipeline(
      batch.flatMap((key): RedisCommand[] => [
        ['TYPE', key],
        ['PTTL', key],
        ['STRLEN', key],
      ]),
    );
    for (const [index, key] of batch.entries()) {
      if (cancelled()) {
        return;
      }
      const typeReply = info[index * 3];
      const type =
        typeReply === undefined || isErrorReply(typeReply) ? 'none' : replyText(typeReply);
      const pttl = info[index * 3 + 1];
      const ttlValue = pttl === undefined || isErrorReply(pttl) ? undefined : replyNumber(pttl);
      if (type === 'none' || ttlValue === -2) {
        continue;
      }
      const ttl = ttlValue === undefined || ttlValue < 0 ? null : ttlValue;
      if (type === 'string') {
        const lengthReply = info[index * 3 + 2];
        const length =
          lengthReply === undefined || isErrorReply(lengthReply)
            ? 0
            : (replyNumber(lengthReply) ?? 0);
        if (length > MAX_STRING_BYTES) {
          skipped.push({
            key: replyText(key),
            reason: msg('The string is larger than 64 MB'),
          });
          continue;
        }
        const value = await session.call(['GET', key]);
        if (value === null) {
          continue;
        }
        await sink.write(
          line({ key: encodeBytes(key), type, ttl, value: encodeBytes(bytesOf(value)) }),
        );
      } else {
        let any = false;
        for await (const record of keyRecords(session, key, type, ttl)) {
          if (cancelled()) {
            return;
          }
          any = true;
          await sink.write(line(record));
        }
        if (!any) {
          continue;
        }
      }
      written += 1;
      request.onProgress?.(written);
    }
  };

  if (request.keys !== undefined) {
    for (let start = 0; start < request.keys.length && !cancelled(); start += KEY_BATCH) {
      await exportBatch(request.keys.slice(start, start + KEY_BATCH));
    }
    return { keys: written, skipped, cancelled: cancelled() };
  }

  let master = 0;
  let cursor = '0';
  let walked = false;
  while (!walked && !cancelled()) {
    const step = await session.scanStep(master, cursor, {
      ...(request.match === undefined ? {} : { match: request.match }),
      count: 1000,
    });
    const fresh: Uint8Array[] = [];
    for (const key of step.keys) {
      const id = Buffer.from(key).toString('latin1');
      if (seen.has(id)) {
        continue;
      }
      // A window, not every key ever seen: repeats come close together, memory stays bounded.
      if (seen.size >= SEEN_WINDOW) {
        const oldest = seen.values().next();
        if (oldest.done !== true) {
          seen.delete(oldest.value);
        }
      }
      seen.add(id);
      fresh.push(key);
    }
    for (let start = 0; start < fresh.length && !cancelled(); start += KEY_BATCH) {
      await exportBatch(fresh.slice(start, start + KEY_BATCH));
    }
    if (step.cursor === '0') {
      master += 1;
      cursor = '0';
      walked = master >= step.masters;
    } else {
      cursor = step.cursor;
    }
  }
  return { keys: written, skipped, cancelled: cancelled() };
}

/** What to do with a key the file has and the database already has. */
export type RestorePolicy =
  /** Leave the key in the database as it is. */
  | { readonly kind: 'skip' }
  /** Replace the key in the database with the one of the file. */
  | { readonly kind: 'overwrite' }
  /** Restore every key under a prefix, so nothing existing is touched. */
  | { readonly kind: 'prefix'; readonly prefix: string };

export interface RestoreRequest {
  readonly session: RedisSession;
  /** The file's text in pieces, as `readTextChunks` gives it. */
  readonly chunks: AsyncIterable<{ readonly text: string }>;
  readonly policy: RestorePolicy;
  readonly signal?: { readonly aborted: boolean };
  /** Told the number of keys restored so far. */
  readonly onProgress?: (keys: number) => void;
}

export interface RestoreProblem {
  /** 1-based line of the file. */
  readonly line: number;
  readonly message: string;
}

export interface RestoreReport {
  readonly restored: number;
  /** Keys left alone because they exist. */
  readonly skipped: number;
  /** Keys the file or the server refused. */
  readonly failed: number;
  readonly problems: readonly RestoreProblem[];
  readonly cancelled: boolean;
}

class FileProblem extends Error {}

function expect<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new FileProblem(what);
  }
  return value;
}

function bytesField(value: unknown, what: string): Uint8Array {
  return expect(decodeBytes(value), msg('{0} is neither text nor base64', what));
}

function listField(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new FileProblem(msg('The value of a record must be a list'));
  }
  return value as unknown[];
}

function pairField(value: unknown): [unknown, unknown] {
  const pair = listField(value);
  if (pair.length !== 2) {
    throw new FileProblem(msg('A pair must have two items'));
  }
  return [pair[0], pair[1]];
}

/** The commands that write one record into `key`. */
function writeCommands(key: Uint8Array, type: string, value: unknown): RedisCommand[] {
  const items = listField(value);
  switch (type) {
    case 'hash':
      return items.length === 0
        ? []
        : [
            [
              'HSET',
              key,
              ...items.flatMap((item) => {
                const [field, content] = pairField(item);
                return [bytesField(field, msg('A field')), bytesField(content, msg('A value'))];
              }),
            ],
          ];
    case 'set':
      return items.length === 0
        ? []
        : [['SADD', key, ...items.map((member) => bytesField(member, msg('A member')))]];
    case 'list':
      return items.length === 0
        ? []
        : [['RPUSH', key, ...items.map((element) => bytesField(element, msg('An element')))]];
    case 'zset':
      return items.length === 0
        ? []
        : [
            [
              'ZADD',
              key,
              ...items.flatMap((item) => {
                const [member, score] = pairField(item);
                if (typeof score !== 'string') {
                  throw new FileProblem(msg('A score must be text'));
                }
                return [score, bytesField(member, msg('A member'))];
              }),
            ],
          ];
    case 'stream':
      return items.map((item) => {
        const [id, fields] = pairField(item);
        if (typeof id !== 'string') {
          throw new FileProblem(msg('A stream id must be text'));
        }
        return [
          'XADD',
          key,
          id,
          ...listField(fields).flatMap((field) => {
            const [name, content] = pairField(field);
            return [bytesField(name, msg('A field')), bytesField(content, msg('A value'))];
          }),
        ];
      });
    default:
      throw new FileProblem(msg('The type "{0}" cannot be restored from items', type));
  }
}

/** Reads the records of a file and writes them, a piece at a time. */
export async function restoreKeys(request: RestoreRequest): Promise<RestoreReport> {
  const { session, policy } = request;
  const problems: RestoreProblem[] = [];
  let restored = 0;
  let skipped = 0;
  let failed = 0;
  const note = (lineNo: number, message: string): void => {
    failed += 1;
    if (problems.length < MAX_REPORTED_PROBLEMS) {
      problems.push({ line: lineNo, message });
    }
  };
  /**
   * The key being restored: the file's name for it and where it is written (they differ
   * under a prefix). No `target` once the key was left out, so its later pieces go with it.
   */
  let current: { readonly fileKey: Uint8Array; target?: Uint8Array } | undefined;

  const runAll = async (lineNo: number, commands: readonly RedisCommand[]): Promise<boolean> => {
    if (commands.length === 0) {
      return true;
    }
    const replies = await session.pipeline(commands);
    const bad = replies.find(isErrorReply);
    if (bad !== undefined) {
      note(lineNo, bad.error);
      return false;
    }
    return true;
  };

  const take = async (text: string, lineNo: number): Promise<void> => {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new FileProblem(msg('A line must be a JSON object'));
      }
      record = parsed as Record<string, unknown>;
    } catch (error) {
      note(lineNo, error instanceof FileProblem ? error.message : errorMessage(error));
      return;
    }
    if (record.datanest !== undefined) {
      if (record.datanest !== FILE_MARK || record.version !== FILE_VERSION) {
        note(lineNo, msg('This is not a DataNest Redis key file of a version this one reads'));
      }
      return;
    }
    try {
      const type = expect(
        typeof record.type === 'string' ? record.type : undefined,
        msg('A record needs a type'),
      );
      const fileKey = bytesField(record.key, msg('The key'));
      if (record.append === true) {
        if (current === undefined || Buffer.compare(current.fileKey, fileKey) !== 0) {
          note(lineNo, msg('A continuation record comes without its key'));
          return;
        }
        if (current.target === undefined) {
          // Its key was left out (it exists, or the server refused it): the pieces go with it.
          return;
        }
        await runAll(lineNo, writeCommands(current.target, type, record.value));
        return;
      }
      current = { fileKey };
      const key =
        policy.kind === 'prefix'
          ? new Uint8Array([...ENCODER.encode(policy.prefix), ...fileKey])
          : fileKey;
      const exists = replyNumber(await session.call(['EXISTS', key])) === 1;
      if (exists) {
        if (policy.kind === 'overwrite') {
          await session.call(['DEL', key]);
        } else {
          skipped += 1;
          return;
        }
      }
      let ok: boolean;
      const ttl =
        typeof record.ttl === 'number' && Number.isFinite(record.ttl) && record.ttl > 0
          ? Math.ceil(record.ttl)
          : undefined;
      if (typeof record.dump === 'string') {
        ok = await runAll(lineNo, [
          ['RESTORE', key, String(ttl ?? 0), new Uint8Array(Buffer.from(record.dump, 'base64'))],
        ]);
      } else if (type === 'string') {
        const value = bytesField(record.value, msg('The value'));
        ok = await runAll(lineNo, [
          ttl === undefined ? ['SET', key, value] : ['SET', key, value, 'PX', String(ttl)],
        ]);
      } else {
        ok = await runAll(lineNo, [
          ...writeCommands(key, type, record.value),
          ...(ttl === undefined ? [] : ([['PEXPIRE', key, String(ttl)]] as RedisCommand[])),
        ]);
      }
      if (ok) {
        current.target = key;
        restored += 1;
        request.onProgress?.(restored);
      }
    } catch (error) {
      if (!(error instanceof FileProblem)) {
        throw error;
      }
      note(lineNo, error.message);
    }
  };

  const finish = (cancelled: boolean): RestoreReport => ({
    restored,
    skipped,
    failed,
    problems,
    cancelled,
  });

  const aborted = (): boolean => request.signal?.aborted === true;
  let carry = '';
  let lineNo = 0;
  for await (const chunk of request.chunks) {
    if (aborted()) {
      return finish(true);
    }
    const lines = (carry + chunk.text).split('\n');
    carry = lines.pop() ?? '';
    for (const raw of lines) {
      lineNo += 1;
      if (raw.trim() !== '') {
        await take(raw.replace(/\r$/u, ''), lineNo);
      }
      if (aborted()) {
        return finish(true);
      }
    }
  }
  if (carry.trim() !== '') {
    lineNo += 1;
    await take(carry.replace(/\r$/u, ''), lineNo);
  }
  return finish(false);
}
