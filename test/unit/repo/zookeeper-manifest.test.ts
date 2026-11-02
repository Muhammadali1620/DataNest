// The ZooKeeper commands, menus and setting (V13.24): where each command shows, that the
// menus of a connection reach ZooKeeper connections the way they reach the other families,
// and that every text has its translation.

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
  keywords: string[];
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

/** The contexts a `when` names, as `viewItem == x` terms. */
const contextsOf = (when: string | undefined): string[] =>
  [...(when ?? '').matchAll(/viewItem == ([\w.]+)/gu)].map((match) => match[1] ?? '');

const COMMANDS = [
  [COMMAND_IDS.zookeeperLoadMoreNodes, 'loadMoreNodes', '$(ellipsis)'],
  [COMMAND_IDS.zookeeperOpenNode, 'openNode', '$(go-to-file)'],
  [COMMAND_IDS.zookeeperGoToNode, 'goToNode', '$(go-to-file)'],
  [COMMAND_IDS.zookeeperNewNode, 'newNode', '$(add)'],
  [COMMAND_IDS.zookeeperDeleteNodes, 'deleteNodes', '$(trash)'],
] as const;

describe('ZooKeeper commands', () => {
  it.each(COMMANDS)(
    '%s is a command with an icon and titles in both languages',
    (id, name, icon) => {
      const command = manifest.contributes.commands.find((c) => c.command === id);
      expect(command).toMatchObject({ category: 'DataNest', icon });
      expect(command?.title).toBe(`%commands.zookeeper.${name}.title%`);
      expect(nls[`commands.zookeeper.${name}.title`]).toBeTruthy();
      expect(nlsRu[`commands.zookeeper.${name}.title`]).toBeTruthy();
      expect(nlsRu[`commands.zookeeper.${name}.title`]).not.toBe(
        nls[`commands.zookeeper.${name}.title`],
      );
    },
  );

  it('is a keyword of the extension', () => {
    expect(manifest.keywords).toContain('zookeeper');
  });

  it('keeps the ones that need a clicked node out of the palette', () => {
    for (const id of [
      COMMAND_IDS.zookeeperLoadMoreNodes,
      COMMAND_IDS.zookeeperOpenNode,
      COMMAND_IDS.zookeeperDeleteNodes,
    ]) {
      expect(palette.find((entry) => entry.command === id)?.when).toBe('false');
    }
    for (const id of [COMMAND_IDS.zookeeperGoToNode, COMMAND_IDS.zookeeperNewNode]) {
      expect(palette.find((entry) => entry.command === id)).toBeUndefined();
    }
  });
});

