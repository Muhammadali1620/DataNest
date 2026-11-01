import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  basicAuthorization,
  postQuery,
  queryUrl,
  readAnswer,
  requestBody,
  targetUrl,
} from '../../../../src/drivers/neo4j/query-api';

describe('targetUrl', () => {
  it('builds the address from host and port', () => {
    expect(targetUrl('db.example.com', 7474, false).href).toBe('http://db.example.com:7474/');
    expect(targetUrl('db.example.com', undefined, false).href).toBe('http://db.example.com:7474/');
    expect(targetUrl('db.example.com', undefined, true).href).toBe('https://db.example.com/');
    expect(targetUrl('db.example.com', 7473, true).href).toBe('https://db.example.com:7473/');
    expect(targetUrl(undefined, undefined, false).href).toBe('http://localhost:7474/');
    expect(targetUrl('  ', 1, false).href).toBe('http://localhost:1/');
  });

  it('puts an IPv6 address in brackets', () => {
    expect(targetUrl('::1', 7474, false).href).toBe('http://[::1]:7474/');
    expect(targetUrl('[::1]', 7474, false).href).toBe('http://[::1]:7474/');
  });

  it('reads an address with a scheme', () => {
    expect(targetUrl('neo4j://db.example.com', undefined, false).href).toBe(
      'http://db.example.com/',
    );
    expect(targetUrl('neo4j+s://x.databases.neo4j.io', undefined, false).href).toBe(
      'https://x.databases.neo4j.io/',
    );
    expect(targetUrl('neo4j+ssc://x.io:7473', 9, false).href).toBe('https://x.io:7473/');
    expect(targetUrl('https://db.example.com', 7473, false).href).toBe(
      'https://db.example.com:7473/',
    );
    expect(targetUrl('http://db.example.com:8080', 7473, true).href).toBe(
      'http://db.example.com:8080/',
    );
  });
});

describe('basicAuthorization', () => {
  it('encodes user and password', () => {
    expect(basicAuthorization('neo4j', 'secret')).toBe(
      `Basic ${Buffer.from('neo4j:secret').toString('base64')}`,
    );
    expect(basicAuthorization('neo4j', undefined)).toBe(
      `Basic ${Buffer.from('neo4j:').toString('base64')}`,
    );
    expect(basicAuthorization(undefined, 'only')).toBe(
      `Basic ${Buffer.from(':only').toString('base64')}`,
    );
  });

  it('sends nothing for a server without sign-in', () => {
    expect(basicAuthorization(undefined, undefined)).toBeUndefined();
    expect(basicAuthorization('', '')).toBeUndefined();
  });

  it('keeps non-ASCII characters', () => {
    expect(basicAuthorization('ü', 'пароль')).toBe(
      `Basic ${Buffer.from('ü:пароль', 'utf8').toString('base64')}`,
    );
  });
});

describe('queryUrl', () => {
  it('addresses one database', () => {
    expect(queryUrl(new URL('http://h:7474'), 'neo4j').href).toBe(
      'http://h:7474/db/neo4j/query/v2',
    );
    expect(queryUrl(new URL('http://h:7474'), 'my db/x').pathname).toBe('/db/my%20db%2Fx/query/v2');
    expect(queryUrl(new URL('http://h:7474/prefix/'), 'a').pathname).toBe('/prefix/db/a/query/v2');
  });
});

describe('requestBody', () => {
  it('asks for counters, and for a read when the connection only reads', () => {
    expect(JSON.parse(requestBody('RETURN 1', undefined, false))).toEqual({
      statement: 'RETURN 1',
      includeCounters: true,
      accessMode: 'Write',
    });
    expect(JSON.parse(requestBody('RETURN $a', { a: 1 }, true))).toEqual({
      statement: 'RETURN $a',
      parameters: { a: 1 },
      includeCounters: true,
      accessMode: 'Read',
    });
  });
});

