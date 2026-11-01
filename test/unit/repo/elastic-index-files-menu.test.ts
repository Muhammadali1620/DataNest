// Export Index, Import Documents and Import as New Index of Elasticsearch (V13.11):
// commands with icons and titles in both languages, in the menu of the nodes they work
// on and nowhere else.

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
const palette = manifest.contributes.menus.commandPalette ?? [];
const entriesOf = (command: string): MenuEntry[] =>
  menu.filter((entry) => entry.command === command);

const contextsIn = (when: string | undefined): string[] =>
  [...(when ?? '').matchAll(/viewItem == ([\w.]+)/g)].map((match) => match[1] ?? '');

describe('Export Index and Import Documents of Elasticsearch', () => {
  it.each([
    [
      'exportIndex',
      COMMAND_IDS.elasticExportIndex,
      '$(export)',
      'Export Index…',
      'Выгрузить индекс…',
    ],
    [
      'importIndex',
      COMMAND_IDS.elasticImportIndex,
      '$(cloud-upload)',
      'Import Documents…',
      'Загрузить документы…',
    ],
    [
      'importNewIndex',
      COMMAND_IDS.elasticImportNewIndex,
      '$(cloud-download)',
      'Import as New Index…',
      'Загрузить как новый индекс…',
    ],
  ])('%s is a command with an icon and titles in both languages', (name, id, icon, en, ru) => {
    const command = manifest.contributes.commands.find((c) => c.command === id);
    expect(command).toMatchObject({ category: 'DataNest', icon });
    expect(command?.title).toBe(`%commands.elastic.${name}.title%`);
    expect(nls[`commands.elastic.${name}.title`]).toBe(en);
    expect(nlsRu[`commands.elastic.${name}.title`]).toBe(ru);
  });

  it('keeps all three off the command palette: they work on a node', () => {
    for (const id of [
      COMMAND_IDS.elasticExportIndex,
      COMMAND_IDS.elasticImportIndex,
      COMMAND_IDS.elasticImportNewIndex,
    ]) {
      expect(palette.find((entry) => entry.command === id)?.when).toBe('false');
    }
  });

  it('exports and imports on an index, starred or not, and on nothing else', () => {
    for (const id of [COMMAND_IDS.elasticExportIndex, COMMAND_IDS.elasticImportIndex]) {
      const entries = entriesOf(id);
      expect(entries, id).toHaveLength(1);
      expect(entries[0]?.group).toMatch(/^1_export@/u);
      expect(contextsIn(entries[0]?.when).sort()).toEqual(
        [TREE_CONTEXT.elasticIndex, `${TREE_CONTEXT.elasticIndex}.starred`].sort(),
      );
    }
  });

  it('makes a new index from a file on an Elasticsearch connection, not on an index', () => {
    const [entry] = entriesOf(COMMAND_IDS.elasticImportNewIndex);
    const contexts = contextsIn(entry?.when);
    expect(contexts).toEqual(
      expect.arrayContaining([
        TREE_CONTEXT.elasticConnection,
        `${TREE_CONTEXT.elasticConnection}.starred`,
        TREE_CONTEXT.elasticConnectionConnected,
        TREE_CONTEXT.projectElasticConnection,
      ]),
    );
    expect(contexts).not.toContain(TREE_CONTEXT.elasticIndex);
    expect(contexts.every((context) => context.toLowerCase().includes('elastic'))).toBe(true);
  });
});
