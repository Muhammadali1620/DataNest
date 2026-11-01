// Export Keys and Restore Keys of Redis (V13.9): commands with icons and titles in both
// languages, in the menu of the nodes they work on and nowhere else.

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
const menu = manifest.contributes.menus['view/item/context'] ?? [];
const entriesOf = (command: string): MenuEntry[] =>
  menu.filter((entry) => entry.command === command);

const contextsIn = (when: string | undefined): string[] =>
  [...(when ?? '').matchAll(/viewItem == ([\w.]+)/g)].map((match) => match[1] ?? '');

describe('Export Keys and Restore Keys of Redis', () => {
  it.each([
    ['exportKeys', COMMAND_IDS.redisExportKeys, '$(export)', 'Export Keys…', 'Выгрузить ключи…'],
    [
      'restoreKeys',
      COMMAND_IDS.redisRestoreKeys,
      '$(cloud-upload)',
      'Restore Keys…',
      'Восстановить ключи…',
    ],
  ])('%s is a command with an icon and titles in both languages', (name, id, icon, en, ru) => {
    const command = manifest.contributes.commands.find((c) => c.command === id);
    expect(command).toMatchObject({ category: 'DataNest', icon });
    expect(command?.title).toBe(`%commands.redis.${name}.title%`);
    expect(nls[`commands.redis.${name}.title`]).toBe(en);
    expect(nlsRu[`commands.redis.${name}.title`]).toBe(ru);
  });

  it('exports from a database, a folder and a key, and from nothing else', () => {
    const entries = entriesOf(COMMAND_IDS.redisExportKeys);
    expect(entries).toHaveLength(1);
    expect(contextsIn(entries[0]?.when).sort()).toEqual(
      [
        TREE_CONTEXT.redisDatabase,
        `${TREE_CONTEXT.redisDatabase}.starred`,
        TREE_CONTEXT.redisFolder,
        TREE_CONTEXT.redisKey,
      ].sort(),
    );
  });

  it('restores into a database or a folder, not from a single key', () => {
    const entries = entriesOf(COMMAND_IDS.redisRestoreKeys);
    expect(entries).toHaveLength(1);
    expect(contextsIn(entries[0]?.when).sort()).toEqual(
      [
        TREE_CONTEXT.redisDatabase,
        `${TREE_CONTEXT.redisDatabase}.starred`,
        TREE_CONTEXT.redisFolder,
      ].sort(),
    );
  });

  it('sit together in their own group of the menu', () => {
    const groups = [COMMAND_IDS.redisExportKeys, COMMAND_IDS.redisRestoreKeys].map(
      (id) => entriesOf(id)[0]?.group,
    );
    expect(groups).toEqual(['3_files@1', '3_files@2']);
  });
});
