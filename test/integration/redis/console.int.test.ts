import { afterEach, describe, expect, it, vi } from 'vitest';
import { driver } from '../../../src/drivers/redis';
import type { RedisSession, ResolvedRedisConfig } from '../../../src/drivers/redis-driver';
import { loadCommandDocs } from '../../../src/services/redis/command-docs';
import { RedisConsole } from '../../../src/services/redis/console';
import { readServerInfo } from '../../../src/services/redis/server-info';
import type { SafeMode } from '../../../src/services/safe-mode';
import { TEST_REDIS } from '../../helpers/redis-servers';

// docker/compose.yml `redis` (V7.4): the console and INFO against real servers.
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

function consoleOn(
  session: RedisSession,
  options: { readOnly?: boolean; production?: boolean; safeMode?: SafeMode } = {},
) {
  const onDatabase = vi.fn();
  const console = new RedisConsole({
    session: () => Promise.resolve(session),
    policy: {
      name: 'it',
      readOnly: options.readOnly ?? false,
      production: options.production ?? false,
    },
    safeMode: () => options.safeMode ?? 'off',
    confirm: () => Promise.resolve(false),
    onDatabase,
  });
  return { console, onDatabase };
}

describe('Redis console (V7.4)', () => {
  it('knows every command the server documents, with syntax and subcommands', async () => {
    const docs = await loadCommandDocs(await open());
    const byName = new Map(docs.map((doc) => [doc.name, doc]));
    expect(docs.length).toBeGreaterThan(200);
    expect(byName.get('SET')).toMatchObject({ keyFirst: true, group: 'string' });
    expect(byName.get('SET')?.syntax).toMatch(/^key value \[NX \| XX\]/);
    expect(byName.get('CONFIG GET')?.syntax).toBe('parameter [parameter ...]');
    expect(byName.get('PING')?.keyFirst).toBe(false);
  });

  it('runs commands and prints replies as redis-cli does', async () => {
    const { console } = consoleOn(await open());
    expect((await console.run('PING'))?.lines).toEqual(['"PONG"']);
    expect((await console.run('HGETALL user:1'))?.lines).toEqual([
      '1) "name"',
      '2) "Alice"',
      '3) "email"',
      '4) "alice@example.com"',
      '5) "age"',
      '6) "30"',
    ]);
    expect((await console.run('GET "key with spaces"'))?.lines).toEqual(['"spaces"']);
    expect((await console.run('GET "bin:\\xff\\xfe"'))?.lines).toEqual(['"binary key"']);
    expect((await console.run('GET app:binary'))?.lines).toEqual(['"\\x00\\xff\\x10\\x80"']);
    expect((await console.run('STRLEN app:name'))?.lines).toEqual(['(integer) 8']);
    expect((await console.run('GET nope'))?.lines).toEqual(['(nil)']);
    expect(await console.run('INCR app:name')).toMatchObject({
      error: true,
      lines: ['(error) ERR value is not an integer or out of range'],
    });
  });

  it('follows SELECT', async () => {
    const { console, onDatabase } = consoleOn(await open());
    await console.run('SELECT 1');
    expect(onDatabase).toHaveBeenCalledWith(1);
    expect((await console.run('GET other:key'))?.lines).toEqual(['"in db 1"']);
  });

  it('keeps a read-only connection to reads, by the server flags', async () => {
    const { console } = consoleOn(await open(), { readOnly: true });
    expect((await console.run('GET app:name'))?.error).toBe(false);
    expect((await console.run('INFO server'))?.error).toBe(false);
    expect((await console.run('CONFIG GET maxmemory'))?.error).toBe(true);
    for (const line of [
      'SET it:console:x 1',
      'CONFIG SET maxmemory 0',
      'FLUSHDB',
      'EVAL "return 1" 0',
    ]) {
      expect((await console.run(line))?.lines[0], line).toMatch(/read-only/);
    }
  });

  it('asks before dangerous commands and runs nothing when declined', async () => {
    const session = await open();
    const { console } = consoleOn(session, { safeMode: 'confirm' });
    expect((await console.run('FLUSHDB'))?.lines).toEqual(['(refused) Not run']);
    expect((await console.run('DBSIZE'))?.lines[0]).not.toBe('(integer) 0');
    const blocked = consoleOn(session, { safeMode: 'block' }).console;
    expect((await blocked.run('KEYS *'))?.lines[0]).toMatch(/Safe mode blocks/);
  });

  it('completes key names', async () => {
    const { console } = consoleOn(await open());
    expect(await console.completeKeys('user:')).toEqual(['user:1', 'user:2', 'user:3', 'user:имя']);
    expect(await console.completeKeys('key with')).toEqual(['key with spaces']);
  });
});

describe('Redis server info (V7.4)', () => {
  it('reads INFO of one server', async () => {
    const [node] = await readServerInfo(await open(), () => 'server');
    expect(node?.summary).toMatchObject({ version: '7.4.6', mode: 'standalone', role: 'master' });
    expect(node?.summary.keys).toBeGreaterThan(2000);
    expect(node?.sections.map((section) => section.name)).toContain('Memory');
  });

  it('reads every master of a cluster', async () => {
    const cluster = await open({
      port: TEST_REDIS.cluster.ports[0],
      user: undefined,
      password: TEST_REDIS.cluster.password,
      redis: { mode: 'cluster' },
    });
    const nodes = await readServerInfo(cluster, (index) => `master ${index + 1}`);
    expect(nodes.map((node) => node.name)).toEqual(['master 1', 'master 2', 'master 3']);
    expect(nodes.every((node) => node.summary.mode === 'cluster')).toBe(true);
    expect(nodes.reduce((sum, node) => sum + node.summary.keys, 0)).toBe(11);
  });
});
