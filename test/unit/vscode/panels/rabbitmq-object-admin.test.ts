// The RabbitMQ page of V13.28 without an editor: consumers of a queue, making and removing
// bindings, and the virtual host page with its connections, users, permissions and policies.

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  parseJsonObject,
  RabbitObjectModel,
  type RabbitObjectModelDeps,
} from '../../../../src/vscode/panels/rabbitmq-object-model';
import { FakeRabbitSession } from '../../../helpers/fake-rabbitmq';

function setup(over: Partial<RabbitObjectModelDeps> = {}) {
  const session = new FakeRabbitSession();
  session.server = { version: '3.13.7', clusterName: 'c', user: 'admin' };
  session.broker.addQueue({
    vhost: '/',
    name: 'orders',
    consumers: 1,
    consumerDetails: [
      {
        consumer_tag: 'amq.ctag-1',
        ack_required: true,
        prefetch_count: 10,
        exclusive: false,
        active: true,
        channel_details: { connection_name: 'c1', name: 'c1 (1)', user: 'app' },
      },
    ],
  });
  session.broker.exchanges.push({ vhost: '/', name: 'events', type: 'topic' });
  session.broker.exchanges.push({ vhost: '/', name: 'audit', type: 'fanout' });
  const make = (kind: 'queue' | 'exchange' | 'vhost', name: string) =>
    new RabbitObjectModel({
      kind,
      vhost: '/',
      name,
      connectionName: 'Broker',
      readOnly: false,
      session: () => Promise.resolve(session),
      ...over,
    });
  return {
    session,
    queue: make('queue', 'orders'),
    exchange: make('exchange', 'events'),
    defaultExchange: make('exchange', ''),
    vhost: make('vhost', '/'),
  };
}

const bindingsOf = (session: FakeRabbitSession) =>
  session.broker.bindings.map(
    (b) => `${b.source}>${b.destination}(${b.destinationType}):${b.routingKey}`,
  );

describe('consumers of a queue', () => {
  it('lists them for the page', async () => {
    const { queue } = setup();
    const state = await queue.refresh();
    expect(state.consumersList).toEqual([
      {
        tag: 'amq.ctag-1',
        connection: 'c1',
        channel: 'c1 (1)',
        user: 'app',
        prefetch: 10,
        ackRequired: true,
        exclusive: false,
        active: true,
      },
    ]);
  });

  it('has none on an exchange', async () => {
    const { exchange } = setup();
    expect((await exchange.refresh()).consumersList).toEqual([]);
  });
});

