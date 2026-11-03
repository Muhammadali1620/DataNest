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

  describe('the settings of a virtual host (V13.39)', () => {
    it('sets and reads the description, the tags and the default queue type', async () => {
      const vhost = unique('settings');
      await session.createVhost(vhost);
      try {
        expect(await session.readVhostSettings(vhost)).toMatchObject({ tags: [] });
        await session.setVhostSettings(vhost, {
          description: 'Billing — тест',
          tags: ['prod', 'eu'],
          defaultQueueType: 'quorum',
        });
        expect(await session.readVhostSettings(vhost)).toEqual({
          description: 'Billing — тест',
          tags: ['prod', 'eu'],
          defaultQueueType: 'quorum',
        });
        // A new queue without a type takes the default of its host.
        await session.declareQueue({ vhost, name: 'q', durable: true, autoDelete: false });
        expect((await session.getQueue(vhost, 'q')).type).toBe('quorum');
        await session.setVhostSettings(vhost, {
          description: '',
          tags: [],
          defaultQueueType: '',
        });
        const cleared = await session.readVhostSettings(vhost);
        expect(cleared.description).toBe('');
        expect(cleared.tags).toEqual([]);
      } finally {
        await session.deleteVhost(vhost).catch(() => undefined);
      }
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

    it('keeps an operator policy apart from the ordinary one of the same name (V13.39)', async () => {
      const name = unique('operator');
      policies.push(name);
      await session.setPolicy({
        vhost: '/',
        name,
        pattern: '^dn-it-operator-nothing$',
        applyTo: 'queues',
        priority: 1,
        definition: { 'message-ttl': 60_000 },
      });
      await session.setPolicy({
        vhost: '/',
        name,
        pattern: '^dn-it-operator-nothing$',
        applyTo: 'queues',
        priority: 2,
        definition: { 'max-length': 50 },
        operator: true,
      });
      const listed = (await session.listPolicies('/')).filter((policy) => policy.name === name);
      expect(listed.map((policy) => [policy.operator === true, policy.priority])).toEqual([
        [false, 1],
        [true, 2],
      ]);
      expect(listed[1]?.definition).toEqual({ 'max-length': 50 });
      await session.deletePolicy('/', name, true);
      const rest = (await session.listPolicies('/')).filter((policy) => policy.name === name);
      expect(rest.map((policy) => policy.operator === true)).toEqual([false]);
      await expect(session.deletePolicy('/', name, true)).rejects.toMatchObject({
        code: 'not-found',
      });
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

    it('changes the tags and keeps the password, then changes the password and keeps the tags (V13.32)', async () => {
      const name = unique('changed');
      users.push(name);
      await session.createUser({ name, password: 'pw-old', tags: ['management'] });
      await session.setPermission('/', { user: name, configure: '', write: '', read: '.*' });
      // A PUT without a password would wipe it (checked against 3.13), so the old one must
      // still sign in after the tags changed.
      await session.updateUser(name, { tags: ['management', 'monitoring'] });
      const tagsOf = async (): Promise<string[]> =>
        [...((await session.listUsers()).find((user) => user.name === name)?.tags ?? [])].sort();
      expect(await tagsOf()).toEqual(['management', 'monitoring']);
      const sameLogin = await driver.openSession({ ...config(), user: name, password: 'pw-old' });
      await sameLogin.close();

      await session.updateUser(name, { password: 'pw-new' });
      expect(await tagsOf()).toEqual(['management', 'monitoring']);
      await expect(
        driver.openSession({ ...config(), user: name, password: 'pw-old' }),
      ).rejects.toMatchObject({ code: 'auth-failed' });
      const newLogin = await driver.openSession({ ...config(), user: name, password: 'pw-new' });
      await newLogin.close();

      // Both together, and the tags emptied (a user without a tag may not use the HTTP API at
      // all, so only the list says it went through).
      await session.updateUser(name, { password: 'pw-third', tags: [] });
      expect(await tagsOf()).toEqual([]);
      await expect(session.updateUser(unique('ghost'), { tags: [] })).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('goes through the page: the tags change and the permission stays', async () => {
      const name = unique('paged');
      users.push(name);
      await session.createUser({ name, password: 'pw-p', tags: [] });
      await session.setPermission('/', { user: name, configure: '', write: '.*', read: '' });
      const model = new RabbitObjectModel({
        kind: 'vhost',
        vhost: '/',
        name: '/',
        connectionName: 'RabbitMQ',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      const state = await model.updateUser(name, { tags: [' monitoring '] });
      const row = state.admin?.users.find((user) => user.name === name);
      expect(row?.tags).toEqual(['monitoring']);
      expect(row?.permission).toEqual({ configure: '', write: '.*', read: '' });
      await (await driver.openSession({ ...config(), user: name, password: 'pw-p' })).close();
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

    it('reads the rates of a queue that is published to and consumed, and draws them live (V13.32)', async () => {
      const name = await queue('rates');
      const probe = new AmqpProbe({
        host: TEST_RABBITMQ.host,
        port: TEST_RABBITMQ.amqpPort,
        user: TEST_RABBITMQ.user,
        password: TEST_RABBITMQ.password,
        vhost: '/',
        connectionName: unique('rates-client'),
        queue: name,
        consumerTag: 'dn-it-rates',
        prefetch: 50,
      });
      await probe.open();
      const model = new RabbitObjectModel({
        kind: 'queue',
        vhost: '/',
        name,
        connectionName: 'RabbitMQ',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      try {
        for (let index = 0; index < 20; index += 1) {
          await session.publish({
            vhost: '/',
            exchange: '',
            routingKey: name,
            payload: new TextEncoder().encode(`message ${index}`),
            properties: {},
          });
        }
        // The consumer never acknowledges, so what it was sent stays unacknowledged.
        const seen = await until(
          () => session.getQueue('/', name),
          (one) => one.deliverRate !== undefined && one.unacked > 0,
        );
        expect(seen.deliverRate).toBeGreaterThanOrEqual(0);
        expect(seen.incomingRate).toBeGreaterThanOrEqual(0);
        expect(seen.unacked).toBeGreaterThan(0);

        const states: number[] = [];
        await model.startLive(
          (state) => states.push(state.live?.samples.length ?? 0),
          (error) => {
            throw error instanceof Error ? error : new Error(String(error));
          },
          500,
        );
        await until(
          () => Promise.resolve(states.length),
          (count) => count >= 3,
        );
        model.stopLive();
        const live = model.state().live;
        expect(live?.on).toBe(false);
        expect(live?.samples.length).toBeGreaterThanOrEqual(3);
        for (const one of live?.samples ?? []) {
          expect(one.unacked).toBeGreaterThan(0);
          expect(one.ready + one.unacked).toBeLessThanOrEqual(20);
          for (const rate of [one.publish, one.deliver, one.ack]) {
            expect(Number.isFinite(rate)).toBe(true);
            expect(rate).toBeGreaterThanOrEqual(0);
          }
        }
      } finally {
        model.stopLive();
        probe.close();
      }
    }, 90_000);

    it('lists no connection of a virtual host nobody uses', async () => {
      const page = await session.listConnections('/');
      expect(page.total).toBe(page.items.length);
    });
  });

  describe('virtual hosts (V13.32)', () => {
    it('makes a virtual host with a slash in its name, then deletes it with what is in it', async () => {
      const vhost = unique('vh/with slash');
      await session.createVhost(vhost);
      try {
        expect((await session.listVhosts()).map((one) => one.name)).toContain(vhost);
        // Making it again is not an error.
        await session.createVhost(vhost);
        // The administrator tag lists every virtual host but gives no access to its queues.
        await session.setPermission(vhost, {
          user: TEST_RABBITMQ.user,
          configure: '.*',
          write: '.*',
          read: '.*',
        });
        await session.declareQueue({ vhost, name: 'inside', durable: false, autoDelete: false });
        expect((await session.listQueues(vhost)).items.map((one) => one.name)).toEqual(['inside']);
      } finally {
        await session.deleteVhost(vhost).catch(() => undefined);
      }
      expect((await session.listVhosts()).map((one) => one.name)).not.toContain(vhost);
      await expect(session.deleteVhost(vhost)).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('the cluster and the limits (V13.35)', () => {
    it('reads the one node of the broker with its resources, the totals and the listeners', async () => {
      const cluster = await session.readCluster();
      expect(cluster.version).toMatch(/^3\./u);
      expect(cluster.erlang).not.toBe('');
      expect(cluster.nodes).toHaveLength(1);
      const [node] = cluster.nodes;
      expect(node?.name).toBe(cluster.node);
      expect(node).toMatchObject({
        running: true,
        memAlarm: false,
        diskAlarm: false,
        draining: false,
      });
      expect(node?.memUsed).toBeGreaterThan(0);
      expect(node?.memLimit).toBeGreaterThan(node?.memUsed ?? 0);
      expect(node?.fdTotal).toBeGreaterThan(0);
      expect(node?.uptimeMs).toBeGreaterThan(0);
      expect(node?.partitions).toEqual([]);
      expect(cluster.listeners.some((listener) => listener.protocol === 'amqp')).toBe(true);
      expect(cluster.exchanges).toBeGreaterThan(0);
    });

    it('lists the global parameters, with the cluster name', async () => {
      const parameters = await session.listGlobalParameters();
      expect(parameters.map((one) => one.name)).toContain('internal_cluster_id');
    });

    it('sets, reads and lifts the limits of a virtual host with a slash in its name', async () => {
      const vhost = unique('limits/host');
      await session.createVhost(vhost);
      try {
        expect(await session.listVhostLimits(vhost)).toEqual({});
        await session.setVhostLimit(vhost, 'max-queues', 7);
        await session.setVhostLimit(vhost, 'max-connections', 0);
        expect(await session.listVhostLimits(vhost)).toEqual({ maxConnections: 0, maxQueues: 7 });
        await session.clearVhostLimit(vhost, 'max-queues');
        expect(await session.listVhostLimits(vhost)).toEqual({ maxConnections: 0 });
        await session.clearVhostLimit(vhost, 'max-connections');
        expect(await session.listVhostLimits(vhost)).toEqual({});
      } finally {
        await session.deleteVhost(vhost).catch(() => undefined);
      }
    });

    it('enforces a limit of queues that the page set', async () => {
      const vhost = unique('limited');
      await session.createVhost(vhost);
      try {
        await session.setPermission(vhost, {
          user: TEST_RABBITMQ.user,
          configure: '.*',
          write: '.*',
          read: '.*',
        });
        const page = new RabbitObjectModel({
          kind: 'vhost',
          vhost,
          name: vhost,
          connectionName: 'RabbitMQ',
          readOnly: false,
          session: () => Promise.resolve(session),
        });
        const state = await page.setLimit('max-queues', 1);
        expect(state.admin?.limits).toEqual({ maxQueues: 1 });
        await session.declareQueue({ vhost, name: 'one', durable: false, autoDelete: false });
        await expect(
          session.declareQueue({ vhost, name: 'two', durable: false, autoDelete: false }),
        ).rejects.toBeInstanceOf(Error);
        expect((await page.setLimit('max-queues', undefined)).admin?.limits).toEqual({});
        await session.declareQueue({ vhost, name: 'two', durable: false, autoDelete: false });
        expect((await session.listQueues(vhost)).items.map((one) => one.name).sort()).toEqual([
          'one',
          'two',
        ]);
      } finally {
        await session.deleteVhost(vhost).catch(() => undefined);
      }
    });

    it('shows the cluster page of the real broker', async () => {
      const page = new RabbitObjectModel({
        kind: 'cluster',
        vhost: '',
        name: '',
        connectionName: 'RabbitMQ',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      const state = await page.refresh();
      expect(state.cluster?.nodes).toHaveLength(1);
      expect(state.cluster?.nodes[0]?.uptime).not.toBe('');
      expect(state.cluster?.parametersError).toBeUndefined();
    });

    it('keeps a policy made from fields, with every popular key, on the broker', async () => {
      const name = unique('popular');
      policies.push(name);
      const definition = {
        'message-ttl': 60_000,
        'max-length': 1000,
        overflow: 'reject-publish',
        'dead-letter-exchange': 'amq.fanout',
        'dead-letter-routing-key': 'dead',
      };
      await session.setPolicy({
        vhost: '/',
        name,
        pattern: '^dn-it-popular-never-matches$',
        applyTo: 'queues',
        priority: 3,
        definition,
      });
      const stored = (await session.listPolicies('/')).find((one) => one.name === name);
      expect(stored?.definition).toEqual(definition);
    });
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}
