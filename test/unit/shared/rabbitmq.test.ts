import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTS,
  driverFamily,
  filterSupport,
  isSqlDriver,
  optionSupport,
  SQL_DRIVER_IDS,
} from '../../../src/shared/connection';
import { connectionInputSchema } from '../../../src/shared/connection-schema';
import { dbMarkFile } from '../../../src/shared/db-marks';
import {
  DEFAULT_RABBIT_PEEK,
  MAX_RABBIT_PEEK,
  rabbitMessageSchema,
  rabbitObjectProtocol,
  rabbitObjectStateSchema,
} from '../../../src/shared/protocols/rabbitmq-object';

describe('RabbitMQ connections (V13.26)', () => {
  it('are a family of their own, apart from SQL', () => {
    expect(driverFamily('rabbitmq')).toBe('rabbitmq');
    expect(isSqlDriver('rabbitmq')).toBe(false);
    expect(SQL_DRIVER_IDS).not.toContain('rabbitmq');
  });

  it('listen on the management plugin’s port by default, not the AMQP one', () => {
    expect(DEFAULT_PORTS.rabbitmq).toBe(15672);
  });

  it('take timeouts and TLS like the other network drivers, and run nothing on connect', () => {
    expect(optionSupport('rabbitmq')).toMatchObject({
      connectTimeout: true,
      keepAlive: true,
      tls: true,
      init: false,
      timeZone: false,
    });
  });

  it('have no databases or schemas to filter', () => {
    expect(filterSupport('rabbitmq')).toEqual({ databases: false, schemas: false });
  });

  it('read from a saved connection, with the virtual host as the database', () => {
    const parsed = connectionInputSchema.parse({
      name: 'mq',
      driver: 'rabbitmq',
      host: 'mq.example',
      user: 'bob',
      database: 'app',
    });
    expect(parsed).toMatchObject({ driver: 'rabbitmq', database: 'app' });
  });

  it('have a mark of their own in every state', () => {
    const files = (['on', 'off', 'error'] as const).map((state) => dbMarkFile('rabbitmq', state));
    expect(new Set(files).size).toBe(3);
    expect(files.every((file) => file.startsWith('rabbitmq'))).toBe(true);
  });
});

describe('the queue and exchange page protocol', () => {
  const message = {
    payload: { text: 'hello' },
    payloadBytes: 5,
    redelivered: true,
    exchange: '',
    routingKey: 'orders',
    messagesLeft: 2,
    properties: '{}',
  };
  const state = {
    kind: 'queue',
    vhost: '/',
    name: 'orders',
    connectionName: 'Local',
    readOnly: false,
    type: 'classic',
    state: 'running',
    ready: 2,
    unacked: 0,
    total: 2,
    consumers: 1,
    facts: [{ key: 'Type', value: 'classic' }],
    arguments: [],
    bindings: [
      {
        source: 'x',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'k',
        arguments: '',
      },
    ],
    bindingsCut: false,
    count: DEFAULT_RABBIT_PEEK,
    messages: [message],
    peeked: true,
    notice: 'hello',
  };

  it('accepts a full state and a missing notice', () => {
    expect(rabbitObjectStateSchema.parse(state)).toEqual(state);
    const { notice: _notice, ...bare } = state;
    expect(rabbitObjectStateSchema.parse(bare)).toEqual(bare);
    expect(rabbitMessageSchema.parse(message).redelivered).toBe(true);
  });

  it('refuses a count a peek may not bring, an unknown kind and a negative figure', () => {
    expect(() => rabbitObjectStateSchema.parse({ ...state, count: 0 })).toThrow();
    expect(() => rabbitObjectStateSchema.parse({ ...state, count: MAX_RABBIT_PEEK + 1 })).toThrow();
    expect(() => rabbitObjectStateSchema.parse({ ...state, kind: 'vhost' })).toThrow();
    expect(() => rabbitObjectStateSchema.parse({ ...state, ready: -1 })).toThrow();
  });

  it('checks what the page asks for', () => {
    const { peek, publish } = rabbitObjectProtocol.host.requests;
    expect(peek.params.parse({ count: 5 })).toEqual({ count: 5 });
    expect(() => peek.params.parse({ count: 0 })).toThrow();
    expect(() => peek.params.parse({ count: MAX_RABBIT_PEEK + 1 })).toThrow();
    expect(
      publish.params.parse({
        routingKey: 'k',
        payload: { text: 'x' },
        persistent: true,
        headers: [{ name: 'a', value: 'b' }],
      }).persistent,
    ).toBe(true);
    expect(() => publish.params.parse({ routingKey: 'k', payload: { text: 'x' } })).toThrow();
  });
});
