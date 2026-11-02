// The tree commands of RabbitMQ connections (V13.26), free of `vscode`: what the dialogs ask
// comes in through `RabbitCommandUi`, so every path (a bad name, a refused delete, a
// production connection) is tested without an editor.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { RabbitSession } from '../../drivers/rabbitmq-driver';
import type { ConnectionStore } from '../../services/connection-store';
import { changeVerdict, policyOf } from '../../services/write-policy';
import { connectionIdOf, isTreeNode, type TreeNode } from '../tree/nodes';
import type { CommandTarget } from '../tree/tree-commands';

/** The longest name RabbitMQ accepts for a queue or an exchange (255 bytes). */
export const MAX_NAME = 255;

export const QUEUE_TYPES = ['classic', 'quorum', 'stream'] as const;
export const EXCHANGE_TYPES = ['direct', 'fanout', 'topic', 'headers'] as const;

export interface RabbitCommandUi {
  /** Asks for text; undefined when the user backs out. */
  input(options: {
    readonly title: string;
    readonly prompt: string;
    readonly value?: string;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  /** Picks one of the choices; undefined when the user backs out. */
  pick(title: string, choices: readonly string[]): Promise<string | undefined>;
  /** A modal question with one action; true when the user takes it. */
  confirm(message: string, detail: string | undefined, action: string): Promise<boolean>;
  /** Picks one of the connections; undefined when the user backs out. */
  pickConnection(ids: readonly string[]): Promise<string | undefined>;
  /** Tells the user something without asking. */
  info(message: string): void;
}

export interface RabbitCommandDeps {
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  /** The tree's session of a connection. */
  readonly session: (connectionId: string) => Promise<RabbitSession>;
  readonly tree: { refresh(node?: TreeNode): void };
  readonly ui: RabbitCommandUi;
  /** Opens the page of a queue or an exchange. */
  readonly openObject: (
    connectionId: string,
    kind: 'queue' | 'exchange' | 'vhost',
    vhost: string,
    name: string,
  ) => Promise<void>;
  readonly texts: {
    readonly noRabbit: string;
    readonly readOnly: string;
  };
}

export type RabbitCommandName =
  'openObject' | 'newQueue' | 'newExchange' | 'purgeQueue' | 'deleteObject';

/** What is wrong with a queue or exchange name, or undefined when RabbitMQ takes it. */
export function objectNameProblem(name: string, what: 'queue' | 'exchange'): string | undefined {
  if (name === '') {
    return what === 'queue' ? msg('A queue needs a name') : msg('An exchange needs a name');
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME) {
    return msg('A name has at most {0} bytes', MAX_NAME);
  }
  if (name.startsWith('amq.')) {
    return msg('Names that begin with "amq." belong to the broker');
  }
  return undefined;
}

export function rabbitCommandHandlers(
  deps: RabbitCommandDeps,
): Record<RabbitCommandName, (target?: CommandTarget) => unknown> {
  /** The connection of the clicked node, or one the user picks. */
  const connectionOf = async (target: CommandTarget): Promise<string | undefined> => {
    const given = connectionIdOf(target);
    if (given !== undefined) {
      if (deps.store.get(given)?.driver !== 'rabbitmq') {
        throw new DbError('unsupported', deps.texts.noRabbit);
      }
      return given;
    }
    const all = deps.store.list().filter((config) => config.driver === 'rabbitmq');
    if (all.length === 0) {
      throw new DbError('not-found', deps.texts.noRabbit);
    }
    return all.length === 1
      ? all[0]?.id
      : await deps.ui.pickConnection(all.map((config) => config.id));
  };

  const requireWritable = (connectionId: string): void => {
    if (changeVerdict(policyOf(deps.store.get(connectionId))) === 'refuse') {
      throw new DbError('permission-denied', deps.texts.readOnly);
    }
  };

  /** Where a new object goes: the host of the clicked node, else the one the user picks. */
  const vhostOf = async (
    target: CommandTarget,
    connectionId: string,
  ): Promise<string | undefined> => {
    if (
      isTreeNode(target) &&
      (target.kind === 'rabbitVhost' ||
        target.kind === 'rabbitFolder' ||
        target.kind === 'rabbitQueue' ||
        target.kind === 'rabbitExchange')
    ) {
      return target.vhost;
    }
    const session = await deps.session(connectionId);
    const vhosts = (await session.listVhosts()).map((vhost) => vhost.name);
    if (vhosts.length === 1) {
      return vhosts[0];
    }
    return await deps.ui.pick(msg('Pick a virtual host'), vhosts);
  };

  const confirmProduction = async (
    connectionId: string,
    question: string,
    action: string,
  ): Promise<boolean> => {
    const policy = policyOf(deps.store.get(connectionId));
    return (
      changeVerdict(policy) !== 'confirm' || (await deps.ui.confirm(question, undefined, action))
    );
  };

  const folderNode = (
    connectionId: string,
    vhost: string,
    folder: 'queues' | 'exchanges',
  ): TreeNode => ({ kind: 'rabbitFolder', connectionId, vhost, folder });

  return {
    openObject: async (target?: CommandTarget) => {
      if (!isTreeNode(target)) {
        return undefined;
      }
      if (target.kind === 'rabbitQueue') {
        await deps.openObject(target.connectionId, 'queue', target.vhost, target.queue);
      } else if (target.kind === 'rabbitExchange') {
        await deps.openObject(target.connectionId, 'exchange', target.vhost, target.exchange);
      } else if (target.kind === 'rabbitFolder' && target.folder === 'admin') {
        // The page of a virtual host is named after it.
        await deps.openObject(target.connectionId, 'vhost', target.vhost, target.vhost);
      }
      return undefined;
    },

    newQueue: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      requireWritable(connectionId);
      const vhost = await vhostOf(target, connectionId);
      if (vhost === undefined) {
        return undefined;
      }
      const name = await deps.ui.input({
        title: msg('New Queue'),
        prompt: msg('The name of the queue'),
        validate: (value) => objectNameProblem(value.trim(), 'queue'),
      });
      if (name === undefined) {
        return undefined;
      }
      const type = await deps.ui.pick(msg('The type of the queue'), QUEUE_TYPES);
      if (type === undefined) {
        return undefined;
      }
      if (
        !(await confirmProduction(
          connectionId,
          msg(
            'Create the queue "{0}" on the production connection "{1}"?',
            name.trim(),
            policyOf(deps.store.get(connectionId)).name,
          ),
          msg('Create'),
        ))
      ) {
        return undefined;
      }
      const session = await deps.session(connectionId);
      await session.declareQueue({
        vhost,
        name: name.trim(),
        type: type === 'quorum' || type === 'stream' ? type : 'classic',
        // A quorum or stream queue must be durable; a classic one is made durable too, so
        // it survives a restart of the broker like the user expects of a queue they name.
        durable: true,
        autoDelete: false,
      });
      deps.tree.refresh(folderNode(connectionId, vhost, 'queues'));
      deps.ui.info(msg('Created the queue "{0}"', name.trim()));
      return undefined;
    },

    newExchange: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      requireWritable(connectionId);
      const vhost = await vhostOf(target, connectionId);
      if (vhost === undefined) {
        return undefined;
      }
      const name = await deps.ui.input({
        title: msg('New Exchange'),
        prompt: msg('The name of the exchange'),
        validate: (value) => objectNameProblem(value.trim(), 'exchange'),
      });
      if (name === undefined) {
        return undefined;
      }
      const type = await deps.ui.pick(msg('The type of the exchange'), EXCHANGE_TYPES);
      if (type === undefined) {
        return undefined;
      }
      if (
        !(await confirmProduction(
          connectionId,
          msg(
            'Create the exchange "{0}" on the production connection "{1}"?',
            name.trim(),
            policyOf(deps.store.get(connectionId)).name,
          ),
          msg('Create'),
        ))
      ) {
        return undefined;
      }
      const session = await deps.session(connectionId);
      await session.declareExchange({
        vhost,
        name: name.trim(),
        type: EXCHANGE_TYPES.find((one) => one === type) ?? 'direct',
        durable: true,
        autoDelete: false,
        internal: false,
      });
      deps.tree.refresh(folderNode(connectionId, vhost, 'exchanges'));
      deps.ui.info(msg('Created the exchange "{0}"', name.trim()));
      return undefined;
    },

    purgeQueue: async (target?: CommandTarget) => {
      if (!isTreeNode(target) || target.kind !== 'rabbitQueue') {
        return undefined;
      }
      requireWritable(target.connectionId);
      const policy = policyOf(deps.store.get(target.connectionId));
      const taken = await deps.ui.confirm(
        msg('Remove all messages of the queue "{0}"?', target.queue),
        policy.production
          ? msg('"{0}" is a production connection. The messages are lost for good.', policy.name)
          : msg('The messages are lost for good.'),
        msg('Remove Messages'),
      );
      if (!taken) {
        return undefined;
      }
      const session = await deps.session(target.connectionId);
      await session.purgeQueue(target.vhost, target.queue);
      deps.tree.refresh(folderNode(target.connectionId, target.vhost, 'queues'));
      return undefined;
    },

    deleteObject: async (target?: CommandTarget) => {
      if (
        !isTreeNode(target) ||
        (target.kind !== 'rabbitQueue' && target.kind !== 'rabbitExchange')
      ) {
        return undefined;
      }
      requireWritable(target.connectionId);
      const queue = target.kind === 'rabbitQueue';
      const name = target.kind === 'rabbitQueue' ? target.queue : target.exchange;
      if (!queue && (name === '' || name.startsWith('amq.'))) {
        throw new DbError('unsupported', msg('The broker’s own exchanges cannot be deleted'));
      }
      const policy = policyOf(deps.store.get(target.connectionId));
      const taken = await deps.ui.confirm(
        queue ? msg('Delete the queue "{0}"?', name) : msg('Delete the exchange "{0}"?', name),
        policy.production
          ? msg('"{0}" is a production connection.', policy.name)
          : queue
            ? msg('Its messages are lost for good.')
            : msg('Its bindings go with it.'),
        msg('Delete'),
      );
      if (!taken) {
        return undefined;
      }
      const session = await deps.session(target.connectionId);
      if (queue) {
        await session.deleteQueue(target.vhost, name);
      } else {
        await session.deleteExchange(target.vhost, name);
      }
      deps.tree.refresh(
        folderNode(target.connectionId, target.vhost, queue ? 'queues' : 'exchanges'),
      );
      return undefined;
    },
  };
}
