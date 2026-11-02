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
    consumersList: [],
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
    expect(() => rabbitObjectStateSchema.parse({ ...state, kind: 'database' })).toThrow();
    expect(() => rabbitObjectStateSchema.parse({ ...state, ready: -1 })).toThrow();
  });

  it('accepts the page of a virtual host with its connections, users and policies', () => {
    const vhost = {
      ...state,
      kind: 'vhost',
      name: '/',
      admin: {
        me: 'admin',
        connections: [
          {
            name: 'c1',
            user: 'app',
            state: 'running',
            protocol: 'AMQP 0-9-1',
            peer: '10.0.0.5:4000',
            channels: 1,
            connectedAt: '',
            clientName: '',
            product: '',
            received: '1 KB',
            sent: '2 KB',
          },
        ],
        connectionsTotal: 1,
        users: [
          {
            name: 'admin',
            tags: ['administrator'],
            permission: { configure: '', write: '', read: '' },
          },
          { name: 'idle', tags: [] },
        ],
        usersError: 'x',
        policies: [{ name: 'p', pattern: '.*', applyTo: 'all', priority: -1, definition: '{}' }],
      },
    };
    expect(rabbitObjectStateSchema.parse(vhost)).toEqual(vhost);
    expect(() =>
      rabbitObjectStateSchema.parse({
        ...vhost,
        admin: { ...vhost.admin, policies: [{ name: 'p' }] },
      }),
    ).toThrow();
    expect(() => rabbitObjectStateSchema.parse({ ...state, consumersList: undefined })).toThrow();
    const { consumersList } = {
      consumersList: [
        {
          tag: 't',
          connection: 'c',
          channel: 'ch',
          user: 'u',
          prefetch: 0,
          ackRequired: false,
          exclusive: false,
          active: true,
        },
      ],
    };
    expect(rabbitObjectStateSchema.parse({ ...state, consumersList }).consumersList).toEqual(
      consumersList,
    );
  });

  it('checks what the administration pages ask for', () => {
    const r = rabbitObjectProtocol.host.requests;
    expect(
      r.addBinding.params.parse({ direction: 'toQueue', peer: 'q', routingKey: '', arguments: '' })
        .direction,
    ).toBe('toQueue');
    expect(() =>
      r.addBinding.params.parse({
        direction: 'sideways',
        peer: 'q',
        routingKey: '',
        arguments: '',
      }),
    ).toThrow();
    expect(() =>
      r.addBinding.params.parse({ direction: 'toQueue', peer: '', routingKey: '', arguments: '' }),
    ).toThrow();
    expect(r.removeBinding.params.parse({ index: 0 })).toEqual({ index: 0 });
    expect(() => r.removeBinding.params.parse({ index: -1 })).toThrow();
    expect(() => r.closeConnection.params.parse({ name: '' })).toThrow();
    expect(r.createUser.params.parse({ name: 'a', password: '', tags: ['x'] }).tags).toEqual(['x']);
    expect(() => r.deleteUser.params.parse({})).toThrow();
    expect(
      r.setPermission.params.parse({ user: 'a', configure: '', write: '', read: '' }).user,
    ).toBe('a');
    expect(() => r.clearPermission.params.parse({ user: '' })).toThrow();
    expect(
      r.setPolicy.params.parse({
        name: 'p',
        pattern: '.*',
        applyTo: 'quorum_queues',
        priority: 3,
        definition: '{}',
      }).applyTo,
    ).toBe('quorum_queues');
    expect(() =>
      r.setPolicy.params.parse({
        name: 'p',
        pattern: '',
        applyTo: 'bindings',
        priority: 0,
        definition: '{}',
      }),
    ).toThrow();
    expect(() =>
      r.setPolicy.params.parse({
        name: 'p',
        pattern: '',
        applyTo: 'all',
        priority: 1.5,
        definition: '{}',
      }),
    ).toThrow();
    expect(() => r.deletePolicy.params.parse({ name: '' })).toThrow();
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
