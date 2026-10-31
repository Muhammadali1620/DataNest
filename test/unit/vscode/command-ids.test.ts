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

interface ConfigProperty {
  type?: string | string[];
  enum?: string[];
  default?: unknown;
  enumDescriptions?: string[];
  markdownDescription?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  scope?: string;
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
    } & Record<string, MenuEntry[]>;
    /** Submenus of the tree (V11.6); their entries live under menus[id]. */
    submenus: { id: string; label: string }[];
    configuration: { properties: Record<string, ConfigProperty> };
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
  /** A submenu entry of the tree, as written: `{ submenu, when, group }` without a command. */
  interface SubmenuEntry {
    submenu?: string;
    when: string;
  }
  const entries = contributes.menus['view/item/context'] as (MenuEntry & SubmenuEntry)[];
  // The commands of the tree's context menu: its own and those of its submenus.
  const items: MenuEntry[] = [
    ...entries.filter((entry) => entry.submenu === undefined),
    ...contributes.submenus.flatMap((submenu) => contributes.menus[submenu.id] ?? []),
  ];
  const submenuEntries = entries.filter((entry) => entry.submenu !== undefined);

  it('opens only submenus the manifest declares, each from the tree', () => {
    const declared = new Set(contributes.submenus.map((submenu) => submenu.id));
    expect(submenuEntries.length).toBe(declared.size);
    for (const entry of submenuEntries) {
      expect(declared.has(entry.submenu ?? '')).toBe(true);
      expect(entry.when).toContain(`view == ${CONNECTIONS_VIEW_ID}`);
    }
  });
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
    for (const entry of [...items, ...submenuEntries]) {
      const used = entry.when.match(/viewItem == ([\w.]+)/g) ?? [];
      expect(used.length).toBeGreaterThan(0);
      for (const value of used) {
        expect(contextValues.has(value.replace('viewItem == ', ''))).toBe(true);
      }
    }
  });

  it('offers new connection, refresh, new query and object search in the view title', () => {
    expect(title.map((entry) => entry.command)).toEqual([
      COMMAND_IDS.addConnection,
      COMMAND_IDS.refreshTree,
      COMMAND_IDS.newQuery,
      COMMAND_IDS.searchObjects,
      COMMAND_IDS.addConnectionFromUrl,
      COMMAND_IDS.importEnvConnections,
      COMMAND_IDS.openProjectFile,
      COMMAND_IDS.importConnections,
      COMMAND_IDS.exportConnections,
      COMMAND_IDS.createFolder,
      COMMAND_IDS.reportIssue,
    ]);
  });

  it('keeps "Report a Problem…" last in the view menu, in a group of its own (V9.6)', () => {
    const report = title.find((entry) => entry.command === COMMAND_IDS.reportIssue);
    expect(report?.group).toBe('9_help@1');
  });

  it('offers on project connections what applies to them, and no user folders (V4.7)', () => {
    const on = (id: string) =>
      items
        .filter((entry) => entry.command === id)
        .map((entry) => entry.when)
        .join(' ');
    for (const id of [
      COMMAND_IDS.connect,
      COMMAND_IDS.editConnection,
      COMMAND_IDS.duplicateConnection,
      COMMAND_IDS.removeConnection,
      COMMAND_IDS.setConnectionColor,
      COMMAND_IDS.moveToUser,
    ]) {
      expect(on(id), id).toContain(`viewItem == ${TREE_CONTEXT.projectConnection}`);
    }
    for (const id of [
      COMMAND_IDS.disconnect,
      COMMAND_IDS.newQuery,
      COMMAND_IDS.createDatabase,
      COMMAND_IDS.refreshTree,
    ]) {
      expect(on(id), id).toContain(`viewItem == ${TREE_CONTEXT.projectConnectionConnected}`);
    }
    for (const id of [
      COMMAND_IDS.moveToFolder,
      COMMAND_IDS.createFolder,
      COMMAND_IDS.moveToProject,
    ]) {
      expect(on(id), id).not.toContain(TREE_CONTEXT.projectConnection);
    }
    expect(on(COMMAND_IDS.moveToProject)).toContain(`viewItem == ${TREE_CONTEXT.connection}`);
    expect(on(COMMAND_IDS.moveToUser)).not.toContain(`viewItem == ${TREE_CONTEXT.connection} `);
    expect(on(COMMAND_IDS.openProjectFile)).toContain(`viewItem == ${TREE_CONTEXT.project}`);
  });

  it('offers the database filter on every connection and database, schemas on schemas (V4.10)', () => {
    const on = (id: string) =>
      items
        .filter((entry) => entry.command === id)
        .map((entry) => entry.when)
        .join(' ');
    for (const context of [
      TREE_CONTEXT.connection,
      TREE_CONTEXT.connectionConnected,
      TREE_CONTEXT.projectConnection,
      TREE_CONTEXT.projectConnectionConnected,
      TREE_CONTEXT.database,
    ]) {
      expect(on(COMMAND_IDS.filterDatabases)).toContain(`viewItem == ${context}`);
    }
    expect(on(COMMAND_IDS.filterSchemas)).toBe(
      `view == datanest.connections && viewItem == ${TREE_CONTEXT.schema}`,
    );
  });

  it('wraps every list of context values in parentheses, so "||" binds inside the view', () => {
    for (const entry of items) {
      if (entry.when.includes('||')) {
        expect(entry.when).toMatch(/^view == [\w.]+ && \(.*\)$/);
      }
    }
  });

  it('offers folder commands on folders and arranging commands on connections', () => {
    const on = (id: string) => items.filter((entry) => entry.command === id).map((e) => e.when);
    for (const id of [COMMAND_IDS.renameFolder, COMMAND_IDS.removeFolder]) {
      expect(on(id)).toEqual([
        `view == datanest.connections && viewItem == ${TREE_CONTEXT.connectionFolder}`,
      ]);
    }
    for (const id of [
      COMMAND_IDS.moveToFolder,
      COMMAND_IDS.setConnectionColor,
      COMMAND_IDS.createFolder,
    ]) {
      const [when] = on(id);
      expect(when).toContain(`viewItem == ${TREE_CONTEXT.connection} `);
      expect(when).toContain(`viewItem == ${TREE_CONTEXT.connectionConnected}`);
    }
  });

  it('keeps the import commands in the view title menu, not as icons', () => {
    for (const id of [
      COMMAND_IDS.addConnectionFromUrl,
      COMMAND_IDS.importEnvConnections,
      COMMAND_IDS.importConnections,
      COMMAND_IDS.exportConnections,
    ]) {
      expect(title.find((entry) => entry.command === id)?.group).toMatch(/^1_add@\d$/);
    }
  });

  it('links the empty view to every way of adding a connection', () => {
    const nls = readJson('package.nls.json') as Record<string, string>;
    const welcome = nls['viewsWelcome.connections.empty'] ?? '';
    for (const id of [
      COMMAND_IDS.addConnection,
      COMMAND_IDS.addConnectionFromUrl,
      COMMAND_IDS.importEnvConnections,
      COMMAND_IDS.importConnections,
    ]) {
      expect(welcome).toContain(`command:${id}`);
    }
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

  it('only ever appears for SQL documents, or for MongoDB and Elasticsearch queries', () => {
    const language = (command: string): string =>
      command.startsWith('datanest.mongo.')
        ? 'datanest-mongo'
        : command.startsWith('datanest.elastic.')
          ? 'datanest-es'
          : 'sql';
    for (const entry of entries) {
      expect(entry.when).toContain(`editorLangId == ${language(entry.command)}`);
    }
    expect(entries.some((entry) => entry.command === COMMAND_IDS.mongoRunQuery)).toBe(true);
    expect(entries.some((entry) => entry.command === COMMAND_IDS.elasticRunQuery)).toBe(true);
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

  it('describes every setting, so the Settings UI is never blank', () => {
    for (const [key, property] of Object.entries(properties)) {
      const described =
        property.markdownDescription !== undefined || property.description !== undefined;
      expect(described, `${key} has no description`).toBe(true);
    }
  });

  it('gives every setting a default, so nothing is undefined at runtime', () => {
    for (const [key, property] of Object.entries(properties)) {
      expect(property.default, `${key} has no default`).toBeDefined();
    }
  });

  it('bounds the numeric settings, so a typo cannot break a query', () => {
    for (const key of ['rowLimit', 'pageSize', 'queryTimeout', 'format.expressionWidth']) {
      const property = properties[`${CONFIG_SECTION}.${key}`];
      expect(property?.minimum, `${key} has no minimum`).toBeDefined();
      expect(property?.maximum, `${key} has no maximum`).toBeDefined();
    }
  });

  it('keeps the row limit and the page size at least one row', () => {
    expect(properties[`${CONFIG_SECTION}.rowLimit`]?.minimum).toBe(1);
    expect(properties[`${CONFIG_SECTION}.pageSize`]?.minimum).toBe(1);
  });

  it('formats with upper-case keywords by default and offers only known cases', () => {
    expect(properties[`${CONFIG_SECTION}.format.keywordCase`]?.default).toBe('upper');
    for (const key of ['keywordCase', 'dataTypeCase', 'functionCase']) {
      expect(properties[`${CONFIG_SECTION}.format.${key}`]?.enum).toEqual([
        'upper',
        'lower',
        'preserve',
      ]);
    }
  });

  it('lets the query timeout be turned off with zero', () => {
    const timeout = properties[`${CONFIG_SECTION}.queryTimeout`];
    expect(timeout?.minimum).toBe(0);
    expect(timeout?.default).toBe(0);
  });

  it('hides the databases of the server itself by default', () => {
    expect(properties[`${CONFIG_SECTION}.showSystemObjects`]?.default).toBe(false);
  });

  it('offers exactly the logger levels with the logger default', () => {
    const logLevel = properties[`${CONFIG_SECTION}.${CONFIG_KEYS.logLevel}`];
    expect(logLevel?.enum).toEqual(LOG_LEVELS);
    expect(logLevel?.default).toBe(DEFAULT_LOG_LEVEL);
    expect(logLevel?.enumDescriptions).toHaveLength(LOG_LEVELS.length);
  });
});
