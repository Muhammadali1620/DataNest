import { describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import {
  EXCHANGE_TYPES,
  MAX_NAME,
  objectNameProblem,
  QUEUE_TYPES,
  rabbitCommandHandlers,
  type RabbitCommandUi,
  vhostNameProblem,
} from '../../../../src/vscode/rabbitmq/rabbitmq-commands';
import { FakeRabbitSession } from '../../../helpers/fake-rabbitmq';

interface Scenario {
  inputs?: (string | undefined)[];
  picks?: (string | undefined)[];
  confirm?: boolean;
  pickConnection?: string | undefined;
  connections?: ConnectionConfig[];
  vhosts?: string[];
}

const broker = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'r1',
  name: 'Local MQ',
  driver: 'rabbitmq',
  host: 'h',
  ...extra,
});

function setup(scenario: Scenario = {}) {
  const session = new FakeRabbitSession();
  for (const vhost of scenario.vhosts ?? []) {
    session.broker.vhosts.add(vhost);
  }
  session.broker.addQueue({ vhost: '/', name: 'orders', messages: ['a'] });
  session.broker.exchanges.push({ vhost: '/', name: 'events', type: 'topic' });
  const connections = scenario.connections ?? [broker()];
  const inputs = [...(scenario.inputs ?? [])];
  const picks = [...(scenario.picks ?? [])];
  const asked: string[] = [];
  const picked: { title: string; choices: readonly string[] }[] = [];
  const confirms: { message: string; detail: string | undefined }[] = [];
  const infos: string[] = [];
  const opened: [string, string, string, string][] = [];
  const refreshed: (TreeNode | undefined)[] = [];
  const ui: RabbitCommandUi = {
    input: (options) => {
      asked.push(options.prompt);
      const next = inputs.shift();
      if (next !== undefined && options.validate?.(next) !== undefined) {
        throw new Error(`rejected: ${options.validate(next)}`);
      }
      return Promise.resolve(next);
    },
    pick: (title, choices) => {
      picked.push({ title, choices });
      return Promise.resolve(picks.shift());
    },
    confirm: (message, detail) => {
      confirms.push({ message, detail });
      return Promise.resolve(scenario.confirm ?? true);
    },
    pickConnection: () => Promise.resolve(scenario.pickConnection),
    info: (message) => {
      infos.push(message);
    },
  };
  const handlers = rabbitCommandHandlers({
    store: {
      get: (id) => connections.find((one) => one.id === id),
      list: () => connections,
    },
    session: () => Promise.resolve(session),
    tree: {
      refresh: (node) => {
        refreshed.push(node);
      },
    },
    ui,
    openObject: (connectionId, kind, vhost, name) => {
      opened.push([connectionId, kind, vhost, name]);
      return Promise.resolve();
    },
    texts: { noRabbit: 'no rabbit', readOnly: 'read-only' },
  });
  return { session, handlers, asked, picked, confirms, infos, opened, refreshed };
}

const queueNode = (queue = 'orders'): TreeNode => ({
  kind: 'rabbitQueue',
  connectionId: 'r1',
  vhost: '/',
  queue,
  state: 'running',
  ready: 1,
  unacked: 0,
  consumers: 0,
});

const exchangeNode = (exchange = 'events'): TreeNode => ({
  kind: 'rabbitExchange',
  connectionId: 'r1',
  vhost: '/',
  exchange,
  exchangeType: 'topic',
});

const queuesFolder: TreeNode = {
  kind: 'rabbitFolder',
  connectionId: 'r1',
  vhost: '/',
  folder: 'queues',
};
const exchangesFolder: TreeNode = {
  kind: 'rabbitFolder',
  connectionId: 'r1',
  vhost: '/',
  folder: 'exchanges',
};

