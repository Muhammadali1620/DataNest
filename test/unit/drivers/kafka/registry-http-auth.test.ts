import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  globalRegistryFetch,
  registryAuthorization,
  SchemaRegistry,
} from '../../../../src/drivers/kafka/registry';
import { avroLong, avroString, framed } from '../../../helpers/wire-encoders';

// The registry's own sign-in over real HTTP (V13.41): a server that answers 401 unless the
// Authorization header is the one it wants, so the header that leaves the process is checked,
// not only the one a fake fetch was handed.

const SCHEMA = JSON.stringify({
  type: 'record',
  name: 'User',
  fields: [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'string' },
  ],
});

let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => {
    if (closing === undefined) {
      resolve();
      return;
    }
    closing.close(() => {
      resolve();
    });
    closing.closeAllConnections();
  });
});

async function registryWanting(
  authorization: string,
): Promise<{ url: string; seen: (string | undefined)[] }> {
  const seen: (string | undefined)[] = [];
  const listening = createServer((request: IncomingMessage, response) => {
    seen.push(request.headers.authorization);
    if (request.headers.authorization !== authorization) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"message":"unauthorized"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ schema: SCHEMA }));
  });
  server = listening;
  await new Promise<void>((resolve) => {
    listening.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listening.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

const message = framed(3, avroLong(8), avroString('Zoe'));

async function decodeWith(url: string, header: string | undefined): Promise<string | undefined> {
  const out = await new SchemaRegistry(url, globalRegistryFetch, header).decode(message);
  return out === undefined ? undefined : Buffer.from(out.bytes).toString('utf8');
}

describe('the registry signs in with a login of its own, over HTTP', () => {
  it('a Basic user of its own that is not the connection login opens the registry', async () => {
    const { url, seen } = await registryWanting(
      `Basic ${Buffer.from('reg:p@ss:word').toString('base64')}`,
    );
    const header = registryAuthorization(
      { sasl: 'plain', registry: url, registryAuth: 'basic', registryUser: 'reg' },
      { user: 'broker-user', password: 'broker-pass' },
      'p@ss:word',
    );
    expect(await decodeWith(url, header)).toBe('{"id":8,"name":"Zoe"}');
    expect(seen).toEqual([header]);
  });

  it('a Bearer token opens a registry that wants one', async () => {
    const { url } = await registryWanting('Bearer eyJ.tok.en');
    const header = registryAuthorization(
      { sasl: 'none', registry: url, registryAuth: 'bearer' },
      { user: 'broker-user', password: 'broker-pass' },
      'eyJ.tok.en',
    );
    expect(await decodeWith(url, header)).toBe('{"id":8,"name":"Zoe"}');
  });

  it('the connection login does not open a registry that wants a token, and the message stays bytes', async () => {
    const { url, seen } = await registryWanting('Bearer secret');
    const header = registryAuthorization(
      { sasl: 'plain', registry: url },
      { user: 'broker-user', password: 'broker-pass' },
      undefined,
    );
    expect(await decodeWith(url, header)).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^Basic /);
  });

  it('a wrong secret is refused, and a registry told to use a token sends nothing without one', async () => {
    const { url, seen } = await registryWanting('Bearer right');
    const bearer = { sasl: 'none', registry: url, registryAuth: 'bearer' } as const;
    expect(await decodeWith(url, registryAuthorization(bearer, {}, 'wrong'))).toBeUndefined();
    expect(
      await decodeWith(url, registryAuthorization(bearer, { user: 'u' }, undefined)),
    ).toBeUndefined();
    expect(seen).toEqual(['Bearer wrong', undefined]);
  });
});
