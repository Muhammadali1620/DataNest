import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTS,
  driverFamily,
  filterSupport,
  isSqlDriver,
  KAFKA_SASL_MECHANISMS,
  optionSupport,
  SQL_DRIVER_IDS,
} from '../../../src/shared/connection';
import { connectionInputSchema, kafkaSchema } from '../../../src/shared/connection-schema';
import { dbMarkFile } from '../../../src/shared/db-marks';
import {
  DEFAULT_KAFKA_COUNT,
  kafkaMessageSchema,
  kafkaTopicProtocol,
  kafkaTopicStateSchema,
  MAX_KAFKA_COUNT,
} from '../../../src/shared/protocols/kafka-topic';

describe('Kafka connections (V13.23)', () => {
  it('are a family of their own, apart from SQL', () => {
    expect(driverFamily('kafka')).toBe('kafka');
    expect(isSqlDriver('kafka')).toBe(false);
    expect(SQL_DRIVER_IDS).not.toContain('kafka');
  });

  it('listen on 9092 by default', () => {
    expect(DEFAULT_PORTS.kafka).toBe(9092);
  });

  it('take timeouts and TLS like the other network drivers, and run nothing on connect', () => {
    expect(optionSupport('kafka')).toMatchObject({
      connectTimeout: true,
      keepAlive: true,
      tls: true,
      init: false,
      timeZone: false,
    });
  });

  it('have no databases or schemas to filter', () => {
    expect(filterSupport('kafka')).toEqual({ databases: false, schemas: false });
  });

  it('offer four ways to sign in', () => {
    expect([...KAFKA_SASL_MECHANISMS]).toEqual(['none', 'plain', 'scram-sha-256', 'scram-sha-512']);
  });

  it('read the SASL mechanism from a saved connection, and refuse an unknown one', () => {
    for (const sasl of KAFKA_SASL_MECHANISMS) {
      expect(kafkaSchema.parse({ sasl })).toEqual({ sasl });
    }
    expect(() => kafkaSchema.parse({ sasl: 'gssapi' })).toThrow();
    expect(() => kafkaSchema.parse({})).toThrow();
    const parsed = connectionInputSchema.parse({
      name: 'k',
      driver: 'kafka',
      host: 'a:9092,b:9092',
      kafka: { sasl: 'plain' },
    });
    expect(parsed.kafka).toEqual({ sasl: 'plain' });
  });

  it('have a mark of their own in every state', () => {
    const files = (['on', 'off', 'error'] as const).map((state) => dbMarkFile('kafka', state));
    expect(new Set(files).size).toBe(3);
    expect(files.every((file) => file.startsWith('kafka'))).toBe(true);
  });
});

describe('the topic page protocol', () => {
  const message = {
    partition: 0,
    offset: '12',
    timestamp: '1700000000000',
    key: { text: 'k' },
    value: null,
    headers: [{ name: 'h', value: { text: 'v' } }],
  };
  const state = {
    topic: 'orders',
    internal: false,
    connectionName: 'Local',
    readOnly: false,
    partitions: [{ partition: 0, low: '0', high: '5', leader: 1, replicas: 1, inSync: 1 }],
    partition: 0,
    mode: 'last',
    count: DEFAULT_KAFKA_COUNT,
    messages: [message],
    read: true,
    notice: 'hello',
  };

  it('accepts a full state, a tombstone and a missing notice', () => {
    expect(kafkaTopicStateSchema.parse(state)).toEqual(state);
    const { notice: _notice, ...bare } = state;
    expect(kafkaTopicStateSchema.parse(bare)).toEqual(bare);
    expect(kafkaMessageSchema.parse(message).value).toBeNull();
  });

  it('refuses a count outside what a read may bring, and an unknown mode', () => {
    expect(() => kafkaTopicStateSchema.parse({ ...state, count: 0 })).toThrow();
    expect(() => kafkaTopicStateSchema.parse({ ...state, count: MAX_KAFKA_COUNT + 1 })).toThrow();
    expect(() => kafkaTopicStateSchema.parse({ ...state, mode: 'all' })).toThrow();
  });

  it('checks what the page asks for', () => {
    const { read, produce } = kafkaTopicProtocol.host.requests;
    expect(read.params.parse({ partition: 1, mode: 'offset', count: 10, offset: '7' })).toEqual({
      partition: 1,
      mode: 'offset',
      count: 10,
      offset: '7',
    });
    expect(() => read.params.parse({ partition: -1, mode: 'last', count: 10 })).toThrow();
    expect(
      produce.params.parse({ value: null, headers: [{ name: 'a', value: 'b' }] }).value,
    ).toBeNull();
    expect(() => produce.params.parse({ value: { text: 'x' } })).toThrow();
  });
});
