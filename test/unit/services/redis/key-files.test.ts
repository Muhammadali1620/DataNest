import { describe, expect, it } from 'vitest';
import {
  decodeBytes,
  encodeBytes,
  exportKeys,
  FILE_MARK,
  FILE_VERSION,
  ITEMS_PER_RECORD,
  MAX_REPORTED_PROBLEMS,
  MAX_STRING_BYTES,
  prefixPattern,
  type RestorePolicy,
  restoreKeys,
} from '../../../../src/services/redis/key-files';
import { MemoryRedis } from '../../../helpers/memory-redis';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

class ArraySink {
  readonly pieces: string[] = [];
  write(piece: string): Promise<void> {
    this.pieces.push(piece);
    return Promise.resolve();
  }
  get text(): string {
    return this.pieces.join('');
  }
  get records(): Record<string, unknown>[] {
    return this.text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

async function* chunksOf(content: string, size = content.length || 1) {
  await Promise.resolve();
  for (let start = 0; start < content.length; start += size) {
    yield { text: content.slice(start, start + size) };
  }
}

async function dump(
  source: MemoryRedis,
  options: Parameters<typeof exportKeys>[0] extends infer R ? Partial<R> : never = {},
) {
  const sink = new ArraySink();
  const report = await exportKeys({ session: source, sink, ...options });
  return { sink, report };
}

async function restore(
  target: MemoryRedis,
  content: string,
  policy: RestorePolicy = { kind: 'skip' },
  extra: { size?: number; signal?: { aborted: boolean } } = {},
) {
  return await restoreKeys({
    session: target,
    chunks: chunksOf(content, extra.size),
    policy,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
  });
}

/** A database with one key of every type, a TTL and binary bytes. */
function seeded(): MemoryRedis {
  const redis = new MemoryRedis();
  redis.string('plain', 'héllo "quoted"\nnew line');
  redis.string('with:ttl', 'v', 60_000);
  redis.put(new Uint8Array([0x62, 0xff, 0x00, 0x01]), {
    type: 'string',
    value: new Uint8Array([0xff, 0xfe, 0x00, 0x80]),
  });
  redis.put('user:1', {
    type: 'hash',
    value: new Map([
      ['name', [text('name'), text('Ann')]],
      ['bin', [text('bin'), new Uint8Array([0xc3])]],
    ]),
  });
  redis.put('tags', {
    type: 'set',
    value: new Map([
      ['a', text('a')],
      ['b', text('b')],
    ]),
  });
  redis.put('queue', { type: 'list', value: [text('one'), text('two'), text('one')] });
  redis.put(
    'board',
    {
      type: 'zset',
      value: new Map([
        ['x', { member: text('x'), score: '2.5' }],
        ['y', { member: text('y'), score: '-inf' }],
      ]),
    },
    5_000,
  );
  redis.put('events', {
    type: 'stream',
    value: [
      { id: '1-0', fields: [[text('k'), text('v')]] },
      {
        id: '1-1',
        fields: [
          [text('a'), text('b')],
          [text('c'), text('d')],
        ],
      },
    ],
  });
  return redis;
}

function snapshot(redis: MemoryRedis): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, slot] of redis.keys) {
    const entry = slot.entry;
    const value =
      entry.type === 'hash'
        ? [...entry.value.entries()].map(([k, [f, v]]) => [k, [...f], [...v]])
        : entry.type === 'set'
          ? [...entry.value.keys()].sort()
          : entry.type === 'zset'
            ? [...entry.value.values()]
                .map((item) => [[...item.member], item.score] as const)
                .sort((a, b) => a[1].localeCompare(b[1]))
            : entry.type === 'list'
              ? entry.value.map((item) => [...item])
              : entry.type === 'stream'
                ? entry.value.map((item) => [
                    item.id,
                    item.fields.map(([f, v]) => [[...f], [...v]]),
                  ])
                : Array.isArray(entry.value)
                  ? entry.value
                  : [...entry.value];
    out[name] = {
      type: entry.type,
      value,
      ttl: slot.expires === undefined ? null : slot.expires - redis.now,
    };
  }
  return out;
}

