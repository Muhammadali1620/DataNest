// Favorites (V13.2): a starred node wears its usual context value plus ".starred", so
// every menu entry that matches a node by context value must match the starred one too,
// and the star buttons must show for exactly the right nodes.

import { describe, expect, it } from 'vitest';
import { FAVORITABLE_CONTEXTS, STARRED_SUFFIX } from '../../../src/vscode/tree/favorites';
import { readJson } from '../../helpers/repo';

interface MenuEntry {
  command?: string;
  when?: string;
  group?: string;
}

interface Manifest {
  contributes: {
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, MenuEntry[]>;
  };
}

const manifest = readJson('package.json') as Manifest;
const nls = readJson('package.nls.json') as Record<string, string>;
const nlsRu = readJson('package.nls.ru.json') as Record<string, string>;
const itemMenu = manifest.contributes.menus['view/item/context'] ?? [];

/** Does a `when` clause of the view's item menu hold for this context value? */
function matches(when: string, viewItem: string): boolean {
  return when.split('||').some((part) => {
    const equal = /viewItem == (\S+?)\s*\)?\s*$/u.exec(part.trim());
    if (equal?.[1] !== undefined && !part.includes('=~')) {
      return equal[1] === viewItem;
    }
    const regex = /viewItem =~ \/(.+)\/\s*\)?\s*$/u.exec(part.trim());
    return regex?.[1] !== undefined && new RegExp(regex[1], 'u').test(viewItem);
  });
}

function entries(command: string, group?: string): MenuEntry[] {
  return itemMenu.filter(
    (entry) => entry.command === command && (group === undefined || entry.group?.startsWith(group)),
  );
}

describe('favorites in the menus of package.json', () => {
  it('declares the two commands with a star icon, translated, and keeps them off the palette', () => {
    const add = manifest.contributes.commands.find((c) => c.command === 'datanest.favorites.add');
    const remove = manifest.contributes.commands.find(
      (c) => c.command === 'datanest.favorites.remove',
    );
    expect(add?.icon).toBe('$(star-empty)');
    expect(remove?.icon).toBe('$(star-full)');
    for (const key of ['commands.favorites.add.title', 'commands.favorites.remove.title']) {
      expect(nls[key], key).toBeTruthy();
      expect(nlsRu[key], key).toBeTruthy();
    }
    const palette = manifest.contributes.menus.commandPalette ?? [];
    for (const command of ['datanest.favorites.add', 'datanest.favorites.remove']) {
      expect(palette.find((entry) => entry.command === command)?.when).toBe('false');
    }
  });

  it('names the starred form wherever it names a starrable context', () => {
    for (const entry of itemMenu) {
      for (const context of FAVORITABLE_CONTEXTS) {
        const when = entry.when ?? '';
        const plain = new RegExp(`viewItem == ${context.replaceAll('.', '\\.')}(?![\\w.])`, 'u');
        if (plain.test(when)) {
          expect(when, `${entry.command} ${context}`).toContain(
            `viewItem == ${context}${STARRED_SUFFIX}`,
          );
        }
      }
    }
  });

  it('keeps every entry that matched a node matching it once it is starred', () => {
    for (const entry of itemMenu) {
      if (entry.when === undefined || entry.command?.startsWith('datanest.favorites.')) {
        continue;
      }
      for (const context of FAVORITABLE_CONTEXTS) {
        expect(
          matches(entry.when, `${context}${STARRED_SUFFIX}`),
          `${entry.command} ${context}`,
        ).toBe(matches(entry.when, context));
      }
    }
  });

  it('shows "Add" as a button and in the menu for every plain starrable node, and never for a starred one', () => {
    for (const group of ['inline', '0_favorite']) {
      const add = entries('datanest.favorites.add', group);
      expect(add, group).toHaveLength(1);
      for (const context of FAVORITABLE_CONTEXTS) {
        expect(matches(add[0]?.when ?? '', context), `${group} ${context}`).toBe(true);
        expect(matches(add[0]?.when ?? '', `${context}${STARRED_SUFFIX}`), context).toBe(false);
      }
    }
  });

  it('shows "Remove" for every starred node and for nothing else', () => {
    for (const group of ['inline', '0_favorite']) {
      const remove = entries('datanest.favorites.remove', group);
      expect(remove, group).toHaveLength(1);
      for (const context of FAVORITABLE_CONTEXTS) {
        expect(matches(remove[0]?.when ?? '', `${context}${STARRED_SUFFIX}`), context).toBe(true);
        expect(matches(remove[0]?.when ?? '', context), context).toBe(false);
      }
      for (const other of ['datanest.column', 'datanest.group', 'datanest.favorites']) {
        expect(matches(remove[0]?.when ?? '', other), other).toBe(false);
      }
    }
  });

  it('does not offer the star on nodes that cannot be starred', () => {
    const add = entries('datanest.favorites.add')[0];
    for (const other of [
      'datanest.column',
      'datanest.group',
      'datanest.group.tables',
      'datanest.folder',
      'datanest.favorites',
      'datanest.connectionFolder',
      'datanest.redisKey',
      'datanest.function',
    ]) {
      expect(matches(add?.when ?? '', other), other).toBe(false);
    }
  });

  it('leaves the usual entries of a table alone', () => {
    const open = itemMenu.filter((entry) => matches(entry.when ?? '', 'datanest.table.starred'));
    const plain = itemMenu.filter((entry) => matches(entry.when ?? '', 'datanest.table'));
    const names = (list: MenuEntry[]): (string | undefined)[] =>
      list.map((entry) => entry.command).filter((c) => !c?.startsWith('datanest.favorites.'));
    expect(names(open)).toEqual(names(plain));
    expect(names(plain).length).toBeGreaterThan(3);
  });
});
