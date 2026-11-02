// The etcd client's streaming call against a real HTTP server in this process: the JSON
// lines of a watch, however the network cuts them, its end, and what goes wrong. The
// cluster behind the server is the in-memory etcd; only `/v3/watch` is the test's own.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { EtcdSession } from '../../../../src/drivers/etcd-driver';
import { openEtcdSession } from '../../../../src/drivers/etcd/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeEtcd } from '../../../helpers/fake-etcd';

type Handler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  count: number,
) => void;

const servers: http.Server[] = [];
const sessions: EtcdSession[] = [];

/** A server that answers every call from the fake cluster, and `/v3/watch` as the test says. */
async function serve(
  cluster: FakeEtcd,
  onWatch: Handler,
): Promise<{ port: number; watches: () => number; paths: string[] }> {
  let watches = 0;
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      paths.push(url);
      if (url === '/v3/watch') {
        watches += 1;
        onWatch(request, response, watches);
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const answer = cluster.handle(
        url.slice('/v3/'.length),
        body === '' ? {} : (JSON.parse(body) as Record<string, unknown>),
        request.headers.authorization,
      );
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, watches: () => watches, paths };
}

function config(port: number, overrides: Partial<ResolvedConnectionConfig> = {}) {
  return {
    id: 't',
    name: 't',
    driver: 'etcd',
    host: '127.0.0.1',
    port,
    options: { connectTimeout: 2 },
    ...overrides,
  } as ResolvedConnectionConfig;
}

