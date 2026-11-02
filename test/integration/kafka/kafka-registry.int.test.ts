import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/kafka';
import type { KafkaSession } from '../../../src/drivers/kafka-driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { TEST_KAFKA, TEST_REGISTRY } from '../../helpers/kafka-servers';
import {
  avroLong,
  avroString,
  framed,
  pbBytes,
  pbIndexes,
  pbVarint,
} from '../../helpers/wire-encoders';

// docker/compose.yml `schema-registry` (V13.34): Apicurio in memory, Confluent-compatible API.
const config: ResolvedConnectionConfig = {
  id: 'test-kafka-registry',
  name: 'Kafka with a registry',
  driver: 'kafka',
  host: TEST_KAFKA.host,
  port: TEST_KAFKA.port,
  kafka: { sasl: 'none', registry: TEST_REGISTRY.url },
};

const unique = (name: string): string => `dn-it-${name}-${randomUUID().slice(0, 8)}`;

async function waitForRegistry(): Promise<void> {
  const deadline = Date.now() + 90_000;
  const origin = new URL(TEST_REGISTRY.url).origin;
  for (;;) {
    try {
      const response = await fetch(`${origin}/health/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error('The schema registry did not become ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function register(subject: string, schema: string, schemaType?: string): Promise<number> {
  const response = await fetch(`${TEST_REGISTRY.url}/subjects/${subject}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.schemaregistry.v1+json' },
    body: JSON.stringify({ schema, ...(schemaType === undefined ? {} : { schemaType }) }),
  });
  if (!response.ok) {
    throw new Error(`Registering ${subject}: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: number }).id;
}

const AVRO = JSON.stringify({
  type: 'record',
  name: 'User',
  namespace: 'demo',
  fields: [
    { name: 'id', type: 'int' },
    { name: 'name', type: 'string' },
    { name: 'email', type: ['null', 'string'], default: null },
  ],
});
const PROTO = `syntax = "proto3";
package demo;
message Order { int32 id = 1; string item = 2; repeated int32 qty = 3; Status st = 4; enum Status { NEW = 0; DONE = 1; } }
message Refund { int32 order = 1; }`;
const JSON_SCHEMA = '{"type":"object","properties":{"a":{"type":"string"}}}';

describe('Kafka through a schema registry (V13.34)', () => {
  let session: KafkaSession;
  let topic = '';
  const outside = new Kafka({
    clientId: 'dn-it-registry',
    brokers: [`${TEST_KAFKA.host}:${TEST_KAFKA.port}`],
    logLevel: logLevel.NOTHING,
  });

  beforeAll(async () => {
    await waitForRegistry();
    session = await driver.openSession(config);
    topic = unique('registry');
    await session.createTopic(topic, 1, 1);
    const avro = await register(`${topic}-avro`, AVRO);
    const proto = await register(`${topic}-proto`, PROTO, 'PROTOBUF');
    const json = await register(`${topic}-json`, JSON_SCHEMA, 'JSON');
    const producer = outside.producer();
    await producer.connect();
    await producer.send({
      topic,
      messages: [
        {
          value: framed(avro, avroLong(1), avroString('Ann'), avroLong(1), avroString('a@x.io')),
        },
        {
          value: framed(
            proto,
            pbIndexes([0]),
            pbVarint(1, 5),
            pbBytes(2, 'pen'),
            pbBytes(3, Buffer.concat([Buffer.from([1, 2])])),
            pbVarint(4, 1),
          ),
        },
        { value: framed(proto, pbIndexes([1]), pbVarint(1, 5)) },
        { value: framed(json, Buffer.from('{"a":"b"}')) },
        { value: Buffer.from('plain text, no schema') },
        { value: framed(987654, Buffer.from('unknown id')) },
      ],
    });
    await producer.disconnect();
  }, 180_000);

  afterAll(async () => {
    await session.deleteTopic(topic).catch(() => undefined);
    await session.close();
  });

  it('shows Avro, Protobuf and JSON Schema messages decoded, and the rest as they are', async () => {
    const messages = await session.readMessages({
      topic,
      partition: 0,
      count: 10,
      maxBytes: 1_000_000,
      fromOffset: '0',
    });
    const shown = messages.map((one) => ({
      value: one.value === null ? null : Buffer.from(one.value).toString('utf8'),
      schema: one.schema?.format,
    }));
    expect(shown[0]).toEqual({
      value: '{"id":1,"name":"Ann","email":"a@x.io"}',
      schema: 'AVRO',
    });
    expect(shown[1]).toEqual({
      value: '{"id":5,"item":"pen","qty":[1,2],"st":"DONE"}',
      schema: 'PROTOBUF',
    });
    expect(shown[2]).toEqual({ value: '{"order":5}', schema: 'PROTOBUF' });
    expect(shown[3]).toEqual({ value: '{"a":"b"}', schema: 'JSON' });
    expect(shown[4]).toEqual({ value: 'plain text, no schema', schema: undefined });
    expect(shown[5]?.schema).toBeUndefined();
    expect(messages[5]?.value?.[0]).toBe(0);
  });

  it('takes no decoding from a connection without a registry', async () => {
    const bare = await driver.openSession({ ...config, kafka: { sasl: 'none' } });
    try {
      const [first] = await bare.readMessages({
        topic,
        partition: 0,
        count: 1,
        maxBytes: 1_000_000,
        fromOffset: '0',
      });
      expect(first?.schema).toBeUndefined();
      expect(first?.value?.[0]).toBe(0);
    } finally {
      await bare.close();
    }
  });

  it('shows the bytes when the registry cannot be reached', async () => {
    const lost = await driver.openSession({
      ...config,
      kafka: { sasl: 'none', registry: 'http://127.0.0.1:7999' },
    });
    try {
      const [first] = await lost.readMessages({
        topic,
        partition: 0,
        count: 1,
        maxBytes: 1_000_000,
        fromOffset: '0',
      });
      expect(first?.schema).toBeUndefined();
      expect(first?.value?.[0]).toBe(0);
    } finally {
      await lost.close();
    }
  });
});
