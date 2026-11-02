// The RabbitMQ commands and menus (V13.26): where each command shows, that the menus of a
// connection reach RabbitMQ connections the way they reach the other families, and that
// every text has its translation.

import { describe, expect, it } from 'vitest';
import { COMMAND_IDS } from '../../../src/vscode/command-ids';
import { connectionContext, TREE_CONTEXT } from '../../../src/vscode/tree/nodes';
import { readJson } from '../../helpers/repo';

interface MenuEntry {
  command?: string;
  when?: string;
  group?: string;
}

interface Manifest {
  keywords: string[];
  contributes: {
    commands: { command: string; title: string; icon?: string; category?: string }[];
    menus: Record<string, MenuEntry[]>;
  };
}

const manifest = readJson('package.json') as Manifest;
const nls = readJson('package.nls.json') as Record<string, string>;
const nlsRu = readJson('package.nls.ru.json') as Record<string, string>;
const context = manifest.contributes.menus['view/item/context'] ?? [];
const palette = manifest.contributes.menus.commandPalette ?? [];

const entriesOf = (command: string): MenuEntry[] =>
  context.filter((entry) => entry.command === command);

const contextsOf = (when: string | undefined): string[] =>
  [...(when ?? '').matchAll(/viewItem == ([\w.]+)/gu)].map((match) => match[1] ?? '');

const RABBIT_COMMANDS = [
  [COMMAND_IDS.rabbitOpenObject, 'openObject', '$(go-to-file)'],
  [COMMAND_IDS.rabbitNewQueue, 'newQueue', '$(add)'],
  [COMMAND_IDS.rabbitNewExchange, 'newExchange', '$(add)'],
  [COMMAND_IDS.rabbitPurgeQueue, 'purgeQueue', '$(clear-all)'],
  [COMMAND_IDS.rabbitDeleteObject, 'deleteObject', '$(trash)'],
] as const;

const RABBIT_CONNECTIONS: readonly string[] = [
  TREE_CONTEXT.rabbitConnection,
  TREE_CONTEXT.rabbitConnectionConnected,
  TREE_CONTEXT.projectRabbitConnection,
  TREE_CONTEXT.projectRabbitConnectionConnected,
];

describe('RabbitMQ commands', () => {
  it.each(RABBIT_COMMANDS)(
    '%s is a command with an icon and titles in both languages',
    (id, name, icon) => {
      const command = manifest.contributes.commands.find((c) => c.command === id);
      expect(command).toMatchObject({ category: 'DataNest', icon });
      expect(command?.title).toBe(`%commands.rabbitmq.${name}.title%`);
      expect(nls[`commands.rabbitmq.${name}.title`]).toBeTruthy();
      expect(nlsRu[`commands.rabbitmq.${name}.title`]).toBeTruthy();
      expect(nlsRu[`commands.rabbitmq.${name}.title`]).not.toBe(
        nls[`commands.rabbitmq.${name}.title`],
      );
    },
  );

  it('keeps the ones that need a clicked node out of the palette', () => {
    for (const id of [
      COMMAND_IDS.rabbitOpenObject,
      COMMAND_IDS.rabbitPurgeQueue,
      COMMAND_IDS.rabbitDeleteObject,
    ]) {
      expect(palette.find((entry) => entry.command === id)?.when).toBe('false');
    }
    for (const id of [COMMAND_IDS.rabbitNewQueue, COMMAND_IDS.rabbitNewExchange]) {
      expect(palette.find((entry) => entry.command === id)).toBeUndefined();
    }
  });
});