describe('file bytes', () => {
  it('keeps UTF-8 as text and anything else as base64', () => {
    expect(encodeBytes(text('héllo ✓'))).toBe('héllo ✓');
    expect(encodeBytes(new Uint8Array([0xff, 0x00]))).toEqual({ b64: '/wA=' });
    expect(encodeBytes(new Uint8Array())).toBe('');
  });

  it('reads both forms back byte for byte', () => {
    expect([...(decodeBytes('héllo') ?? [])]).toEqual([...text('héllo')]);
    expect([...(decodeBytes({ b64: '/wA=' }) ?? [])]).toEqual([0xff, 0x00]);
    expect([...(decodeBytes({ b64: '' }) ?? [1])]).toEqual([]);
  });

  it('refuses what is neither', () => {
    expect(decodeBytes(5)).toBeUndefined();
    expect(decodeBytes(null)).toBeUndefined();
    expect(decodeBytes([])).toBeUndefined();
    expect(decodeBytes({ b64: 5 })).toBeUndefined();
    expect(decodeBytes({ b64: 'not base64!' })).toBeUndefined();
    expect(decodeBytes({})).toBeUndefined();
  });

  it('makes a glob that matches a prefix literally', () => {
    expect(prefixPattern('')).toBeUndefined();
    expect(prefixPattern('user:')).toBe('user:*');
    expect(prefixPattern('a*b[c]?\\')).toBe('a\\*b\\[c\\]\\?\\\\*');
  });
});

