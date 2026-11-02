import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RabbitSession } from '../../../../src/drivers/rabbitmq-driver';
import { ManagedRabbitSession } from '../../../../src/services/rabbitmq/managed-rabbit-session';

function inner(overrides: Partial<RabbitSession> = {}): RabbitSession {
  const queue = {
    vhost: '/',
    name: 'q',
    type: 'classic',
    durable: true,
    autoDelete: false,
    exclusive: false,
    state: 'running',
    ready: 0,
    unacked: 0,
    total: 0,
    consumers: 0,
    memory: 0,
    policy: '',
    arguments: {},
    incomingRate: undefined,
    node: '',
    consumerDetails: [],
  };
  const exchange = {
    vhost: '/',
    name: 'x',
    type: 'direct',
    durable: true,
    autoDelete: false,
    internal: false,
    policy: '',
    arguments: {},
  };
  return {
    server: { version: '3.13.7', clusterName: 'c', user: 'guest' },
    listVhosts: () => Promise.resolve([{ name: '/', messages: 0 }]),
    listQueues: () => Promise.resolve({ items: [queue], total: 1 }),
    listExchanges: () => Promise.resolve({ items: [exchange], total: 1 }),
    getQueue: () => Promise.resolve(queue),
    getExchange: () => Promise.resolve(exchange),
    listBindings: () => Promise.resolve([]),
    peekMessages: () => Promise.resolve([]),
    publish: () => Promise.resolve(true),
    declareQueue: () => Promise.resolve(),
    deleteQueue: () => Promise.resolve(),
    purgeQueue: () => Promise.resolve(),
    declareExchange: () => Promise.resolve(),
    deleteExchange: () => Promise.resolve(),
    bind: () => Promise.resolve(),
    unbind: () => Promise.resolve(),
    listConnections: () => Promise.resolve({ items: [], total: 0 }),
    closeConnection: () => Promise.resolve(),
    listUsers: () => Promise.resolve([{ name: 'u', tags: [] }]),
    createUser: () => Promise.resolve(),
    updateUser: () => Promise.resolve(),
    createVhost: () => Promise.resolve(),
    deleteVhost: () => Promise.resolve(),
    deleteUser: () => Promise.resolve(),
    listPermissions: () => Promise.resolve([]),
    setPermission: () => Promise.resolve(),
    clearPermission: () => Promise.resolve(),
    listPolicies: () => Promise.resolve([]),
    setPolicy: () => Promise.resolve(),
    deletePolicy: () => Promise.resolve(),
    readCluster: () =>
      Promise.resolve({
        clusterName: '',
        version: '',
        erlang: '',
        node: '',
        queues: 0,
        exchanges: 0,
        connections: 0,
        channels: 0,
        consumers: 0,
        ready: 0,
        unacked: 0,
        listeners: [],
        nodes: [],
      }),
    listGlobalParameters: () => Promise.resolve([]),
    listVhostLimits: () => Promise.resolve({}),
    setVhostLimit: () => Promise.resolve(),
    clearVhostLimit: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

describe('ManagedRabbitSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes every call to the session', async () => {
    const calls: string[] = [];
    const note =
      (name: string) =>
      (...args: unknown[]): Promise<void> => {
        calls.push(`${name} ${args.map((one) => JSON.stringify(one)).join(' ')}`);
        return Promise.resolve();
      };
    const managed = new ManagedRabbitSession(
      inner({
        deleteQueue: note('deleteQueue'),
        purgeQueue: note('purgeQueue'),
        deleteExchange: note('deleteExchange'),
        declareQueue: note('declareQueue'),
        declareExchange: note('declareExchange'),
        bind: note('bind'),
        unbind: note('unbind'),
        closeConnection: note('closeConnection'),
        createUser: note('createUser'),
        updateUser: note('updateUser'),
        createVhost: note('createVhost'),
        deleteVhost: note('deleteVhost'),
        deleteUser: note('deleteUser'),
        setPermission: note('setPermission'),
        clearPermission: note('clearPermission'),
        setPolicy: note('setPolicy'),
        deletePolicy: note('deletePolicy'),
      }),
      { onLinkLost: () => undefined },
    );
    expect(managed.server).toEqual({ version: '3.13.7', clusterName: 'c', user: 'guest' });
    expect(await managed.listVhosts()).toEqual([{ name: '/', messages: 0 }]);
    expect((await managed.listQueues('/')).total).toBe(1);
    expect((await managed.listExchanges('/')).total).toBe(1);
    expect((await managed.getQueue('/', 'q')).name).toBe('q');
    expect((await managed.getExchange('/', 'x')).name).toBe('x');
    expect(await managed.listBindings('/', { queue: 'q' })).toEqual([]);
    expect(await managed.peekMessages({ vhost: '/', queue: 'q', count: 1, maxBytes: 1 })).toEqual(
      [],
    );
    expect(
      await managed.publish({
        vhost: '/',
        exchange: '',
        routingKey: 'q',
        payload: new Uint8Array(),
      }),
    ).toBe(true);
    await managed.deleteQueue('/', 'q');
    await managed.purgeQueue('/', 'q');
    await managed.deleteExchange('/', 'x');
    await managed.declareQueue({ vhost: '/', name: 'n', durable: true, autoDelete: false });
    await managed.declareExchange({
      vhost: '/',
      name: 'e',
      type: 'topic',
      durable: true,
      autoDelete: false,
      internal: false,
    });
    const binding = {
      source: 'x',
      destination: 'q',
      destinationType: 'queue' as const,
      routingKey: 'k',
      arguments: {},
      propertiesKey: 'k',
    };
    await managed.bind('/', binding);
    await managed.unbind('/', binding);
    expect((await managed.listConnections('/')).total).toBe(0);
    await managed.closeConnection('c');
    expect(await managed.listUsers()).toEqual([{ name: 'u', tags: [] }]);
    await managed.createUser({ name: 'n', password: 'p', tags: [] });
    await managed.updateUser('n', { password: 'q', tags: ['management'] });
    await managed.deleteUser('n');
    await managed.createVhost('v');
    await managed.deleteVhost('v');
    expect(await managed.listPermissions('/')).toEqual([]);
    const permission = { user: 'u', configure: '.*', write: '.*', read: '.*' };
    await managed.setPermission('/', permission);
    await managed.clearPermission('/', 'u');
    expect(await managed.listPolicies('/')).toEqual([]);
    const policy = {
      vhost: '/',
      name: 'p',
      pattern: '.*',
      applyTo: 'all',
      priority: 0,
      definition: {},
    };
    await managed.setPolicy(policy);
    await managed.deletePolicy('/', 'p');
    expect(calls).toEqual([
      'deleteQueue "/" "q"',
      'purgeQueue "/" "q"',
      'deleteExchange "/" "x"',
      'declareQueue {"vhost":"/","name":"n","durable":true,"autoDelete":false}',
      'declareExchange {"vhost":"/","name":"e","type":"topic","durable":true,"autoDelete":false,"internal":false}',
      `bind "/" ${JSON.stringify(binding)}`,
      `unbind "/" ${JSON.stringify(binding)}`,
      'closeConnection "c"',
      'createUser {"name":"n","password":"p","tags":[]}',
      'updateUser "n" {"password":"q","tags":["management"]}',
      'deleteUser "n"',
      'createVhost "v"',
      'deleteVhost "v"',
      `setPermission "/" ${JSON.stringify(permission)}`,
      'clearPermission "/" "u"',
      `setPolicy ${JSON.stringify(policy)}`,
      'deletePolicy "/" "p"',
    ]);
  });

  it('tells the manager when the link is lost, and only then', async () => {
    const lost: unknown[] = [];
    const failing = new ManagedRabbitSession(
      inner({
        listVhosts: () => Promise.reject(new DbError('connection-failed', 'gone')),
        purgeQueue: () => Promise.reject(new DbError('permission-denied', 'no')),
      }),
      {
        onLinkLost: (error) => {
          lost.push(error);
        },
      },
    );
    await expect(failing.listVhosts()).rejects.toMatchObject({ code: 'connection-failed' });
    expect(lost).toHaveLength(1);
    await expect(failing.purgeQueue('/', 'q')).rejects.toMatchObject({ code: 'permission-denied' });
    expect(lost).toHaveLength(1);
  });

  it('turns any failure into a DbError', async () => {
    const managed = new ManagedRabbitSession(
      inner({ purgeQueue: () => Promise.reject(new Error('odd')) }),
      { onLinkLost: () => undefined },
    );
    await expect(managed.purgeQueue('/', 'q')).rejects.toBeInstanceOf(DbError);
  });

  it('lists the virtual hosts after a quiet spell, to keep the link alive', async () => {
    let pings = 0;
    const managed = new ManagedRabbitSession(
      inner({
        listVhosts: () => {
          pings += 1;
          return Promise.resolve([]);
        },
      }),
      { onLinkLost: () => undefined, keepAliveMs: 1000 },
    );
    managed.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(3500);
    expect(pings).toBe(3);
    await managed.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings).toBe(3);
  });

  it('does not ping when keep-alive is off, and a ping that fails reports the lost link', async () => {
    let pings = 0;
    const off = new ManagedRabbitSession(
      inner({
        listVhosts: () => {
          pings += 1;
          return Promise.resolve([]);
        },
      }),
      { onLinkLost: () => undefined },
    );
    off.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pings).toBe(0);

    const lost: unknown[] = [];
    const dying = new ManagedRabbitSession(
      inner({ listVhosts: () => Promise.reject(new DbError('connection-failed', 'gone')) }),
      {
        onLinkLost: (error) => {
          lost.push(error);
        },
        keepAliveMs: 500,
      },
    );
    dying.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(600);
    expect(lost).toHaveLength(1);
    await dying.close();
  });

  it('does not ping while a call is running', async () => {
    let pings = 0;
    let release: () => void = () => undefined;
    const managed = new ManagedRabbitSession(
      inner({
        listVhosts: () => {
          pings += 1;
          return Promise.resolve([]);
        },
        purgeQueue: () =>
          new Promise<void>((resolve) => {
            release = () => {
              resolve();
            };
          }),
      }),
      { onLinkLost: () => undefined, keepAliveMs: 100 },
    );
    managed.scheduleKeepAlive();
    const pending = managed.purgeQueue('/', 'q');
    await vi.advanceTimersByTimeAsync(1000);
    expect(pings).toBe(0);
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(150);
    expect(pings).toBe(1);
    await managed.close();
  });

  it('runs its closing hook after the session closed, even when closing fails', async () => {
    const order: string[] = [];
    const managed = new ManagedRabbitSession(
      inner({
        close: () => {
          order.push('inner');
          return Promise.reject(new Error('boom'));
        },
      }),
      {
        onLinkLost: () => undefined,
        onClosed: () => {
          order.push('hook');
          return Promise.resolve();
        },
      },
    );
    await expect(managed.close()).rejects.toThrow('boom');
    expect(order).toEqual(['inner', 'hook']);
  });
});