describe('ZooKeeper menus', () => {
  it('opens a znode from its own item and nowhere else', () => {
    expect(entriesOf(COMMAND_IDS.zookeeperOpenNode).map((entry) => contextsOf(entry.when))).toEqual(
      [[TREE_CONTEXT.zookeeperNode]],
    );
  });

  it('loads more from the "load more" item only', () => {
    expect(
      entriesOf(COMMAND_IDS.zookeeperLoadMoreNodes).map((entry) => contextsOf(entry.when)),
    ).toEqual([[TREE_CONTEXT.zookeeperMore]]);
  });

  it('deletes from a znode', () => {
    expect(
      entriesOf(COMMAND_IDS.zookeeperDeleteNodes).map((entry) => contextsOf(entry.when)),
    ).toEqual([[TREE_CONTEXT.zookeeperNode]]);
  });

  it('goes to and makes znodes from a znode, as buttons, and from a connected connection, in the menu', () => {
    for (const id of [COMMAND_IDS.zookeeperGoToNode, COMMAND_IDS.zookeeperNewNode]) {
      const entries = entriesOf(id);
      expect(entries).toHaveLength(2);
      const inline = entries.find((entry) => entry.group?.startsWith('inline@') === true);
      const menu = entries.find((entry) => entry.group?.startsWith('inline@') !== true);
      expect(contextsOf(inline?.when)).toEqual([TREE_CONTEXT.zookeeperNode]);
      expect(contextsOf(menu?.when)).toEqual([
        TREE_CONTEXT.zookeeperNode,
        TREE_CONTEXT.zookeeperConnectionConnected,
        `${TREE_CONTEXT.zookeeperConnectionConnected}.starred`,
        TREE_CONTEXT.projectZookeeperConnectionConnected,
        `${TREE_CONTEXT.projectZookeeperConnectionConnected}.starred`,
      ]);
    }
  });

  it('gives a ZooKeeper connection every menu an etcd connection has, but the etcd ones', () => {
    const etcd: string[] = [
      TREE_CONTEXT.etcdConnection,
      TREE_CONTEXT.etcdConnectionConnected,
      TREE_CONTEXT.projectEtcdConnection,
      TREE_CONTEXT.projectEtcdConnectionConnected,
    ];
    const pairs: [string, string][] = [
      [TREE_CONTEXT.etcdConnection, TREE_CONTEXT.zookeeperConnection],
      [TREE_CONTEXT.etcdConnectionConnected, TREE_CONTEXT.zookeeperConnectionConnected],
      [TREE_CONTEXT.projectEtcdConnection, TREE_CONTEXT.projectZookeeperConnection],
      [
        TREE_CONTEXT.projectEtcdConnectionConnected,
        TREE_CONTEXT.projectZookeeperConnectionConnected,
      ],
    ];
    let shared = 0;
    for (const entry of context) {
      const contexts = contextsOf(entry.when);
      if (!contexts.some((one) => etcd.includes(one))) {
        continue;
      }
      if (entry.command?.startsWith('datanest.etcd.') === true) {
        // The etcd menus stay etcd's.
        expect(contexts.some((one) => /zookeeper/iu.test(one))).toBe(false);
        continue;
      }
      shared += 1;
      for (const [from, to] of pairs) {
        for (const suffix of ['', '.starred']) {
          if (contexts.includes(`${from}${suffix}`)) {
            expect(contexts, `${entry.command ?? ''} ${entry.group ?? ''}`).toContain(
              `${to}${suffix}`,
            );
          }
        }
      }
    }
    expect(shared).toBeGreaterThan(10);
  });

  it('copies the path of a znode and refreshes it', () => {
    const copy = entriesOf('datanest.tree.copyName');
    expect(copy.some((entry) => contextsOf(entry.when).includes(TREE_CONTEXT.zookeeperNode))).toBe(
      true,
    );
    const refresh = entriesOf('datanest.tree.refresh');
    expect(
      refresh.some((entry) => contextsOf(entry.when).includes(TREE_CONTEXT.zookeeperNode)),
    ).toBe(true);
  });

  it('names only contexts the tree really makes', () => {
    const made = new Set<string>(Object.values(TREE_CONTEXT));
    for (const entry of context) {
      for (const one of contextsOf(entry.when)) {
        if (/zookeeper/iu.test(one)) {
          expect(made.has(one.replace(/\.starred$/u, ''))).toBe(true);
        }
      }
    }
  });
});

describe('the children per load setting', () => {
  const property =
    manifest.contributes.configuration.properties['datanest.zookeeper.childrenPerLoad'];

  it('is a number with a default, a range and a description in both languages', () => {
    expect(CONFIG_KEYS.zookeeperChildrenPerLoad).toBe('zookeeper.childrenPerLoad');
    expect(property).toMatchObject({ type: 'integer', default: 300, minimum: 20, maximum: 5000 });
    expect(property?.markdownDescription).toBe(
      '%configuration.zookeeper.childrenPerLoad.description%',
    );
    expect(nls['configuration.zookeeper.childrenPerLoad.description']).toBeTruthy();
    expect(nlsRu['configuration.zookeeper.childrenPerLoad.description']).toBeTruthy();
  });
});
