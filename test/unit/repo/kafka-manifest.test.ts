// The Kafka commands, menus and setting (V13.23): where each command shows, that the menus
// of a connection reach Kafka connections the way they reach the other families, and that
// every text has its translation.

import { describe, expect, it } from 'vitest';
import { COMMAND_IDS, CONFIG_KEYS } from '../../../src/vscode/command-ids';
import { TREE_CONTEXT } from '../../../src/vscode/tree/nodes';
import { readJson } from '../../helpers/repo';

interface MenuEntry {
  command?: string;
  when?: string;
  group?: string;
}

interface Manifest {
  contributes: {
    commands: { command: string; title: string; icon?: string; category?: string }[];
    menus: Record<string, MenuEntry[]>;
    configuration: { properties: Record<string, Record<string, unknown>> };
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

const KAFKA_COMMANDS = [
  [COMMAND_IDS.kafkaOpenTopic, 'openTopic', '$(go-to-file)'],
  [COMMAND_IDS.kafkaNewTopic, 'newTopic', '$(add)'],
  [COMMAND_IDS.kafkaDeleteTopic, 'deleteTopic', '$(trash)'],
  [COMMAND_IDS.kafkaManageAcls, 'manageAcls', '$(shield)'],
  [COMMAND_IDS.kafkaManageSettings, 'manageSettings', '$(settings-gear)'],
] as const;

const KAFKA_CONNECTIONS: readonly string[] = [
  TREE_CONTEXT.kafkaConnection,
  TREE_CONTEXT.kafkaConnectionConnected,
  TREE_CONTEXT.projectKafkaConnection,
  TREE_CONTEXT.projectKafkaConnectionConnected,
];

describe('Kafka commands', () => {
  it.each(KAFKA_COMMANDS)(
    '%s is a command with an icon and titles in both languages',
    (id, name, icon) => {
      const command = manifest.contributes.commands.find((c) => c.command === id);
      expect(command).toMatchObject({ category: 'DataNest', icon });
      expect(command?.title).toBe(`%commands.kafka.${name}.title%`);
      expect(nls[`commands.kafka.${name}.title`]).toBeTruthy();
      expect(nlsRu[`commands.kafka.${name}.title`]).toBeTruthy();
      expect(nlsRu[`commands.kafka.${name}.title`]).not.toBe(nls[`commands.kafka.${name}.title`]);
    },
  );

  it('keeps the ones that need a clicked node out of the palette', () => {
    for (const id of [
      COMMAND_IDS.kafkaOpenTopic,
      COMMAND_IDS.kafkaDeleteTopic,
      COMMAND_IDS.kafkaManageAcls,
      COMMAND_IDS.kafkaManageSettings,
    ]) {
      expect(palette.find((entry) => entry.command === id)?.when).toBe('false');
    }
    expect(palette.find((entry) => entry.command === COMMAND_IDS.kafkaNewTopic)).toBeUndefined();
  });
});

describe('Kafka menus', () => {
  it('opens a topic from its item and from its partitions, and nowhere else', () => {
    expect(entriesOf(COMMAND_IDS.kafkaOpenTopic).map((entry) => contextsOf(entry.when))).toEqual([
      [TREE_CONTEXT.kafkaTopic, `${TREE_CONTEXT.kafkaTopic}.starred`, TREE_CONTEXT.kafkaPartition],
    ]);
  });

  it('makes a topic from the Topics folder, as a button, and from a connected connection', () => {
    const entries = entriesOf(COMMAND_IDS.kafkaNewTopic);
    const inline = entries.find((entry) => entry.group?.startsWith('inline'));
    expect(contextsOf(inline?.when)).toEqual([TREE_CONTEXT.kafkaTopics]);
    const menu = entries.find((entry) => !entry.group?.startsWith('inline'));
    const named = contextsOf(menu?.when);
    expect(named).toContain(TREE_CONTEXT.kafkaTopics);
    expect(named).toContain(TREE_CONTEXT.kafkaConnectionConnected);
    expect(named).not.toContain(TREE_CONTEXT.kafkaConnection);
  });

  it('deletes a topic from its item only', () => {
    expect(entriesOf(COMMAND_IDS.kafkaDeleteTopic).map((entry) => contextsOf(entry.when))).toEqual([
      [TREE_CONTEXT.kafkaTopic, `${TREE_CONTEXT.kafkaTopic}.starred`],
    ]);
  });

  it('opens the access rules from a connected Kafka connection only (V13.34)', () => {
    const named = entriesOf(COMMAND_IDS.kafkaManageAcls).flatMap((entry) => contextsOf(entry.when));
    expect(named.sort()).toEqual(
      [
        TREE_CONTEXT.kafkaConnectionConnected,
        `${TREE_CONTEXT.kafkaConnectionConnected}.starred`,
        TREE_CONTEXT.projectKafkaConnectionConnected,
        `${TREE_CONTEXT.projectKafkaConnectionConnected}.starred`,
      ].sort(),
    );
  });

  it('opens the settings from a connected connection (its brokers) and from a topic (V13.34)', () => {
    const named = entriesOf(COMMAND_IDS.kafkaManageSettings).flatMap((entry) =>
      contextsOf(entry.when),
    );
    expect(named).toContain(TREE_CONTEXT.kafkaConnectionConnected);
    expect(named).toContain(TREE_CONTEXT.kafkaTopic);
    expect(named).toContain(`${TREE_CONTEXT.kafkaTopic}.starred`);
    expect(named).not.toContain(TREE_CONTEXT.kafkaConnection);
    expect(named).not.toContain(TREE_CONTEXT.kafkaGroup);
  });

  it('resets the offsets of a group from its item only, starred or not', () => {
    expect(entriesOf(COMMAND_IDS.kafkaResetOffsets).map((entry) => contextsOf(entry.when))).toEqual(
      [[TREE_CONTEXT.kafkaGroup, `${TREE_CONTEXT.kafkaGroup}.starred`]],
    );
  });

  it('gives Kafka connections the menus every connection has, and etcd ones no Kafka entries', () => {
    for (const command of [
      'datanest.connections.connect',
      'datanest.connections.disconnect',
      'datanest.connections.edit',
      'datanest.connections.remove',
    ]) {
      const named = entriesOf(command).flatMap((entry) => contextsOf(entry.when));
      expect(named.some((one) => KAFKA_CONNECTIONS.includes(one))).toBe(true);
    }
    for (const entry of context.filter((one) => one.command?.startsWith('datanest.etcd.'))) {
      expect(contextsOf(entry.when).some((one) => one.toLowerCase().includes('kafka'))).toBe(false);
    }
  });

  it('refreshes and copies the names of the Kafka nodes', () => {
    const refresh = entriesOf('datanest.tree.refresh').flatMap((entry) => contextsOf(entry.when));
    for (const kind of [
      TREE_CONTEXT.kafkaTopics,
      TREE_CONTEXT.kafkaTopic,
      TREE_CONTEXT.kafkaGroups,
      TREE_CONTEXT.kafkaGroup,
    ]) {
      expect(refresh).toContain(kind);
    }
    const copy = entriesOf('datanest.tree.copyName').flatMap((entry) => contextsOf(entry.when));
    expect(copy).toContain(TREE_CONTEXT.kafkaTopic);
    expect(copy).toContain(TREE_CONTEXT.kafkaGroup);
  });

  it('only names contexts the tree can produce', () => {
    const known = new Set<string>();
    for (const value of Object.values(TREE_CONTEXT)) {
      known.add(value);
      known.add(`${value}.starred`);
    }
    for (const entry of context) {
      for (const name of contextsOf(entry.when)) {
        if (name.toLowerCase().includes('kafka')) {
          expect(known.has(name)).toBe(true);
        }
      }
    }
  });
});

describe('Kafka setting', () => {
  it('hides the cluster’s own topics unless asked, with a description in both languages', () => {
    const setting =
      manifest.contributes.configuration.properties['datanest.kafka.showInternalTopics'];
    expect(setting).toMatchObject({ type: 'boolean', default: false, scope: 'window' });
    expect(CONFIG_KEYS.kafkaShowInternalTopics).toBe('kafka.showInternalTopics');
    expect(setting?.markdownDescription).toBe(
      '%configuration.kafka.showInternalTopics.description%',
    );
    expect(nls['configuration.kafka.showInternalTopics.description']).toBeTruthy();
    expect(nlsRu['configuration.kafka.showInternalTopics.description']).toBeTruthy();
  });

  it('is listed among the keywords of the extension', () => {
    const keywords = (readJson('package.json') as { keywords: string[] }).keywords;
    expect(keywords).toContain('kafka');
  });
});
