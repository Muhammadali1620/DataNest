// The etcd client against real HTTP and HTTPS servers in this process: what it sends,
// how it signs in and renews its token, how it reads a refusal, and how TLS checks the
// certificate in each mode. The cluster behind the HTTP server is the in-memory etcd.

import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { etcdTarget, openEtcdSession } from '../../../../src/drivers/etcd/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeEtcd, type GatewayAnswer } from '../../../helpers/fake-etcd';
import { ROOT } from '../../../helpers/repo';

const TLS = join(ROOT, 'docker', 'tls');

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: http.Server[] = [];

type Override = (seen: Seen, response: http.ServerResponse) => boolean;

async function serve(
  cluster: FakeEtcd,
  options: { secure?: boolean; override?: Override; prefix?: string } = {},
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const prefix = options.prefix ?? '/v3/';
  const listener: http.RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const one: Seen = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(one);
      if (options.override?.(one, response) === true) {
        return;
      }
      if (!one.url.startsWith(prefix)) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"code":12,"message":"Not Found"}');
        return;
      }
      const answer: GatewayAnswer = cluster.handle(
        one.url.slice(prefix.length),
        one.body === '' ? {} : (JSON.parse(one.body) as Record<string, unknown>),
        one.headers.authorization,
      );
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  };
  const server =
    options.secure === true
      ? https.createServer(
          {
            cert: readFileSync(join(TLS, 'server.crt')),
            key: readFileSync(join(TLS, 'server.key')),
          },
          listener,
        )
      : http.createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