describe('readAnswer', () => {
  const ok = (body: unknown): { status: number; body: string } => ({
    status: 202,
    body: JSON.stringify(body),
  });

  it('reads fields, values, counters and notifications', () => {
    const answer = readAnswer(
      ok({
        data: { fields: ['a'], values: [[{ $type: 'Integer', _value: '1' }]] },
        counters: { nodesCreated: 1 },
        notifications: [{ description: 'careful' }, { nothing: 1 }, null],
      }),
    );
    expect(answer.fields).toEqual(['a']);
    expect(answer.values).toHaveLength(1);
    expect(answer.counters).toEqual({ nodesCreated: 1 });
    expect(answer.notifications).toEqual(['careful']);
  });

  it('has no counters or notifications when the server sent none', () => {
    const answer = readAnswer(ok({ data: { fields: [], values: [] } }));
    expect(answer.counters).toBeUndefined();
    expect(answer.notifications).toEqual([]);
  });

  it('throws the error of an HTTP failure', () => {
    expect(() =>
      readAnswer({
        status: 400,
        body: JSON.stringify({
          errors: [{ code: 'Neo.ClientError.Statement.SyntaxError', message: 'bad' }],
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'syntax', message: 'bad' }));
  });

  it('throws the error an answer carries in its body', () => {
    expect(() =>
      readAnswer(ok({ errors: [{ code: 'Neo.ClientError.Statement.AccessMode', message: 'no' }] })),
    ).toThrow(expect.objectContaining({ code: 'permission-denied' }));
  });

  it('refuses something that is not JSON, or has no result', () => {
    expect(() => readAnswer({ status: 200, body: '<html>' })).toThrow(/not JSON/u);
    expect(() => readAnswer(ok({ data: {} }))).toThrow(/without a result/u);
    expect(() => readAnswer(ok({}))).toThrow(DbError);
  });
});

describe('postQuery', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
    server = undefined;
  });

  async function serve(
    handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
  ): Promise<URL> {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        handler(request, response, Buffer.concat(chunks).toString('utf8'));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/q`);
  }

  it('posts JSON with the headers the Query API wants', async () => {
    let seen: { headers: IncomingMessage['headers']; body: string } | undefined;
    const url = await serve((request, response, body) => {
      seen = { headers: request.headers, body };
      response.statusCode = 202;
      response.end('{"ok":true}');
    });
    const answer = await postQuery(url, '{"a":1}', {
      authorization: 'Basic abc',
      agent: new Agent(),
      signal: undefined,
    });
    expect(answer).toEqual({ status: 202, body: '{"ok":true}' });
    expect(seen?.body).toBe('{"a":1}');
    expect(seen?.headers.authorization).toBe('Basic abc');
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(seen?.headers.accept).toBe('application/vnd.neo4j.query');
  });

  it('sends no authorization header when there is none', async () => {
    let header: string | undefined = 'unset';
    const url = await serve((request, response) => {
      header = request.headers.authorization;
      response.end('{}');
    });
    await postQuery(url, '{}', { authorization: undefined, agent: new Agent(), signal: undefined });
    expect(header).toBeUndefined();
  });

  it('gives up when the signal is aborted, as a cancel', async () => {
    const url = await serve(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = postQuery(url, '{}', {
      authorization: undefined,
      agent: new Agent(),
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('says so when the signal was a timeout', async () => {
    const url = await serve(() => {
      // Never answers.
    });
    await expect(
      postQuery(url, '{}', {
        authorization: undefined,
        agent: new Agent(),
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('does not even send when the signal is aborted already', async () => {
    const url = await serve((_request, response) => {
      response.end('{}');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      postQuery(url, '{}', {
        authorization: undefined,
        agent: new Agent(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('fails when nobody listens', async () => {
    const url = await serve((_request, response) => {
      response.end('{}');
    });
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
    server = undefined;
    await expect(
      postQuery(url, '{}', { authorization: undefined, agent: new Agent(), signal: undefined }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