describe('objectNameProblem', () => {
  it('takes what RabbitMQ takes', () => {
    for (const name of ['orders', 'a.b-c_d', 'with space', 'ünï', 'x'.repeat(MAX_NAME)]) {
      expect(objectNameProblem(name, 'queue')).toBeUndefined();
    }
  });

  it('refuses an empty name, a long one and the broker’s own prefix', () => {
    expect(objectNameProblem('', 'queue')).toBe('A queue needs a name');
    expect(objectNameProblem('', 'exchange')).toBe('An exchange needs a name');
    expect(objectNameProblem('x'.repeat(MAX_NAME + 1), 'queue')).toContain('at most 255 bytes');
    expect(objectNameProblem('é'.repeat(MAX_NAME), 'queue')).toContain('at most 255 bytes');
    expect(objectNameProblem('amq.mine', 'exchange')).toContain('amq.');
  });
});

describe('RabbitMQ commands (V13.26)', () => {
  describe('openObject', () => {
    it('opens the page of a queue and of an exchange', async () => {
      const { handlers, opened } = setup();
      await handlers.openObject(queueNode());
      await handlers.openObject(exchangeNode());
      expect(opened).toEqual([
        ['r1', 'queue', '/', 'orders'],
        ['r1', 'exchange', '/', 'events'],
      ]);
    });

    it('opens the page of a virtual host from its administration item', async () => {
      const { handlers, opened } = setup();
      await handlers.openObject({
        kind: 'rabbitFolder',
        connectionId: 'r1',
        vhost: 'app',
        folder: 'admin',
      });
      expect(opened).toEqual([['r1', 'vhost', 'app', 'app']]);
    });

    it('does nothing for anything else', async () => {
      const { handlers, opened } = setup();
      await handlers.openObject(queuesFolder);
      await handlers.openObject('r1');
      await handlers.openObject(undefined);
      expect(opened).toEqual([]);
    });
  });

  describe('newQueue', () => {
    it('asks for the name and the type, declares a durable queue and refreshes the folder', async () => {
      const { handlers, session, infos, refreshed, picked } = setup({
        inputs: ['  billing  '],
        picks: ['quorum'],
      });
      await handlers.newQueue(queuesFolder);
      const made = session.broker.queue('/', 'billing');
      expect(made).toMatchObject({ type: 'quorum', durable: true, autoDelete: false });
      expect(picked[0]?.choices).toEqual(QUEUE_TYPES);
      expect(refreshed).toEqual([queuesFolder]);
      expect(infos).toEqual(['Created the queue "billing"']);
    });

    it('makes a classic queue when asked to', async () => {
      const { handlers, session } = setup({ inputs: ['plain'], picks: ['classic'] });
      await handlers.newQueue(queuesFolder);
      expect(session.broker.queue('/', 'plain')?.type).toBe('classic');
    });

    it('works from a connection that has a single virtual host, without asking', async () => {
      const { handlers, session, picked } = setup({ inputs: ['viaConn'], picks: ['classic'] });
      await handlers.newQueue('r1');
      expect(session.broker.queue('/', 'viaConn')).toBeDefined();
      expect(picked.map((one) => one.title)).toEqual(['The type of the queue']);
    });

    it('asks which virtual host when there are several', async () => {
      const { handlers, session, picked } = setup({
        vhosts: ['app'],
        inputs: ['q'],
        picks: ['app', 'classic'],
      });
      await handlers.newQueue('r1');
      expect(picked[0]?.title).toBe('Pick a virtual host');
      expect(session.broker.queue('app', 'q')).toBeDefined();
    });

    it('stops quietly when the user backs out at any question', async () => {
      for (const scenario of [
        { inputs: [undefined] },
        { inputs: ['q'], picks: [undefined] },
        { vhosts: ['app'], picks: [undefined] },
      ] satisfies Scenario[]) {
        const { handlers, session } = setup(scenario);
        await handlers.newQueue('r1');
        expect(session.calls).not.toContain('declareQueue');
      }
    });

    it('checks the name while it is typed', async () => {
      const { handlers } = setup({ inputs: ['amq.nope'] });
      await expect(handlers.newQueue(queuesFolder)).rejects.toThrow('rejected');
    });

    it('asks first on a production connection, and honours a no', async () => {
      const yes = setup({
        connections: [broker({ production: true })],
        inputs: ['p'],
        picks: ['classic'],
      });
      await yes.handlers.newQueue(queuesFolder);
      expect(yes.confirms[0]?.message).toContain('production connection "Local MQ"');
      expect(yes.session.broker.queue('/', 'p')).toBeDefined();
      const no = setup({
        connections: [broker({ production: true })],
        inputs: ['p'],
        picks: ['classic'],
        confirm: false,
      });
      await no.handlers.newQueue(queuesFolder);
      expect(no.session.broker.queue('/', 'p')).toBeUndefined();
    });

    it('refuses on a read-only connection before it asks anything', async () => {
      const { handlers, asked } = setup({ connections: [broker({ readOnly: true })] });
      await expect(handlers.newQueue(queuesFolder)).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'read-only',
      });
      expect(asked).toEqual([]);
    });

    it('needs a RabbitMQ connection, and picks among several', async () => {
      const none = setup({ connections: [{ id: 's', name: 's', driver: 'mysql', host: 'h' }] });
      await expect(none.handlers.newQueue(undefined)).rejects.toMatchObject({ code: 'not-found' });
      await expect(
        none.handlers.newQueue({ kind: 'connection', connectionId: 's' }),
      ).rejects.toMatchObject({ code: 'unsupported' });
      const two = setup({
        connections: [broker(), broker({ id: 'r2', name: 'Other' })],
        pickConnection: undefined,
      });
      await two.handlers.newQueue(undefined);
      expect(two.asked).toEqual([]);
    });
  });

  describe('newExchange', () => {
    it('asks for the name and the type and declares a durable exchange', async () => {
      const { handlers, session, refreshed, infos, picked } = setup({
        inputs: ['audit'],
        picks: ['fanout'],
      });
      await handlers.newExchange(exchangesFolder);
      expect(session.broker.exchanges.find((one) => one.name === 'audit')).toMatchObject({
        type: 'fanout',
        durable: true,
        autoDelete: false,
        internal: false,
      });
      expect(picked[0]?.choices).toEqual(EXCHANGE_TYPES);
      expect(refreshed).toEqual([exchangesFolder]);
      expect(infos).toEqual(['Created the exchange "audit"']);
    });

    it('stops when the user backs out, and honours production and read-only', async () => {
      const out = setup({ inputs: [undefined] });
      await out.handlers.newExchange(exchangesFolder);
      expect(out.session.calls).not.toContain('declareExchange');
      const noType = setup({ inputs: ['x'], picks: [undefined] });
      await noType.handlers.newExchange(exchangesFolder);
      expect(noType.session.calls).not.toContain('declareExchange');
      const prod = setup({
        connections: [broker({ production: true })],
        inputs: ['x'],
        picks: ['topic'],
        confirm: false,
      });
      await prod.handlers.newExchange(exchangesFolder);
      expect(prod.confirms[0]?.message).toContain('Create the exchange "x"');
      expect(prod.session.calls).not.toContain('declareExchange');
      const ro = setup({ connections: [broker({ readOnly: true })] });
      await expect(ro.handlers.newExchange(exchangesFolder)).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    it('falls back to a direct exchange for a type it does not know', async () => {
      const { handlers, session } = setup({ inputs: ['x'], picks: ['unknown'] });
      await handlers.newExchange(exchangesFolder);
      expect(session.broker.exchanges.find((one) => one.name === 'x')?.type).toBe('direct');
    });
  });

  describe('purgeQueue', () => {
    it('empties the queue after the user agrees', async () => {
      const { handlers, session, confirms, refreshed } = setup();
      await handlers.purgeQueue(queueNode());
      expect(session.broker.queue('/', 'orders')?.messages).toHaveLength(0);
      expect(confirms[0]).toMatchObject({
        message: 'Remove all messages of the queue "orders"?',
        detail: 'The messages are lost for good.',
      });
      expect(refreshed).toEqual([queuesFolder]);
    });

    it('names the production connection in the question', async () => {
      const { handlers, confirms } = setup({ connections: [broker({ production: true })] });
      await handlers.purgeQueue(queueNode());
      expect(confirms[0]?.detail).toContain('production connection');
    });

    it('changes nothing on a no, for a read-only connection, or for another node', async () => {
      const no = setup({ confirm: false });
      await no.handlers.purgeQueue(queueNode());
      expect(no.session.broker.queue('/', 'orders')?.messages).toHaveLength(1);
      const ro = setup({ connections: [broker({ readOnly: true })] });
      await expect(ro.handlers.purgeQueue(queueNode())).rejects.toMatchObject({
        code: 'permission-denied',
      });
      const other = setup();
      await other.handlers.purgeQueue(exchangeNode());
      await other.handlers.purgeQueue(undefined);
      expect(other.session.calls).toEqual([]);
    });
  });

  describe('deleteObject', () => {
    it('deletes a queue after the user agrees', async () => {
      const { handlers, session, confirms, refreshed } = setup();
      await handlers.deleteObject(queueNode());
      expect(session.broker.queue('/', 'orders')).toBeUndefined();
      expect(confirms[0]).toMatchObject({
        message: 'Delete the queue "orders"?',
        detail: 'Its messages are lost for good.',
      });
      expect(refreshed).toEqual([queuesFolder]);
    });

    it('deletes an exchange and refreshes the exchanges', async () => {
      const { handlers, session, confirms, refreshed } = setup();
      await handlers.deleteObject(exchangeNode());
      expect(session.broker.exchanges.some((one) => one.name === 'events')).toBe(false);
      expect(confirms[0]).toMatchObject({
        message: 'Delete the exchange "events"?',
        detail: 'Its bindings go with it.',
      });
      expect(refreshed).toEqual([exchangesFolder]);
    });

    it('never deletes the default exchange or one of the broker’s', async () => {
      const { handlers, session } = setup();
      for (const name of ['', 'amq.direct']) {
        await expect(handlers.deleteObject(exchangeNode(name))).rejects.toMatchObject({
          code: 'unsupported',
        });
      }
      expect(session.calls).not.toContain('deleteExchange');
    });

    it('keeps everything on a no, on read-only and for another node', async () => {
      const no = setup({ confirm: false });
      await no.handlers.deleteObject(queueNode());
      expect(no.session.broker.queue('/', 'orders')).toBeDefined();
      const ro = setup({ connections: [broker({ readOnly: true })] });
      await expect(ro.handlers.deleteObject(queueNode())).rejects.toMatchObject({
        code: 'permission-denied',
      });
      const other = setup();
      await other.handlers.deleteObject(queuesFolder);
      await other.handlers.deleteObject('r1');
      expect(other.session.calls).toEqual([]);
    });

    it('speaks of the production connection', async () => {
      const { handlers, confirms } = setup({ connections: [broker({ production: true })] });
      await handlers.deleteObject(queueNode());
      expect(confirms[0]?.detail).toBe('"Local MQ" is a production connection.');
    });
  });

  describe('virtual hosts (V13.32)', () => {
    const vhostNode = (vhost = 'app'): TreeNode => ({
      kind: 'rabbitVhost',
      connectionId: 'r1',
      vhost,
    });
    const connectionNode: TreeNode = { kind: 'connection', connectionId: 'r1' };

    it('makes one from the connection, refreshes the tree and says so', async () => {
      const { handlers, session, refreshed, infos, asked } = setup({ inputs: [' app/one '] });
      await handlers.newVhost(connectionNode);
      expect(asked).toEqual(['The name of the virtual host']);
      expect(session.broker.vhosts.has('app/one')).toBe(true);
      expect(refreshed).toEqual([connectionNode]);
      expect(infos).toEqual(['Created the virtual host "app/one"']);
    });

    it('can be started from the node of a virtual host too', async () => {
      const { handlers, session } = setup({ inputs: ['second'] });
      await handlers.newVhost(vhostNode('/'));
      expect(session.broker.vhosts.has('second')).toBe(true);
    });

    it('stops when the user backs out, and refuses a name that exists', async () => {
      const out = setup({ inputs: [undefined] });
      await out.handlers.newVhost(connectionNode);
      expect(out.session.calls).not.toContain('createVhost');
      const twice = setup({ inputs: ['/'] });
      await expect(twice.handlers.newVhost(connectionNode)).rejects.toMatchObject({
        code: 'constraint',
      });
      expect(twice.session.calls).not.toContain('createVhost');
    });

    it('checks the name while it is typed', async () => {
      const { handlers } = setup({ inputs: ['  '] });
      await expect(handlers.newVhost(connectionNode)).rejects.toThrow(
        'A virtual host needs a name',
      );
    });

    it('asks first on a production connection, and honours a no', async () => {
      const yes = setup({ connections: [broker({ production: true })], inputs: ['prod'] });
      await yes.handlers.newVhost(connectionNode);
      expect(yes.confirms[0]?.message).toContain('production connection "Local MQ"');
      expect(yes.session.broker.vhosts.has('prod')).toBe(true);
      const no = setup({
        connections: [broker({ production: true })],
        inputs: ['prod'],
        confirm: false,
      });
      await no.handlers.newVhost(connectionNode);
      expect(no.session.broker.vhosts.has('prod')).toBe(false);
    });

    it('is refused on a read-only connection, and on one limited to a virtual host', async () => {
      const ro = setup({ connections: [broker({ readOnly: true })] });
      await expect(ro.handlers.newVhost(connectionNode)).rejects.toMatchObject({
        code: 'permission-denied',
      });
      const limited = setup({ connections: [broker({ database: 'only' })], inputs: ['x'] });
      await expect(limited.handlers.newVhost(connectionNode)).rejects.toMatchObject({
        code: 'unsupported',
      });
      expect(limited.session.calls).not.toContain('createVhost');
    });

    it('deletes one after the question, and refreshes the tree', async () => {
      const { handlers, session, confirms, refreshed } = setup({ vhosts: ['app'] });
      await handlers.deleteVhost(vhostNode('app'));
      expect(confirms[0]?.message).toBe('Delete the virtual host "app"?');
      expect(confirms[0]?.detail).toBe(
        'Every queue, exchange, binding and message in it is lost for good.',
      );
      expect(session.broker.vhosts.has('app')).toBe(false);
      expect(refreshed).toEqual([connectionNode]);
    });

    it('warns about the default virtual host and the production connection', async () => {
      const { handlers, confirms } = setup({ connections: [broker({ production: true })] });
      await handlers.deleteVhost(vhostNode('/'));
      expect(confirms[0]?.detail).toBe(
        '"Local MQ" is a production connection. Every queue, exchange, binding and message in it is lost for good. This is the default virtual host of the broker.',
      );
    });

    it('keeps everything on a no, on read-only and for another node', async () => {
      const no = setup({ vhosts: ['app'], confirm: false });
      await no.handlers.deleteVhost(vhostNode('app'));
      expect(no.session.broker.vhosts.has('app')).toBe(true);
      const ro = setup({ connections: [broker({ readOnly: true })], vhosts: ['app'] });
      await expect(ro.handlers.deleteVhost(vhostNode('app'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      const other = setup();
      await other.handlers.deleteVhost(queuesFolder);
      await other.handlers.deleteVhost('r1');
      expect(other.session.calls).toEqual([]);
    });
  });
});

describe('vhostNameProblem', () => {
  it('takes what RabbitMQ takes, even a slash', () => {
    expect(vhostNameProblem('/')).toBeUndefined();
    expect(vhostNameProblem('app/one')).toBeUndefined();
    expect(vhostNameProblem('amq.something')).toBeUndefined();
  });

  it('refuses an empty name and a long one', () => {
    expect(vhostNameProblem('')).toBe('A virtual host needs a name');
    expect(vhostNameProblem('x'.repeat(MAX_NAME + 1))).toContain('at most 255 bytes');
  });
});
