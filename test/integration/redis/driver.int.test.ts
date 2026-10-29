import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/redis';
import type {
  RedisReply,
  RedisSession,
  ResolvedRedisConfig,
} from '../../../src/drivers/redis-driver';
import { replyText } from '../../../src/services/redis/reply';
import { TEST_REDIS } from '../../helpers/redis-servers';

// docker/compose.yml `redis` (V7.1): Redis 7.4 with docker/seed/redis, a Sentinel and a cluster.
function config(overrides: Partial<ResolvedRedisConfig> = {}): ResolvedRedisConfig {
  return {
    id: 'test-redis',
    name: 'redis',
    driver: 'redis',
    host: TEST_REDIS.host,
    port: TEST_REDIS.port,
    user: TEST_REDIS.user.name,
    password: TEST_REDIS.user.password,
    ...overrides,
  };
}

const text = (reply: RedisReply): string => replyText(reply);

async function failure(
  opening: Promise<RedisSession>,
): Promise<{ code?: string; message: string }> {
  const session = await opening.then(
    (opened) => opened,
    () => undefined,
  );
  if (session !== undefined) {
    await session.close();
    throw new Error('The session opened');
  }
  return await opening.then(
    () => ({ message: '' }),
    (error: unknown) => error as { code?: string; message: string },
  );
}

describe('redis driver: one server', () => {
  let session: RedisSession;

  beforeAll(async () => {
    session = await driver.openSession(config());
  });

  afterAll(async () => {
    await session.call(['DEL', 'it:driver:bytes', 'it:driver:list']);
    await session.close();
  });

  it('reports the mode and the database it works in', () => {
    expect(session.mode).toBe('standalone');
    expect(session.database).toBe(0);
  });

  it('returns bulk replies as bytes and status replies too', async () => {
    const value = await session.call(['GET', 'app:name']);
    expect(value).toBeInstanceOf(Uint8Array);
    expect(text(value)).toBe('DataNest');
    expect(text(await session.call(['PING']))).toBe('PONG');
  });

  it('keeps 64-bit integers exact, as text', async () => {
    expect(await session.call(['STRLEN', 'app:name'])).toBe('8');
    const counter = await session.call(['GET', 'app:big-counter']);
    expect(text(counter)).toBe('9007199254740993');
    expect(await session.call(['INCRBY', 'it:driver:big', '9007199254740993'])).toBe(
      '9007199254740993',
    );
    await session.call(['DEL', 'it:driver:big']);
  });

  it('round-trips binary keys and values byte for byte', async () => {
    const bytes = Uint8Array.of(0, 255, 16, 128, 10);
    await session.call(['SET', 'it:driver:bytes', bytes]);
    expect(Buffer.from((await session.call(['GET', 'it:driver:bytes'])) as Uint8Array)).toEqual(
      Buffer.from(bytes),
    );
    const key = Uint8Array.of(0x62, 0x69, 0x6e, 0x3a, 0xff, 0xfe);
    expect(text(await session.call(['GET', key]))).toBe('binary key');
    expect(await session.call(['GET', 'no:such:key'])).toBeNull();
  });

  it('returns nested arrays as they come', async () => {
    const entries = (await session.call([
      'XRANGE',
      'events',
      '-',
      '+',
      'COUNT',
      '1',
    ])) as RedisReply[][];
    expect(text(entries[0]?.[0] ?? null)).toBe('1700000000000-0');
    expect((entries[0]?.[1] as RedisReply[]).map(text)).toEqual(['type', 'click', 'page', '/home']);
  });

  it('maps error replies to DbError codes', async () => {
    await expect(session.call(['NOPE'])).rejects.toMatchObject({
      name: 'DbError',
      code: 'syntax',
      driverCode: 'ERR',
    });
    await expect(session.call(['INCR', 'app:name'])).rejects.toMatchObject({ code: 'constraint' });
    await expect(session.call(['LPUSH', 'app:name', 'x'])).rejects.toMatchObject({
      code: 'constraint',
      driverCode: 'WRONGTYPE',
    });
    // The session goes on after an error reply.
    expect(text(await session.call(['PING']))).toBe('PONG');
  });

  it('runs a pipeline in order and keeps error replies in their place', async () => {
    const replies = await session.pipeline([
      ['RPUSH', 'it:driver:list', 'a', 'b'],
      ['INCR', 'app:name'],
      ['LRANGE', 'it:driver:list', '0', '-1'],
    ]);
    expect(replies[0]).toBe('2');
    expect(replies[1]).toEqual({ error: 'ERR value is not an integer or out of range' });
    expect((replies[2] as RedisReply[]).map(text)).toEqual(['a', 'b']);
    expect(await session.pipeline([])).toEqual([]);
  });

  it('runs a keyless command on its one master', async () => {
    const [size] = await session.onMasters(['DBSIZE']);
    expect(Number(size)).toBeGreaterThan(2000);
  });

  it('opens on the database the connection names', async () => {
    const other = await driver.openSession(config({ database: '1' }));
    try {
      expect(other.database).toBe(1);
      expect(text(await other.call(['GET', 'other:key']))).toBe('in db 1');
    } finally {
      await other.close();
    }
  });

  it('refuses a database the server does not have', async () => {
    const error = await failure(driver.openSession(config({ database: '99' })));
    expect(error).toMatchObject({ code: 'not-found' });
    expect(error.message).toMatch(/Database 99/);
  });

  it('says the link is gone after close', async () => {
    const other = await driver.openSession(config());
    await other.close();
    await expect(other.call(['PING'])).rejects.toMatchObject({ code: 'connection-failed' });
  });
});

