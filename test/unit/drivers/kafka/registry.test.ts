import { describe, expect, it, vi } from 'vitest';
import {
  basicAuth,
  registryAuthorization,
  isRegistryUrl,
  SchemaRegistry,
  type RegistryFetch,
} from '../../../../src/drivers/kafka/registry';
import {
  avroLong,
  avroString,
  framed,
  pbBytes,
  pbIndexes,
  pbVarint,
} from '../../../helpers/wire-encoders';

const AVRO = JSON.stringify({
  type: 'record',
  name: 'User',
  fields: [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'string' },
  ],
});
const PROTO = 'syntax = "proto3"; message A { string x = 1; } message B { int32 n = 1; }';

function fakeRegistry(schemas: Record<number, { schema: string; schemaType?: string }>): {
  fetcher: RegistryFetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: RegistryFetch = (url, init) => {
    calls.push({ url, headers: init.headers });
    const id = Number(url.split('/').pop());
    const found = schemas[id];
    return Promise.resolve(
      found === undefined
        ? { ok: false, status: 404, json: () => Promise.resolve({}) }
        : { ok: true, status: 200, json: () => Promise.resolve(found) },
    );
  };
  return { fetcher, calls };
}

const textOf = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');

describe('isRegistryUrl (V13.34)', () => {
  it('takes http and https addresses only', () => {
    expect(isRegistryUrl('http://localhost:8081')).toBe(true);
    expect(isRegistryUrl('https://registry.example/apis/ccompat/v7')).toBe(true);
    expect(isRegistryUrl('ftp://x')).toBe(false);
    expect(isRegistryUrl('localhost:8081')).toBe(false);
    expect(isRegistryUrl('')).toBe(false);
  });
});

