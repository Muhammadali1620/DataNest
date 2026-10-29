// How a MongoDB connection becomes the driver's URL and options (V7.5). Credentials go
// in the options, never into the URL (nothing to escape, nothing to leak into a log);
// the URL names only the servers and the topology.

import type { MongoClientOptions } from 'mongodb';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_PORTS,
  effectivePort,
  mongoModeOf,
  type NodeAddress,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import { identityCheck, sniName, type TlsMaterial } from '../common/tls';

/** Connections each client keeps at most: a tree, a page and a query need few. */
const MAX_POOL_SIZE = 4;

/** `host:port` as a URL wants it: IPv6 addresses in brackets. */
function hostPort(host: string, port: number | undefined): string {
  const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return port === undefined ? name : `${name}:${port}`;
}

/** The URL of the servers: one, a seed list, or an SRV name. */
export function mongoUrl(config: ResolvedConnectionConfig): string {
  const host = config.host?.trim() ?? 'localhost';
  const mode = mongoModeOf(config);
  if (mode === 'srv') {
    return `mongodb+srv://${hostPort(host, undefined)}/`;
  }
  const defaultPort = DEFAULT_PORTS.mongodb ?? 27_017;
  const nodes: NodeAddress[] =
    mode === 'replicaSet'
      ? [{ host, port: effectivePort(config) ?? defaultPort }, ...(config.mongo?.nodes ?? [])]
      : [{ host, port: effectivePort(config) ?? defaultPort }];
  return `mongodb://${nodes.map((node) => hostPort(node.host.trim(), node.port ?? defaultPort)).join(',')}/`;
}

/** The database the user signs in to: as set, else the connection's database, else admin. */
export function authSourceOf(config: ResolvedConnectionConfig): string {
  const set = config.mongo?.authSource?.trim();
  if (set !== undefined && set !== '') {
    return set;
  }
  if (config.mongo?.authMechanism === 'MONGODB-X509') {
    return '$external';
  }
  const database = config.database?.trim();
  return database === undefined || database === '' ? 'admin' : database;
}

export function mongoOptions(
  config: ResolvedConnectionConfig,
  tls: TlsMaterial | undefined,
): MongoClientOptions {
  const mode = mongoModeOf(config);
  const user = config.user?.trim() ?? '';
  const mechanism = config.mongo?.authMechanism;
  const timeout = (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000;
  const replicaSet = config.mongo?.replicaSet?.trim();
  const servername = tls === undefined ? undefined : sniName(tls.serverName);
  const signsIn = user !== '' || mechanism === 'MONGODB-X509';
  return {
    appName: 'DataNest',
    // One server only: through a tunnel, or to a member that announces names the
    // editor cannot reach (a container's own host name).
    ...(mode === 'direct' ? { directConnection: true } : {}),
    ...(mode === 'replicaSet' && replicaSet !== undefined && replicaSet !== ''
      ? { replicaSet }
      : {}),
    ...(signsIn
      ? {
          // X.509 names the user by the client certificate: no name, no password.
          ...(user === '' ? {} : { auth: { username: user, password: config.password ?? '' } }),
          authSource: authSourceOf(config),
          ...(mechanism === undefined ? {} : { authMechanism: mechanism }),
        }
      : {}),
    serverSelectionTimeoutMS: timeout,
    connectTimeoutMS: timeout,
    maxPoolSize: MAX_POOL_SIZE,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
    // Retryable writes are applied once even when sent twice: the server remembers each
    // by its transaction number, so they are not the blind repeat D26 forbids.
    retryWrites: true,
    retryReads: true,
    monitorCommands: false,
    // Without TLS set, an SRV connection keeps the driver's default, which is TLS.
    ...(tls === undefined
      ? mode === 'srv'
        ? {}
        : { tls: false }
      : {
          tls: true,
          ...(tls.ca === undefined ? {} : { ca: tls.ca }),
          ...(tls.cert === undefined ? {} : { cert: tls.cert }),
          ...(tls.key === undefined ? {} : { key: tls.key }),
          rejectUnauthorized: tls.mode !== 'require',
          // Our own rule checks the name, against the server's real name (§8); the
          // driver's `tlsAllowInvalidHostnames` would replace it with no check at all.
          checkServerIdentity: identityCheck(tls),
          ...(servername === undefined ? {} : { servername }),
        }),
  };
}