async function open(
  cluster: FakeEtcd,
  onWatch: Handler,
  overrides: Partial<ResolvedConnectionConfig> = {},
) {
  const server = await serve(cluster, onWatch);
  const session = await openEtcdSession(config(server.port, overrides));
  sessions.push(session);
  return { session, server };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe('the watch stream of the etcd session', () => {
  it('posts the request to the gateway and hands over every line', async () => {
    let posted = '';
    const { session, server } = await open(new FakeEtcd(), (request, response) => {
      request.on('data', () => undefined);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(line({ result: { created: true } }));
      response.end(line({ result: { events: [{ kv: { key: 'YQ==' } }] } }));
      posted = request.method ?? '';
    });
    const messages: unknown[] = [];
    await session.watch(
      'watch',
      { create_request: { key: 'YQ==' } },
      (message) => messages.push(message),
      new AbortController().signal,
    );
    expect(posted).toBe('POST');
    expect(messages).toEqual([
      { result: { created: true } },
      { result: { events: [{ kv: { key: 'YQ==' } }] } },
    ]);
    expect(server.paths).toContain('/v3/watch');
  });

  it('puts together a line the network cut in pieces, and splits chunks of many lines', async () => {
    const whole =
      line({ result: { n: 1 } }) + line({ result: { n: 2 } }) + line({ result: { n: 3 } });
    const { session } = await open(new FakeEtcd(), (_request, response) => {
      response.writeHead(200);
      // Cut in the middle of the second line, and again in the middle of the third.
      const first = whole.indexOf('"n":2') + 2;
      const second = whole.indexOf('"n":3') + 2;
      response.write(whole.slice(0, first));
      setTimeout(() => {
        response.write(whole.slice(first, second));
        setTimeout(() => {
          response.end(whole.slice(second));
        }, 10);
      }, 10);
    });
    const messages: unknown[] = [];
    await session.watch(
      'watch',
      {},
      (message) => messages.push(message),
      new AbortController().signal,
    );
    expect(messages).toEqual([{ result: { n: 1 } }, { result: { n: 2 } }, { result: { n: 3 } }]);
  });

  it('skips blank lines', async () => {
    const { session } = await open(new FakeEtcd(), (_request, response) => {
      response.writeHead(200);
      response.end(`\n${line({ a: 1 })}\n\n`);
    });
    const messages: unknown[] = [];
    await session.watch(
      'watch',
      {},
      (message) => messages.push(message),
      new AbortController().signal,
    );
    expect(messages).toEqual([{ a: 1 }]);
  });

  it('stays open, quiet, until it is stopped; then it ends without an error', async () => {
    let closedByClient = false;
    const { session } = await open(new FakeEtcd(), (request, response) => {
      response.writeHead(200);
      response.write(line({ result: { created: true } }));
      request.on('close', () => {
        closedByClient = true;
      });
    });
    const abort = new AbortController();
    const messages: unknown[] = [];
    const done = session.watch(
      'watch',
      {},
      (message) => {
        messages.push(message);
        setTimeout(() => {
          abort.abort();
        }, 30);
      },
      abort.signal,
    );
    await expect(done).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closedByClient).toBe(true);
  });

  it('does not even ask when it is stopped already', async () => {
    const { session, server } = await open(new FakeEtcd(), (_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const abort = new AbortController();
    abort.abort();
    await session.watch('watch', {}, () => undefined, abort.signal);
    expect(server.watches()).toBe(0);
  });

  it('refuses on a session that is closed', async () => {
    const { session } = await open(new FakeEtcd(), (_request, response) => {
      response.writeHead(200);
      response.end();
    });
    await session.close();
    await expect(
      session.watch('watch', {}, () => undefined, new AbortController().signal),
    ).rejects.toThrow('closed');
  });

  it('reads a refusal by its status and its gRPC code', async () => {
    const { session } = await open(new FakeEtcd(), (_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end('{"code":7,"message":"etcdserver: permission denied"}');
    });
    const error = await session
      .watch('watch', {}, () => undefined, new AbortController().signal)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({
      code: 'permission-denied',
      message: 'etcdserver: permission denied',
    });
  });

  it('fails when a line is not JSON', async () => {
    const { session } = await open(new FakeEtcd(), (_request, response) => {
      response.writeHead(200);
      response.write('this is not json\n');
    });
    const error = await session
      .watch('watch', {}, () => undefined, new AbortController().signal)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'connection-failed' });
    expect((error as DbError).message).toContain('did not answer as etcd does');
  });

  it('fails with what the listener threw, and closes the stream', async () => {
    let closed = false;
    const { session } = await open(new FakeEtcd(), (request, response) => {
      response.writeHead(200);
      response.write(line({ result: { created: true } }));
      request.on('close', () => {
        closed = true;
      });
    });
    const error = await session
      .watch(
        'watch',
        {},
        () => {
          throw new DbError('constraint', 'cancelled by the cluster');
        },
        new AbortController().signal,
      )
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'constraint', message: 'cancelled by the cluster' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });

  it('fails as a lost link when the connection is cut mid-stream', async () => {
    const { session } = await open(new FakeEtcd(), (request, response) => {
      response.writeHead(200);
      response.write(line({ result: { created: true } }));
      setTimeout(() => {
        request.socket.destroy();
      }, 20);
    });
    const error = await session
      .watch('watch', {}, () => undefined, new AbortController().signal)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('connection-failed');
  });

  it('fails when nobody listens at the address', async () => {
    const { session } = await open(new FakeEtcd(), (_request, response) => {
      response.end();
    });
    // The session is open; its target now points at a port that was closed.
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const error = await session
      .watch('watch', {}, () => undefined, new AbortController().signal)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DbError);
  });

  it('sends the token it signed in with', async () => {
    const cluster = new FakeEtcd();
    cluster.users = new Map([['root', 'pw']]);
    let sent: string | undefined;
    const { session } = await open(
      cluster,
      (request, response) => {
        sent = request.headers.authorization;
        response.writeHead(200);
        response.end();
      },
      { user: 'root', password: 'pw' },
    );
    await session.watch('watch', {}, () => undefined, new AbortController().signal);
    expect(sent).toMatch(/\S+/u);
  });

  it('signs in again once when the cluster says the token has expired', async () => {
    const cluster = new FakeEtcd();
    cluster.users = new Map([['root', 'pw']]);
    const { session, server } = await open(
      cluster,
      (_request, response, count) => {
        if (count === 1) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end('{"code":16,"message":"etcdserver: invalid auth token"}');
          return;
        }
        response.writeHead(200);
        response.end(line({ result: { created: true } }));
      },
      { user: 'root', password: 'pw' },
    );
    const messages: unknown[] = [];
    await session.watch(
      'watch',
      {},
      (message) => messages.push(message),
      new AbortController().signal,
    );
    expect(server.watches()).toBe(2);
    expect(server.paths.filter((path) => path === '/v3/auth/authenticate')).toHaveLength(2);
    expect(messages).toEqual([{ result: { created: true } }]);
  });

  it('gives up when the second attempt is refused too', async () => {
    const cluster = new FakeEtcd();
    cluster.users = new Map([['root', 'pw']]);
    const { session, server } = await open(
      cluster,
      (_request, response) => {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"code":16,"message":"etcdserver: invalid auth token"}');
      },
      { user: 'root', password: 'pw' },
    );
    await expect(
      session.watch('watch', {}, () => undefined, new AbortController().signal),
    ).rejects.toThrow('invalid auth token');
    expect(server.watches()).toBe(2);
  });
});
