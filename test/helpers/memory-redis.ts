// A small Redis in memory for unit tests of the key files (V13.9): the commands the
// export and restore use, with real semantics for types, TTLs and paging, so a file can
// be written from one database and read back into another.

import { DbError } from '../../src/core/errors';
import type {
  RedisCommand,
  RedisReply,
  RedisSession,
  ScanOptions,
  ScanStep,
} from '../../src/drivers/redis-driver';
import type { RedisMode } from '../../src/shared/connection';

type Bytes = Uint8Array;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('latin1');
const id = (bytes: Bytes): string => DECODER.decode(bytes);
const bytesOf = (text: string): Bytes => ENCODER.encode(text);

export type Entry =
  | { type: 'string'; value: Bytes }
  | { type: 'hash'; value: Map<string, [Bytes, Bytes]> }
  | { type: 'set'; value: Map<string, Bytes> }
  | { type: 'zset'; value: Map<string, { member: Bytes; score: string }> }
  | { type: 'list'; value: Bytes[] }
  | { type: 'stream'; value: { id: string; fields: [Bytes, Bytes][] }[] }
  | { type: 'module'; value: Bytes };

interface Slot {
  entry: Entry;
  /** Epoch ms when it expires. */
  expires?: number;
}

const words = (command: RedisCommand): Bytes[] =>
  command.map((word) => (typeof word === 'string' ? bytesOf(word) : word));
/** A score as a number; `inf` and `-inf` as Redis writes them. */
const scoreNum = (score: string): number =>
  /^[+-]?inf$/i.test(score) ? (score.startsWith('-') ? -Infinity : Infinity) : Number(score);