describe('redis driver: signing in', () => {
  it('accepts the default user by password alone', async () => {
    const session = await driver.openSession(
      config({ user: undefined, password: TEST_REDIS.defaultPassword }),
    );
    expect(text(await session.call(['ACL', 'WHOAMI']))).toBe('default');
    await session.close();
  });

  it('refuses a wrong password with the server reason', async () => {
    const error = await failure(driver.openSession(config({ password: 'wrong' })));
    expect(error).toMatchObject({ code: 'auth-failed' });
    expect(error.message).toMatch(/WRONGPASS/);
  });

  it('says a password is needed when none is given', async () => {
    const error = await failure(
      driver.openSession(config({ user: undefined, password: undefined })),
    );
    expect(error).toMatchObject({ code: 'auth-failed' });
    expect(error.message).toMatch(/NOAUTH|Authentication required/i);
  });

  it('lets a read-only ACL user read and refuses its writes as permission denied', async () => {
    const session = await driver.openSession(
      config({ user: TEST_REDIS.reader.name, password: TEST_REDIS.reader.password }),
    );
    try {
      expect(text(await session.call(['GET', 'app:name']))).toBe('DataNest');
      await expect(session.call(['SET', 'x', '1'])).rejects.toMatchObject({
        code: 'permission-denied',
        driverCode: 'NOPERM',
      });
    } finally {
      await session.close();
    }
  });

  it('fails fast when nothing listens', async () => {
    const error = await failure(driver.openSession(config({ port: 7998 })));
    expect(error).toMatchObject({ code: 'connection-failed' });
    expect(error.message).toMatch(/ECONNREFUSED/);
  });
});

describe('redis driver: TLS', () => {
  const tls = (overrides: Partial<ResolvedRedisConfig>): ResolvedRedisConfig =>
    config({ port: TEST_REDIS.tlsPort, ...overrides });

  it('encrypts without checking the certificate in require mode', async () => {
    const session = await driver.openSession(tls({ ssl: { mode: 'require' } }));
    expect(text(await session.call(['PING']))).toBe('PONG');
    await session.close();
  });

  it('checks the chain and the name in verify-full mode', async () => {
    const session = await driver.openSession(
      tls({ host: 'localhost', ssl: { mode: 'verify-full', ca: TEST_REDIS.tls.ca } }),
    );
    expect(text(await session.call(['GET', 'app:name']))).toBe('DataNest');
    await session.close();
  });

  it('presents a client certificate when given one', async () => {
    const session = await driver.openSession(
      tls({
        ssl: {
          mode: 'verify-ca',
          ca: TEST_REDIS.tls.ca,
          cert: TEST_REDIS.tls.cert,
          key: TEST_REDIS.tls.key,
        },
      }),
    );
    expect(text(await session.call(['PING']))).toBe('PONG');
    await session.close();
  });

  it('refuses a certificate from another CA with a clear message', async () => {
    const error = await failure(
      driver.openSession(tls({ ssl: { mode: 'verify-ca', ca: TEST_REDIS.tls.otherCa } })),
    );
    expect(error).toMatchObject({ code: 'connection-failed' });
    expect(error.message).toMatch(/not trusted/);
  });

  it('refuses a name the certificate does not cover in verify-full mode', async () => {
    const error = await failure(
      driver.openSession(
        tls({
          ssl: { mode: 'verify-full', ca: TEST_REDIS.tls.ca },
          tlsServerName: 'elsewhere.test',
        }),
      ),
    );
    expect(error.message).toMatch(/not issued for "elsewhere.test"/);
  });
});

