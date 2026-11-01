import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  agentFor,
  HranaStream,
  StreamExpired,
  targetUrl,
} from '../../../../src/drivers/libsql/hrana';
import { FakeHrana } from '../../../helpers/fake-hrana';

describe('targetUrl', () => {
  it('builds a plain address from host and port', () => {
    expect(targetUrl('db.local', 8080, false).href).toBe('http://db.local:8080/');
    expect(targetUrl('db.local', undefined, false).href).toBe('http://db.local:8080/');
  });

  it('uses https and 443 when TLS is on', () => {
    expect(targetUrl('db-org.turso.io', undefined, true).href).toBe('https://db-org.turso.io/');
    expect(targetUrl('db-org.turso.io', 8443, true).href).toBe('https://db-org.turso.io:8443/');
  });

  it('defaults to localhost for an empty host', () => {
    expect(targetUrl(undefined, 7080, false).href).toBe('http://localhost:7080/');
    expect(targetUrl('   ', 7080, false).href).toBe('http://localhost:7080/');
  });

  it('puts an IPv6 address in brackets', () => {
    expect(targetUrl('::1', 7080, false).href).toBe('http://[::1]:7080/');
    expect(targetUrl('[::1]', 7080, false).href).toBe('http://[::1]:7080/');
  });

  it('takes the scheme of a URL: libsql, https and wss mean TLS, http and ws do not', () => {
    expect(targetUrl('libsql://db-org.turso.io', undefined, false).href).toBe(
      'https://db-org.turso.io/',
    );
    expect(targetUrl('https://db.example.com', undefined, false).href).toBe(
      'https://db.example.com/',
    );
    expect(targetUrl('wss://db.example.com', undefined, false).href).toBe(
      'https://db.example.com/',
    );
    expect(targetUrl('http://db.local:9000', undefined, true).href).toBe('http://db.local:9000/');
    expect(targetUrl('ws://db.local', 9001, true).href).toBe('http://db.local:9001/');
  });

  it('keeps the port of a URL over the port field, and drops the path and the query', () => {
    expect(targetUrl('http://db.local:9000/some/path?x=1', 1234, false).href).toBe(
      'http://db.local:9000/',
    );
  });
});

/** The options an agent was made with; Node keeps them on the object but does not type them. */
function optionsOf(agent: object): Record<string, unknown> {
  return (agent as { options: Record<string, unknown> }).options;
}

describe('agentFor', () => {
  it('keeps connections alive, for plain HTTP and for HTTPS', () => {
    const http = agentFor(new URL('http://a'), undefined);
    const https = agentFor(new URL('https://a'), undefined);
    expect(optionsOf(http).keepAlive).toBe(true);
    expect(optionsOf(https).keepAlive).toBe(true);
    http.destroy();
    https.destroy();
  });

  it('checks the certificate as the connection asks', () => {
    const material = (mode: 'require' | 'verify-ca' | 'verify-full') => ({
      mode,
      serverName: 'db.example.com',
      ca: Buffer.from('ca'),
      cert: Buffer.from('cert'),
      key: Buffer.from('key'),
    });
    const require = agentFor(new URL('https://a'), material('require'));
    expect(optionsOf(require).rejectUnauthorized).toBe(false);
    expect(optionsOf(require).servername).toBe('db.example.com');
    expect(optionsOf(require).ca).toEqual(Buffer.from('ca'));
    expect(optionsOf(require).cert).toEqual(Buffer.from('cert'));
    expect(optionsOf(require).key).toEqual(Buffer.from('key'));
    const verify = agentFor(new URL('https://a'), material('verify-ca'));
    expect(optionsOf(verify).rejectUnauthorized).toBe(true);
    require.destroy();
    verify.destroy();
  });

  it('sends no server name for an IP address', () => {
    const agent = agentFor(new URL('https://a'), { mode: 'verify-full', serverName: '127.0.0.1' });
    expect(optionsOf(agent).servername).toBeUndefined();
    agent.destroy();
  });

  it('ignores TLS material for a plain address', () => {
    const agent = agentFor(new URL('http://a'), { mode: 'require', serverName: 'a' });
    expect(optionsOf(agent).rejectUnauthorized).toBeUndefined();
    agent.destroy();
  });
});