describe('exportKeys', () => {
  it('starts with a header and writes one record per small key', async () => {
    const { sink, report } = await dump(seeded());
    const [header, ...records] = sink.records;
    expect(header).toEqual({ datanest: FILE_MARK, version: FILE_VERSION });
    expect(report).toMatchObject({ keys: 8, cancelled: false, skipped: [] });
    expect(records).toHaveLength(8);
    expect(sink.text.endsWith('\n')).toBe(true);
  });

  it('writes every type in its own shape, with the TTL', async () => {
    const { sink } = await dump(seeded());
    const byKey = new Map(
      sink.records.slice(1).map((record) => [JSON.stringify(record.key), record]),
    );
    expect(byKey.get('"plain"')).toEqual({
      key: 'plain',
      type: 'string',
      ttl: null,
      value: 'héllo "quoted"\nnew line',
    });
    expect(byKey.get('"with:ttl"')).toMatchObject({ ttl: 60_000, value: 'v' });
    expect(byKey.get('"user:1"')).toMatchObject({
      type: 'hash',
      value: [
        ['name', 'Ann'],
        ['bin', { b64: 'ww==' }],
      ],
    });
    expect(byKey.get('"tags"')?.value).toEqual(['a', 'b']);
    expect(byKey.get('"queue"')?.value).toEqual(['one', 'two', 'one']);
    expect(byKey.get('"board"')).toMatchObject({
      ttl: 5_000,
      value: [
        ['y', '-inf'],
        ['x', '2.5'],
      ],
    });
    expect(byKey.get('"events"')?.value).toEqual([
      ['1-0', [['k', 'v']]],
      [
        '1-1',
        [
          ['a', 'b'],
          ['c', 'd'],
        ],
      ],
    ]);
  });

  it('writes a key with binary bytes by their base64', async () => {
    const { sink } = await dump(seeded());
    const binary = sink.records.find((record) => typeof record.key === 'object');
    expect(binary).toMatchObject({ key: { b64: 'Yv8AAQ==' }, value: { b64: '//4AgA==' } });
  });

  it('cuts a big collection into records and marks the later ones', async () => {
    const redis = new MemoryRedis();
    const total = ITEMS_PER_RECORD * 2 + 7;
    redis.put('big', {
      type: 'hash',
      value: new Map(
        Array.from({ length: total }, (_x, n) => [`f${n}`, [text(`f${n}`), text(`v${n}`)]]),
      ),
    });
    redis.put('bigl', {
      type: 'list',
      value: Array.from({ length: total }, (_x, n) => text(`e${n}`)),
    });
    redis.put('bigz', {
      type: 'zset',
      value: new Map(
        Array.from({ length: total }, (_x, n) => [
          `m${n}`,
          { member: text(`m${n}`), score: String(n) },
        ]),
      ),
    });
    redis.put('bigs', {
      type: 'stream',
      value: Array.from({ length: total }, (_x, n) => ({
        id: `${n + 1}-0`,
        fields: [[text('f'), text('v')] as [Uint8Array, Uint8Array]],
      })),
    });
    redis.put('bigset', {
      type: 'set',
      value: new Map(Array.from({ length: total }, (_x, n) => [`s${n}`, text(`s${n}`)])),
    });
    const { sink, report } = await dump(redis);
    expect(report.keys).toBe(5);
    for (const name of ['big', 'bigl', 'bigz', 'bigs', 'bigset']) {
      const parts = sink.records.filter((record) => record.key === name);
      expect(parts).toHaveLength(3);
      expect(parts[0]).toHaveProperty('ttl');
      expect(parts[0]).not.toHaveProperty('append');
      expect(parts[1]).toMatchObject({ append: true });
      expect(parts[1]).not.toHaveProperty('ttl');
      expect(parts.map((part) => (part.value as unknown[]).length)).toEqual([
        ITEMS_PER_RECORD,
        ITEMS_PER_RECORD,
        7,
      ]);
    }
  });

  it('writes a list that fills exactly one record as one record', async () => {
    const redis = new MemoryRedis();
    redis.put('exact', {
      type: 'list',
      value: Array.from({ length: ITEMS_PER_RECORD }, (_x, n) => text(`e${n}`)),
    });
    const { sink } = await dump(redis);
    expect(sink.records.filter((record) => record.key === 'exact')).toHaveLength(1);
  });

  it('sends a type it has no shape for as its DUMP payload', async () => {
    const redis = new MemoryRedis();
    redis.put('doc', { type: 'module', value: text('payload') }, 1_000);
    const { sink } = await dump(redis);
    const record = sink.records[1];
    expect(record).toMatchObject({ key: 'doc', type: 'ReJSON-RL', ttl: 1_000 });
    expect(typeof record?.dump).toBe('string');
  });

  it('walks only the keys under a pattern', async () => {
    const { sink, report } = await dump(seeded(), { match: 'user:*' });
    expect(report.keys).toBe(1);
    expect(sink.records[1]?.key).toBe('user:1');
  });

  it('exports exactly the keys it is given and leaves out the missing ones', async () => {
    const { sink, report } = await dump(seeded(), {
      keys: [text('tags'), text('gone'), text('plain')],
    });
    expect(report.keys).toBe(2);
    expect(sink.records.slice(1).map((record) => record.key)).toEqual(['tags', 'plain']);
  });

  it('writes a key that SCAN returned twice once', async () => {
    const redis = seeded();
    redis.repeats = ['plain', 'tags'];
    const { report, sink } = await dump(redis);
    expect(report.keys).toBe(8);
    expect(sink.records.filter((record) => record.key === 'plain')).toHaveLength(1);
  });

  it('never uses KEYS', async () => {
    const redis = seeded();
    await dump(redis);
    expect(redis.log.some((words) => words[0]?.toUpperCase() === 'KEYS')).toBe(false);
  });

  it('leaves out a string that is too big, and says which', async () => {
    const redis = new MemoryRedis();
    redis.put('huge', { type: 'string', value: new Uint8Array(MAX_STRING_BYTES + 1) });
    redis.string('small', 'x');
    const { report, sink } = await dump(redis);
    expect(report.keys).toBe(1);
    expect(report.skipped).toEqual([
      { key: 'huge', reason: expect.stringContaining('64') as unknown },
    ]);
    expect(sink.records.map((record) => record.key)).toEqual([undefined, 'small']);
    expect(redis.log.some((words) => words[0] === 'GET' && words[1] === 'huge')).toBe(false);
  });

  it('skips a key that expired between the walk and the read', async () => {
    const redis = new MemoryRedis();
    redis.string('a', '1');
    redis.string('b', '2');
    const read = redis.pipeline.bind(redis);
    redis.pipeline = async (commands) => {
      redis.keys.delete('a');
      return await read(commands);
    };
    const { report } = await dump(redis);
    expect(report.keys).toBe(1);
  });

  it('reports progress as keys are written', async () => {
    const seen: number[] = [];
    await dump(seeded(), { onProgress: (keys) => seen.push(keys) });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('stops when cancelled and says so', async () => {
    const signal = { aborted: false };
    const { report } = await dump(seeded(), {
      signal,
      onProgress: (keys) => {
        if (keys === 3) {
          signal.aborted = true;
        }
      },
    });
    expect(report.cancelled).toBe(true);
    expect(report.keys).toBe(3);
  });

  it('is cancelled before anything when the signal is already set', async () => {
    const { report } = await dump(seeded(), { signal: { aborted: true } });
    expect(report).toMatchObject({ keys: 0, cancelled: true });
  });

  it('passes a server error on', async () => {
    const redis = seeded();
    redis.refuse.set('GET', 'ERR boom');
    await expect(dump(redis)).rejects.toThrow('boom');
  });

  it('exports an empty database as just the header', async () => {
    const { sink, report } = await dump(new MemoryRedis());
    expect(sink.records).toHaveLength(1);
    expect(report.keys).toBe(0);
  });
});

describe('restoreKeys', () => {
  it('brings back what was exported, byte for byte, in another database', async () => {
    const source = seeded();
    const { sink } = await dump(source);
    const target = new MemoryRedis();
    const report = await restore(target, sink.text);
    expect(report).toMatchObject({ restored: 8, skipped: 0, failed: 0, cancelled: false });
    expect(snapshot(target)).toEqual(snapshot(source));
  });

  it('brings back collections cut into records', async () => {
    const source = new MemoryRedis();
    const total = ITEMS_PER_RECORD * 2 + 7;
    source.put('big', {
      type: 'hash',
      value: new Map(
        Array.from({ length: total }, (_x, n) => [`f${n}`, [text(`f${n}`), text(`v${n}`)]]),
      ),
    });
    source.put('bigl', {
      type: 'list',
      value: Array.from({ length: total }, (_x, n) => text(`e${n}`)),
    });
    source.put('bigs', {
      type: 'stream',
      value: Array.from({ length: total }, (_x, n) => ({
        id: `${n + 1}-0`,
        fields: [[text('f'), text('v')] as [Uint8Array, Uint8Array]],
      })),
    });
    const target = new MemoryRedis();
    const report = await restore(target, (await dump(source)).sink.text);
    expect(report.restored).toBe(3);
    expect(snapshot(target)).toEqual(snapshot(source));
  });

  it('gives the TTL of the first record to the whole key', async () => {
    const source = new MemoryRedis();
    source.put(
      'l',
      {
        type: 'list',
        value: Array.from({ length: ITEMS_PER_RECORD + 1 }, (_x, n) => text(String(n))),
      },
      9_000,
    );
    const target = new MemoryRedis();
    await restore(target, (await dump(source)).sink.text);
    expect(target.ttlOf('l')).toBe(9_000);
    expect((target.entryOf('l') as { value: unknown[] }).value).toHaveLength(ITEMS_PER_RECORD + 1);
  });

  it('restores a DUMP payload with its TTL', async () => {
    const source = new MemoryRedis();
    source.put('doc', { type: 'module', value: text('payload') }, 1_000);
    const target = new MemoryRedis();
    const report = await restore(target, (await dump(source)).sink.text);
    expect(report.restored).toBe(1);
    expect(snapshot(target)).toEqual(snapshot(source));
  });

  it('reads a file cut anywhere, with CRLF and no final newline', async () => {
    const source = seeded();
    const content = (await dump(source)).sink.text.replaceAll('\n', '\r\n').trimEnd();
    for (const size of [1, 7, 64, 100_000]) {
      const target = new MemoryRedis();
      const report = await restore(target, content, { kind: 'skip' }, { size });
      expect(report.failed).toBe(0);
      expect(snapshot(target)).toEqual(snapshot(source));
    }
  });

  describe('a key that exists', () => {
    const file = async () => {
      const source = new MemoryRedis();
      source.string('a', 'from file');
      source.put('l', {
        type: 'list',
        value: Array.from({ length: ITEMS_PER_RECORD + 3 }, (_x, n) => text(String(n))),
      });
      source.string('b', 'new');
      return (await dump(source)).sink.text;
    };
    const existing = () => {
      const target = new MemoryRedis();
      target.string('a', 'mine');
      target.put('l', { type: 'list', value: [text('keep')] });
      return target;
    };

    it('is left alone by "skip", with the rest of its records', async () => {
      const target = existing();
      const report = await restore(target, await file(), { kind: 'skip' });
      expect(report).toMatchObject({ restored: 1, skipped: 2, failed: 0 });
      expect((target.entryOf('a') as { value: Uint8Array }).value).toEqual(text('mine'));
      expect((target.entryOf('l') as { value: unknown[] }).value).toHaveLength(1);
      expect(target.entryOf('b')).toBeDefined();
    });

    it('is replaced by "overwrite", whole', async () => {
      const target = existing();
      const report = await restore(target, await file(), { kind: 'overwrite' });
      expect(report).toMatchObject({ restored: 3, skipped: 0, failed: 0 });
      expect((target.entryOf('a') as { value: Uint8Array }).value).toEqual(text('from file'));
      expect((target.entryOf('l') as { value: unknown[] }).value).toHaveLength(
        ITEMS_PER_RECORD + 3,
      );
    });

    it('is not touched by "prefix", which restores everything beside it', async () => {
      const target = existing();
      const report = await restore(target, await file(), { kind: 'prefix', prefix: 'old:' });
      expect(report).toMatchObject({ restored: 3, skipped: 0 });
      expect([...target.keys.keys()].sort()).toEqual(['a', 'l', 'old:a', 'old:b', 'old:l']);
      expect((target.entryOf('l') as { value: unknown[] }).value).toHaveLength(1);
      expect((target.entryOf('old:l') as { value: unknown[] }).value).toHaveLength(
        ITEMS_PER_RECORD + 3,
      );
    });

    it('is skipped under a prefix too, when the prefixed key exists', async () => {
      const target = existing();
      target.string('old:a', 'there');
      const report = await restore(target, await file(), { kind: 'prefix', prefix: 'old:' });
      expect(report.skipped).toBe(1);
      expect((target.entryOf('old:a') as { value: Uint8Array }).value).toEqual(text('there'));
    });

    it('puts a prefix before binary key bytes as well', async () => {
      const source = new MemoryRedis();
      source.put(new Uint8Array([0xff, 0x01]), { type: 'string', value: text('x') });
      const target = new MemoryRedis();
      await restore(target, (await dump(source)).sink.text, { kind: 'prefix', prefix: 'p:' });
      expect([...target.keys.keys()][0]).toBe(
        Buffer.from([0x70, 0x3a, 0xff, 0x01]).toString('latin1'),
      );
    });
  });

  describe('a file with problems', () => {
    const record = (extra: Record<string, unknown>) =>
      JSON.stringify({ key: 'k', type: 'string', ttl: null, value: 'v', ...extra });

    it('reports a line that is not JSON, with its number, and goes on', async () => {
      const target = new MemoryRedis();
      const report = await restore(
        target,
        `${record({ key: 'a' })}\nnot json\n${record({ key: 'b' })}\n`,
      );
      expect(report).toMatchObject({ restored: 2, failed: 1 });
      expect(report.problems).toEqual([{ line: 2, message: expect.any(String) as unknown }]);
    });

    it('reports a line that is JSON but not an object', async () => {
      const report = await restore(new MemoryRedis(), '[1]\n"x"\n5\n');
      expect(report.failed).toBe(3);
      expect(report.problems.map((problem) => problem.line)).toEqual([1, 2, 3]);
    });

    it.each([
      ['no type', { type: undefined }],
      ['no key', { key: undefined }],
      ['a key that is not bytes', { key: 5 }],
      ['a value that is not bytes', { value: 5 }],
      ['a bad base64 value', { value: { b64: '***' } }],
      ['an unknown type without a payload', { type: 'mystery', value: [] }],
      ['a hash that is not a list', { type: 'hash', value: 'x' }],
      ['a hash pair of three', { type: 'hash', value: [['a', 'b', 'c']] }],
      ['a zset score that is not text', { type: 'zset', value: [['m', 5]] }],
      ['a stream id that is not text', { type: 'stream', value: [[1, []]] }],
    ])('refuses %s', async (_name, extra) => {
      const target = new MemoryRedis();
      const report = await restore(target, `${record(extra)}\n`);
      expect(report).toMatchObject({ restored: 0, failed: 1 });
      expect(report.problems[0]?.line).toBe(1);
      expect(target.keys.size).toBe(0);
    });

    it('counts a key the server refuses and goes on', async () => {
      const target = new MemoryRedis();
      target.refuse.set('HSET', 'ERR no hashes today');
      const hash = JSON.stringify({ key: 'h', type: 'hash', ttl: null, value: [['f', 'v']] });
      const report = await restore(target, `${hash}\n${record({ key: 'ok' })}\n`);
      expect(report).toMatchObject({ restored: 1, failed: 1 });
      expect(report.problems[0]).toEqual({ line: 1, message: 'ERR no hashes today' });
    });

    it('refuses a header of another file or version', async () => {
      for (const header of [
        { datanest: 'other', version: 1 },
        { datanest: FILE_MARK, version: 99 },
      ]) {
        const report = await restore(new MemoryRedis(), `${JSON.stringify(header)}\n`);
        expect(report.failed).toBe(1);
      }
    });

    it('takes a file without a header', async () => {
      const target = new MemoryRedis();
      const report = await restore(target, `${record({})}\n`);
      expect(report.restored).toBe(1);
    });

    it('reports a continuation without its key', async () => {
      const lone = JSON.stringify({ key: 'x', type: 'list', append: true, value: ['a'] });
      const report = await restore(new MemoryRedis(), `${lone}\n`);
      expect(report).toMatchObject({ restored: 0, failed: 1 });
    });

    it('reports a continuation that belongs to another key', async () => {
      const first = JSON.stringify({ key: 'a', type: 'list', ttl: null, value: ['1'] });
      const other = JSON.stringify({ key: 'b', type: 'list', append: true, value: ['2'] });
      const report = await restore(new MemoryRedis(), `${first}\n${other}\n`);
      expect(report).toMatchObject({ restored: 1, failed: 1 });
    });

    it('lists no more problems than the cap, but counts them all', async () => {
      const lines = Array.from({ length: MAX_REPORTED_PROBLEMS + 20 }, () => 'nope').join('\n');
      const report = await restore(new MemoryRedis(), lines);
      expect(report.failed).toBe(MAX_REPORTED_PROBLEMS + 20);
      expect(report.problems).toHaveLength(MAX_REPORTED_PROBLEMS);
    });

    it('ignores blank lines', async () => {
      const report = await restore(new MemoryRedis(), `\n\n${record({})}\n   \n`);
      expect(report).toMatchObject({ restored: 1, failed: 0 });
    });

    it('takes an empty file', async () => {
      expect(await restore(new MemoryRedis(), '')).toMatchObject({
        restored: 0,
        failed: 0,
        cancelled: false,
      });
    });
  });

  it('writes an empty collection record as nothing and still counts the key', async () => {
    const target = new MemoryRedis();
    const report = await restore(
      target,
      `${JSON.stringify({ key: 'e', type: 'list', ttl: null, value: [] })}\n`,
    );
    expect(report).toMatchObject({ restored: 1, failed: 0 });
  });

  it('writes a TTL that is not a positive number as none', async () => {
    const target = new MemoryRedis();
    const lines = [0, -1, 'soon', null].map((ttl, n) =>
      JSON.stringify({ key: `k${n}`, type: 'string', ttl, value: 'v' }),
    );
    await restore(target, `${lines.join('\n')}\n`);
    expect([...target.keys.values()].every((slot) => slot.expires === undefined)).toBe(true);
  });

  it('reports progress and stops when cancelled', async () => {
    const source = seeded();
    const content = (await dump(source)).sink.text;
    const signal = { aborted: false };
    const target = new MemoryRedis();
    const seen: number[] = [];
    const report = await restoreKeys({
      session: target,
      chunks: chunksOf(content),
      policy: { kind: 'skip' },
      signal,
      onProgress: (keys) => {
        seen.push(keys);
        if (keys === 2) {
          signal.aborted = true;
        }
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(report).toMatchObject({ restored: 2, cancelled: true });
  });

  it('is cancelled before the first piece when the signal is set', async () => {
    const target = new MemoryRedis();
    const report = await restore(target, 'x', { kind: 'skip' }, { signal: { aborted: true } });
    expect(report.cancelled).toBe(true);
    expect(target.keys.size).toBe(0);
  });

  it('passes a lost connection on', async () => {
    const target = new MemoryRedis();
    target.call = () => Promise.reject(new Error('link lost'));
    const file = `${JSON.stringify({ key: 'k', type: 'string', ttl: null, value: 'v' })}\n`;
    await expect(restore(target, file)).rejects.toThrow('link lost');
  });
});