function config(
  port: number,
  overrides: Partial<ResolvedConnectionConfig> = {},
): ResolvedConnectionConfig {
  return {
    id: 't',
    name: 't',
    driver: 'etcd',
    host: '127.0.0.1',
    port,
    options: { connectTimeout: 2 },
    ...overrides,
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function failure(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error('It did not fail');
}

describe('etcd session over HTTP (V13.19)', () => {
  it('asks the cluster its status when it opens', async () => {
    const cluster = new FakeEtcd();
    const { port, seen } = await serve(cluster);
    const session = await openEtcdSession(config(port));
    expect(session.server).toEqual({
      version: '3.5.17',
      clusterId: '1',
      dbSizeBytes: 20_480,
      authenticated: false,
    });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/v3/maintenance/status');
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(seen[0]?.headers.authorization).toBeUndefined();
    await session.close();
  });

  it('posts JSON to the path it is given and returns the parsed answer', async () => {
    const cluster = new FakeEtcd();
    cluster.seed('/a', 'hello');
    const { port, seen } = await serve(cluster);
    const session = await openEtcdSession(config(port));
    const answer = (await session.call('kv/range', {
      key: Buffer.from('/a').toString('base64'),
    })) as {
      kvs: { value: string }[];
    };
    expect(Buffer.from(answer.kvs[0]?.value ?? '', 'base64').toString()).toBe('hello');
    expect(seen.at(-1)?.url).toBe('/v3/kv/range');
    expect(JSON.parse(seen.at(-1)?.body ?? '{}')).toEqual({ key: 'L2E=' });
    await session.close();
  });

  it('falls back to the older /v3beta gateway', async () => {
    const cluster = new FakeEtcd();
    const { port, seen } = await serve(cluster, { prefix: '/v3beta/' });
    const session = await openEtcdSession(config(port));
    expect(session.server.version).toBe('3.5.17');
    await session.call('kv/range', { key: 'YQ==' });
    expect(seen.map((one) => one.url)).toEqual([
      '/v3/maintenance/status',
      '/v3beta/maintenance/status',
      // An anonymous session asks whether the cluster wants a user.
      '/v3beta/auth/status',
      '/v3beta/kv/range',
    ]);
    await session.close();
  });

  it('refuses a server that does not answer like etcd', async () => {
    const cluster = new FakeEtcd();
    const answered = await serve(cluster, {
      override: (_seen, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"hello":"world"}');
        return true;
      },
    });
    const noVersion = await failure(openEtcdSession(config(answered.port)));
    expect(noVersion.code).toBe('connection-failed');
    const garbage = await serve(cluster, {
      override: (_seen, response) => {
        response.writeHead(200);
        response.end('<html>not json</html>');
        return true;
      },
    });
    const notJson = await failure(openEtcdSession(config(garbage.port)));
    expect(notJson.code).toBe('connection-failed');
  });

  it('turns a refused connection into a lost link', async () => {
    const cluster = new FakeEtcd();
    const { port } = await serve(cluster);
    const server = servers[0];
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
    const error = await failure(openEtcdSession(config(port)));
    expect(error.code).toBe('connection-failed');
  });

  it('reads a refusal by its gRPC code', async () => {
    const cluster = new FakeEtcd();
    const { port } = await serve(cluster);
    const session = await openEtcdSession(config(port));
    expect((await failure(session.call('kv/range', { key: '' }))).code).toBe('syntax');
    expect((await failure(session.call('lease/revoke', { ID: '12' }))).code).toBe('not-found');
    cluster.failNext = { status: 503, body: { code: 14, message: 'etcdserver: no leader' } };
    expect((await failure(session.call('kv/range', { key: 'YQ==' }))).code).toBe('busy');
    cluster.failNext = { status: 502, body: 'x' };
    expect((await failure(session.call('kv/range', { key: 'YQ==' }))).code).toBe('internal');
    await session.close();
  });

  it('gives up on a call that takes longer than asked', async () => {
    const cluster = new FakeEtcd();
    const { port } = await serve(cluster, {
      override: (seen) => seen.url.endsWith('kv/range'),
    });
    const session = await openEtcdSession(config(port));
    const error = await failure(session.call('kv/range', { key: 'YQ==' }, { timeoutMs: 100 }));
    expect(error.code).toBe('timeout');
    await session.close();
  });

  it('refuses calls once it is closed', async () => {
    const cluster = new FakeEtcd();
    const { port } = await serve(cluster);
    const session = await openEtcdSession(config(port));
    await session.close();
    expect((await failure(session.call('kv/range', { key: 'YQ==' }))).code).toBe(
      'connection-failed',
    );
  });
});

describe('signing in', () => {
  function secured(): FakeEtcd {
    const cluster = new FakeEtcd();
    cluster.users = new Map([['root', 'pw']]);
    return cluster;
  }

  it('signs in and sends the token as the Authorization header', async () => {
    const cluster = secured();
    const { port, seen } = await serve(cluster);
    const session = await openEtcdSession(config(port, { user: 'root', password: 'pw' }));
    expect(session.server.authenticated).toBe(true);
    await session.call('kv/range', { key: 'YQ==' });
    const authenticate = seen.find((one) => one.url.endsWith('auth/authenticate'));
    expect(JSON.parse(authenticate?.body ?? '{}')).toEqual({ name: 'root', password: 'pw' });
    expect(authenticate?.headers.authorization).toBeUndefined();
    expect(seen.at(-1)?.headers.authorization).toBe('token-1');
    await session.close();
  });

  it('says so when the password is wrong', async () => {
    const { port } = await serve(secured());
    const error = await failure(openEtcdSession(config(port, { user: 'root', password: 'nope' })));
    expect(error.code).toBe('auth-failed');
    expect(error.message).toMatch(/authentication failed/u);
  });

  it('says so when the cluster wants a user and none was given', async () => {
    const { port } = await serve(secured());
    const error = await failure(openEtcdSession(config(port)));
    expect(error.code).toBe('auth-failed');
    expect(error.message).toMatch(/authentication/iu);
  });

  it('works without a token when the cluster has no authentication', async () => {
    const cluster = new FakeEtcd();
    const { port, seen } = await serve(cluster);
    const session = await openEtcdSession(config(port, { user: 'root', password: 'pw' }));
    expect(session.server.authenticated).toBe(false);
    await session.call('kv/range', { key: 'YQ==' });
    expect(seen.at(-1)?.headers.authorization).toBeUndefined();
    await session.close();
  });

  it('signs in again, once and silently, when the token is refused', async () => {
    const cluster = secured();
    cluster.seed('/a', 'x');
    const { port, seen } = await serve(cluster);
    const session = await openEtcdSession(config(port, { user: 'root', password: 'pw' }));
    cluster.forgetTokens();
    const answer = (await session.call('kv/range', {
      key: Buffer.from('/a').toString('base64'),
    })) as {
      kvs: unknown[];
    };
    expect(answer.kvs).toHaveLength(1);
    expect(seen.filter((one) => one.url.endsWith('auth/authenticate'))).toHaveLength(2);
    expect(seen.at(-1)?.headers.authorization).toBe('token-2');
    await session.close();
  });

  it('does not loop when the new token is refused as well', async () => {
    const cluster = secured();
    const { port, seen } = await serve(cluster);
    const session = await openEtcdSession(config(port, { user: 'root', password: 'pw' }));
    cluster.forgetTokens();
    // The cluster keeps refusing tokens: after one more sign-in the second refusal is final.
    const original = cluster.handle.bind(cluster);
    cluster.handle = (path, body, token) => {
      if (path === 'kv/range') {
        return { status: 401, body: { code: 16, message: 'etcdserver: invalid auth token' } };
      }
      return original(path, body, token);
    };
    const error = await failure(session.call('kv/range', { key: 'YQ==' }));
    expect(error.code).toBe('auth-failed');
    expect(seen.filter((one) => one.url.endsWith('auth/authenticate'))).toHaveLength(2);
    await session.close();
  });

  it('does not sign in again for a user it never had', async () => {
    const cluster = new FakeEtcd();
    const { port, seen } = await serve(cluster);
    const session = await openEtcdSession(config(port));
    cluster.failNext = {
      status: 401,
      body: { code: 16, message: 'etcdserver: invalid auth token' },
    };
    const error = await failure(session.call('kv/range', { key: 'YQ==' }));
    expect(error.code).toBe('auth-failed');
    expect(seen.some((one) => one.url.endsWith('auth/authenticate'))).toBe(false);
    await session.close();
  });
});

describe('TLS', () => {
  it('trusts any certificate in require mode', async () => {
    const { port } = await serve(new FakeEtcd(), { secure: true });
    const session = await openEtcdSession(config(port, { ssl: { mode: 'require' } }));
    expect(session.server.version).toBe('3.5.17');
    await session.close();
  });

  it('checks the issuer in verify-ca mode and the name in verify-full mode', async () => {
    const { port } = await serve(new FakeEtcd(), { secure: true });
    const ca = join(TLS, 'ca.crt');
    await (await openEtcdSession(config(port, { ssl: { mode: 'verify-ca', ca } }))).close();
    await (
      await openEtcdSession(config(port, { host: 'localhost', ssl: { mode: 'verify-full', ca } }))
    ).close();
    await expect(
      openEtcdSession(config(port, { ssl: { mode: 'verify-ca' } })),
    ).rejects.toBeInstanceOf(DbError);
    await expect(
      openEtcdSession(config(port, { ssl: { mode: 'verify-ca', ca: join(TLS, 'other-ca.crt') } })),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('explains a TLS answer from a plain port', async () => {
    const { port } = await serve(new FakeEtcd());
    const error = await failure(openEtcdSession(config(port, { ssl: { mode: 'require' } })));
    expect(error.code).toBe('connection-failed');
  });
});

describe('etcdTarget', () => {
  it('uses the defaults of etcd', () => {
    const target = etcdTarget({ id: 't', name: 't', driver: 'etcd' }, undefined);
    expect(target).toMatchObject({
      secure: false,
      host: 'localhost',
      port: 2379,
      user: '',
      password: '',
    });
  });

  it('trims the user and keeps the password as typed', () => {
    const target = etcdTarget(
      { id: 't', name: 't', driver: 'etcd', host: ' h ', port: 1, user: ' u ', password: ' p ' },
      undefined,
    );
    expect(target).toMatchObject({ host: 'h', port: 1, user: 'u', password: ' p ' });
  });
});
