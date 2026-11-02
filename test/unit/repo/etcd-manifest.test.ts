// The etcd commands, menus and setting (V13.19): where each command shows, that the menus
// of a connection reach etcd connections the way they reach the other families, and that
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

/** The contexts a `when` names, as `viewItem == x` terms (the starred forms of nodes, V13.27, left out). */
const contextsOf = (when: string | undefined): string[] =>
  [...(when ?? '').matchAll(/viewItem == ([\w.]+)/gu)]
    .map((match) => match[1] ?? '')
    .filter((name) => !/^datanest\.(etcdFolder|etcdKey)\.starred$/u.test(name));

const ETCD_COMMANDS = [
  [COMMAND_IDS.etcdLoadMoreKeys, 'loadMoreKeys', '$(ellipsis)'],
  [COMMAND_IDS.etcdOpenKey, 'openKey', '$(go-to-file)'],
  [COMMAND_IDS.etcdFindKey, 'findKey', '$(search)'],
  [COMMAND_IDS.etcdNewKey, 'newKey', '$(add)'],
  [COMMAND_IDS.etcdDeleteKeys, 'deleteKeys', '$(trash)'],
] as const;

describe('etcd commands', () => {
  it.each(ETCD_COMMANDS)(
    '%s is a command with an icon and titles in both languages',
    (id, name, icon) => {
      const command = manifest.contributes.commands.find((c) => c.command === id);
      expect(command).toMatchObject({ category: 'DataNest', icon });
      expect(command?.title).toBe(`%commands.etcd.${name}.title%`);
      expect(nls[`commands.etcd.${name}.title`]).toBeTruthy();
      expect(nlsRu[`commands.etcd.${name}.title`]).toBeTruthy();
      expect(nlsRu[`commands.etcd.${name}.title`]).not.toBe(nls[`commands.etcd.${name}.title`]);
    },
  );

  it('keeps the ones that need a clicked node out of the palette', () => {
    for (const id of [
      COMMAND_IDS.etcdLoadMoreKeys,
      COMMAND_IDS.etcdOpenKey,
      COMMAND_IDS.etcdDeleteKeys,
    ]) {
      expect(palette.find((entry) => entry.command === id)?.when).toBe('false');
    }
    for (const id of [COMMAND_IDS.etcdFindKey, COMMAND_IDS.etcdNewKey]) {
      expect(palette.find((entry) => entry.command === id)).toBeUndefined();
    }
  });
});

describe('etcd users and roles (V13.27)', () => {
  it('is a command with an icon and titles in both languages, open to the palette', () => {
    const command = manifest.contributes.commands.find(
      (c) => c.command === COMMAND_IDS.etcdManageAccess,
    );
    expect(command).toMatchObject({
      category: 'DataNest',
      icon: '$(organization)',
      title: '%commands.etcd.manageAccess.title%',
    });
    expect(nls['commands.etcd.manageAccess.title']).toBeTruthy();
    expect(nlsRu['commands.etcd.manageAccess.title']).toBeTruthy();
    expect(nlsRu['commands.etcd.manageAccess.title']).not.toBe(
      nls['commands.etcd.manageAccess.title'],
    );
    expect(palette.find((entry) => entry.command === COMMAND_IDS.etcdManageAccess)).toBeUndefined();
  });

  it('shows in the menu of a connected etcd connection and nowhere else', () => {
    const entries = entriesOf(COMMAND_IDS.etcdManageAccess);
    expect(entries).toHaveLength(1);
    expect(contextsOf(entries[0]?.when)).toEqual([
      TREE_CONTEXT.etcdConnectionConnected,
      `${TREE_CONTEXT.etcdConnectionConnected}.starred`,
      TREE_CONTEXT.projectEtcdConnectionConnected,
      `${TREE_CONTEXT.projectEtcdConnectionConnected}.starred`,
    ]);
  });
});

