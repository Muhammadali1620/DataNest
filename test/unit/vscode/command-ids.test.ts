import { describe, expect, it } from 'vitest';
import { LOG_LEVELS, DEFAULT_LOG_LEVEL } from '../../../src/core/logging/logger';
import {
  COMMAND_IDS,
  CONFIG_KEYS,
  CONFIG_SECTION,
  CONTEXT_KEYS,
} from '../../../src/vscode/command-ids';
import { CONNECTIONS_VIEW_ID, TREE_CONTEXT } from '../../../src/vscode/tree/nodes';
import { readJson } from '../../helpers/repo';

interface MenuEntry {
  command: string;
  when: string;
  group?: string;
}

interface Manifest {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    menus: {
      commandPalette: MenuEntry[];
      'view/title': MenuEntry[];
      'view/item/context': MenuEntry[];
      'editor/title': MenuEntry[];
      'editor/context': MenuEntry[];
    };
    configuration: {
      properties: Record<
        string,
        { enum?: string[]; default?: unknown; enumDescriptions?: string[] }
      >;
    };
  };
}

const { contributes } = readJson('package.json') as Manifest;

describe('command ids', () => {
  it('match the commands contributed in package.json', () => {
    expect(contributes.commands.map((c) => c.command).sort()).toEqual(
      Object.values(COMMAND_IDS).sort(),
    );
  });

  it('follow the <extId>.<area>.<action> pattern', () => {
    for (const id of Object.values(COMMAND_IDS)) {
      expect(id).toMatch(/^datanest\.[a-z]+(?:[A-Z][a-z]+)*\.[a-z]+(?:[A-Z][a-z]+)*$/);
    }
  });

  it('are unique', () => {
    const ids = Object.values(COMMAND_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('appear in the palette under the DataNest category', () => {
    for (const command of contributes.commands) {
      expect(command.category).toBe('DataNest');
    }
  });
});

describe('command palette', () => {
  const palette = contributes.menus.commandPalette;

  it('mentions only contributed commands', () => {
    const ids = new Set(contributes.commands.map((c) => c.command));
    for (const entry of palette) {
      expect(ids.has(entry.command)).toBe(true);
    }
  });

  it('uses only context keys the extension sets', () => {
    const known = new Set<string>(Object.values(CONTEXT_KEYS));
    for (const entry of palette) {
      const keys = entry.when.match(/datanest\.[\w.]+/g) ?? [];
      for (const key of keys) {
        expect(known.has(key)).toBe(true);
      }
    }
  });

  it('hides the ping page outside development', () => {
    expect(palette).toContainEqual({
      command: COMMAND_IDS.openPing,
      when: CONTEXT_KEYS.isDevelopment,
    });
  });
});

describe('tree menus', () => {
  const title = contributes.menus['view/title'];
  const items = contributes.menus['view/item/context'];
  const contributed = new Set(contributes.commands.map((c) => c.command));
  const viewIds = new Set([CONNECTIONS_VIEW_ID]);
  const contextValues = new Set<string>(Object.values(TREE_CONTEXT));

  it('mentions only contributed commands', () => {
    for (const entry of [...title, ...items]) {
      expect(contributed.has(entry.command)).toBe(true);
    }
  });

  it('binds every entry to a view the extension registers', () => {
    for (const entry of [...title, ...items]) {
      const views = entry.when.match(/view == ([\w.]+)/g) ?? [];
      expect(views.length).toBeGreaterThan(0);
      for (const view of views) {
        expect(viewIds.has(view.replace('view == ', ''))).toBe(true);
      }
    }
  });

  it('uses only context values the tree actually sets', () => {
    for (const entry of items) {
      const used = entry.when.match(/viewItem == ([\w.]+)/g) ?? [];
      expect(used.length).toBeGreaterThan(0);
      for (const value of used) {
        expect(contextValues.has(value.replace('viewItem == ', ''))).toBe(true);
      }
    }
  });

  it('offers new connection, refresh and new query in the view title', () => {
    expect(title.map((entry) => entry.command)).toEqual([
      COMMAND_IDS.addConnection,
      COMMAND_IDS.refreshTree,
      COMMAND_IDS.newQuery,
    ]);
  });

  it('offers a new query only where a connection is live', () => {
    const entries = [...title, ...items].filter((entry) => entry.command === COMMAND_IDS.newQuery);
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries.filter((e) => e.when.includes('viewItem'))) {
      expect(entry.when).toContain(TREE_CONTEXT.connectionConnected);
      expect(entry.when).not.toContain(`viewItem == ${TREE_CONTEXT.column}`);
    }
  });

  it('shows connect and disconnect on opposite states, never both at once', () => {
    const connect = items.filter((entry) => entry.command === COMMAND_IDS.connect);
    const disconnect = items.filter((entry) => entry.command === COMMAND_IDS.disconnect);
    expect(connect.length).toBeGreaterThan(0);
    expect(disconnect.length).toBeGreaterThan(0);
    for (const entry of connect) {
      expect(entry.when).toContain(`viewItem == ${TREE_CONTEXT.connection}`);
      expect(entry.when).not.toContain(TREE_CONTEXT.connectionConnected);
    }
    for (const entry of disconnect) {
      expect(entry.when).toContain(`viewItem == ${TREE_CONTEXT.connectionConnected}`);
    }
  });

  it('puts delete in its own group so it is not next to edit', () => {
    const remove = items.find((entry) => entry.command === COMMAND_IDS.removeConnection);
    const edit = items.find(
      (entry) => entry.command === COMMAND_IDS.editConnection && entry.group !== 'inline@3',
    );
    expect(remove?.group).toBeDefined();
    expect(edit?.group).toBeDefined();
    expect(remove?.group?.split('@')[0]).not.toBe(edit?.group?.split('@')[0]);
  });

  it('offers Open Table on tables and views only', () => {
    const entries = items.filter((entry) => entry.command === COMMAND_IDS.openTable);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.when).toContain(TREE_CONTEXT.table);
      expect(entry.when).toContain(TREE_CONTEXT.view);
      expect(entry.when).not.toContain(TREE_CONTEXT.column);
      expect(entry.when).not.toContain(TREE_CONTEXT.group);
    }
  });

  it('keeps Open Table out of the palette, where there is no node to open', () => {
    expect(contributes.menus.commandPalette).toContainEqual({
      command: COMMAND_IDS.openTable,
      when: 'false',
    });
  });

  it('offers copy name on named objects only', () => {
    const copy = items.filter((entry) => entry.command === COMMAND_IDS.copyName);
    expect(copy).toHaveLength(1);
    const when = copy[0]?.when ?? '';
    for (const value of [
      TREE_CONTEXT.database,
      TREE_CONTEXT.schema,
      TREE_CONTEXT.table,
      TREE_CONTEXT.view,
      TREE_CONTEXT.column,
    ]) {
      expect(when).toContain(value);
    }
    expect(when).not.toContain(TREE_CONTEXT.group);
  });
});

