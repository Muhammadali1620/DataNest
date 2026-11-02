// An etcd session over Node's own HTTP client (V13.19): a keep-alive agent, TLS with
// DataNest's rules and, when a user is given, the token `auth/authenticate` hands out. The
// gateway is plain JSON over HTTP, so no gRPC client is needed (D148).

import * as http from 'node:http';
import * as https from 'node:https';
import { DbError, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_PORTS,
  effectivePort,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import { identityCheck, sniName, tlsFailure, tlsMaterial, type TlsMaterial } from '../common/tls';
import type { EtcdCallOptions, EtcdServerInfo, EtcdSession } from '../etcd-driver';
import { etcdFailure, isTokenRefusal, networkFailure } from './errors';

/** Bytes of an answer DataNest reads at most; a bigger one is refused, not cut. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Connections each session keeps open at most. */
const MAX_SOCKETS = 4;

export interface EtcdTarget {
  readonly secure: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly tls?: https.AgentOptions;
  readonly connectTimeoutMs: number;
}

/** Where and how to send requests: the host, the credentials, TLS. */
export function etcdTarget(
  config: ResolvedConnectionConfig,
  tls: TlsMaterial | undefined,
): EtcdTarget {
  const servername = tls === undefined ? undefined : sniName(tls.serverName);
  return {
    secure: tls !== undefined,
    host: config.host?.trim() ?? 'localhost',
    port: effectivePort(config) ?? DEFAULT_PORTS.etcd ?? 2379,
    user: config.user?.trim() ?? '',
    password: config.password ?? '',
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

/** The gateway's path prefix: `v3` since etcd 3.4, `v3beta` before. */
type GatewayVersion = 'v3' | 'v3beta';

class GatewaySession implements EtcdSession {
  server: EtcdServerInfo = { version: '', clusterId: '', dbSizeBytes: 0, authenticated: false };
  private readonly agent: http.Agent;
  private version: GatewayVersion = 'v3';
  private token: string | undefined;
  private signingIn: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly target: EtcdTarget,
    private readonly serverName: string | undefined,
  ) {
    this.agent = target.secure
      ? new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS, ...target.tls })
      : new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
  }

  get authenticated(): boolean {
    return this.token !== undefined;
  }

  async call(
    path: string,
    body: Readonly<Record<string, unknown>>,
    options: EtcdCallOptions = {},
  ): Promise<unknown> {
    try {
      return await this.post(path, body, options);
    } catch (error) {
      // A token lives a few minutes (or until the cluster restarts): sign in again once.
      if (this.target.user !== '' && isTokenRefusal(error)) {
        await this.signIn(true);
        return await this.post(path, body, options);
      }
      throw error;
    }
  }

  /**
   * Signs in when a user is given. A cluster without authentication refuses the call
   * with "authentication is not enabled": the credentials are then not needed, and the
   * session works without a token.
   */
  async signIn(again = false): Promise<void> {
    if (this.target.user === '') {
      return;
    }
    if (this.signingIn === undefined || again) {
      this.signingIn = (async () => {
        try {
          const answer = (await this.post(
            'auth/authenticate',
            { name: this.target.user, password: this.target.password },
            {},
          )) as { token?: unknown };
          this.token = typeof answer.token === 'string' ? answer.token : undefined;
        } catch (error) {
          if (error instanceof DbError && /authentication is not enabled/iu.test(error.message)) {
            this.token = undefined;
            return;
          }
          if (
            error instanceof DbError &&
            /authentication failed|invalid user/iu.test(error.message)
          ) {
            throw new DbError('auth-failed', error.message, { cause: error });
          }
          throw error;
        }
      })();
    }
    try {
      await this.signingIn;
    } finally {
      this.signingIn = undefined;
    }
  }

  /**
   * A call whose answer never ends (V13.31): the messages come as JSON lines and go to
   * `onMessage` one by one. Ends when `signal` aborts or the cluster closes the stream.
   * Like `call`, it signs in again once when the token has expired.
   */
  async watch(
    path: string,
    body: Readonly<Record<string, unknown>>,
    onMessage: (message: unknown) => void,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.stream(path, body, onMessage, signal);
    } catch (error) {
      if (this.target.user !== '' && isTokenRefusal(error)) {
        await this.signIn(true);
        await this.stream(path, body, onMessage, signal);
        return;
      }
      throw error;
    }
  }

  private stream(
    path: string,
    body: Readonly<Record<string, unknown>>,
    onMessage: (message: unknown) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new DbError('connection-failed', msg('The session is closed')));
    }
    if (signal.aborted) {
      return Promise.resolve();
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };
      const send = this.target.secure ? https.request : http.request;
      // A stream holds its socket for as long as it lives: it gets its own, outside the
      // pool the short calls share.
      const outgoing = send(
        {
          host: this.target.host,
          port: this.target.port,
          method: 'POST',
          path: `/${this.version}/${path}`,
          agent: false,
          ...(this.target.secure ? this.target.tls : {}),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...(this.token === undefined ? {} : { authorization: this.token }),
          },
        },
        (incoming) => {
          const status = incoming.statusCode ?? 0;
          incoming.setEncoding('utf8');
          let pending = '';
          incoming.on('data', (chunk: string) => {
            if (status >= 400) {
              pending += chunk.slice(0, 4096);
              return;
            }
            pending += chunk;
            let newline = pending.indexOf('\n');
            while (newline >= 0) {
              const line = pending.slice(0, newline).trim();
              pending = pending.slice(newline + 1);
              newline = pending.indexOf('\n');
              if (line === '') {
                continue;
              }
              try {
                onMessage(JSON.parse(line) as unknown);
              } catch (error) {
                outgoing.destroy();
                finish(
                  error instanceof DbError
                    ? error
                    : new DbError(
                        'connection-failed',
                        msg('The server did not answer as etcd does: {0}', errorMessage(error)),
                        { cause: error },
                      ),
                );
                return;
              }
            }
          });
          incoming.on('end', () => {
            finish(status >= 400 ? etcdFailure(status, pending) : undefined);
          });
          incoming.on('error', (error) => {
            finish(signal.aborted ? undefined : networkFailure(error));
          });
        },
      );
      const onAbort = (): void => {
        outgoing.destroy();
        finish();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      outgoing.setTimeout(this.target.connectTimeoutMs, () => {
        if (outgoing.socket?.connecting !== false) {
          outgoing.destroy(
            Object.assign(new Error(`connect ETIMEDOUT ${this.target.host}:${this.target.port}`), {
              code: 'ETIMEDOUT',
            }),
          );
        } else {
          // Connected: a stream may be quiet for as long as nothing changes.
          outgoing.setTimeout(0);
        }
      });
      outgoing.on('socket', (socket) => {
        socket.setKeepAlive(true, 30_000);
      });
      outgoing.on('error', (error) => {
        if (signal.aborted) {
          finish();
          return;
        }
        finish(
          error instanceof DbError
            ? error
            : ((this.serverName === undefined ? undefined : tlsFailure(error, this.serverName)) ??
                networkFailure(error)),
        );
      });
      outgoing.end(payload);
    });
  }

  /** Reads who the cluster is; a gateway of etcd 3.3 answers on `/v3beta` only. */
  async readServer(): Promise<EtcdServerInfo> {
    let answer: unknown;
    try {
      answer = await this.post('maintenance/status', {}, {});
    } catch (error) {
      if (error instanceof DbError && error.code === 'not-found' && this.version === 'v3') {
        this.version = 'v3beta';
        answer = await this.post('maintenance/status', {}, {});
      } else {
        throw error;
      }
    }
    const status = answer as {
      version?: unknown;
      dbSize?: unknown;
      header?: { cluster_id?: unknown };
    };
    if (typeof status.version !== 'string' || status.version === '') {
      throw new DbError(
        'connection-failed',
        msg('The server did not answer as etcd does: no version'),
      );
    }
    await this.requireSignInIfNeeded();
    return {
      version: status.version,
      clusterId: typeof status.header?.cluster_id === 'string' ? status.header.cluster_id : '',
      dbSizeBytes: Number(status.dbSize ?? 0) || 0,
      authenticated: this.authenticated,
    };
  }

  /**
   * Status is open to anyone, so a cluster with authentication on lets an anonymous
   * session in and only fails its first read. Ask `auth/status` (etcd 3.5) to say so at
   * once; an older cluster does not answer it, and the first read tells.
   */
  private async requireSignInIfNeeded(): Promise<void> {
    if (this.token !== undefined) {
      return;
    }
    try {
      const answer = (await this.post('auth/status', {}, {})) as { enabled?: unknown };
      if (answer.enabled !== true) {
        return;
      }
    } catch (error) {
      // With authentication on, even this call wants a user: that is the answer.
      if (needsSignIn(error) === undefined) {
        return;
      }
    }
    throw new DbError(
      'auth-failed',
      msg('The cluster has authentication on: enter a user and password'),
    );
  }

  private post(
    path: string,
    body: Readonly<Record<string, unknown>>,
    options: EtcdCallOptions,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new DbError('connection-failed', msg('The session is closed')));
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const send = this.target.secure ? https.request : http.request;
      const outgoing = send(
        {
          host: this.target.host,
          port: this.target.port,
          method: 'POST',
          path: `/${this.version}/${path}`,
          agent: this.agent,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': String(payload.length),
            ...(this.token === undefined ? {} : { authorization: this.token }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              incoming.destroy();
              clearTimeout(timer);
              reject(
                new DbError(
                  'constraint',
                  msg(
                    'The answer is larger than {0} MB: ask for less (limit, keys only)',
                    MAX_RESPONSE_BYTES / 1024 / 1024,
                  ),
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('end', () => {
            clearTimeout(timer);
            const status = incoming.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString('utf8');
            if (status >= 400) {
              reject(etcdFailure(status, text));
              return;
            }
            try {
              resolve(text.trim() === '' ? {} : (JSON.parse(text) as unknown));
            } catch (error) {
              reject(
                new DbError(
                  'connection-failed',
                  msg('The server did not answer as etcd does: {0}', errorMessage(error)),
                  { cause: error },
                ),
              );
            }
          });
          incoming.on('error', (error) => {
            clearTimeout(timer);
            reject(networkFailure(error));
          });
        },
      );
      // Connecting has its own limit; a slow answer only the call's.
      outgoing.setTimeout(this.target.connectTimeoutMs, () => {
        if (!outgoing.reusedSocket && outgoing.socket?.connecting !== false) {
          outgoing.destroy(
            Object.assign(new Error(`connect ETIMEDOUT ${this.target.host}:${this.target.port}`), {
              code: 'ETIMEDOUT',
            }),
          );
        }
      });
      const limit = options.timeoutMs ?? 0;
      const timer =
        limit > 0
          ? setTimeout(() => {
              outgoing.destroy(
                new DbError('timeout', msg('The request took longer than {0} s', limit / 1000)),
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
      outgoing.end(payload);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.agent.destroy();
    await Promise.resolve();
  }
}

/** A cluster that wants a user answers an anonymous call with this; say what is missing. */
function needsSignIn(error: unknown): DbError | undefined {
  if (error instanceof DbError && /user name is empty/iu.test(error.message)) {
    return new DbError(
      'auth-failed',
      msg('The cluster has authentication on: enter a user and password'),
      { cause: error },
    );
  }
  return undefined;
}

export async function openEtcdSession(config: ResolvedConnectionConfig): Promise<EtcdSession> {
  const tls = await tlsMaterial(config);
  const session = new GatewaySession(etcdTarget(config, tls), tls?.serverName);
  try {
    await session.signIn();
    session.server = await session.readServer();
  } catch (error) {
    await session.close();
    throw needsSignIn(error) ?? error;
  }
  return session;
}
