// The commands of Kafka that look after the cluster itself (V13.34): who may do what (access
// rules, ACLs) and the settings of a topic or a broker. Like the other Kafka commands they are
// free of `vscode`; the dialogs come in through `KafkaCommandUi`. They are lists to pick from,
// not a page of their own (as with etcd's users and roles, D157): a pick opens one rule or one
// setting, and the list shows again after every change.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  KAFKA_ACL_OPERATIONS,
  KAFKA_ACL_RESOURCES,
  type KafkaAcl,
  type KafkaAclOperation,
  type KafkaAclPattern,
  type KafkaAclResource,
  type KafkaConfigEntry,
  type KafkaConfigTarget,
} from '../../drivers/kafka-driver';
import { changeVerdict, policyOf } from '../../services/write-policy';
import { connectionIdOf, isTreeNode } from '../tree/nodes';
import type { CommandTarget } from '../tree/tree-commands';
import type { KafkaCommandDeps } from './kafka-commands';

export type KafkaAdminCommandName = 'manageAcls' | 'manageSettings';

/** The name the cluster itself goes by in a rule. */
export const CLUSTER_RESOURCE_NAME = 'kafka-cluster';

/** A rule in one line, the way the list shows it. */
export function describeAcl(acl: KafkaAcl): string {
  const what =
    acl.resource === 'cluster'
      ? msg('the cluster')
      : acl.pattern === 'prefixed'
        ? msg('{0} "{1}…"', acl.resource, acl.name)
        : msg('{0} "{1}"', acl.resource, acl.name);
  return acl.permission === 'allow'
    ? msg('{0} may {1} {2}', acl.principal, acl.operation, what)
    : msg('{0} may not {1} {2}', acl.principal, acl.operation, what);
}

/** What is wrong with a principal (`User:alice`), or undefined when it can be used. */
export function principalProblem(text: string): string | undefined {
  const value = text.trim();
  if (!/^[A-Za-z][A-Za-z0-9]*:.+$/u.test(value)) {
    return msg('Write it as Type:name, e.g. User:alice (User:* is everybody)');
  }
  return undefined;
}

type AclListChoice = { readonly kind: 'add' } | { readonly kind: 'rule'; readonly acl: KafkaAcl };

interface ConfigChoice {
  readonly entry: KafkaConfigEntry;
}