describe('binding', () => {
  it('binds a queue to an exchange', async () => {
    const { queue, session } = setup();
    const state = await queue.addBinding({
      direction: 'fromExchange',
      peer: ' events ',
      routingKey: 'order.#',
      arguments: '',
    });
    expect(bindingsOf(session)).toEqual(['events>orders(queue):order.#']);
    expect(state.bindings).toMatchObject([{ source: 'events', destination: 'orders' }]);
  });

  it('binds an exchange in each of its three directions', async () => {
    const { exchange, session } = setup();
    await exchange.addBinding({
      direction: 'toQueue',
      peer: 'orders',
      routingKey: 'a',
      arguments: '',
    });
    await exchange.addBinding({
      direction: 'toExchange',
      peer: 'audit',
      routingKey: 'b',
      arguments: '',
    });
    await exchange.addBinding({
      direction: 'fromExchange',
      peer: 'audit',
      routingKey: 'c',
      arguments: '{"x-match": "all"}',
    });
    expect(bindingsOf(session)).toEqual([
      'events>orders(queue):a',
      'events>audit(exchange):b',
      'audit>events(exchange):c',
    ]);
    expect(session.broker.bindings[2]?.arguments).toEqual({ 'x-match': 'all' });
  });

  it('refuses what the broker would refuse, before asking it', async () => {
    const { queue, exchange, defaultExchange, vhost, session } = setup();
    const refusal = async (promise: Promise<unknown>): Promise<DbError> => {
      try {
        await promise;
      } catch (error) {
        return error as DbError;
      }
      throw new Error('it did not fail');
    };
    const bind = (
      direction: 'toQueue' | 'toExchange' | 'fromExchange',
      peer: string,
      args = '',
    ) => ({
      direction,
      peer,
      routingKey: '',
      arguments: args,
    });
    expect((await refusal(queue.addBinding(bind('fromExchange', '  ')))).code).toBe('syntax');
    expect((await refusal(queue.addBinding(bind('fromExchange', 'amq.default')))).code).toBe(
      'syntax',
    );
    expect((await refusal(queue.addBinding(bind('toQueue', 'x')))).code).toBe('unsupported');
    expect((await refusal(defaultExchange.addBinding(bind('toQueue', 'orders')))).code).toBe(
      'unsupported',
    );
    expect((await refusal(exchange.addBinding(bind('toQueue', 'orders', '{bad')))).message).toMatch(
      /not valid JSON/u,
    );
    expect((await refusal(exchange.addBinding(bind('toQueue', 'orders', '[1]')))).message).toMatch(
      /must be a JSON object/u,
    );
    expect((await refusal(vhost.addBinding(bind('toQueue', 'orders')))).code).toBe('unsupported');
    expect(session.calls).not.toContain('bind');
  });

  it('removes a binding listed on the page, by its place', async () => {
    const { queue, session } = setup();
    session.broker.bindings.push(
      {
        vhost: '/',
        source: 'events',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'a',
      },
      {
        vhost: '/',
        source: 'events',
        destination: 'orders',
        destinationType: 'queue',
        routingKey: 'b',
      },
    );
    await queue.refresh();
    expect(queue.bindingAt(1)?.routingKey).toBe('b');
    const state = await queue.removeBinding(1);
    expect(bindingsOf(session)).toEqual(['events>orders(queue):a']);
    expect(state.bindings).toHaveLength(1);
  });

  it('will not remove the binding of the default exchange, nor one that is not listed', async () => {
    const { queue, session } = setup();
    session.broker.bindings.push({
      vhost: '/',
      source: '',
      destination: 'orders',
      destinationType: 'queue',
      routingKey: 'orders',
    });
    await queue.refresh();
    await expect(queue.removeBinding(0)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(queue.removeBinding(5)).rejects.toMatchObject({ code: 'not-found' });
    expect(session.calls).not.toContain('unbind');
  });

  it('is refused on a read-only connection', async () => {
    const { queue, session } = setup({ readOnly: true });
    await expect(
      queue.addBinding({
        direction: 'fromExchange',
        peer: 'events',
        routingKey: '',
        arguments: '',
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(queue.removeBinding(0)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(session.calls).not.toContain('bind');
  });
});

describe('parseJsonObject', () => {
  it('reads an object, and empty text as an empty one', () => {
    expect(parseJsonObject('', 'X')).toEqual({});
    expect(parseJsonObject('  ', 'X')).toEqual({});
    expect(parseJsonObject('{"a": 1}', 'X')).toEqual({ a: 1 });
  });

  it('names what it was reading when it fails', () => {
    expect(() => parseJsonObject('{', 'The definition')).toThrow(
      'The definition is not valid JSON',
    );
    expect(() => parseJsonObject('null', 'The definition')).toThrow('must be a JSON object');
    expect(() => parseJsonObject('[]', 'The definition')).toThrow('must be a JSON object');
    expect(() => parseJsonObject('"s"', 'The definition')).toThrow('must be a JSON object');
  });
});

describe('a virtual host page', () => {
  function seeded() {
    const made = setup();
    const { session } = made;
    session.broker.connections.push(
      {
        name: 'c1',
        vhost: '/',
        user: 'app',
        channels: 2,
        connectedAt: Date.UTC(2026, 10, 2, 10, 15, 0),
        clientName: 'billing',
      },
      { name: 'elsewhere', vhost: 'other' },
    );
    session.broker.users.push(
      { name: 'admin', tags: ['administrator'] },
      { name: 'app', tags: [] },
    );
    session.broker.permissions.push(
      { vhost: '/', user: 'admin', configure: '.*', write: '.*', read: '.*' },
      { vhost: 'other', user: 'app', configure: '', write: '', read: '.*' },
    );
    session.broker.policies.push({
      vhost: '/',
      name: 'ttl',
      pattern: '^tmp\\.',
      applyTo: 'queues',
      priority: 1,
      definition: { 'message-ttl': 60_000 },
    });
    return made;
  }

  it('reads connections, users with their permissions here, and policies', async () => {
    const { vhost } = seeded();
    const state = await vhost.refresh();
    expect(state).toMatchObject({ kind: 'vhost', name: '/', bindings: [], consumersList: [] });
    expect(state.facts.map((fact) => fact.key)).toEqual([
      'Virtual host',
      'Signed in as',
      'Broker version',
    ]);
    expect(state.admin).toMatchObject({
      me: 'admin',
      connectionsTotal: 1,
      connections: [
        {
          name: 'c1',
          user: 'app',
          channels: 2,
          clientName: 'billing',
          connectedAt: '2026-11-02 10:15:00 UTC',
          received: '1 KB',
          sent: '2 KB',
        },
      ],
      policies: [{ name: 'ttl', pattern: '^tmp\\.', applyTo: 'queues', priority: 1 }],
    });
    expect(state.admin?.policies[0]?.definition).toBe('{\n  "message-ttl": 60000\n}');
    // "app" has a permission in another host only, so here it has none.
    expect(state.admin?.users).toEqual([
      {
        name: 'admin',
        tags: ['administrator'],
        permission: { configure: '.*', write: '.*', read: '.*' },
      },
      { name: 'app', tags: [] },
      { name: 'guest', tags: ['administrator'] },
    ]);
  });

  it('shows a connection whose time the broker did not say without one', async () => {
    const { vhost, session } = seeded();
    session.broker.connections.push({ name: 'c2', vhost: '/' });
    const state = await vhost.refresh();
    expect(state.admin?.connections.find((c) => c.name === 'c2')?.connectedAt).toBe('');
  });

  it('reads each part alone, so a refusal hides only itself', async () => {
    const { vhost, session } = seeded();
    session.failures.set('listUsers', new DbError('auth-failed', 'needs the administrator tag'));
    session.failures.set('listConnections', new DbError('internal', 'boom'));
    const state = await vhost.refresh();
    expect(state.admin).toMatchObject({
      connectionsError: 'boom',
      connections: [],
      usersError: 'needs the administrator tag',
      users: [],
    });
    expect(state.admin?.policies).toHaveLength(1);
    session.failures.set('listPolicies', new Error('plain'));
    expect((await vhost.refresh()).admin?.policiesError).toBe('plain');
  });

  it('closes a connection', async () => {
    const { vhost, session } = seeded();
    const state = await vhost.closeConnection('c1');
    expect(session.broker.connections.map((c) => c.name)).toEqual(['elsewhere']);
    expect(state.admin?.connections).toEqual([]);
  });

  it('hides a closed connection the broker still lists for a few seconds', async () => {
    const { vhost, session } = seeded();
    // The broker takes the connection down but its statistics lag behind.
    session.closeConnection = (name) => {
      session.calls.push(`closeConnection ${name}`);
      return Promise.resolve();
    };
    const state = await vhost.closeConnection('c1');
    expect(session.broker.connections.map((c) => c.name)).toContain('c1');
    expect(state.admin?.connections).toEqual([]);
    expect(state.admin?.connectionsTotal).toBe(0);
    // Another connection of the same page stays.
    session.broker.connections.push({ name: 'c3', vhost: '/' });
    const again = await vhost.closeConnection('c1');
    expect(again.admin?.connections.map((c) => c.name)).toEqual(['c3']);
    expect(again.admin?.connectionsTotal).toBe(1);
  });

  it('creates a user with clean tags, and wants a name and a password', async () => {
    const { vhost, session } = seeded();
    await vhost.createUser(' ann ', 'pw', [' management ', '', 'monitoring']);
    expect(session.broker.users.at(-1)).toMatchObject({
      name: 'ann',
      tags: ['management', 'monitoring'],
      password: 'pw',
    });
    await expect(vhost.createUser('  ', 'pw', [])).rejects.toMatchObject({ code: 'syntax' });
    await expect(vhost.createUser('bob', '', [])).rejects.toMatchObject({ code: 'syntax' });
  });

  it('deletes a user but never the one it is signed in as', async () => {
    const { vhost, session } = seeded();
    await vhost.deleteUser('app');
    expect(session.broker.users.map((u) => u.name)).not.toContain('app');
    await expect(vhost.deleteUser('admin')).rejects.toMatchObject({ code: 'unsupported' });
    expect(session.broker.users.map((u) => u.name)).toContain('admin');
  });

  it('sets and clears a permission, checking the patterns', async () => {
    const { vhost, session } = seeded();
    const state = await vhost.setPermission('app', { configure: '', write: '^q', read: '.*' });
    expect(
      session.broker.permissions.find((p) => p.vhost === '/' && p.user === 'app'),
    ).toMatchObject({
      write: '^q',
    });
    expect(state.admin?.users.find((u) => u.name === 'app')?.permission).toEqual({
      configure: '',
      write: '^q',
      read: '.*',
    });
    await expect(
      vhost.setPermission('app', { configure: '(', write: '', read: '' }),
    ).rejects.toThrow(/not a valid regular expression/u);
    await vhost.clearPermission('app');
    expect(session.broker.permissions.some((p) => p.vhost === '/' && p.user === 'app')).toBe(false);
  });

  it('saves a policy that is checked, and deletes one', async () => {
    const { vhost, session } = seeded();
    const policy = {
      name: ' limit ',
      pattern: '^q\\.',
      applyTo: 'quorum_queues',
      priority: -3,
      definition: '{"max-length": 5}',
    };
    const state = await vhost.setPolicy(policy);
    expect(session.broker.policies.find((p) => p.name === 'limit')).toMatchObject({
      vhost: '/',
      applyTo: 'quorum_queues',
      priority: -3,
      definition: { 'max-length': 5 },
    });
    expect(state.admin?.policies.map((p) => p.name)).toEqual(['limit', 'ttl']);
    const bad = async (over: Partial<typeof policy>) => vhost.setPolicy({ ...policy, ...over });
    await expect(bad({ name: ' ' })).rejects.toMatchObject({ code: 'syntax' });
    await expect(bad({ pattern: '' })).rejects.toMatchObject({ code: 'syntax' });
    await expect(bad({ pattern: '[' })).rejects.toThrow(/regular expression/u);
    await expect(bad({ applyTo: 'bindings' })).rejects.toThrow(/applies to/u);
    await expect(bad({ definition: '{}' })).rejects.toThrow(/needs a definition/u);
    await expect(bad({ definition: '' })).rejects.toThrow(/needs a definition/u);
    await expect(bad({ definition: '{x' })).rejects.toThrow(/not valid JSON/u);
    await vhost.deletePolicy('ttl');
    expect(session.broker.policies.map((p) => p.name)).toEqual(['limit']);
  });

  it('lists, saves and deletes an operator policy apart from the ordinary ones (V13.39)', async () => {
    const { vhost, session } = seeded();
    const state = await vhost.setPolicy({
      name: 'cap',
      pattern: '.*',
      applyTo: 'queues',
      priority: 0,
      definition: '{"max-length": 100}',
      operator: true,
    });
    expect(session.broker.operatorPolicies.map((p) => p.name)).toEqual(['cap']);
    expect(session.broker.policies.map((p) => p.name)).toEqual(['ttl']);
    expect(state.admin?.policies.map((p) => [p.name, p.operator === true])).toEqual([
      ['ttl', false],
      ['cap', true],
    ]);
    // The same name may be an ordinary policy as well: the two kinds are kept apart.
    await vhost.setPolicy({
      name: 'cap',
      pattern: '.*',
      applyTo: 'all',
      priority: 1,
      definition: '{"message-ttl": 5}',
    });
    expect(session.broker.policies.map((p) => p.name)).toEqual(['ttl', 'cap']);
    await vhost.deletePolicy('cap', true);
    expect(session.broker.operatorPolicies).toEqual([]);
    expect(session.broker.policies.map((p) => p.name)).toEqual(['ttl', 'cap']);
    await vhost.deletePolicy('cap');
    expect(session.broker.policies.map((p) => p.name)).toEqual(['ttl']);
  });

  it('shows and changes the description, tags and default queue type of a host (V13.39)', async () => {
    const { vhost, session } = seeded();
    const first = await vhost.refresh();
    expect(first.admin?.settings).toEqual({ description: '', tags: [], defaultQueueType: '' });
    const state = await vhost.setVhostSettings({
      description: '  Billing  ',
      tags: [' prod ', 'prod', ''],
      defaultQueueType: 'quorum',
    });
    expect(session.broker.vhostSettings.get('/')).toEqual({
      description: 'Billing',
      tags: ['prod'],
      defaultQueueType: 'quorum',
    });
    expect(state.admin?.settings).toEqual({
      description: 'Billing',
      tags: ['prod'],
      defaultQueueType: 'quorum',
    });
    await expect(
      vhost.setVhostSettings({ description: '', tags: ['a b'], defaultQueueType: '' }),
    ).rejects.toThrow(/one word/u);
    await expect(
      vhost.setVhostSettings({ description: '', tags: ['a,b'], defaultQueueType: '' }),
    ).rejects.toThrow(/one word/u);
    await expect(
      vhost.setVhostSettings({ description: '', tags: [], defaultQueueType: 'lazy' }),
    ).rejects.toThrow(/classic, quorum or stream/u);
  });

  it('says why the settings of a host cannot be read, and the rest still shows (V13.39)', async () => {
    const { vhost, session } = seeded();
    session.failures.set('readVhostSettings', new Error('plain'));
    const state = await vhost.refresh();
    expect(state.admin?.settingsError).toBe('plain');
    expect(state.admin?.settings).toBeUndefined();
    expect(state.admin?.policies.length).toBeGreaterThan(0);
  });

  it('is refused on a read-only connection, and its changes belong to a host page only', async () => {
    const { vhost, session } = setup({ readOnly: true });
    await expect(vhost.closeConnection('c')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(vhost.createUser('a', 'b', [])).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(vhost.deleteUser('a')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      vhost.setPermission('a', { configure: '', write: '', read: '' }),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(vhost.clearPermission('a')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(vhost.deletePolicy('a')).rejects.toMatchObject({ code: 'permission-denied' });
    expect(session.calls.filter((c) => c !== 'listVhosts')).toEqual([]);
    const writable = setup();
    for (const run of [
      () => writable.queue.closeConnection('c'),
      () => writable.queue.createUser('a', 'b', []),
      () => writable.queue.deleteUser('a'),
      () => writable.queue.setPermission('a', { configure: '', write: '', read: '' }),
      () => writable.queue.clearPermission('a'),
      () =>
        writable.queue.setPolicy({
          name: 'p',
          pattern: '.*',
          applyTo: 'all',
          priority: 0,
          definition: '{"a":1}',
        }),
      () => writable.queue.deletePolicy('p'),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: 'unsupported' });
    }
  });

  it('has nothing to look at, publish or delete', async () => {
    const { vhost } = setup();
    await expect(vhost.peek(5)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(vhost.purge()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(vhost.deleteObject()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      vhost.publish({ routingKey: 'k', payload: { text: 'x' }, persistent: true, headers: [] }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});
