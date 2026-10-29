// The Elasticsearch client against real HTTP and HTTPS servers in this process: what it
// sends, how it signs in, and how TLS checks the certificate in each mode.

import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { elasticTarget, openElasticSession } from '../../../../src/drivers/elasticsearch/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { ROOT } from '../../../helpers/repo';

const TLS = join(ROOT, 'docker', 'tls');
const ROOT_ANSWER = JSON.stringify({
  cluster_name: 'test-cluster',
  version: { number: '8.19.6', distribution: undefined },
});

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const servers: http.Server[] = [];

type Handler = (seen: Seen, response: http.ServerResponse) => void;

function answerRoot(seen: Seen, response: http.ServerResponse, root = ROOT_ANSWER): boolean {
  if (seen.url === '/' || seen.url === '/es/') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(seen.method === 'HEAD' ? undefined : root);
    return true;
  }
  return false;
}

async function serve(handler: Handler, secure = false): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const listener: http.RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const one = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(one);
      handler(one, response);
    });
  };
  const server = secure
    ? https.createServer(
        { cert: readFileSync(join(TLS, 'server.crt')), key: readFileSync(join(TLS, 'server.key')) },
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
    driver: 'elasticsearch',
    host: '127.0.0.1',
    port,
    options: { connectTimeout: 2 },
    ...overrides,
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

describe('Elasticsearch session over HTTP (V7.8)', () => {
  it('asks the cluster who it is when it opens', async () => {
    const { port } = await serve((seen, response) => answerRoot(seen, response));
    const session = await openElasticSession(config(port));
    expect(session.server).toEqual({
      version: '8.19.6',
      distribution: 'elasticsearch',
      clusterName: 'test-cluster',
    });
    await session.close();
  });

  it('knows OpenSearch by its distribution', async () => {
    const root = JSON.stringify({
      cluster_name: 'os',
      version: { number: '2.18.0', distribution: 'opensearch' },
    });
    const { port } = await serve((seen, response) => answerRoot(seen, response, root));
    const session = await openElasticSession(config(port));
    expect(session.server.distribution).toBe('opensearch');
    await session.close();
  });

  it('signs in with Basic, with an API key, or not at all', async () => {
    const { port, seen } = await serve((one, response) => answerRoot(one, response));
    await (await openElasticSession(config(port, { user: 'elastic', password: 'p:ä' }))).close();
    await (
      await openElasticSession(
        config(port, { password: 'abc==', elastic: { auth: 'apiKey' }, user: 'ignored' }),
      )
    ).close();
    await (await openElasticSession(config(port))).close();
    expect(seen.map((one) => one.headers.authorization)).toEqual([
      `Basic ${Buffer.from('elastic:p:ä').toString('base64')}`,
      'ApiKey abc==',
      undefined,
    ]);
  });

  it('sends JSON and NDJSON bodies under the path prefix, and resolves any status', async () => {
    const { port, seen } = await serve((one, response) => {
      if (answerRoot(one, response)) {
        return;
      }
      response.writeHead(one.url.includes('nope') ? 404 : 200, {
        'content-type': 'application/json',
      });
      response.end('{"took":1,"id":9007199254740993}');
    });
    const session = await openElasticSession(
      config(port, { elastic: { auth: 'basic', pathPrefix: '/es/' } }),
    );
    const answer = await session.request({
      method: 'POST',
      path: 'products/_search',
      body: '{"size":1}',
    });
    expect(answer).toEqual({
      status: 200,
      body: '{"took":1,"id":9007199254740993}',
      contentType: 'application/json',
    });
    await session.request({ method: 'POST', path: '/_bulk', body: '{}\n{}\n', ndjson: true });
    expect((await session.request({ method: 'GET', path: '/nope' })).status).toBe(404);
    expect(
      seen.slice(1).map((one) => [one.method, one.url, one.headers['content-type'], one.body]),
    ).toEqual([
      ['POST', '/es/products/_search', 'application/json', '{"size":1}'],
      ['POST', '/es/_bulk', 'application/x-ndjson', '{}\n{}\n'],
      ['GET', '/es/nope', undefined, ''],
    ]);
    await session.close();
    await expect(session.request({ method: 'GET', path: '/' })).rejects.toMatchObject({
      code: 'connection-failed',
    });
  });

  it('answers HEAD without a body', async () => {
    const { port } = await serve((one, response) => answerRoot(one, response));
    const session = await openElasticSession(config(port));
    expect(await session.request({ method: 'HEAD', path: '/' })).toMatchObject({
      status: 200,
      body: '',
    });
    await session.close();
  });

  it('gives up on a request that takes longer than its time', async () => {
    const { port } = await serve((one, response) => {
      if (!answerRoot(one, response)) {
        setTimeout(() => response.end('{}'), 2000);
      }
    });
    const session = await openElasticSession(config(port));
    await expect(
      session.request({ method: 'GET', path: '/slow', timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: 'timeout',
    });
    await session.close();
  });

  it('fails to open on a refused port, a wrong password and a server that is not Elasticsearch', async () => {
    await expect(openElasticSession(config(1))).rejects.toMatchObject({
      code: 'connection-failed',
    });
    const refusing = await serve((_one, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        '{"error":{"root_cause":[{"type":"security_exception","reason":"unable to authenticate"}]},"status":401}',
      );
    });
    await expect(openElasticSession(config(refusing.port))).rejects.toMatchObject({
      code: 'auth-failed',
      message: 'security_exception: unable to authenticate',
    });
    const other = await serve((_one, response) => {
      response.end('<html>hello</html>');
    });
    await expect(openElasticSession(config(other.port))).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('did not answer as Elasticsearch does') as unknown,
    });
    const versionless = await serve((_one, response) => {
      response.end('{"name":"x"}');
    });
    await expect(openElasticSession(config(versionless.port))).rejects.toThrow('no version');
  });
});

