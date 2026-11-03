import { describe, expect, it } from 'vitest';
import type { RegistryFetch } from '../../../../src/drivers/kafka/registry';
import { openKafkaSession } from '../../../../src/drivers/kafka/session';
import type { ResolvedKafkaConfig } from '../../../../src/drivers/kafka-driver';
import { FakeKafka } from '../../../helpers/fake-kafka';
import { avroLong, avroString, framed } from '../../../helpers/wire-encoders';

const SCHEMA = JSON.stringify({
  type: 'record',
  name: 'User',
  fields: [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'string' },
  ],
});

function config(extra: Partial<ResolvedKafkaConfig> = {}): ResolvedKafkaConfig {
  return {
    id: 'k',
    name: 'Kafka',
    driver: 'kafka',
    host: 'broker',
    port: 9092,
    kafka: { sasl: 'none', registry: 'http://registry:8081' },
    ...extra,
  };
}

function registryFetch(): { fetcher: RegistryFetch; headers: Record<string, string>[] } {
  const headers: Record<string, string>[] = [];
  const fetcher: RegistryFetch = (url, init) => {
    headers.push(init.headers);
    const ok = url.endsWith('/schemas/ids/4');
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      json: () => Promise.resolve({ schema: SCHEMA }),
    });
  };
  return { fetcher, headers };
}

const text = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString('utf8');

const user = (id: number, name: string): Buffer => framed(4, avroLong(id), avroString(name));

function cluster(): FakeKafka {
  const fake = new FakeKafka();
  fake.addTopic('users', 1);
  fake.append('users', 0, user(1, 'Ann'), { key: 'plain-key' });
  fake.append('users', 0, 'just text');
  fake.append('users', 0, framed(77, Buffer.from('x')));
  fake.append('users', 0, null);
  return fake;
}

