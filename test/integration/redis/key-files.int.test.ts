import { afterEach, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/redis';
import type { RedisSession, ResolvedRedisConfig } from '../../../src/drivers/redis-driver';
import {
  exportKeys,
  ITEMS_PER_RECORD,
  prefixPattern,
  restoreKeys,
} from '../../../src/services/redis/key-files';
import { replyItems, replyNumber, replyText } from '../../../src/services/redis/reply';
import { TEST_REDIS } from '../../helpers/redis-servers';

// docker/compose.yml `redis` (V13.9): the keys of a real server written to a file and read
// back, on a standalone server and on a cluster, under a prefix of their own.
const opened: RedisSession[] = [];

async function open(overrides: Partial<ResolvedRedisConfig> = {}): Promise<RedisSession> {
  const session = await driver.openSession({
    id: 'it',
    name: 'it',
    driver: 'redis',
    host: TEST_REDIS.host,
    port: TEST_REDIS.port,
    user: TEST_REDIS.user.name,
    password: TEST_REDIS.user.password,
    ...overrides,
  });
  opened.push(session);
  return session;
}

const cluster = (): Promise<RedisSession> =>
  open({
    port: TEST_REDIS.cluster.ports[0],
    user: undefined,
    password: TEST_REDIS.cluster.password,
    redis: { mode: 'cluster' },
  });

afterEach(async () => {
  for (const session of opened.splice(0)) {
    await session.close();
  }
});

class ArraySink {
  readonly pieces: string[] = [];
  write(piece: string): Promise<void> {
    this.pieces.push(piece);
    return Promise.resolve();
  }
}

async function* chunks(pieces: readonly string[]) {
  await Promise.resolve();
  for (const piece of pieces) {
    yield { text: piece };
  }
}

/** The value of a key in a form that compares: the type and its content. */
async function contentOf(session: RedisSession, key: string): Promise<unknown> {
  const type = replyText(await session.call(['TYPE', key]));
  const hex = (reply: unknown): string => Buffer.from(reply as Uint8Array).toString('hex');
  switch (type) {
    case 'string':
      return [type, hex(await session.call(['GET', key]))];
    case 'hash': {
      const flat = replyItems(await session.call(['HGETALL', key])).map(hex);
      const pairs: string[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        pairs.push(`${flat[i]}=${flat[i + 1]}`);
      }
      return [type, pairs.sort()];
    }
    case 'list':
      return [type, replyItems(await session.call(['LRANGE', key, '0', '-1'])).map(hex)];
    case 'set':
      return [
        type,
        replyItems(await session.call(['SMEMBERS', key]))
          .map(hex)
          .sort(),
      ];
    case 'zset':
      return [
        type,
        replyItems(await session.call(['ZRANGE', key, '0', '-1', 'WITHSCORES'])).map(hex),
      ];
    case 'stream':
      return [
        type,
        replyText(await session.call(['XLEN', key])),
        JSON.stringify(
          replyItems(await session.call(['XRANGE', key, '-', '+'])).map((entry) =>
            replyItems(entry).map((part) => (Array.isArray(part) ? part.map(hex) : hex(part))),
          ),
        ),
      ];
    default:
      return [type];
  }
}

async function seed(session: RedisSession, prefix: string): Promise<string[]> {
  const k = (name: string): string => `${prefix}${name}`;
  const big = Array.from({ length: ITEMS_PER_RECORD * 2 + 11 }, (_x, n) => [
    `f${n}`,
    `v${n}`,
  ]).flat();
  await session.call(['SET', k('str'), 'héllo\nworld "quoted"']);
  await session.call(['SET', k('bin'), new Uint8Array([0xff, 0xfe, 0x00, 0x80])]);
  await session.call([
    'SET',
    new Uint8Array([...new TextEncoder().encode(k('bk:')), 0xff, 0x01]),
    'binary key',
  ]);
  await session.call(['SET', k('ttl'), 'soon', 'PX', '600000']);
  await session.call(['HSET', k('hash'), 'a', '1', 'b', '2']);
  await session.call(['HSET', k('bighash'), ...big]);
  await session.call(['RPUSH', k('list'), 'one', 'two', 'one']);
  await session.call(['RPUSH', k('biglist'), ...big]);
  await session.call(['SADD', k('set'), 'x', 'y', 'z']);
  await session.call(['ZADD', k('zset'), '1.5', 'a', '-3', 'b', '2', 'c']);
  await session.call(['XADD', k('stream'), '1-1', 'f', 'v']);
  await session.call(['XADD', k('stream'), '1-2', 'g', 'w', 'h', 'x']);
  return ['str', 'bin', 'ttl', 'hash', 'bighash', 'list', 'biglist', 'set', 'zset', 'stream'].map(
    k,
  );
}

async function clear(session: RedisSession, prefix: string): Promise<void> {
  const found: Uint8Array[] = [];
  for (let master = 0, cursor = '0'; ;) {
    const step = await session.scanStep(master, cursor, {
      match: prefixPattern(prefix),
      count: 1000,
    });
    found.push(...step.keys);
    if (step.cursor === '0') {
      master += 1;
      cursor = '0';
      if (master >= step.masters) {
        break;
      }
    } else {
      cursor = step.cursor;
    }
  }
  for (const key of found) {
    await session.call(['DEL', key]);
  }
}

async function roundTrip(session: RedisSession, prefix: string): Promise<void> {
  const names = await seed(session, prefix);
  const before = new Map<string, unknown>();
  for (const name of names) {
    before.set(name, await contentOf(session, name));
  }
  const sink = new ArraySink();
  const report = await exportKeys({ session, match: prefixPattern(prefix), sink });
  expect(report).toMatchObject({ keys: names.length + 1, cancelled: false, skipped: [] });
  await clear(session, prefix);
  expect(replyNumber(await session.call(['EXISTS', names[0] ?? '']))).toBe(0);

  const restored = await restoreKeys({
    session,
    // Cut in odd places, as a file is read from disk.
    chunks: chunks(sink.pieces.join('').match(/[\s\S]{1,777}/gu) ?? []),
    policy: { kind: 'skip' },
  });
  expect(restored).toMatchObject({ restored: names.length + 1, failed: 0, skipped: 0 });
  for (const name of names) {
    expect(await contentOf(session, name), name).toEqual(before.get(name));
  }
  // The binary key came back byte for byte.
  const binaryKey = new Uint8Array([...new TextEncoder().encode(`${prefix}bk:`), 0xff, 0x01]);
  expect(Buffer.from((await session.call(['GET', binaryKey])) as Uint8Array).toString()).toBe(
    'binary key',
  );
  // A TTL comes back, a little shorter.
  const ttl = replyNumber(await session.call(['PTTL', `${prefix}ttl`])) ?? 0;
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(600_000);
  expect(replyNumber(await session.call(['PTTL', `${prefix}str`]))).toBe(-1);
  await clear(session, prefix);
}

describe('Redis key files (V13.9)', () => {
  it('gives back every type, binary bytes and TTLs on a standalone server', async () => {
    await roundTrip(await open(), 'v139:solo:');
  });

  it('gives them back on a cluster too', async () => {
    await roundTrip(await cluster(), 'v139:cluster:');
  });

  it('leaves a key that exists alone, overwrites it, or restores beside it', async () => {
    const session = await open();
    const prefix = 'v139:policy:';
    await session.call(['SET', `${prefix}a`, 'from server']);
    await session.call(['RPUSH', `${prefix}l`, '1', '2', '3']);
    const sink = new ArraySink();
    await exportKeys({ session, match: prefixPattern(prefix), sink });
    await session.call(['SET', `${prefix}a`, 'changed']);
    await session.call(['DEL', `${prefix}l`]);
    await session.call(['RPUSH', `${prefix}l`, 'other']);
    const file = sink.pieces.join('');

    const skip = await restoreKeys({ session, chunks: chunks([file]), policy: { kind: 'skip' } });
    expect(skip).toMatchObject({ restored: 0, skipped: 2 });
    expect(replyText(await session.call(['GET', `${prefix}a`]))).toBe('changed');

    const prefixed = await restoreKeys({
      session,
      chunks: chunks([file]),
      policy: { kind: 'prefix', prefix: 'v139:copy:' },
    });
    expect(prefixed.restored).toBe(2);
    expect(replyText(await session.call(['GET', `v139:copy:${prefix}a`]))).toBe('from server');

    const overwrite = await restoreKeys({
      session,
      chunks: chunks([file]),
      policy: { kind: 'overwrite' },
    });
    expect(overwrite.restored).toBe(2);
    expect(replyText(await session.call(['GET', `${prefix}a`]))).toBe('from server');
    expect(
      replyItems(await session.call(['LRANGE', `${prefix}l`, '0', '-1'])).map(replyText),
    ).toEqual(['1', '2', '3']);
    await clear(session, 'v139:');
  });

  it('restores a DUMP payload on the server that made it', async () => {
    const session = await open();
    const key = 'v139:dump:hash';
    await session.call(['HSET', key, 'f', 'v']);
    const payload = (await session.call(['DUMP', key])) as Uint8Array;
    await session.call(['DEL', key]);
    const file = `${JSON.stringify({ key, type: 'hash', ttl: 60_000, dump: Buffer.from(payload).toString('base64') })}\n`;
    const report = await restoreKeys({ session, chunks: chunks([file]), policy: { kind: 'skip' } });
    expect(report).toMatchObject({ restored: 1, failed: 0 });
    expect(replyItems(await session.call(['HGETALL', key])).map(replyText)).toEqual(['f', 'v']);
    expect(replyNumber(await session.call(['PTTL', key]))).toBeGreaterThan(0);
    await clear(session, 'v139:');
  });

  it('reports a record the server refuses and goes on', async () => {
    const session = await open();
    const bad = JSON.stringify({
      key: 'v139:bad:z',
      type: 'zset',
      ttl: null,
      value: [['m', 'not-a-number']],
    });
    const good = JSON.stringify({ key: 'v139:bad:s', type: 'string', ttl: null, value: 'ok' });
    const report = await restoreKeys({
      session,
      chunks: chunks([`${bad}\n${good}\n`]),
      policy: { kind: 'skip' },
    });
    expect(report).toMatchObject({ restored: 1, failed: 1 });
    expect(report.problems[0]?.line).toBe(1);
    expect(report.problems[0]?.message).toMatch(/float|ERR/i);
    await clear(session, 'v139:');
  });

  it('exports exactly the keys it is given', async () => {
    const session = await open();
    await session.call(['SET', 'v139:one:a', '1']);
    await session.call(['SET', 'v139:one:b', '2']);
    const sink = new ArraySink();
    const report = await exportKeys({
      session,
      keys: [new TextEncoder().encode('v139:one:b'), new TextEncoder().encode('v139:one:none')],
      sink,
    });
    expect(report.keys).toBe(1);
    expect(sink.pieces.join('')).toContain('v139:one:b');
    expect(sink.pieces.join('')).not.toContain('v139:one:a');
    await clear(session, 'v139:');
  });
});