describe('Elasticsearch session over HTTPS (V7.8)', () => {
  const ca = join(TLS, 'ca.crt');

  it('encrypts without checking in require mode', async () => {
    const { port } = await serve((one, response) => answerRoot(one, response), true);
    const session = await openElasticSession(config(port, { ssl: { mode: 'require' } }));
    expect(session.server.clusterName).toBe('test-cluster');
    await session.close();
  });

  it('checks the issuer in verify-ca and the name too in verify-full', async () => {
    const { port } = await serve((one, response) => answerRoot(one, response), true);
    await (await openElasticSession(config(port, { ssl: { mode: 'verify-ca', ca } }))).close();
    await (
      await openElasticSession(
        config(port, { host: 'localhost', ssl: { mode: 'verify-full', ca } }),
      )
    ).close();
    await expect(
      openElasticSession(config(port, { ssl: { mode: 'verify-full' } })),
    ).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('not trusted') as unknown,
    });
    await expect(
      openElasticSession(
        config(port, { ssl: { mode: 'verify-ca', ca: join(TLS, 'other-ca.crt') } }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('not trusted') as unknown });
  });

  it('checks the real name of the server through a tunnel', async () => {
    const { port } = await serve((one, response) => answerRoot(one, response), true);
    await (
      await openElasticSession(
        config(port, { tlsServerName: 'localhost', ssl: { mode: 'verify-full', ca } }),
      )
    ).close();
    await expect(
      openElasticSession(
        config(port, { tlsServerName: 'db.example.com', ssl: { mode: 'verify-full', ca } }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not issued for "db.example.com"') as unknown,
    });
  });

  it('says so when TLS meets a plain port', async () => {
    const { port } = await serve((one, response) => answerRoot(one, response));
    await expect(
      openElasticSession(config(port, { ssl: { mode: 'require' } })),
    ).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('TLS failed') as unknown,
    });
  });
});

describe('elasticTarget (V7.8)', () => {
  it('uses the default port and no prefix', () => {
    const target = elasticTarget(config(0, { port: undefined }), undefined);
    expect(target).toMatchObject({ secure: false, port: 9200, prefix: '', connectTimeoutMs: 2000 });
    expect(target.headers).toEqual({ accept: 'application/json' });
  });

  it('sends no API key header without a key', () => {
    expect(
      elasticTarget(config(1, { elastic: { auth: 'apiKey' } }), undefined).headers.authorization,
    ).toBeUndefined();
  });

  it('sends no SNI for an IP address', () => {
    const target = elasticTarget(config(1), { mode: 'verify-ca', serverName: '10.0.0.1' });
    expect(target.secure).toBe(true);
    expect(target.tls?.servername).toBeUndefined();
    expect(target.tls?.rejectUnauthorized).toBe(true);
  });
});