const text = (bytes: Bytes | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

/** A Redis glob (`*`, `?`, `\\x` for a literal) as a regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? '';
    if (char === '\\') {
      i += 1;
      source += (glob[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '*') {
      source += '[\\s\\S]*';
    } else if (char === '?') {
      source += '[\\s\\S]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

export class MemoryRedis implements RedisSession {
  readonly mode: RedisMode = 'standalone';
  readonly database = 0;
  readonly keys = new Map<string, Slot>();
  /** Every command asked for, as text (keys and values decoded as UTF-8). */
  readonly log: string[][] = [];
  /** Names of the commands that must fail with this error reply. */
  readonly refuse = new Map<string, string>();
  now = 1_000_000;

  put(key: string | Bytes, entry: Entry, ttlMs?: number): void {
    const name = typeof key === 'string' ? bytesOf(key) : key;
    this.keys.set(id(name), {
      entry,
      ...(ttlMs === undefined ? {} : { expires: this.now + ttlMs }),
    });
  }

  string(key: string, value: string | Bytes, ttlMs?: number): void {
    this.put(
      key,
      { type: 'string', value: typeof value === 'string' ? bytesOf(value) : value },
      ttlMs,
    );
  }

  entryOf(key: string | Bytes): Entry | undefined {
    return this.keys.get(id(typeof key === 'string' ? bytesOf(key) : key))?.entry;
  }

  ttlOf(key: string | Bytes): number | undefined {
    const slot = this.keys.get(id(typeof key === 'string' ? bytesOf(key) : key));
    return slot?.expires === undefined ? undefined : slot.expires - this.now;
  }

  private slot(key: Bytes): Slot | undefined {
    const found = this.keys.get(id(key));
    if (found?.expires !== undefined && found.expires <= this.now) {
      this.keys.delete(id(key));
      return undefined;
    }
    return found;
  }

  private wrong(): RedisReply {
    return { error: 'WRONGTYPE Operation against a key holding the wrong kind of value' };
  }

  private run(command: RedisCommand): RedisReply {
    const w = words(command);
    const name = text(w[0]).toUpperCase();
    this.log.push(w.map((word) => text(word)));
    const refused = this.refuse.get(name);
    if (refused !== undefined) {
      return { error: refused };
    }
    const key = w[1] ?? new Uint8Array();
    const slot = [
      'TYPE',
      'PTTL',
      'STRLEN',
      'GET',
      'HSCAN',
      'SSCAN',
      'ZRANGE',
      'LRANGE',
      'XRANGE',
      'DUMP',
      'EXISTS',
    ].includes(name)
      ? this.slot(key)
      : undefined;
    switch (name) {
      case 'TYPE':
        return slot === undefined
          ? 'none'
          : slot.entry.type === 'module'
            ? 'ReJSON-RL'
            : slot.entry.type;
      case 'PTTL':
        return slot === undefined
          ? '-2'
          : slot.expires === undefined
            ? '-1'
            : String(slot.expires - this.now);
      case 'EXISTS':
        return slot === undefined ? '0' : '1';
      case 'STRLEN':
        return slot === undefined
          ? '0'
          : slot.entry.type === 'string'
            ? String(slot.entry.value.length)
            : this.wrong();
      case 'GET':
        return slot === undefined
          ? null
          : slot.entry.type === 'string'
            ? slot.entry.value
            : this.wrong();
      case 'DUMP':
        return slot === undefined
          ? null
          : bytesOf(
              `DUMP:${JSON.stringify(Buffer.from(slot.entry.type === 'module' ? slot.entry.value : new Uint8Array()).toString('base64'))}`,
            );
      case 'HSCAN':
      case 'SSCAN': {
        if (slot === undefined) {
          return ['0', []];
        }
        const cursor = Number(text(w[2]));
        const count = Number(text(w[4]));
        if (name === 'HSCAN' && slot.entry.type === 'hash') {
          const items = [...slot.entry.value.values()];
          const page = items.slice(cursor, cursor + count);
          const next = cursor + count >= items.length ? '0' : String(cursor + count);
          return [next, page.flatMap(([f, v]) => [f, v])];
        }
        if (name === 'SSCAN' && slot.entry.type === 'set') {
          const items = [...slot.entry.value.values()];
          const page = items.slice(cursor, cursor + count);
          return [cursor + count >= items.length ? '0' : String(cursor + count), page];
        }
        return this.wrong();
      }
      case 'ZRANGE': {
        if (slot === undefined) {
          return [];
        }
        if (slot.entry.type !== 'zset') {
          return this.wrong();
        }
        const items = [...slot.entry.value.values()].sort(
          (a, b) => scoreNum(a.score) - scoreNum(b.score),
        );
        const page = items.slice(Number(text(w[2])), Number(text(w[3])) + 1);
        return page.flatMap((item) => [item.member, bytesOf(item.score)]);
      }
      case 'LRANGE': {
        if (slot === undefined) {
          return [];
        }
        return slot.entry.type === 'list'
          ? slot.entry.value.slice(Number(text(w[2])), Number(text(w[3])) + 1)
          : this.wrong();
      }
      case 'XRANGE': {
        if (slot === undefined) {
          return [];
        }
        if (slot.entry.type !== 'stream') {
          return this.wrong();
        }
        const from = text(w[2]);
        const count = Number(text(w[5]));
        const after = (entryId: string): boolean => {
          if (from === '-') {
            return true;
          }
          const [a = 0n, b = 0n] = entryId.split('-').map(BigInt);
          const [c = 0n, d = 0n] = from.split('-').map(BigInt);
          return a > c || (a === c && b >= d);
        };
        return slot.entry.value
          .filter((entry) => after(entry.id))
          .slice(0, count)
          .map((entry) => [bytesOf(entry.id), entry.fields.flatMap(([f, v]) => [f, v])]);
      }
      case 'DEL': {
        this.keys.delete(id(key));
        return '1';
      }
      case 'SET': {
        const px = w.findIndex((word) => text(word).toUpperCase() === 'PX');
        this.put(
          key,
          { type: 'string', value: w[2] ?? new Uint8Array() },
          px === -1 ? undefined : Number(text(w[px + 1])),
        );
        return bytesOf('OK');
      }
      case 'HSET': {
        const entry = this.writable(key, 'hash', () => ({ type: 'hash', value: new Map() }));
        if (!('error' in entry) && entry.type === 'hash') {
          for (let i = 2; i + 1 < w.length; i += 2) {
            entry.value.set(id(w[i] ?? new Uint8Array()), [
              w[i] ?? new Uint8Array(),
              w[i + 1] ?? new Uint8Array(),
            ]);
          }
          return String((w.length - 2) / 2);
        }
        return this.wrong();
      }
      case 'SADD': {
        const entry = this.writable(key, 'set', () => ({ type: 'set', value: new Map() }));
        if (!('error' in entry) && entry.type === 'set') {
          for (const member of w.slice(2)) {
            entry.value.set(id(member), member);
          }
          return String(w.length - 2);
        }
        return this.wrong();
      }
      case 'RPUSH': {
        const entry = this.writable(key, 'list', () => ({ type: 'list', value: [] }));
        if (!('error' in entry) && entry.type === 'list') {
          entry.value.push(...w.slice(2));
          return String(entry.value.length);
        }
        return this.wrong();
      }
      case 'ZADD': {
        const entry = this.writable(key, 'zset', () => ({ type: 'zset', value: new Map() }));
        if (!('error' in entry) && entry.type === 'zset') {
          for (let i = 2; i + 1 < w.length; i += 2) {
            const score = text(w[i]);
            if (Number.isNaN(scoreNum(score))) {
              return { error: 'ERR value is not a valid float' };
            }
            const member = w[i + 1] ?? new Uint8Array();
            entry.value.set(id(member), { member, score });
          }
          return String((w.length - 2) / 2);
        }
        return this.wrong();
      }
      case 'XADD': {
        const entry = this.writable(key, 'stream', () => ({ type: 'stream', value: [] }));
        if (!('error' in entry) && entry.type === 'stream') {
          const fields: [Bytes, Bytes][] = [];
          for (let i = 3; i + 1 < w.length; i += 2) {
            fields.push([w[i] ?? new Uint8Array(), w[i + 1] ?? new Uint8Array()]);
          }
          entry.value.push({ id: text(w[2]), fields });
          return bytesOf(text(w[2]));
        }
        return this.wrong();
      }
      case 'PEXPIRE': {
        const found = this.slot(key);
        if (found === undefined) {
          return '0';
        }
        found.expires = this.now + Number(text(w[2]));
        return '1';
      }
      case 'RESTORE': {
        if (this.slot(key) !== undefined) {
          return { error: 'BUSYKEY Target key name already exists.' };
        }
        const payload = text(w[3]);
        if (!payload.startsWith('DUMP:')) {
          return { error: 'ERR DUMP payload version or checksum are wrong' };
        }
        const b64 = JSON.parse(payload.slice(5)) as string;
        const ttl = Number(text(w[2]));
        this.put(
          key,
          { type: 'module', value: new Uint8Array(Buffer.from(b64, 'base64')) },
          ttl === 0 ? undefined : ttl,
        );
        return bytesOf('OK');
      }
      default:
        return { error: `ERR unknown command '${name}'` };
    }
  }

  /** The entry of a key for a write: made when missing, an error reply for another type. */
  private writable(key: Bytes, type: Entry['type'], make: () => Entry): Entry | { error: string } {
    const found = this.slot(key);
    if (found === undefined) {
      const entry = make();
      this.keys.set(id(key), { entry });
      return entry;
    }
    return found.entry.type === type ? found.entry : { error: 'WRONGTYPE' };
  }

  call(command: RedisCommand): Promise<RedisReply> {
    const reply = this.run(command);
    if (
      typeof reply === 'object' &&
      reply !== null &&
      !(reply instanceof Uint8Array) &&
      !Array.isArray(reply)
    ) {
      return Promise.reject(new DbError('syntax', (reply as { error: string }).error));
    }
    return Promise.resolve(reply);
  }

  pipeline(commands: readonly RedisCommand[]): Promise<RedisReply[]> {
    return Promise.resolve(commands.map((command) => this.run(command)));
  }

  atomic(commands: readonly RedisCommand[]): Promise<RedisReply[]> {
    return this.pipeline(commands);
  }

  onMasters(command: RedisCommand): Promise<RedisReply[]> {
    return Promise.resolve([this.run(command)]);
  }

  /** The keys walked, 3 per step so that paging is exercised; repeats can be injected. */
  repeats: string[] = [];

  scanStep(_master: number, cursor: string, options: ScanOptions): Promise<ScanStep> {
    const pattern = options.match === undefined ? undefined : globToRegExp(options.match);
    const all = [...this.keys.keys()].filter(
      (name) => this.slot(Buffer.from(name, 'latin1')) !== undefined,
    );
    const start = Number(cursor);
    const size = 3;
    const page = all.slice(start, start + size);
    const next = start + size >= all.length ? '0' : String(start + size);
    const names = [...page, ...(start === 0 ? this.repeats : [])];
    const matching = names.filter(
      (name) => pattern === undefined || pattern.test(Buffer.from(name, 'latin1').toString('utf8')),
    );
    return Promise.resolve({
      cursor: next,
      keys: matching.map((name) => new Uint8Array(Buffer.from(name, 'latin1'))),
      masters: 1,
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