describe('HranaStream', () => {
  let fake: FakeHrana;
  let url: URL;
  const streams: HranaStream[] = [];

  async function serve(options: ConstructorParameters<typeof FakeHrana>[0] = {}): Promise<void> {
    fake = new FakeHrana(options);
    url = new URL(`http://127.0.0.1:${await fake.start()}`);
  }

  function open(readOnly = false, token?: string): HranaStream {
    const stream = new HranaStream({ url, ...(token === undefined ? {} : { token }) }, readOnly);
    streams.push(stream);
    return stream;
  }

  afterEach(async () => {
    await Promise.all(streams.splice(0).map((stream) => stream.close()));
    await fake.stop();
  });

  const select = { type: 'execute', stmt: { sql: 'SELECT 1', want_rows: true } } as const;

  it('hands the baton of every answer to the next request', async () => {
    await serve();
    const stream = open();
    await stream.send([select]);
    await stream.send([select]);
    await stream.send([select]);
    expect(fake.records.map((record) => record.baton === null)).toEqual([true, false, false]);
    // One stream on the server the whole time.
    expect(new Set([...fake.streams.values()]).size).toBe(1);
  });

  it('answers each request in its place, and asks the server about transactions', async () => {
    await serve();
    const stream = open();
    const [executed, autocommit] = await stream.send([select, { type: 'get_autocommit' }]);
    expect(executed?.type).toBe('ok');
    expect(autocommit).toEqual({
      type: 'ok',
      response: { type: 'get_autocommit', is_autocommit: true },
    });
    expect(stream.reportsTransactions).toBe(true);
    expect(fake.records[0]?.path).toBe('/v3/pipeline');
  });

  it('carries an open transaction from one request to the next', async () => {
    await serve();
    const stream = open();
    await stream.send([{ type: 'execute', stmt: { sql: 'BEGIN', want_rows: false } }]);
    const [, autocommit] = await stream.send([select, { type: 'get_autocommit' }]);
    expect(autocommit).toMatchObject({ response: { is_autocommit: false } });
  });

  it('sends the token as a bearer token, and nothing when there is none', async () => {
    await serve({ token: 'secret' });
    await open(false, 'secret').send([select]);
    expect(fake.records[0]?.authorization).toBe('Bearer secret');
  });

  it('calls a refused token a failed sign-in', async () => {
    await serve({ token: 'secret' });
    await expect(open(false, 'wrong').send([select])).rejects.toMatchObject({
      code: 'auth-failed',
    });
    await expect(open().send([select])).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('falls back to Hrana 2 on a server without /v3, and says it cannot tell transactions', async () => {
    await serve({ v3: false });
    const stream = open();
    const results = await stream.send([select, { type: 'get_autocommit' }]);
    expect(results[0]?.type).toBe('ok');
    expect(results[1]).toBeUndefined();
    expect(stream.version).toBe('v2');
    expect(stream.reportsTransactions).toBe(false);
    expect(fake.records.map((record) => record.path)).toEqual(['/v2/pipeline']);
    // The request that cannot be sent is not sent again later either.
    await stream.send([select, { type: 'get_autocommit' }]);
    expect(fake.records.at(-1)?.requests.map((r) => r.type)).toEqual(['execute']);
  });

  it('turns query_only on in a fresh read-only stream, once', async () => {
    await serve();
    const stream = open(true);
    const first = await stream.send([select]);
    const second = await stream.send([select]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(fake.statements).toEqual(['PRAGMA query_only = 1', 'SELECT 1', 'SELECT 1']);
  });

  it('does that again for the stream that follows a reset', async () => {
    await serve();
    const stream = open(true);
    await stream.send([select]);
    stream.reset();
    await stream.send([select]);
    expect(fake.statements.filter((sql) => sql.startsWith('PRAGMA'))).toHaveLength(2);
  });

  it('goes on without query_only when the server turns the pragma down, and asks no more', async () => {
    await serve({
      handler: (statement) =>
        statement.sql.startsWith('PRAGMA')
          ? { error: { message: 'unsupported statement', code: 'SQL_PARSE_ERROR' } }
          : { cols: [], rows: [] },
    });
    const stream = open(true);
    const results = await stream.send([select]);
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe('ok');
    expect(stream.queryOnlyRefused).toBe(true);
    stream.reset();
    await stream.send([select]);
    expect(fake.statements.filter((sql) => sql.startsWith('PRAGMA'))).toHaveLength(1);
  });

  it('does not mark a server that accepts the pragma as refusing it', async () => {
    await serve();
    const stream = open(true);
    await stream.send([select]);
    expect(stream.queryOnlyRefused).toBe(false);
  });

  it('starts a new stream after reset', async () => {
    await serve();
    const stream = open();
    await stream.send([select]);
    stream.reset();
    await stream.send([select]);
    expect(fake.records.map((record) => record.baton === null)).toEqual([true, true]);
  });

  it('reports a stream the server forgot, once, and starts again after it', async () => {
    await serve();
    const stream = open();
    await stream.send([select]);
    fake.expireAll();
    await expect(stream.send([select])).rejects.toBeInstanceOf(StreamExpired);
    await expect(stream.send([select])).resolves.toHaveLength(1);
  });

  it('does not take an invalid baton for an expiry on a stream that was never opened', async () => {
    await serve();
    fake.failNext = { status: 400, body: 'Received an invalid baton' };
    const error = await open()
      .send([select])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect(error).not.toBeInstanceOf(StreamExpired);
  });

  it('knows an expired stream by the server code or by its words', async () => {
    await serve();
    const stream = open();
    await stream.send([select]);
    fake.failNext = { status: 404, body: JSON.stringify({ message: 'x', code: 'STREAM_EXPIRED' }) };
    await expect(stream.send([select])).rejects.toBeInstanceOf(StreamExpired);
    await stream.send([select]);
    fake.failNext = { status: 400, body: JSON.stringify({ message: 'The stream has expired' }) };
    await expect(stream.send([select])).rejects.toBeInstanceOf(StreamExpired);
  });

  it('shows another HTTP failure as it is', async () => {
    await serve();
    const stream = open();
    await stream.send([select]);
    fake.failNext = { status: 500, body: 'boom' };
    const error = await stream.send([select]).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'connection-failed', message: 'boom' });
  });

  it('refuses an answer that is not JSON', async () => {
    await serve();
    fake.failNext = { status: 200, body: '<html>' };
    await expect(open().send([select])).rejects.toMatchObject({ code: 'internal' });
  });

  it('forgets the stream when a request is aborted', async () => {
    await serve();
    const stream = open();
    await stream.send([select]);
    fake.delayMs = 200;
    const controller = new AbortController();
    const pending = stream.send([select], controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 30);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    fake.delayMs = 0;
    await stream.send([select]);
    expect(fake.records.at(-1)?.baton).toBeNull();
  });

  it('says a timeout is a timeout', async () => {
    await serve();
    fake.delayMs = 300;
    await expect(open().send([select], AbortSignal.timeout(40))).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('fails at once with a signal that is already aborted', async () => {
    await serve();
    const controller = new AbortController();
    controller.abort();
    await expect(open().send([select], controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('fails with the network error when nobody listens', async () => {
    await serve();
    const stream = new HranaStream({ url: new URL('http://127.0.0.1:1') }, false);
    streams.push(stream);
    await expect(stream.send([select])).rejects.toMatchObject({ code: 'connection-failed' });
  });

  it('closes the stream on the server', async () => {
    await serve();
    const stream = open();
    await stream.send([select]);
    await stream.close();
    expect(fake.records.at(-1)?.requests.map((r) => r.type)).toEqual(['close']);
    expect(fake.streams.size).toBe(0);
  });

  it('has nothing to close before the first request, and closes quietly twice', async () => {
    await serve();
    const stream = open();
    await stream.close();
    expect(fake.records).toHaveLength(0);
    await stream.send([select]);
    await stream.close();
    await stream.close();
    expect(fake.records.filter((r) => r.requests[0]?.type === 'close')).toHaveLength(1);
  });

  it('does not mind a server that is gone when it closes', async () => {
    await serve();
    const stream = open();
    await stream.send([select]);
    await fake.stop();
    await expect(stream.close()).resolves.toBeUndefined();
    await serve();
  });
});

describe('HranaStream and the address the server points to', () => {
  let server: Server | undefined;
  let other: Server | undefined;

  afterEach(() => {
    server?.closeAllConnections();
    other?.closeAllConnections();
    server?.close();
    other?.close();
  });

  it('follows base_url for the requests after the first', async () => {
    const hits: string[] = [];
    other = createServer((request, response) => {
      hits.push(`other ${request.url}`);
      response.end(JSON.stringify({ baton: null, base_url: null, results: [] }));
    });
    await new Promise<void>((resolve) => other?.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as AddressInfo).port;
    server = createServer((request, response) => {
      hits.push(`first ${request.url}`);
      response.end(
        JSON.stringify({ baton: 'b1', base_url: `http://127.0.0.1:${otherPort}`, results: [] }),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const stream = new HranaStream({ url: new URL(`http://127.0.0.1:${port}`) }, false);
    await stream.send([]);
    await stream.send([]);
    expect(hits).toEqual(['first /v3/pipeline', 'other /v3/pipeline']);
    // A reset goes back to the address the user gave.
    stream.reset();
    await stream.send([]);
    expect(hits.at(-1)).toBe('first /v3/pipeline');
  });

  it('ignores a base_url that is no address', async () => {
    let calls = 0;
    server = createServer((_request, response) => {
      calls += 1;
      response.end(JSON.stringify({ baton: 'b', base_url: 'not a url', results: [] }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const stream = new HranaStream({ url: new URL(`http://127.0.0.1:${port}`) }, false);
    await stream.send([]);
    await stream.send([]);
    expect(calls).toBe(2);
  });

  it('survives an answer without results', async () => {
    server = createServer((_request, response) => {
      response.end('{}');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const stream = new HranaStream({ url: new URL(`http://127.0.0.1:${port}`) }, false);
    await expect(
      stream.send([{ type: 'execute', stmt: { sql: 'x', want_rows: false } }]),
    ).resolves.toEqual([undefined]);
  });
});
