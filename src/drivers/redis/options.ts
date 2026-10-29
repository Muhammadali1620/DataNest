// How a Redis connection becomes ioredis options (V7.1): one server, the master a
// group of Sentinels names, or a cluster. Every mode gives up instead of reconnecting
// on its own: a lost link is the manager's to handle (D26), and a command is never
// sent twice behind the user's back.

import type { ClusterNode, ClusterOptions, RedisOptions } from 'ioredis';
import type { ConnectionOptions as TlsOptions } from 'node:tls';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_PORTS,
  DEFAULT_SENTINEL_PORT,
  effectivePort,
  redisModeOf,
  type RedisNodeAddress,
} from '../../shared/connection';
import { identityCheck, sniName, type TlsMaterial } from '../common/tls';
import type { ResolvedRedisConfig } from '../redis-driver';

/** Seconds of quiet before the OS checks that the TCP link is alive. */
const TCP_KEEP_ALIVE_MS = 30_000;

export type RedisTarget =
  | { readonly mode: 'standalone' | 'sentinel'; readonly options: RedisOptions }
  | {
      readonly mode: 'cluster';
      readonly nodes: ClusterNode[];
      readonly options: ClusterOptions;
    };

/** TLS as the connection asks for it, checked against the server's real name. */
export function tlsOptions(tls: TlsMaterial): TlsOptions {
  const servername = sniName(tls.serverName);
  return {
    ...(tls.ca === undefined ? {} : { ca: tls.ca }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    rejectUnauthorized: tls.mode !== 'require',
    ...(servername === undefined ? {} : { servername }),
    checkServerIdentity: identityCheck(tls),
  };
}

/** Options every connection shares: RESP2, exact integers, no retries, no queue. */
function baseOptions(config: ResolvedRedisConfig, tls: TlsMaterial | undefined): RedisOptions {
  const user = config.user?.trim();
  return {
    lazyConnect: true,
    // RESP3 needs HELLO 3, which proxies and older servers refuse; RESP2 works everywhere.
    protocol: 2,
    // 64-bit integers arrive as text instead of a rounded double.
    stringNumbers: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    reconnectOnError: () => false,
    autoResubscribe: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout: (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000,
    keepAlive: TCP_KEEP_ALIVE_MS,
    ...(user === undefined || user === '' ? {} : { username: user }),
    ...(config.password === undefined || config.password === ''
      ? {}
      : { password: config.password }),
    ...(tls === undefined ? {} : { tls: tlsOptions(tls) }),
  };
}

function address(node: RedisNodeAddress, defaultPort: number): { host: string; port: number } {
  return { host: node.host.trim(), port: node.port ?? defaultPort };
}

/** The ioredis setup of a connection; the database is selected after connecting. */
export function redisTarget(
  config: ResolvedRedisConfig,
  tls: TlsMaterial | undefined,
): RedisTarget {
  const base = baseOptions(config, tls);
  const host = config.host?.trim() ?? 'localhost';
  const mode = redisModeOf(config);
  const extra = config.redis?.nodes ?? [];
  switch (mode) {
    case 'standalone':
      return {
        mode,
        options: { ...base, host, port: effectivePort(config) ?? DEFAULT_PORTS.redis },
      };
    case 'sentinel': {
      const sentinelUser = config.redis?.sentinelUser?.trim();
      return {
        mode,
        options: {
          ...base,
          sentinels: [
            { host, port: effectivePort(config) ?? DEFAULT_SENTINEL_PORT },
            ...extra.map((node) => address(node, DEFAULT_SENTINEL_PORT)),
          ],
          name: config.redis?.masterName?.trim() ?? '',
          role: 'master',
          sentinelRetryStrategy: () => null,
          ...(sentinelUser === undefined || sentinelUser === ''
            ? {}
            : { sentinelUsername: sentinelUser }),
          ...(config.sentinelPassword === undefined || config.sentinelPassword === ''
            ? {}
            : { sentinelPassword: config.sentinelPassword }),
          // The Sentinels and the master speak TLS alike.
          ...(tls === undefined
            ? {}
            : { enableTLSForSentinelMode: true, sentinelTLS: tlsOptions(tls) }),
        },
      };
    }
    case 'cluster': {
      const defaultPort = DEFAULT_PORTS.redis ?? 6379;
      return {
        mode,
        nodes: [
          { host, port: effectivePort(config) ?? defaultPort },
          ...extra.map((node) => address(node, defaultPort)),
        ],
        options: {
          lazyConnect: true,
          redisOptions: base,
          clusterRetryStrategy: () => null,
          enableOfflineQueue: false,
          maxRedirections: 16,
          slotsRefreshTimeout: base.connectTimeout ?? 10_000,
          // No auto-pipelining: with it ioredis 6 drops the name of a `callBuffer`
          // command. Concurrent commands still share each node's socket without waiting.
          enableAutoPipelining: false,
          // Managed clusters announce names their certificates are issued for.
          ...(tls === undefined
            ? {}
            : {
                dnsLookup: (name: string, callback: (error: null, address: string) => void) => {
                  callback(null, name);
                },
              }),
        },
      };
    }
  }
}
