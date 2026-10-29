// An Elasticsearch session over Node's own HTTP client (V7.8, D91): a keep-alive agent,
// TLS with DataNest's rules, Basic or API key sign-in. The official client is not used:
// it refuses servers that are not Elastic's own (OpenSearch), and the API is plain HTTP.

import * as http from 'node:http';
import * as https from 'node:https';
import { DbError, errorMessage } from '../../core/errors';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_PORTS,
  effectivePort,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import { identityCheck, sniName, tlsFailure, tlsMaterial, type TlsMaterial } from '../common/tls';
import type {
  ElasticRequest,
  ElasticResponse,
  ElasticServerInfo,
  ElasticSession,
} from '../elastic-driver';
import { elasticFailure, networkFailure } from './errors';

/** Bytes of a response DataNest reads at most; a bigger one is refused, not cut. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Connections each session keeps open at most. */
const MAX_SOCKETS = 4;

export interface ElasticTarget {
  readonly secure: boolean;
  readonly host: string;
  readonly port: number;
  readonly prefix: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly tls?: https.AgentOptions;
  readonly connectTimeoutMs: number;
}

/** Where and how to send requests: the host, the sign-in header, TLS. */
export function elasticTarget(
  config: ResolvedConnectionConfig,
  tls: TlsMaterial | undefined,
): ElasticTarget {
  const user = config.user?.trim() ?? '';
  const password = config.password ?? '';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (config.elastic?.auth === 'apiKey') {
    if (password !== '') {
      headers.authorization = `ApiKey ${password}`;
    }
  } else if (user !== '') {
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
  }
  const servername = tls === undefined ? undefined : sniName(tls.serverName);
  return {
    secure: tls !== undefined,
    host: config.host?.trim() ?? 'localhost',
    port: effectivePort(config) ?? DEFAULT_PORTS.elasticsearch ?? 9200,
    prefix: (config.elastic?.pathPrefix ?? '').replace(/\/+$/, ''),
    headers,
    connectTimeoutMs: (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000,
    ...(tls === undefined
      ? {}
      : {
          tls: {
            ...(tls.ca === undefined ? {} : { ca: tls.ca }),
            ...(tls.cert === undefined ? {} : { cert: tls.cert }),
            ...(tls.key === undefined ? {} : { key: tls.key }),
            rejectUnauthorized: tls.mode !== 'require',
            checkServerIdentity: identityCheck(tls),
            ...(servername === undefined ? {} : { servername }),
          },
        }),
  };
}

class HttpSession implements ElasticSession {
  server: ElasticServerInfo = { version: '', distribution: 'elasticsearch', clusterName: '' };
  private readonly agent: http.Agent;
  private closed = false;

  constructor(
    private readonly target: ElasticTarget,
    private readonly serverName: string | undefined,
  ) {
    this.agent = target.secure
      ? new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS, ...target.tls })
      : new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
  }

  request(request: ElasticRequest): Promise<ElasticResponse> {
    if (this.closed) {
      return Promise.reject(new DbError('connection-failed', 'The session is closed'));
    }
    const path = `${this.target.prefix}${request.path.startsWith('/') ? '' : '/'}${request.path}`;
    const body = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8');
    return new Promise((resolve, reject) => {
      const send = this.target.secure ? https.request : http.request;
      const outgoing = send(
        {
          host: this.target.host,
          port: this.target.port,
          method: request.method,
          path,
          agent: this.agent,
          headers: {
            ...this.target.headers,
            ...(body === undefined
              ? {}
              : {
                  'content-type':
                    request.ndjson === true ? 'application/x-ndjson' : 'application/json',
                  'content-length': String(body.length),
                }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              incoming.destroy();
              reject(
                new DbError(
                  'constraint',
                  `The answer is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB: ask for less (size, _source)`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('end', () => {
            clearTimeout(timer);
            resolve({
              status: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              contentType: incoming.headers['content-type'] ?? '',
            });
          });
          incoming.on('error', (error) => {
            clearTimeout(timer);
            reject(networkFailure(error));
          });
        },
      );
      // Connecting has its own limit; a slow answer only the request's.
      outgoing.setTimeout(this.target.connectTimeoutMs, () => {
        if (!outgoing.reusedSocket && outgoing.socket?.connecting !== false) {
          outgoing.destroy(
            Object.assign(new Error(`connect ETIMEDOUT ${this.target.host}:${this.target.port}`), {
              code: 'ETIMEDOUT',
            }),
          );
        }
      });
      const limit = request.timeoutMs ?? 0;
      const timer =
        limit > 0
          ? setTimeout(() => {
              outgoing.destroy(
                new DbError('timeout', `The request took longer than ${limit / 1000} s`),
              );
            }, limit)
          : undefined;
      outgoing.on('error', (error) => {
        clearTimeout(timer);
        if (error instanceof DbError) {
          reject(error);
          return;
        }
        reject(
          (this.serverName === undefined ? undefined : tlsFailure(error, this.serverName)) ??
            networkFailure(error),
        );
      });
      outgoing.end(body);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.agent.destroy();
    await Promise.resolve();
  }
}

/** Who the cluster is, from `GET /`; a refusal there is the session's own failure. */
async function readServer(session: HttpSession): Promise<ElasticServerInfo> {
  const response = await session.request({ method: 'GET', path: '/' });
  if (response.status >= 400) {
    throw elasticFailure(response);
  }
  let info: { version?: { number?: unknown; distribution?: unknown }; cluster_name?: unknown };
  try {
    info = JSON.parse(response.body) as typeof info;
  } catch (error) {
    throw new DbError(
      'connection-failed',
      `The server did not answer as Elasticsearch does: ${errorMessage(error)}`,
    );
  }
  const version = typeof info.version?.number === 'string' ? info.version.number : '';
  if (version === '') {
    throw new DbError(
      'connection-failed',
      'The server did not answer as Elasticsearch does: no version',
    );
  }
  return {
    version,
    distribution: info.version?.distribution === 'opensearch' ? 'opensearch' : 'elasticsearch',
    clusterName: typeof info.cluster_name === 'string' ? info.cluster_name : '',
  };
}

export async function openElasticSession(
  config: ResolvedConnectionConfig,
): Promise<ElasticSession> {
  const tls = await tlsMaterial(config);
  const session = new HttpSession(elasticTarget(config, tls), tls?.serverName);
  try {
    session.server = await readServer(session);
  } catch (error) {
    await session.close();
    throw error;
  }
  return session;
}