export function kafkaAdminHandlers(
  deps: KafkaCommandDeps,
): Record<KafkaAdminCommandName, (target?: CommandTarget) => unknown> {
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

  /** A change to the cluster always asks; a production connection says so. */
  const confirmChange = async (
    connectionId: string,
    question: string,
    detail: string,
    action: string,
  ): Promise<boolean> => {
    const policy = policyOf(deps.store.get(connectionId));
    return await deps.ui.confirm(
      question,
      policy.production
        ? msg('"{0}" is a production connection. {1}', policy.name, detail)
        : detail,
      action,
    );
  };

  const askRule = async (): Promise<KafkaAcl | undefined> => {
    const principal = await deps.ui.input({
      title: msg('New Access Rule'),
      prompt: msg(
        'Who is the rule for? Write it as Type:name, e.g. User:alice (User:* is everybody)',
      ),
      value: 'User:',
      validate: principalProblem,
    });
    if (principal === undefined) {
      return undefined;
    }
    const resource = await deps.ui.pick<KafkaAclResource>(
      KAFKA_ACL_RESOURCES.map((one) => ({
        label: one,
        description:
          one === 'topic'
            ? msg('read or write the messages of a topic')
            : one === 'group'
              ? msg('join a consumer group')
              : one === 'cluster'
                ? msg('create topics, change the cluster')
                : msg('use a transaction id'),
        value: one,
      })),
      msg('What does the rule apply to?'),
    );
    if (resource === undefined) {
      return undefined;
    }
    let name = CLUSTER_RESOURCE_NAME;
    let pattern: KafkaAclPattern = 'literal';
    if (resource !== 'cluster') {
      const typed = await deps.ui.input({
        title: msg('New Access Rule'),
        prompt: msg('The name of the {0} (* is every one)', resource),
        validate: (value) => (value.trim() === '' ? msg('A rule needs a name') : undefined),
      });
      if (typed === undefined) {
        return undefined;
      }
      name = typed.trim();
      if (name !== '*') {
        const how = await deps.ui.pick<KafkaAclPattern>(
          [
            { label: msg('This name'), description: name, value: 'literal' },
            {
              label: msg('Every name that starts with it'),
              description: `${name}…`,
              value: 'prefixed',
            },
          ],
          msg('Does the rule fit one name, or a whole family?'),
        );
        if (how === undefined) {
          return undefined;
        }
        pattern = how;
      }
    }
    const operation = await deps.ui.pick<KafkaAclOperation>(
      KAFKA_ACL_OPERATIONS.map((one) => ({ label: one, value: one })),
      msg('What may be done?'),
    );
    if (operation === undefined) {
      return undefined;
    }
    const permission = await deps.ui.pick<'allow' | 'deny'>(
      [
        { label: msg('Allow'), value: 'allow' },
        { label: msg('Deny'), description: msg('wins over an allow'), value: 'deny' },
      ],
      msg('Allow it, or deny it?'),
    );
    if (permission === undefined) {
      return undefined;
    }
    const host = await deps.ui.input({
      title: msg('New Access Rule'),
      prompt: msg('From which address? * is any'),
      value: '*',
      validate: (value) => (value.trim() === '' ? msg('Write * for any address') : undefined),
    });
    if (host === undefined) {
      return undefined;
    }
    return {
      resource,
      name,
      pattern,
      principal: principal.trim(),
      host: host.trim(),
      operation,
      permission,
    };
  };

  /** The text of a setting’s value in the list. */
  const shownValue = (entry: KafkaConfigEntry): string =>
    entry.sensitive ? msg('(secret)') : entry.value === '' ? msg('(empty)') : entry.value;

  const manageSettingsOf = async (
    connectionId: string,
    target: KafkaConfigTarget,
    title: string,
  ): Promise<void> => {
    const session = await deps.session(connectionId);
    for (;;) {
      const entries = await session.describeConfig(target);
      const chosen = await deps.ui.pick<ConfigChoice>(
        [...entries]
          .sort((a, b) => Number(b.overridden) - Number(a.overridden))
          .map((entry) => ({
            label: `${entry.name} = ${shownValue(entry)}`,
            description: entry.overridden
              ? msg('set here ({0})', entry.source)
              : entry.readOnly
                ? msg('{0}, read only', entry.source)
                : entry.source,
            value: { entry },
          })),
        title,
      );
      if (chosen === undefined) {
        return;
      }
      const { entry } = chosen;
      if (entry.readOnly || entry.sensitive) {
        deps.ui.info(
          entry.sensitive
            ? msg(
                'The setting "{0}" is secret; the cluster never tells it, so it is not changed here',
                entry.name,
              )
            : msg('The setting "{0}" cannot be changed', entry.name),
        );
        continue;
      }
      requireWritable(connectionId);
      const action = await deps.ui.pick<'change' | 'reset'>(
        [
          { label: msg('Change the value…'), description: shownValue(entry), value: 'change' },
          ...(entry.overridden
            ? [
                {
                  label: msg('Take the override away'),
                  description: msg('the setting goes back to what it is without it'),
                  value: 'reset' as const,
                },
              ]
            : []),
        ],
        entry.name,
      );
      if (action === undefined) {
        continue;
      }
      let value: string | null = null;
      if (action === 'change') {
        const typed = await deps.ui.input({
          title: entry.name,
          prompt: msg('The new value of {0}', entry.name),
          value: entry.value,
          validate: (text) => (text.trim() === '' ? msg('A setting needs a value') : undefined),
        });
        if (typed === undefined) {
          continue;
        }
        value = typed.trim();
      }
      const taken = await confirmChange(
        connectionId,
        value === null
          ? msg('Take the override of "{0}" away?', entry.name)
          : msg('Set "{0}" to "{1}"?', entry.name, value),
        target.kind === 'broker'
          ? msg('A broker setting changes how the whole broker behaves.')
          : msg('The topic uses it from now on.'),
        value === null ? msg('Take Away') : msg('Set'),
      );
      if (!taken) {
        continue;
      }
      await session.setConfig(target, entry.name, value);
      deps.ui.info(
        value === null
          ? msg('"{0}" is back to what it is without an override', entry.name)
          : msg('"{0}" is now {1}', entry.name, value),
      );
    }
  };

  return {
    manageAcls: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      const session = await deps.session(connectionId);
      for (;;) {
        const rules = await session.listAcls();
        const chosen = await deps.ui.pick<AclListChoice>(
          [
            {
              label: msg('$(add) New rule…'),
              description:
                rules.length === 0 ? msg('no rules yet') : msg('{0} rules', rules.length),
              value: { kind: 'add' },
            },
            ...rules.map((acl) => ({
              label: describeAcl(acl),
              description:
                `${acl.host === '*' ? '' : msg('from {0}', acl.host)} ${acl.permission}`.trim(),
              value: { kind: 'rule', acl } as const,
            })),
          ],
          msg('Access rules of the cluster'),
        );
        if (chosen === undefined) {
          return undefined;
        }
        requireWritable(connectionId);
        if (chosen.kind === 'add') {
          const acl = await askRule();
          if (acl === undefined) {
            continue;
          }
          const taken = await confirmChange(
            connectionId,
            msg('Make the rule: {0}?', describeAcl(acl)),
            msg('It takes effect at once, and may lock applications out.'),
            msg('Make Rule'),
          );
          if (taken) {
            await session.createAcl(acl);
            deps.ui.info(msg('The rule is made'));
          }
        } else {
          const taken = await confirmChange(
            connectionId,
            msg('Remove the rule: {0}?', describeAcl(chosen.acl)),
            msg('It stops counting at once.'),
            msg('Remove'),
          );
          if (taken) {
            const gone = await session.deleteAcl(chosen.acl);
            deps.ui.info(
              gone === 0 ? msg('The rule was already gone') : msg('The rule is removed'),
            );
          }
        }
      }
    },

    manageSettings: async (target?: CommandTarget) => {
      if (isTreeNode(target) && target.kind === 'kafkaTopic') {
        await manageSettingsOf(
          target.connectionId,
          { kind: 'topic', name: target.topic },
          msg('Settings of the topic "{0}"', target.topic),
        );
        return undefined;
      }
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      const session = await deps.session(connectionId);
      const brokers = await session.listBrokers();
      const broker =
        brokers.length === 1
          ? brokers[0]
          : await deps.ui.pick(
              brokers.map((one) => ({
                label: msg('Broker {0}', one.id),
                description: `${one.host}:${one.port}`,
                value: one,
              })),
              msg('Whose settings?'),
            );
      if (broker === undefined) {
        return undefined;
      }
      await manageSettingsOf(
        connectionId,
        { kind: 'broker', id: broker.id },
        msg('Settings of broker {0}', broker.id),
      );
      return undefined;
    },
  };
}
