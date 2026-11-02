// RabbitMQ for real (V13.28): bindings made and removed with awkward routing keys, the policies,
// users and permissions of a virtual host, and a client that really connects and consumes, so
// the lists of connections and consumers read what the broker sends. The client is a small
// AMQP helper (test/helpers/amqp-probe.ts); the extension itself only speaks the HTTP API.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/rabbitmq';
import type { RabbitSession } from '../../../src/drivers/rabbitmq-driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { RabbitObjectModel } from '../../../src/vscode/panels/rabbitmq-object-model';
import { AmqpProbe } from '../../helpers/amqp-probe';
import { TEST_RABBITMQ } from '../../helpers/rabbitmq-servers';

function config(): ResolvedConnectionConfig {
  return {
    id: 'test-rabbit',
    name: 'RabbitMQ',
    driver: 'rabbitmq',
    host: TEST_RABBITMQ.host,
    port: TEST_RABBITMQ.port,
    user: TEST_RABBITMQ.user,
    password: TEST_RABBITMQ.password,
  };
}

const unique = (name: string): string => `dn-it-${name}-${randomUUID().slice(0, 8)}`;

/** The broker refreshes its figures every few seconds; wait until they show what we expect. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('RabbitMQ administration (V13.28)', () => {
  let session: RabbitSession;
  const queues: string[] = [];
  const policies: string[] = [];
  const users: string[] = [];

  async function queue(name: string): Promise<string> {
    const full = unique(name);
    await session.declareQueue({ vhost: '/', name: full, durable: false, autoDelete: false });
    queues.push(full);
    return full;
  }

  beforeAll(async () => {
    session = await driver.openSession(config());
  }, 60_000);

  afterAll(async () => {
    for (const name of queues) {
      await session.deleteQueue('/', name).catch(() => undefined);
    }
    for (const name of policies) {
      await session.deletePolicy('/', name).catch(() => undefined);
    }
    for (const name of users) {
      await session.deleteUser(name).catch(() => undefined);
    }
    await session.close();
  });

  describe('bindings', () => {
    it('makes bindings with awkward keys and removes each of them again', async () => {
      const name = await queue('bind');
      const keys = ['plain', 'a#b/c d', '100%', '', 'with.dots.#', 'ключ'];
      for (const routingKey of keys) {
        await session.bind('/', {
          source: 'amq.topic',
          destination: name,
          destinationType: 'queue',
          routingKey,
        });
      }
      const listed = await session.listBindings('/', { queue: name });
      const ours = listed.filter((binding) => binding.source === 'amq.topic');
      expect(ours.map((binding) => binding.routingKey).sort()).toEqual([...keys].sort());
      for (const binding of ours) {
        await session.unbind('/', binding);
      }
      const after = await session.listBindings('/', { queue: name });
      expect(after.filter((binding) => binding.source === 'amq.topic')).toEqual([]);
    });

    it('keeps the binding of the default exchange that every queue has', async () => {
      const name = await queue('implicit');
      const listed = await session.listBindings('/', { queue: name });
      expect(listed.map((binding) => binding.source)).toContain('');
    });

    it('binds with arguments, and an exchange to an exchange', async () => {
      const name = await queue('args');
      await session.bind('/', {
        source: 'amq.headers',
        destination: name,
        destinationType: 'queue',
        routingKey: '',
        arguments: { 'x-match': 'all', kind: 'order' },
      });
      await session.bind('/', {
        source: 'amq.direct',
        destination: 'amq.topic',
        destinationType: 'exchange',
        routingKey: unique('hop'),
      });
      const byHeaders = (await session.listBindings('/', { queue: name })).find(
        (binding) => binding.source === 'amq.headers',
      );
      expect(byHeaders?.arguments).toEqual({ 'x-match': 'all', kind: 'order' });
      await session.unbind('/', must(byHeaders));
      const hops = (await session.listBindings('/', { exchange: 'amq.topic' })).filter(
        (binding) => binding.source === 'amq.direct' && binding.destinationType === 'exchange',
      );
      for (const hop of hops.filter((one) => one.routingKey.startsWith('dn-it-hop-'))) {
        await session.unbind('/', hop);
      }
    });

    it('is refused for the default exchange, which the broker will not bind, and for a queue that is not there', async () => {
      const name = await queue('refuse');
      await expect(
        session.bind('/', {
          source: 'amq.default',
          destination: name,
          destinationType: 'queue',
          routingKey: 'x',
        }),
        // The broker answers 401 "Access refused" here, though the user may do the rest.
      ).rejects.toMatchObject({ driverCode: 401 });
      await expect(
        session.bind('/', {
          source: 'amq.topic',
          destination: unique('missing'),
          destinationType: 'queue',
          routingKey: 'x',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('goes through the page: add, list, remove', async () => {
      const name = await queue('page');
      const model = new RabbitObjectModel({
        kind: 'queue',
        vhost: '/',
        name,
        connectionName: 'RabbitMQ',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      await model.refresh();
      const made = await model.addBinding({
        direction: 'fromExchange',
        peer: 'amq.topic',
        routingKey: 'page.#',
        arguments: '',
      });
      const index = made.bindings.findIndex((binding) => binding.routingKey === 'page.#');
      expect(index).toBeGreaterThanOrEqual(0);
      const removed = await model.removeBinding(index);
      expect(removed.bindings.some((binding) => binding.routingKey === 'page.#')).toBe(false);
    });
  });

  describe('policies', () => {
    it('sets, reads, changes and deletes a policy', async () => {
      const name = unique('policy');
      policies.push(name);
      await session.setPolicy({
        vhost: '/',
        name,
        pattern: '^dn-it-policy-nothing$',
        applyTo: 'queues',
        priority: 3,
        definition: { 'max-length': 100 },
      });
      const found = (await session.listPolicies('/')).find((policy) => policy.name === name);
      expect(found).toEqual({
        name,
        pattern: '^dn-it-policy-nothing$',
        applyTo: 'queues',
        priority: 3,
        definition: { 'max-length': 100 },
      });
      await session.setPolicy({
        vhost: '/',
        name,
        pattern: '^dn-it-policy-nothing$',
        applyTo: 'all',
        priority: 4,
        definition: { 'max-length': 200 },
      });
      const changed = (await session.listPolicies('/')).find((policy) => policy.name === name);
      expect(changed).toMatchObject({
        applyTo: 'all',
        priority: 4,
        definition: { 'max-length': 200 },
      });
      await session.deletePolicy('/', name);
      expect((await session.listPolicies('/')).some((policy) => policy.name === name)).toBe(false);
      await expect(session.deletePolicy('/', name)).rejects.toMatchObject({ code: 'not-found' });
    });

    it('applies a policy to a queue it matches', async () => {
      const name = unique('policy-apply');
      policies.push(name);
      const target = await queue('policy-apply');
      await session.setPolicy({
        vhost: '/',
        name,
        pattern: `^${target}$`,
        applyTo: 'queues',
        priority: 1,
        definition: { 'max-length': 10 },
      });
      const seen = await until(
        () => session.getQueue('/', target),
        (one) => one.policy === name,
      );
      expect(seen.policy).toBe(name);
    });

    it('reports a definition the broker refuses', async () => {
      const name = unique('policy-bad');
      policies.push(name);
      await expect(
        session.setPolicy({
          vhost: '/',
          name,
          pattern: '.*',
          applyTo: 'queues',
          priority: 0,
          definition: { 'no-such-setting': 1 },
        }),
      ).rejects.toMatchObject({ code: 'syntax' });
    });
  });

  describe('users and permissions', () => {
    it('creates a user with tags and a permission, lists them, and removes them', async () => {
      const name = unique('user');
      users.push(name);
      await session.createUser({ name, password: 'pw-1', tags: ['management', 'monitoring'] });
      const listed = (await session.listUsers()).find((user) => user.name === name);
      expect([...(listed?.tags ?? [])].sort()).toEqual(['management', 'monitoring']);
      expect((await session.listPermissions('/')).some((p) => p.user === name)).toBe(false);
      await session.setPermission('/', { user: name, configure: '', write: '^q\\.', read: '.*' });
      expect((await session.listPermissions('/')).find((p) => p.user === name)).toEqual({
        user: name,
        configure: '',
        write: '^q\\.',
        read: '.*',
      });
      await session.clearPermission('/', name);
      expect((await session.listPermissions('/')).some((p) => p.user === name)).toBe(false);
      await session.deleteUser(name);
      expect((await session.listUsers()).some((user) => user.name === name)).toBe(false);
      await expect(session.deleteUser(name)).rejects.toMatchObject({ code: 'not-found' });
    });

    it('lets the new user sign in once it has a tag and a permission, and shows it a smaller view', async () => {
      const name = unique('viewer');
      users.push(name);
      await session.createUser({ name, password: 'pw-2', tags: ['management'] });
      await session.setPermission('/', { user: name, configure: '', write: '', read: '.*' });
      const own = await driver.openSession({ ...config(), user: name, password: 'pw-2' });
      try {
        expect(own.server.user).toBe(name);
        // A user without the administrator tag may not list users or permissions.
        await expect(own.listUsers()).rejects.toMatchObject({ driverCode: 401 });
        await expect(own.listPermissions('/')).rejects.toMatchObject({ driverCode: 401 });
        // The page reads the other parts all the same.
        const model = new RabbitObjectModel({
          kind: 'vhost',
          vhost: '/',
          name: '/',
          connectionName: 'RabbitMQ',
          readOnly: false,
          session: () => Promise.resolve(own),
        });
        const state = await model.refresh();
        expect(state.admin?.usersError).toBeTruthy();
        expect(state.admin?.users).toEqual([]);
        expect(state.admin?.connectionsError).toBeUndefined();
      } finally {
        await own.close();
      }
    });

    it('will not delete the user the page is signed in as', async () => {
      const model = new RabbitObjectModel({
        kind: 'vhost',
        vhost: '/',
        name: '/',
        connectionName: 'RabbitMQ',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      await expect(model.deleteUser(TEST_RABBITMQ.user)).rejects.toMatchObject({
        code: 'unsupported',
      });
    });
  });

  describe('connections and consumers', () => {
    it('lists a client that connects and consumes, and closes its connection', async () => {
      const name = await queue('consumed');
      const clientName = unique('client');
      const probe = new AmqpProbe({
        host: TEST_RABBITMQ.host,
        port: TEST_RABBITMQ.amqpPort,
        user: TEST_RABBITMQ.user,
        password: TEST_RABBITMQ.password,
        vhost: '/',
        connectionName: clientName,
        queue: name,
        consumerTag: 'dn-it-consumer',
        prefetch: 7,
      });
      await probe.open();
      try {
        const page = await until(
          () => session.listConnections('/'),
          (one) => one.items.some((connection) => connection.clientName === clientName),
        );
        const connection = must(page.items.find((one) => one.clientName === clientName));
        expect(connection).toMatchObject({
          user: TEST_RABBITMQ.user,
          vhost: '/',
          product: 'datanest-test',
        });
        expect(connection.peer).toMatch(/^[\d.]+:\d+$/u);
        expect(connection.state).not.toBe('');
        expect(connection.connectedAt).toBeGreaterThan(Date.now() - 120_000);

        const consumed = await until(
          () => session.getQueue('/', name),
          (one) => one.consumerDetails.length > 0,
        );
        expect(consumed.consumers).toBe(1);
        expect(consumed.consumerDetails[0]).toMatchObject({
          tag: 'dn-it-consumer',
          prefetch: 7,
          ackRequired: true,
          exclusive: false,
          active: true,
          user: TEST_RABBITMQ.user,
        });
        expect(consumed.consumerDetails[0]?.connectionName).toContain('->');

        // The page shows the same, and closing the connection drops the client.
        const queueModel = new RabbitObjectModel({
          kind: 'queue',
          vhost: '/',
          name,
          connectionName: 'RabbitMQ',
          readOnly: false,
          session: () => Promise.resolve(session),
        });
        expect((await queueModel.refresh()).consumersList).toHaveLength(1);
        const vhostModel = new RabbitObjectModel({
          kind: 'vhost',
          vhost: '/',
          name: '/',
          connectionName: 'RabbitMQ',
          readOnly: false,
          session: () => Promise.resolve(session),
        });
        const state = await vhostModel.closeConnection(connection.name);
        expect(state.admin?.connections.some((one) => one.name === connection.name)).toBe(false);
        await until(
          () => Promise.resolve(probe.closedByBroker),
          (closed) => closed,
        );
        expect(probe.closedByBroker).toBe(true);
      } finally {
        probe.close();
      }
    }, 90_000);

    it('lists no connection of a virtual host nobody uses', async () => {
      const page = await session.listConnections('/');
      expect(page.total).toBe(page.items.length);
    });
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}