describe('reading messages through a schema registry (V13.34)', () => {
  it('shows a message with a registry schema decoded and leaves the others as they are', async () => {
    const { fetcher } = registryFetch();
    const session = await openKafkaSession(config(), cluster().factory, fetcher);
    const messages = await session.readMessages({
      topic: 'users',
      partition: 0,
      count: 10,
      maxBytes: 1_000_000,
      fromOffset: '0',
    });
    expect(messages.map((one) => text(one.value))).toEqual([
      '{"id":1,"name":"Ann"}',
      'just text',
      expect.stringContaining('x'),
      null,
    ]);
    expect(messages[0]?.schema).toEqual({ id: 4, format: 'AVRO' });
    expect(text(messages[0]?.key ?? null)).toBe('plain-key');
    expect(messages[1]?.schema).toBeUndefined();
    expect(messages[2]?.schema).toBeUndefined();
    expect(Buffer.from(messages[2]?.value ?? []).equals(framed(77, Buffer.from('x')))).toBe(true);
  });

  it('decodes a key written with a schema as well', async () => {
    const fake = new FakeKafka();
    fake.addTopic('keys', 1);
    fake.append('keys', 0, 'v', { key: user(2, 'Bob') });
    const session = await openKafkaSession(config(), fake.factory, registryFetch().fetcher);
    const [message] = await session.readMessages({
      topic: 'keys',
      partition: 0,
      count: 1,
      maxBytes: 1_000_000,
      fromOffset: '0',
    });
    expect(text(message?.key ?? null)).toBe('{"id":2,"name":"Bob"}');
    expect(text(message?.value ?? null)).toBe('v');
    expect(message?.schema).toEqual({ id: 4, format: 'AVRO' });
  });

  it('decodes what a live watch brings', async () => {
    const fake = new FakeKafka();
    fake.addTopic('live', 1);
    const session = await openKafkaSession(config(), fake.factory, registryFetch().fetcher);
    const abort = new AbortController();
    const got: (string | null)[] = [];
    const done = session.watchMessages(
      { topic: 'live', partition: 0, signal: abort.signal },
      (messages) => {
        got.push(...messages.map((one) => text(one.value)));
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    fake.append('live', 0, user(3, 'Cy'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    abort.abort();
    await done;
    expect(got).toEqual(['{"id":3,"name":"Cy"}']);
  });

  it('shows the bytes as they are when no registry is set', async () => {
    const fake = cluster();
    const session = await openKafkaSession(config({ kafka: { sasl: 'none' } }), fake.factory);
    const [first] = await session.readMessages({
      topic: 'users',
      partition: 0,
      count: 1,
      maxBytes: 1_000_000,
      fromOffset: '0',
    });
    expect(first?.schema).toBeUndefined();
    expect(Buffer.from(first?.value ?? []).equals(user(1, 'Ann'))).toBe(true);
  });

  it('signs in to the registry with the connection user and password', async () => {
    const { fetcher, headers } = registryFetch();
    const session = await openKafkaSession(
      config({ user: 'ann', password: 's3' }),
      cluster().factory,
      fetcher,
    );
    await session.readMessages({
      topic: 'users',
      partition: 0,
      count: 1,
      maxBytes: 1_000_000,
      fromOffset: '0',
    });
    expect(headers[0]?.authorization).toBe(`Basic ${Buffer.from('ann:s3').toString('base64')}`);
  });

  it('asks without a sign-in when the connection has no user', async () => {
    const { fetcher, headers } = registryFetch();
    const session = await openKafkaSession(config(), cluster().factory, fetcher);
    await session.readMessages({
      topic: 'users',
      partition: 0,
      count: 1,
      maxBytes: 1_000_000,
      fromOffset: '0',
    });
    expect(headers[0]?.authorization).toBeUndefined();
  });

  describe('a sign-in of its own (V13.41)', () => {
    async function headerWith(extra: Partial<ResolvedKafkaConfig>): Promise<string | undefined> {
      const { fetcher, headers } = registryFetch();
      const session = await openKafkaSession(config(extra), cluster().factory, fetcher);
      await session.readMessages({
        topic: 'users',
        partition: 0,
        count: 1,
        maxBytes: 1_000_000,
        fromOffset: '0',
      });
      return headers[0]?.authorization;
    }
    const kafka = (extra: object): ResolvedKafkaConfig['kafka'] => ({
      sasl: 'plain',
      registry: 'http://registry:8081',
      ...extra,
    });

    it('uses a user of its own and its secret, not the connection login', async () => {
      const header = await headerWith({
        user: 'ann',
        password: 'conn-secret',
        kafka: kafka({ registryAuth: 'basic', registryUser: 'reg' }),
        registrySecret: 'reg-secret',
      });
      expect(header).toBe(`Basic ${Buffer.from('reg:reg-secret').toString('base64')}`);
    });

    it('sends a token as Bearer', async () => {
      const header = await headerWith({
        user: 'ann',
        password: 'conn-secret',
        kafka: kafka({ registryAuth: 'bearer' }),
        registrySecret: 'tok.en',
      });
      expect(header).toBe('Bearer tok.en');
    });

    it('never lends the connection login to a registry told to use its own', async () => {
      expect(
        await headerWith({
          user: 'ann',
          password: 'conn-secret',
          kafka: kafka({ registryAuth: 'bearer' }),
        }),
      ).toBeUndefined();
      expect(
        await headerWith({
          user: 'ann',
          password: 'conn-secret',
          kafka: kafka({ registryAuth: 'basic' }),
          registrySecret: 'x',
        }),
      ).toBeUndefined();
    });

    it('still follows the connection with registryAuth connection', async () => {
      const header = await headerWith({
        user: 'ann',
        password: 's3',
        kafka: kafka({ registryAuth: 'connection' }),
        registrySecret: 'ignored',
      });
      expect(header).toBe(`Basic ${Buffer.from('ann:s3').toString('base64')}`);
    });
  });
});
