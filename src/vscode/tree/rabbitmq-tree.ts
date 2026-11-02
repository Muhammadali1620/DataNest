// The children of RabbitMQ nodes (V13.26): a connection holds its virtual hosts; a host
// holds a Queues and an Exchanges folder; a folder holds the objects. Free of `vscode`.
// Asking the broker is cheap but not free, so the model keeps nothing: a refresh of the
// tree is a new question.

import { ConnectionManager } from '../../services/connection-manager';
import type {
  MessageNode,
  RabbitExchangeNode,
  RabbitFolderNode,
  RabbitQueueNode,
  RabbitVhostNode,
  TreeNode,
} from './nodes';

export interface RabbitTreeDeps {
  readonly manager: Pick<ConnectionManager, 'acquireRabbit'>;
  readonly texts: {
    readonly noVhosts: string;
    readonly noQueues: string;
    readonly noExchanges: string;
    /** `… and 120 more that are not shown`. */
    readonly more: (count: number) => string;
  };
}

function owner(connectionId: string): string {
  return ConnectionManager.treeOwner(connectionId);
}

/** A connection of RabbitMQ: its virtual hosts. */
export async function rabbitVhostChildren(
  deps: RabbitTreeDeps,
  connectionId: string,
): Promise<TreeNode[]> {
  const session = await deps.manager.acquireRabbit(owner(connectionId), { connectionId });
  const vhosts = await session.listVhosts();
  if (vhosts.length === 0) {
    return [message(deps.texts.noVhosts, connectionId)];
  }
  return vhosts.map((vhost): RabbitVhostNode => ({
    kind: 'rabbitVhost',
    connectionId,
    vhost: vhost.name,
  }));
}

/** A virtual host: the two folders. */
export function rabbitFolderChildren(node: RabbitVhostNode): TreeNode[] {
  return [
    { kind: 'rabbitFolder', connectionId: node.connectionId, vhost: node.vhost, folder: 'queues' },
    {
      kind: 'rabbitFolder',
      connectionId: node.connectionId,
      vhost: node.vhost,
      folder: 'exchanges',
    },
    { kind: 'rabbitFolder', connectionId: node.connectionId, vhost: node.vhost, folder: 'admin' },
  ];
}

export async function rabbitObjectChildren(
  deps: RabbitTreeDeps,
  node: RabbitFolderNode,
): Promise<TreeNode[]> {
  // The administration page is a leaf; it opens a page and has nothing below it.
  if (node.folder === 'admin') {
    return [];
  }
  const session = await deps.manager.acquireRabbit(owner(node.connectionId), {
    connectionId: node.connectionId,
  });
  if (node.folder === 'queues') {
    const page = await session.listQueues(node.vhost);
    if (page.items.length === 0) {
      return [message(deps.texts.noQueues, node.connectionId)];
    }
    const nodes: TreeNode[] = page.items.map((queue): RabbitQueueNode => ({
      kind: 'rabbitQueue',
      connectionId: node.connectionId,
      vhost: node.vhost,
      queue: queue.name,
      state: queue.state,
      ready: queue.ready,
      unacked: queue.unacked,
      consumers: queue.consumers,
    }));
    if (page.total > page.items.length) {
      nodes.push(message(deps.texts.more(page.total - page.items.length), node.connectionId));
    }
    return nodes;
  }
  const page = await session.listExchanges(node.vhost);
  if (page.items.length === 0) {
    return [message(deps.texts.noExchanges, node.connectionId)];
  }
  const nodes: TreeNode[] = page.items.map((exchange): RabbitExchangeNode => ({
    kind: 'rabbitExchange',
    connectionId: node.connectionId,
    vhost: node.vhost,
    exchange: exchange.name,
    exchangeType: exchange.type,
  }));
  if (page.total > page.items.length) {
    nodes.push(message(deps.texts.more(page.total - page.items.length), node.connectionId));
  }
  return nodes;
}

function message(text: string, connectionId: string): MessageNode {
  return { kind: 'message', text, connectionId };
}
