import { describe, expect, it } from 'vitest';
import { parseInfo, readServerInfo, summarize } from '../../../../src/services/redis/server-info';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

const INFO = [
  '# Server',
  'redis_version:7.4.6',
  'redis_mode:standalone',
  'uptime_in_seconds:3700',
  '',
  '# Clients',
  'connected_clients:3',
  '# Memory',
  'used_memory:2048',
  'used_memory_peak:4096',
  'maxmemory:0',
  '# Stats',
  'instantaneous_ops_per_sec:12',
  'keyspace_hits:3',
  'keyspace_misses:1',
  '# Replication',
  'role:master',
  '# Keyspace',
  'db0:keys=10,expires=1,avg_ttl=0',
  'db2:keys=5,expires=0,avg_ttl=0',
].join('\r\n');

describe('parseInfo', () => {
  it('splits sections and fields, keeping colons in values', () => {
    const sections = parseInfo('# Server\nexecutable:/usr/bin/redis:x\nbroken line\n# Empty\n');
    expect(sections).toEqual([
      { name: 'Server', fields: [['executable', '/usr/bin/redis:x']] },
      { name: 'Empty', fields: [] },
    ]);
  });

  it('keeps fields before the first header', () => {
    expect(parseInfo('a:1')).toEqual([{ name: '', fields: [['a', '1']] }]);
    expect(parseInfo('')).toEqual([]);
  });
});

describe('summarize', () => {
  it('picks the numbers people look at first', () => {
    expect(summarize(parseInfo(INFO))).toEqual({
      version: '7.4.6',
      mode: 'standalone',
      role: 'master',
      uptimeSeconds: 3700,
      clients: 3,
      usedMemory: 2048,
      peakMemory: 4096,
      maxMemory: 0,
      opsPerSecond: 12,
      hitRate: 0.75,
      keys: 15,
    });
  });

  it('leaves out what is missing, with no hit rate before any lookup', () => {
    expect(
      summarize(parseInfo('# Stats\nkeyspace_hits:0\nkeyspace_misses:0\nvalkey_version:8.0')),
    ).toEqual({
      version: '8.0',
      keys: 0,
    });
  });
});

describe('readServerInfo', () => {
  it('reads every master and names each', async () => {
    const session = new FakeRedisSession();
    session.masters = () => [bulk(INFO), bulk('# Server\nredis_version:7.4.6')];
    const nodes = await readServerInfo(session, (index, count) => `node ${index + 1}/${count}`);
    expect(nodes.map((node) => node.name)).toEqual(['node 1/2', 'node 2/2']);
    expect(nodes[0]?.summary.keys).toBe(15);
    expect(session.calls).toEqual([['INFO']]);
  });
});