describe('RabbitMQ menus', () => {
  it('opens a queue or an exchange from its item and nowhere else', () => {
    expect(entriesOf(COMMAND_IDS.rabbitOpenObject).map((entry) => contextsOf(entry.when))).toEqual([
      [TREE_CONTEXT.rabbitQueue, TREE_CONTEXT.rabbitExchange],
    ]);
  });

  it('makes a queue from the Queues folder, as a button, and from a connected connection', () => {
    const entries = entriesOf(COMMAND_IDS.rabbitNewQueue);
    const inline = entries.find((entry) => entry.group?.startsWith('inline'));
    expect(contextsOf(inline?.when)).toEqual([TREE_CONTEXT.rabbitQueues]);
    const menu = entries.find((entry) => !entry.group?.startsWith('inline'));
    const named = contextsOf(menu?.when);
    expect(named).toContain(TREE_CONTEXT.rabbitQueues);
    expect(named).toContain(TREE_CONTEXT.rabbitVhost);
    expect(named).toContain(TREE_CONTEXT.rabbitConnectionConnected);
    expect(named).not.toContain(TREE_CONTEXT.rabbitConnection);
  });

  it('makes an exchange from the Exchanges folder, as a button, and from a connected connection', () => {
    const entries = entriesOf(COMMAND_IDS.rabbitNewExchange);
    const inline = entries.find((entry) => entry.group?.startsWith('inline'));
    expect(contextsOf(inline?.when)).toEqual([TREE_CONTEXT.rabbitExchanges]);
    const menu = entries.find((entry) => !entry.group?.startsWith('inline'));
    const named = contextsOf(menu?.when);
    expect(named).toContain(TREE_CONTEXT.rabbitExchanges);
    expect(named).toContain(TREE_CONTEXT.rabbitConnectionConnected);
  });

  it('removes the messages of a queue and deletes a queue or an exchange from their items only', () => {
    expect(entriesOf(COMMAND_IDS.rabbitPurgeQueue).map((entry) => contextsOf(entry.when))).toEqual([
      [TREE_CONTEXT.rabbitQueue],
    ]);
    expect(
      entriesOf(COMMAND_IDS.rabbitDeleteObject).map((entry) => contextsOf(entry.when)),
    ).toEqual([[TREE_CONTEXT.rabbitQueue, TREE_CONTEXT.rabbitExchange]]);
  });

  it('gives RabbitMQ connections the menus every connection has, and Kafka ones no RabbitMQ entries', () => {
    for (const command of [
      'datanest.connections.connect',
      'datanest.connections.disconnect',
      'datanest.connections.edit',
      'datanest.connections.remove',
    ]) {
      const named = entriesOf(command).flatMap((entry) => contextsOf(entry.when));
      expect(named.some((one) => RABBIT_CONNECTIONS.includes(one))).toBe(true);
    }
    for (const entry of context.filter((one) => one.command?.startsWith('datanest.kafka.'))) {
      expect(contextsOf(entry.when).some((one) => one.toLowerCase().includes('rabbit'))).toBe(
        false,
      );
    }
  });

  it('refreshes and copies the names of the RabbitMQ nodes', () => {
    const refresh = entriesOf('datanest.tree.refresh').flatMap((entry) => contextsOf(entry.when));
    for (const kind of [
      TREE_CONTEXT.rabbitVhost,
      TREE_CONTEXT.rabbitQueues,
      TREE_CONTEXT.rabbitExchanges,
      TREE_CONTEXT.rabbitQueue,
      TREE_CONTEXT.rabbitExchange,
    ]) {
      expect(refresh).toContain(kind);
    }
    const copy = entriesOf('datanest.tree.copyName').flatMap((entry) => contextsOf(entry.when));
    for (const kind of [
      TREE_CONTEXT.rabbitVhost,
      TREE_CONTEXT.rabbitQueue,
      TREE_CONTEXT.rabbitExchange,
    ]) {
      expect(copy).toContain(kind);
    }
  });

  it('only names contexts the tree can produce', () => {
    const known = new Set<string>();
    for (const value of Object.values(TREE_CONTEXT)) {
      known.add(value);
      known.add(`${value}.starred`);
    }
    for (const entry of context) {
      for (const name of contextsOf(entry.when)) {
        if (name.toLowerCase().includes('rabbit')) {
          expect(known.has(name)).toBe(true);
        }
      }
    }
  });
});

describe('RabbitMQ connection contexts', () => {
  it('are told apart from the others by family and project', () => {
    const base = { family: 'rabbitmq' } as const;
    expect(connectionContext({ ...base, project: false, connected: false })).toBe(
      TREE_CONTEXT.rabbitConnection,
    );
    expect(connectionContext({ ...base, project: false, connected: true })).toBe(
      TREE_CONTEXT.rabbitConnectionConnected,
    );
    expect(connectionContext({ ...base, project: true, connected: false })).toBe(
      TREE_CONTEXT.projectRabbitConnection,
    );
    expect(connectionContext({ ...base, project: true, connected: true })).toBe(
      TREE_CONTEXT.projectRabbitConnectionConnected,
    );
  });

  it('are listed among the keywords of the extension', () => {
    expect(manifest.keywords).toContain('rabbitmq');
  });
});
