// The tree commands of Kafka connections (V13.23), free of `vscode`: what the dialogs ask
// comes in through `KafkaCommandUi`, so every path (a taken name, a refused delete, a
// production connection) is tested without an editor.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { KafkaOffsetTarget, KafkaSession } from '../../drivers/kafka-driver';
import type { ConnectionStore } from '../../services/connection-store';
import { changeVerdict, policyOf } from '../../services/write-policy';
import { parseMoment } from '../panels/kafka-topic-model';
import { connectionIdOf, isTreeNode, type TreeNode } from '../tree/nodes';
import type { CommandTarget } from '../tree/tree-commands';

/** Partitions and replicas a new topic starts with, as the broker's own defaults. */
export const DEFAULT_PARTITIONS = 1;
export const DEFAULT_REPLICATION = 1;
/** The longest topic name Kafka accepts. */
export const MAX_TOPIC_NAME = 249;

export interface KafkaCommandUi {
  /** Asks for text; undefined when the user backs out. */
  input(options: {
    readonly title: string;
    readonly prompt: string;
    readonly value?: string;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  /** A modal question with one action; true when the user takes it. */
  confirm(message: string, detail: string | undefined, action: string): Promise<boolean>;
  /** Picks one of the items; undefined when the user backs out. */
  pick<T>(
    items: readonly { readonly label: string; readonly description?: string; readonly value: T }[],
    placeholder: string,
  ): Promise<T | undefined>;
  /** Picks one of the connections; undefined when the user backs out. */
  pickConnection(ids: readonly string[]): Promise<string | undefined>;
  /** Tells the user something without asking. */
  info(message: string): void;
}

export interface KafkaCommandDeps {
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  /** The tree's session of a connection. */
  readonly session: (connectionId: string) => Promise<KafkaSession>;
  readonly tree: { refresh(node?: TreeNode): void };
  readonly ui: KafkaCommandUi;
  /** Opens the page of a topic. */
  readonly openTopic: (connectionId: string, topic: string, internal: boolean) => Promise<void>;
  readonly texts: {
    readonly noKafka: string;
    readonly readOnly: string;
  };
}

export type KafkaCommandName = 'openTopic' | 'newTopic' | 'deleteTopic' | 'resetOffsets';

/** What is wrong with a topic name, or undefined when Kafka takes it. */
export function topicNameProblem(name: string): string | undefined {
  if (name === '' || name === '.' || name === '..') {
    return msg('A topic needs a name');
  }
  if (name.length > MAX_TOPIC_NAME) {
    return msg('A topic name has at most {0} characters', MAX_TOPIC_NAME);
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
    return msg('Use letters, digits, ".", "_" and "-" in a topic name');
  }
  return undefined;
}

function wholeNumber(text: string, min: number): number | undefined {
  return /^\d{1,6}$/u.test(text.trim()) && Number(text) >= min ? Number(text) : undefined;
}

export function kafkaCommandHandlers(
  deps: KafkaCommandDeps,
): Record<KafkaCommandName, (target?: CommandTarget) => unknown> {
  /** The connection of the clicked node, or one the user picks. */
  const connectionOf = async (target: CommandTarget): Promise<string | undefined> => {
    const given = connectionIdOf(target);
    if (given !== undefined) {
      if (deps.store.get(given)?.driver !== 'kafka') {
        throw new DbError('unsupported', deps.texts.noKafka);
      }
      return given;
    }
    const all = deps.store.list().filter((config) => config.driver === 'kafka');
    if (all.length === 0) {
      throw new DbError('not-found', deps.texts.noKafka);
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

  const topicsNode = (connectionId: string): TreeNode => ({ kind: 'kafkaTopics', connectionId });

  return {
    openTopic: async (target?: CommandTarget) => {
      if (!isTreeNode(target)) {
        return undefined;
      }
      if (target.kind === 'kafkaTopic') {
        await deps.openTopic(target.connectionId, target.topic, target.internal);
      } else if (target.kind === 'kafkaPartition') {
        await deps.openTopic(target.connectionId, target.topic, target.topic.startsWith('_'));
      }
      return undefined;
    },

    newTopic: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      requireWritable(connectionId);
      const policy = policyOf(deps.store.get(connectionId));
      const name = await deps.ui.input({
        title: msg('New Topic'),
        prompt: msg('The name of the topic'),
        validate: (value) => topicNameProblem(value.trim()),
      });
      if (name === undefined) {
        return undefined;
      }
      const partitionsText = await deps.ui.input({
        title: msg('New Topic'),
        prompt: msg('How many partitions?'),
        value: String(DEFAULT_PARTITIONS),
        validate: (value) =>
          wholeNumber(value, 1) === undefined ? msg('Enter a whole number, 1 or more') : undefined,
      });
      if (partitionsText === undefined) {
        return undefined;
      }
      const replicationText = await deps.ui.input({
        title: msg('New Topic'),
        prompt: msg('How many copies of each partition (replication factor)?'),
        value: String(DEFAULT_REPLICATION),
        validate: (value) =>
          wholeNumber(value, 1) === undefined ? msg('Enter a whole number, 1 or more') : undefined,
      });
      if (replicationText === undefined) {
        return undefined;
      }
      if (
        changeVerdict(policy) === 'confirm' &&
        !(await deps.ui.confirm(
          msg(
            'Create the topic "{0}" on the production connection "{1}"?',
            name.trim(),
            policy.name,
          ),
          undefined,
          msg('Create'),
        ))
      ) {
        return undefined;
      }
      const session = await deps.session(connectionId);
      await session.createTopic(
        name.trim(),
        wholeNumber(partitionsText, 1) ?? DEFAULT_PARTITIONS,
        wholeNumber(replicationText, 1) ?? DEFAULT_REPLICATION,
      );
      deps.tree.refresh(topicsNode(connectionId));
      deps.ui.info(msg('Created the topic "{0}"', name.trim()));
      return undefined;
    },

    deleteTopic: async (target?: CommandTarget) => {
      if (!isTreeNode(target) || target.kind !== 'kafkaTopic') {
        return undefined;
      }
      requireWritable(target.connectionId);
      const policy = policyOf(deps.store.get(target.connectionId));
      const taken = await deps.ui.confirm(
        msg('Delete the topic "{0}"?', target.topic),
        policy.production
          ? msg('"{0}" is a production connection. The messages are lost for good.', policy.name)
          : msg('Its messages are lost for good.'),
        msg('Delete'),
      );
      if (!taken) {
        return undefined;
      }
      const session = await deps.session(target.connectionId);
      await session.deleteTopic(target.topic);
      deps.tree.refresh(topicsNode(target.connectionId));
      return undefined;
    },

    resetOffsets: async (target?: CommandTarget) => {
      if (!isTreeNode(target) || target.kind !== 'kafkaGroup') {
        return undefined;
      }
      requireWritable(target.connectionId);
      const policy = policyOf(deps.store.get(target.connectionId));
      const session = await deps.session(target.connectionId);
      const topics = [...new Set((await session.groupLag(target.group)).map((one) => one.topic))];
      if (topics.length === 0) {
        deps.ui.info(msg('The group "{0}" has committed no offsets yet', target.group));
        return undefined;
      }
      const topic =
        topics.length === 1
          ? topics[0]
          : await deps.ui.pick(
              topics.map((name) => ({ label: name, value: name })),
              msg('Which topic should the offsets of "{0}" move on?', target.group),
            );
      if (topic === undefined) {
        return undefined;
      }
      const chosen = await deps.ui.pick<'earliest' | 'latest' | 'offset' | 'time'>(
        [
          {
            label: msg('To the beginning'),
            description: msg('the group reads the topic again from its oldest message'),
            value: 'earliest',
          },
          {
            label: msg('To the end'),
            description: msg('the group skips everything that is there now'),
            value: 'latest',
          },
          {
            label: msg('To an offset…'),
            description: msg('the same offset on every partition'),
            value: 'offset',
          },
          {
            label: msg('To a moment in time…'),
            description: msg('the first message at or after it'),
            value: 'time',
          },
        ],
        msg('Where should the group of "{0}" read from?', topic),
      );
      if (chosen === undefined) {
        return undefined;
      }
      let move: KafkaOffsetTarget;
      if (chosen === 'offset') {
        const text = await deps.ui.input({
          title: msg('Reset Offsets'),
          prompt: msg('The offset (a partition that holds fewer messages goes to its end)'),
          value: '0',
          validate: (value) =>
            /^\d{1,18}$/u.test(value.trim()) ? undefined : msg('Enter a whole number, 0 or more'),
        });
        if (text === undefined) {
          return undefined;
        }
        move = { kind: 'offset', offset: text.trim() };
      } else if (chosen === 'time') {
        const text = await deps.ui.input({
          title: msg('Reset Offsets'),
          prompt: msg('The moment, e.g. 2026-11-01 12:00 (or milliseconds since 1970)'),
          validate: (value) => {
            try {
              parseMoment(value);
              return undefined;
            } catch {
              return msg('That is not a date and time');
            }
          },
        });
        if (text === undefined) {
          return undefined;
        }
        move = { kind: 'time', timestamp: parseMoment(text) };
      } else {
        move = { kind: chosen };
      }
      // The consumers will start from the new place: that is always worth a question.
      const taken = await deps.ui.confirm(
        msg('Move the offsets of the group "{0}" on the topic "{1}"?', target.group, topic),
        policy.production
          ? msg(
              '"{0}" is a production connection. The group will read from the new place.',
              policy.name,
            )
          : msg('The group will read from the new place; what it skips is not read again.'),
        msg('Reset'),
      );
      if (!taken) {
        return undefined;
      }
      const done = await session.resetGroupOffsets(target.group, topic, move);
      deps.tree.refresh(target);
      deps.ui.info(
        msg(
          'Moved the offsets of "{0}" on {1} partitions of "{2}"',
          target.group,
          done.length,
          topic,
        ),
      );
      return undefined;
    },
  };
}