describe('redis driver: Sentinel', () => {
  const sentinel = (overrides: Partial<ResolvedRedisConfig> = {}): ResolvedRedisConfig =>
    config({
      port: TEST_REDIS.sentinel.port,
      user: undefined,
      password: TEST_REDIS.sentinel.masterPassword,
      sentinelPassword: TEST_REDIS.sentinel.password,
      redis: { mode: 'sentinel', masterName: TEST_REDIS.sentinel.masterName },
      ...overrides,
    });

  it('finds the master through the Sentinel and talks to it', async () => {
    const session = await driver.openSession(sentinel());
    try {
      expect(session.mode).toBe('sentinel');
      expect(text(await session.call(['GET', 'sentinel:seed']))).toBe('master');
      const role = (await session.call(['ROLE'])) as RedisReply[];
      expect(text(role[0] ?? null)).toBe('master');
    } finally {
      await session.close();
    }
  });

  it('tries the next Sentinel when the first does not answer', async () => {
    const session = await driver.openSession(
      sentinel({
        port: 7998,
        redis: {
          mode: 'sentinel',
          masterName: TEST_REDIS.sentinel.masterName,
          nodes: [{ host: TEST_REDIS.host, port: TEST_REDIS.sentinel.port }],
        },
      }),
    );
    expect(text(await session.call(['PING']))).toBe('PONG');
    await session.close();
  });

  it('fails when the Sentinel wants a password it did not get', async () => {
    const error = await failure(driver.openSession(sentinel({ sentinelPassword: undefined })));
    expect(error.code).toMatch(/auth-failed|connection-failed/);
  });

  it('fails when no Sentinel knows the master name', async () => {
    const error = await failure(
      driver.openSession(sentinel({ redis: { mode: 'sentinel', masterName: 'nobody' } })),
    );
    expect(error).toMatchObject({ code: 'connection-failed' });
  });
});

describe('redis driver: cluster', () => {
  const cluster = (overrides: Partial<ResolvedRedisConfig> = {}): ResolvedRedisConfig =>
    config({
      port: TEST_REDIS.cluster.ports[0],
      user: undefined,
      password: TEST_REDIS.cluster.password,
      redis: { mode: 'cluster' },
      ...overrides,
    });

  let session: RedisSession;

  beforeAll(async () => {
    session = await driver.openSession(cluster());
  });

  afterAll(async () => {
    await session.close();
  });

  it('follows keys to the node that holds them', async () => {
    expect(session.mode).toBe('cluster');
    for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
      expect(text(await session.call(['GET', `cluster:${name}`]))).toBe(name);
    }
  });

  it('pipelines keys of different nodes in one call', async () => {
    const replies = await session.pipeline([
      ['GET', 'cluster:alpha'],
      ['GET', 'cluster:juliet'],
      ['INCR', 'cluster:alpha'],
      ['GET', 'cluster:hotel'],
    ]);
    expect(replies.map((reply) => (reply instanceof Uint8Array ? text(reply) : reply))).toEqual([
      'alpha',
      'juliet',
      { error: 'ERR value is not an integer or out of range' },
      'hotel',
    ]);
  });

  it('asks every master for a keyless command', async () => {
    const sizes = await session.onMasters(['DBSIZE']);
    expect(sizes).toHaveLength(3);
    expect(sizes.reduce((sum, size) => sum + Number(size), 0)).toBe(11);
  });

  it('starts from any node of the list when the first does not answer', async () => {
    const other = await driver.openSession(
      cluster({
        port: 7998,
        redis: { mode: 'cluster', nodes: [{ host: TEST_REDIS.host, port: 7392 }] },
      }),
    );
    expect(text(await other.call(['GET', 'cluster:alpha']))).toBe('alpha');
    await other.close();
  });

  it('fails when no node answers', async () => {
    const error = await failure(driver.openSession(cluster({ port: 7998 })));
    expect(error).toMatchObject({ code: 'connection-failed' });
  });
});
