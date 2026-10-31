import { describe, expect, it } from 'vitest';
import type { RedisOptions } from 'ioredis';
import { redisTarget, tlsOptions } from '../../../../src/drivers/redis/options';
import type { ResolvedRedisConfig } from '../../../../src/drivers/redis-driver';
import type { TlsMaterial } from '../../../../src/drivers/common/tls';

const base: ResolvedRedisConfig = { id: 'r', name: 'r', driver: 'redis', host: ' cache ' };

function options(config: Partial<ResolvedRedisConfig> = {}, tls?: TlsMaterial): RedisOptions {
  const target = redisTarget({ ...base, ...config }, tls);
  if (target.mode === 'cluster') {
    throw new Error('expected one server');
  }
  return target.options;
}

describe('redisTarget', () => {
  it('connects to one server on its default port, without retries or a queue', () => {
    const target = redisTarget(base, undefined);
    expect(target.mode).toBe('standalone');
    expect(options()).toMatchObject({
      host: 'cache',
      port: 6379,
      lazyConnect: true,
      protocol: 2,
      stringNumbers: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      connectTimeout: 10_000,
    });
    expect(options().retryStrategy?.(1)).toBeNull();
    expect(options()).not.toHaveProperty('db');
    expect(options()).not.toHaveProperty('username');
    expect(options()).not.toHaveProperty('password');
  });

  it('signs in with the ACL user and password, and waits as long as the connection says', () => {
    expect(
      options({ port: 7000, user: ' app ', password: 'pw', options: { connectTimeout: 3 } }),
    ).toMatchObject({ port: 7000, username: 'app', password: 'pw', connectTimeout: 3000 });
  });

  it('asks the Sentinels for the master, the first one on port 26379 by default', () => {
    const sentinel = options({
      password: 'master-pw',
      sentinelPassword: 'sentinel-pw',
      redis: {
        mode: 'sentinel',
        masterName: ' mymaster ',
        nodes: [{ host: 's2', port: 26380 }, { host: ' s3 ' }],
        sentinelUser: 'watcher',
      },
    });
    expect(sentinel).toMatchObject({
      sentinels: [
        { host: 'cache', port: 26_379 },
        { host: 's2', port: 26_380 },
        { host: 's3', port: 26_379 },
      ],
      name: 'mymaster',
      role: 'master',
      password: 'master-pw',
      sentinelUsername: 'watcher',
      sentinelPassword: 'sentinel-pw',
    });
    expect(sentinel.sentinelRetryStrategy?.(1)).toBeNull();
    expect(sentinel).not.toHaveProperty('host');
    expect(sentinel).not.toHaveProperty('enableTLSForSentinelMode');
  });

  it('starts a cluster from every listed node, with the server options on each', () => {
    const target = redisTarget(
      { ...base, port: 7001, password: 'pw', redis: { mode: 'cluster', nodes: [{ host: 'n2' }] } },
      undefined,
    );
    if (target.mode !== 'cluster') {
      throw new Error('expected a cluster');
    }
    expect(target.nodes).toEqual([
      { host: 'cache', port: 7001 },
      { host: 'n2', port: 6379 },
    ]);
    expect(target.options).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      enableAutoPipelining: false,
      redisOptions: { password: 'pw', protocol: 2, stringNumbers: true },
    });
    expect(target.options.clusterRetryStrategy?.(1)).toBeNull();
    expect(target.options).not.toHaveProperty('dnsLookup');
  });

  it('uses TLS for the server, the Sentinels and every cluster node alike', () => {
    const tls: TlsMaterial = { mode: 'verify-full', serverName: 'cache.example' };
    expect(options({}, tls).tls).toMatchObject({
      rejectUnauthorized: true,
      servername: 'cache.example',
    });
    const sentinel = options({ redis: { mode: 'sentinel', masterName: 'm' } }, tls);
    expect(sentinel).toMatchObject({ enableTLSForSentinelMode: true });
    expect(sentinel.sentinelTLS).toMatchObject({ servername: 'cache.example' });
    const cluster = redisTarget({ ...base, redis: { mode: 'cluster' } }, tls);
    if (cluster.mode !== 'cluster') {
      throw new Error('expected a cluster');
    }
    expect(cluster.options.redisOptions?.tls).toMatchObject({ servername: 'cache.example' });
    // Node names stay as announced, so certificates for names keep matching.
    const looked: string[] = [];
    cluster.options.dnsLookup?.('node-1.example', (_error, address) => {
      looked.push(address);
    });
    expect(looked).toEqual(['node-1.example']);
  });
});

describe('tlsOptions', () => {
  it('trusts anything in require mode and checks the chain above it', () => {
    expect(tlsOptions({ mode: 'require', serverName: 'h' }).rejectUnauthorized).toBe(false);
    expect(tlsOptions({ mode: 'verify-ca', serverName: 'h' }).rejectUnauthorized).toBe(true);
  });

  it('sends no SNI for an IP address, and passes the certificate files on', () => {
    const ca = Buffer.from('ca');
    const options = tlsOptions({
      mode: 'verify-ca',
      serverName: '127.0.0.1',
      ca,
      cert: ca,
      key: ca,
    });
    expect(options.servername).toBeUndefined();
    expect(options).toMatchObject({ ca, cert: ca, key: ca });
  });
});

describe('redisTarget with a Unix socket (V10.2.5)', () => {
  it('connects one server through the socket instead of host and port', () => {
    const chosen = options({ socket: ' /run/redis/redis.sock ' });
    expect(chosen.path).toBe('/run/redis/redis.sock');
    expect(chosen.host).toBeUndefined();
    expect(chosen.port).toBeUndefined();
  });

  it('uses host and port without one', () => {
    expect(options({ socket: '' })).toMatchObject({ host: 'cache', port: 6379 });
  });
});
