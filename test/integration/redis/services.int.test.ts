import { afterEach, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/redis';
import type { RedisSession, ResolvedRedisConfig } from '../../../src/drivers/redis-driver';
import { listRedisDatabases } from '../../../src/services/redis/redis-databases';
import { setUpRedisSession } from '../../../src/services/redis/redis-setup';
import { replyText } from '../../../src/services/redis/reply';
import { TEST_REDIS } from '../../helpers/redis-servers';

// docker/compose.yml `redis` (V7.1): what the tree and session setup read from real servers.
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

afterEach(async () => {
  for (const session of opened.splice(0)) {
    await session.close();
  }
});

describe('Redis databases (V7.1)', () => {
  it('lists the 16 databases of the server with the seeded key counts', async () => {
    const databases = await listRedisDatabases(await open(), 0);
    expect(databases.map((database) => database.index)).toEqual([...Array(16).keys()]);
    expect(databases[0]?.keys).toBeGreaterThan(2000);
    expect(databases[0]?.expires).toBeGreaterThanOrEqual(1);
    expect(databases[1]?.keys).toBe(2);
    expect(databases[2]?.keys).toBe(0);
    expect(databases[15]?.keys).toBe(1);
  });

  it('still lists them for a user that may not read the configuration', async () => {
    const reader = await open({
      user: TEST_REDIS.reader.name,
      password: TEST_REDIS.reader.password,
    });
    const databases = await listRedisDatabases(reader, 0);
    expect(databases).toHaveLength(16);
    expect(databases[1]?.keys).toBe(2);
  });

  it('adds up the keys of every master of a cluster as database 0', async () => {
    const cluster = await open({
      port: TEST_REDIS.cluster.ports[0],
      user: undefined,
      password: TEST_REDIS.cluster.password,
      redis: { mode: 'cluster' },
    });
    expect(await listRedisDatabases(cluster, 0)).toEqual([{ index: 0, keys: 11, expires: 0 }]);
  });
});

describe('Redis init commands (V7.1)', () => {
  it('runs them on the session', async () => {
    const session = await open();
    await setUpRedisSession(session, { options: { initSql: 'CLIENT SETNAME datanest-it' } });
    expect(replyText(await session.call(['CLIENT', 'GETNAME']))).toBe('datanest-it');
  });

  it('lets a read-only connection name itself and ping, by the server flags', async () => {
    const session = await open();
    await setUpRedisSession(session, {
      readOnly: true,
      options: { initSql: 'CLIENT SETNAME ro-it\nPING\nGET app:name' },
    });
    expect(replyText(await session.call(['CLIENT', 'GETNAME']))).toBe('ro-it');
  });

  it('refuses writes and server settings on a read-only connection before running them', async () => {
    for (const line of [
      'SET it:ro:x 1',
      'CONFIG SET maxmemory 0',
      'FLUSHDB',
      'EVAL "return 1" 0',
    ]) {
      const session = await open();
      await expect(
        setUpRedisSession(session, { readOnly: true, options: { initSql: line } }),
        line,
      ).rejects.toMatchObject({ code: 'permission-denied' });
    }
    expect(replyText(await (await open()).call(['EXISTS', 'it:ro:x']))).toBe('0');
  });

  it('names the command the server refused', async () => {
    const reader = await open({
      user: TEST_REDIS.reader.name,
      password: TEST_REDIS.reader.password,
    });
    await expect(
      setUpRedisSession(reader, { options: { initSql: 'SET it:x 1' } }),
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('Init command "SET it:x 1" failed: NOPERM') as unknown,
    });
  });
});
