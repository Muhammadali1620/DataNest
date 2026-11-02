import { describe, expect, it } from 'vitest';
import { nameOf, nodeId, type TreeNode } from '../../../../src/vscode/tree/nodes';
import {
  rabbitFolderChildren,
  rabbitObjectChildren,
  rabbitVhostChildren,
  type RabbitTreeDeps,
} from '../../../../src/vscode/tree/rabbitmq-tree';
import { FakeRabbitSession } from '../../../helpers/fake-rabbitmq';

function setup() {
  const session = new FakeRabbitSession();
  session.broker.vhosts.add('app');
  session.broker.addQueue({
    vhost: '/',
    name: 'orders',
    consumers: 2,
    state: 'running',
    messages: ['a', 'b'],
    unacked: 1,
  });
  session.broker.addQueue({ vhost: '/', name: 'idle' });
  const owners: string[] = [];
  const deps: RabbitTreeDeps = {
    manager: {
      acquireRabbit: (owner) => {
        owners.push(owner);
        return Promise.resolve(session);
      },
    },
    texts: {
      noVhosts: 'No hosts',
      noQueues: 'No queues',
      noExchanges: 'No exchanges',
      more: (count) => `${count} more`,
    },
  };
  return { session, deps, owners };
}

describe('RabbitMQ tree (V13.26)', () => {
  it('lists the virtual hosts of a connection with the tree’s own session', async () => {
    const { deps, owners } = setup();
    expect(await rabbitVhostChildren(deps, 'r1')).toEqual([
      { kind: 'rabbitVhost', connectionId: 'r1', vhost: '/' },
      { kind: 'rabbitVhost', connectionId: 'r1', vhost: 'app' },
    ]);
    expect(owners).toEqual(['tree:r1']);
  });

  it('says so when the user sees no virtual host', async () => {
    const { deps, session } = setup();
    session.broker.vhosts.clear();
    expect(await rabbitVhostChildren(deps, 'r1')).toEqual([
      { kind: 'message', text: 'No hosts', connectionId: 'r1' },
    ]);
  });

  it('shows a virtual host as its two folders', () => {
    expect(rabbitFolderChildren({ kind: 'rabbitVhost', connectionId: 'r1', vhost: '/' })).toEqual([
      { kind: 'rabbitFolder', connectionId: 'r1', vhost: '/', folder: 'queues' },
      { kind: 'rabbitFolder', connectionId: 'r1', vhost: '/', folder: 'exchanges' },
    ]);
  });

  it('lists the queues of a host with what waits in them', async () => {
    const { deps } = setup();
    const nodes = await rabbitObjectChildren(deps, {
      kind: 'rabbitFolder',
      connectionId: 'r1',
      vhost: '/',
      folder: 'queues',
    });
    expect(nodes).toEqual([
      {
        kind: 'rabbitQueue',
        connectionId: 'r1',
        vhost: '/',
        queue: 'orders',
        state: 'running',
        ready: 2,
        unacked: 1,
        consumers: 2,
      },
      {
        kind: 'rabbitQueue',
        connectionId: 'r1',
        vhost: '/',
        queue: 'idle',
        state: 'running',
        ready: 0,
        unacked: 0,
        consumers: 0,
      },
    ]);
  });

  it('says how many queues it did not list', async () => {
    const { deps, session } = setup();
    session.broker.extraTotal = 7;
    const nodes = await rabbitObjectChildren(deps, {
      kind: 'rabbitFolder',
      connectionId: 'r1',
      vhost: '/',
      folder: 'queues',
    });
    expect(nodes.at(-1)).toEqual({ kind: 'message', text: '7 more', connectionId: 'r1' });
    expect(nodes).toHaveLength(3);
  });

  it('says so when a host has no queues', async () => {
    const { deps } = setup();
    expect(
      await rabbitObjectChildren(deps, {
        kind: 'rabbitFolder',
        connectionId: 'r1',
        vhost: 'app',
        folder: 'queues',
      }),
    ).toEqual([{ kind: 'message', text: 'No queues', connectionId: 'r1' }]);
  });

  it('lists the exchanges, the default one with an empty name', async () => {
    const { deps, session } = setup();
    const nodes = await rabbitObjectChildren(deps, {
      kind: 'rabbitFolder',
      connectionId: 'r1',
      vhost: '/',
      folder: 'exchanges',
    });
    expect(nodes.map((node) => (node.kind === 'rabbitExchange' ? node.exchange : '?'))).toEqual([
      '',
      'amq.direct',
      'amq.topic',
    ]);
    expect(nodes[2]).toMatchObject({ exchangeType: 'topic' });
    session.broker.extraTotal = 2;
    const more = await rabbitObjectChildren(deps, {
      kind: 'rabbitFolder',
      connectionId: 'r1',
      vhost: '/',
      folder: 'exchanges',
    });
    expect(more.at(-1)).toMatchObject({ kind: 'message', text: '2 more' });
  });

  it('says so when a host has no exchanges', async () => {
    const { deps, session } = setup();
    session.broker.exchanges.length = 0;
    expect(
      await rabbitObjectChildren(deps, {
        kind: 'rabbitFolder',
        connectionId: 'r1',
        vhost: '/',
        folder: 'exchanges',
      }),
    ).toEqual([{ kind: 'message', text: 'No exchanges', connectionId: 'r1' }]);
  });

  it('gives every node an id of its own and a name to copy', () => {
    const nodes: TreeNode[] = [
      { kind: 'rabbitVhost', connectionId: 'r1', vhost: '/' },
      { kind: 'rabbitFolder', connectionId: 'r1', vhost: '/', folder: 'queues' },
      { kind: 'rabbitFolder', connectionId: 'r1', vhost: '/', folder: 'exchanges' },
      {
        kind: 'rabbitQueue',
        connectionId: 'r1',
        vhost: '/',
        queue: 'q',
        state: '',
        ready: 0,
        unacked: 0,
        consumers: 0,
      },
      {
        kind: 'rabbitExchange',
        connectionId: 'r1',
        vhost: '/',
        exchange: 'x',
        exchangeType: 'direct',
      },
      {
        kind: 'rabbitExchange',
        connectionId: 'r1',
        vhost: '/',
        exchange: '',
        exchangeType: 'direct',
      },
      { kind: 'rabbitVhost', connectionId: 'r1', vhost: 'app' },
    ];
    expect(new Set(nodes.map(nodeId)).size).toBe(nodes.length);
    expect(nodes.map(nameOf)).toEqual(['/', undefined, undefined, 'q', 'x', undefined, 'app']);
  });
});
