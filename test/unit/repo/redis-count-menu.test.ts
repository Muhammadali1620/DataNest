// Counting the keys of a Redis folder (V13.7): the command belongs to the folder item only,
// as a button and in the menu, and has titles in both languages.

import { describe, expect, it } from 'vitest';
import { COMMAND_IDS } from '../../../src/vscode/command-ids';
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
  };
}

const manifest = readJson('package.json') as Manifest;
const nls = readJson('package.nls.json') as Record<string, string>;
const nlsRu = readJson('package.nls.ru.json') as Record<string, string>;
const entries = (manifest.contributes.menus['view/item/context'] ?? []).filter(
  (entry) => entry.command === COMMAND_IDS.redisCountKeys,
);

describe('Count Keys of a Redis folder', () => {
  it('is a command with an icon and a title in both languages', () => {
    const command = manifest.contributes.commands.find(
      (c) => c.command === 'datanest.redis.countKeys',
    );
    expect(command).toMatchObject({ category: 'DataNest', icon: '$(symbol-numeric)' });
    expect(command?.title).toBe('%commands.redis.countKeys.title%');
    expect(nls['commands.redis.countKeys.title']).toBe('Count Keys');
    expect(nlsRu['commands.redis.countKeys.title']).toBe('Посчитать ключи');
  });

  it('shows in the menu and as a button, for a folder and nothing else', () => {
    expect(entries.map((entry) => entry.group).sort()).toEqual(['1_keys@2', 'inline@1']);
    for (const entry of entries) {
      expect(entry.when).toBe(
        `view == datanest.connections && viewItem == ${TREE_CONTEXT.redisFolder}`,
      );
    }
  });

  it('sits right after the search button of the folder', () => {
    const menu = manifest.contributes.menus['view/item/context'] ?? [];
    const inline = menu.filter((entry) => entry.group?.startsWith('inline@') === true);
    const at = inline.findIndex((entry) => entry.command === COMMAND_IDS.redisFindKey);
    expect(inline[at + 1]?.command).toBe(COMMAND_IDS.redisCountKeys);
  });
});