describe('SchemaRegistry (V13.34)', () => {
  it('decodes an Avro message and asks for the schema once', async () => {
    const { fetcher, calls } = fakeRegistry({ 7: { schema: AVRO } });
    const registry = new SchemaRegistry('http://r:8081/', fetcher);
    const bytes = framed(7, avroLong(5), avroString('Ann'));
    const first = await registry.decode(bytes);
    const second = await registry.decode(bytes);
    expect(first).toMatchObject({ id: 7, format: 'AVRO' });
    expect(textOf(first?.bytes)).toBe('{"id":5,"name":"Ann"}');
    expect(textOf(second?.bytes)).toBe('{"id":5,"name":"Ann"}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://r:8081/schemas/ids/7');
    expect(calls[0]?.headers.accept).toContain('application/json');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('sends the Basic header when it has one', async () => {
    const { fetcher, calls } = fakeRegistry({ 1: { schema: AVRO } });
    const registry = new SchemaRegistry('http://r', fetcher, basicAuth('u', 'p:w'));
    await registry.decode(framed(1, avroLong(1), avroString('a')));
    expect(calls[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('u:p:w').toString('base64')}`,
    );
  });

  it('decodes Protobuf with the message the index path names', async () => {
    const { fetcher } = fakeRegistry({ 2: { schema: PROTO, schemaType: 'PROTOBUF' } });
    const registry = new SchemaRegistry('http://r', fetcher);
    const second = await registry.decode(framed(2, pbIndexes([1]), pbVarint(1, 9)));
    expect(second).toMatchObject({ id: 2, format: 'PROTOBUF' });
    expect(textOf(second?.bytes)).toBe('{"n":9}');
    const first = await registry.decode(framed(2, pbIndexes([0]), pbBytes(1, 'z')));
    expect(textOf(first?.bytes)).toBe('{"x":"z"}');
  });

  it('reads the short header of Protobuf (a single zero byte) as the first message', async () => {
    const { fetcher } = fakeRegistry({ 2: { schema: PROTO, schemaType: 'PROTOBUF' } });
    const registry = new SchemaRegistry('http://r', fetcher);
    const out = await registry.decode(framed(2, Buffer.from([0]), pbBytes(1, 'z')));
    expect(textOf(out?.bytes)).toBe('{"x":"z"}');
  });

  it('passes JSON Schema data on as written', async () => {
    const { fetcher } = fakeRegistry({ 3: { schema: '{"type":"object"}', schemaType: 'JSON' } });
    const registry = new SchemaRegistry('http://r', fetcher);
    const out = await registry.decode(framed(3, Buffer.from('{"a":1}')));
    expect(out).toMatchObject({ id: 3, format: 'JSON' });
    expect(textOf(out?.bytes)).toBe('{"a":1}');
  });

  it('leaves a message alone that is not framed', async () => {
    const { fetcher, calls } = fakeRegistry({});
    const registry = new SchemaRegistry('http://r', fetcher);
    expect(await registry.decode(Buffer.from('plain text'))).toBeUndefined();
    expect(await registry.decode(Buffer.from([0, 0, 0]))).toBeUndefined();
    expect(await registry.decode(Buffer.alloc(0))).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('leaves a message alone when the registry does not know the id, and does not ask again at once', async () => {
    const { fetcher, calls } = fakeRegistry({});
    let now = 1_000;
    const registry = new SchemaRegistry('http://r', fetcher, undefined, () => now);
    const bytes = framed(99, Buffer.from('x'));
    expect(await registry.decode(bytes)).toBeUndefined();
    expect(await registry.decode(bytes)).toBeUndefined();
    expect(calls).toHaveLength(1);
    now += 31_000;
    expect(await registry.decode(bytes)).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('leaves a message alone when the data does not fit the schema or the schema is broken', async () => {
    const { fetcher } = fakeRegistry({
      1: { schema: AVRO },
      2: { schema: 'not json' },
      3: { schema: 'message {', schemaType: 'PROTOBUF' },
      4: { schema: PROTO, schemaType: 'PROTOBUF' },
    });
    const registry = new SchemaRegistry('http://r', fetcher);
    expect(await registry.decode(framed(1, avroLong(1)))).toBeUndefined();
    expect(await registry.decode(framed(2, Buffer.from('x')))).toBeUndefined();
    expect(await registry.decode(framed(3, Buffer.from([0])))).toBeUndefined();
    expect(await registry.decode(framed(4, Buffer.from([0x80])))).toBeUndefined();
    expect(await registry.decode(framed(4, Buffer.from([0x7e, 0x01])))).toBeUndefined();
  });

  it('survives a registry that is down, sends no schema, or hangs', async () => {
    const down: RegistryFetch = () => Promise.reject(new Error('connection refused'));
    expect(
      await new SchemaRegistry('http://r', down).decode(framed(1, Buffer.from('x'))),
    ).toBeUndefined();
    const empty: RegistryFetch = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    expect(
      await new SchemaRegistry('http://r', empty).decode(framed(1, Buffer.from('x'))),
    ).toBeUndefined();
    vi.useFakeTimers();
    try {
      const hang: RegistryFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      const pending = new SchemaRegistry('http://r', hang).decode(framed(1, Buffer.from('x')));
      await vi.advanceTimersByTimeAsync(10_500);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets its schemas when it holds too many', async () => {
    const schemas: Record<number, { schema: string }> = {};
    for (let id = 0; id < 502; id += 1) {
      schemas[id] = { schema: '"int"' };
    }
    const { fetcher, calls } = fakeRegistry(schemas);
    const registry = new SchemaRegistry('http://r', fetcher);
    for (let id = 0; id < 502; id += 1) {
      await registry.decode(framed(id, avroLong(1)));
    }
    await registry.decode(framed(0, avroLong(1)));
    expect(calls.length).toBeGreaterThan(502);
  });
});

describe('registryAuthorization (V13.41)', () => {
  const basic = (user: string, password: string): string =>
    `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const login = { user: 'ann', password: 'pw' };

  it('follows the connection by default and with `connection`', () => {
    expect(registryAuthorization(undefined, login, 'x')).toBe(basic('ann', 'pw'));
    expect(registryAuthorization({ sasl: 'none' }, login, undefined)).toBe(basic('ann', 'pw'));
    expect(registryAuthorization({ sasl: 'none', registryAuth: 'connection' }, login, 'x')).toBe(
      basic('ann', 'pw'),
    );
  });

  it('asks without a sign-in when the connection has no user, even with an empty password', () => {
    expect(registryAuthorization(undefined, {}, undefined)).toBeUndefined();
    expect(registryAuthorization(undefined, { user: '  ' }, undefined)).toBeUndefined();
    expect(registryAuthorization(undefined, { user: 'ann' }, undefined)).toBe(basic('ann', ''));
  });

  it('signs in with a user of its own and the secret as password', () => {
    const kafka = { sasl: 'none', registryAuth: 'basic', registryUser: ' reg ' } as const;
    expect(registryAuthorization(kafka, login, 's3:cret')).toBe(basic('reg', 's3:cret'));
    // No secret stored: an empty password, not the connection's.
    expect(registryAuthorization(kafka, login, undefined)).toBe(basic('reg', ''));
  });

  it('sends nothing for `basic` without a user and for `bearer` without a token', () => {
    expect(
      registryAuthorization({ sasl: 'none', registryAuth: 'basic' }, login, 'x'),
    ).toBeUndefined();
    expect(
      registryAuthorization({ sasl: 'none', registryAuth: 'basic', registryUser: ' ' }, login, 'x'),
    ).toBeUndefined();
    expect(
      registryAuthorization({ sasl: 'none', registryAuth: 'bearer' }, login, ''),
    ).toBeUndefined();
    expect(
      registryAuthorization({ sasl: 'none', registryAuth: 'bearer' }, login, undefined),
    ).toBeUndefined();
  });

  it('sends a token as Bearer', () => {
    expect(registryAuthorization({ sasl: 'none', registryAuth: 'bearer' }, login, 'abc.def')).toBe(
      'Bearer abc.def',
    );
  });
});