describe('editor menus', () => {
  const entries = [...contributes.menus['editor/title'], ...contributes.menus['editor/context']];
  const contributed = new Set(contributes.commands.map((c) => c.command));

  it('mentions only contributed commands', () => {
    for (const entry of entries) {
      expect(contributed.has(entry.command)).toBe(true);
    }
  });

  it('only ever appears for SQL documents', () => {
    for (const entry of entries) {
      expect(entry.when).toContain('editorLangId == sql');
    }
  });

  it('offers Run and Run All in both places', () => {
    for (const menu of ['editor/title', 'editor/context'] as const) {
      const commands = contributes.menus[menu].map((entry) => entry.command);
      expect(commands).toContain(COMMAND_IDS.runQuery);
      expect(commands).toContain(COMMAND_IDS.runAll);
    }
  });

  it('shows Cancel only while a query is running', () => {
    const cancels = entries.filter((entry) => entry.command === COMMAND_IDS.cancelQuery);
    expect(cancels.length).toBeGreaterThan(0);
    for (const entry of cancels) {
      expect(entry.when).toContain(CONTEXT_KEYS.queryRunning);
    }
  });

  it('uses only context keys the extension sets', () => {
    const known = new Set<string>(Object.values(CONTEXT_KEYS));
    for (const entry of entries) {
      const keys = entry.when.match(/datanest\.[\w.]+/g) ?? [];
      for (const key of keys) {
        expect(known.has(key)).toBe(true);
      }
    }
  });

  it('keeps the CodeLens-only command out of the palette', () => {
    expect(contributes.menus.commandPalette).toContainEqual({
      command: COMMAND_IDS.runRange,
      when: 'false',
    });
  });
});

describe('settings', () => {
  const properties = contributes.configuration.properties;

  it('declares only settings the code knows', () => {
    expect(Object.keys(properties).sort()).toEqual(
      Object.values(CONFIG_KEYS)
        .map((key) => `${CONFIG_SECTION}.${key}`)
        .sort(),
    );
  });

  it('offers exactly the logger levels with the logger default', () => {
    const logLevel = properties[`${CONFIG_SECTION}.${CONFIG_KEYS.logLevel}`];
    expect(logLevel?.enum).toEqual(LOG_LEVELS);
    expect(logLevel?.default).toBe(DEFAULT_LOG_LEVEL);
    expect(logLevel?.enumDescriptions).toHaveLength(LOG_LEVELS.length);
  });
});