describe('etcd menus', () => {
  it('opens a key from its own item and nowhere else', () => {
    expect(entriesOf(COMMAND_IDS.etcdOpenKey).map((entry) => contextsOf(entry.when))).toEqual([
      [TREE_CONTEXT.etcdKey],
    ]);
  });

  it('loads more from the "load more" item only', () => {
    expect(entriesOf(COMMAND_IDS.etcdLoadMoreKeys).map((entry) => contextsOf(entry.when))).toEqual([
      [TREE_CONTEXT.etcdMore],
    ]);
  });

  it('deletes from a key and from a folder', () => {
    expect(entriesOf(COMMAND_IDS.etcdDeleteKeys).map((entry) => contextsOf(entry.when))).toEqual([
      [TREE_CONTEXT.etcdKey, TREE_CONTEXT.etcdFolder],
    ]);
  });

  it('finds and makes keys from a folder, as buttons, and from a connected connection, in the menu', () => {
    for (const id of [COMMAND_IDS.etcdFindKey, COMMAND_IDS.etcdNewKey]) {
      const entries = entriesOf(id);
      expect(entries).toHaveLength(2);
      const inline = entries.find((entry) => entry.group?.startsWith('inline@') === true);
      const menu = entries.find((entry) => entry.group?.startsWith('inline@') !== true);
      expect(contextsOf(inline?.when)).toEqual([TREE_CONTEXT.etcdFolder]);
      expect(contextsOf(menu?.when)).toEqual([
        TREE_CONTEXT.etcdFolder,
        TREE_CONTEXT.etcdConnectionConnected,
        `${TREE_CONTEXT.etcdConnectionConnected}.starred`,
        TREE_CONTEXT.projectEtcdConnectionConnected,
        `${TREE_CONTEXT.projectEtcdConnectionConnected}.starred`,
      ]);
    }
  });

  it('gives an etcd connection every menu an Elasticsearch connection has, but the Elasticsearch ones', () => {
    const elastic: string[] = [
      TREE_CONTEXT.elasticConnection,
      TREE_CONTEXT.elasticConnectionConnected,
      TREE_CONTEXT.projectElasticConnection,
      TREE_CONTEXT.projectElasticConnectionConnected,
    ];
    const pairs: [string, string][] = [
      [TREE_CONTEXT.elasticConnection, TREE_CONTEXT.etcdConnection],
      [TREE_CONTEXT.elasticConnectionConnected, TREE_CONTEXT.etcdConnectionConnected],
      [TREE_CONTEXT.projectElasticConnection, TREE_CONTEXT.projectEtcdConnection],
      [TREE_CONTEXT.projectElasticConnectionConnected, TREE_CONTEXT.projectEtcdConnectionConnected],
    ];
    let shared = 0;
    for (const entry of context) {
      const contexts = contextsOf(entry.when);
      if (!contexts.some((one) => elastic.includes(one))) {
        continue;
      }
      if (entry.command?.startsWith('datanest.elastic.') === true) {
        // The Elasticsearch menus stay Elasticsearch's.
        expect(contexts.some((one) => one.includes('Etcd') || one.includes('etcd'))).toBe(false);
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

  it('copies the name of a key and a folder, and refreshes a folder', () => {
    const copy = entriesOf('datanest.tree.copyName');
    expect(copy.some((entry) => contextsOf(entry.when).includes(TREE_CONTEXT.etcdKey))).toBe(true);
    expect(copy.some((entry) => contextsOf(entry.when).includes(TREE_CONTEXT.etcdFolder))).toBe(
      true,
    );
    const refresh = entriesOf('datanest.tree.refresh');
    expect(refresh.some((entry) => contextsOf(entry.when).includes(TREE_CONTEXT.etcdFolder))).toBe(
      true,
    );
  });

  it('names only contexts the tree really makes', () => {
    const made = new Set<string>(Object.values(TREE_CONTEXT));
    for (const entry of context) {
      for (const one of contextsOf(entry.when)) {
        if (/etcd/iu.test(one)) {
          expect(made.has(one.replace(/\.starred$/u, ''))).toBe(true);
        }
      }
    }
  });
});

describe('the keys per load setting', () => {
  const property = manifest.contributes.configuration.properties['datanest.etcd.keysPerLoad'];

  it('is a number with a default, a range and a description in both languages', () => {
    expect(CONFIG_KEYS.etcdKeysPerLoad).toBe('etcd.keysPerLoad');
    expect(property).toMatchObject({ type: 'integer', default: 300, minimum: 20, maximum: 5000 });
    expect(property?.markdownDescription).toBe('%configuration.etcd.keysPerLoad.description%');
    expect(nls['configuration.etcd.keysPerLoad.description']).toBeTruthy();
    expect(nlsRu['configuration.etcd.keysPerLoad.description']).toBeTruthy();
  });
});
