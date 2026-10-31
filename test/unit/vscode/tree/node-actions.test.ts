import { describe, expect, it } from 'vitest';
import { COMMAND_IDS } from '../../../../src/vscode/command-ids';
import { actionsOf, nodeSqlTargetOf } from '../../../../src/vscode/tree/node-actions';
import { TREE_CONTEXT, type TreeNode } from '../../../../src/vscode/tree/nodes';
import { readJson } from '../../../helpers/repo';

interface Entry {
  command?: string;
  submenu?: string;
  when: string;
  group?: string;
}
interface Manifest {
  contributes: {
    commands: { command: string; icon?: string }[];
    menus: Record<string, Entry[]>;
    submenus: { id: string }[];
  };
}
const { contributes } = readJson('package.json') as Manifest;
const entries = contributes.menus['view/item/context'] ?? [];
const menuItems = [
  ...entries,
  ...contributes.submenus.flatMap((submenu) => contributes.menus[submenu.id] ?? []),
].filter((entry) => entry.command !== undefined);

const TABLE = { database: 'app', name: 'orders' };
const NODES: { node: TreeNode; context: string }[] = [
  {
    node: {
      kind: 'table',
      connectionId: 'c',
      scope: { database: 'app' },
      name: 'orders',
      tableKind: 'table',
    },
    context: TREE_CONTEXT.table,
  },
  {
    node: {
      kind: 'table',
      connectionId: 'c',
      scope: { database: 'app' },
      name: 'v',
      tableKind: 'view',
    },
    context: TREE_CONTEXT.view,
  },
  {
    node: {
      kind: 'column',
      connectionId: 'c',
      table: TABLE,
      column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
    },
    context: TREE_CONTEXT.column,
  },
  {
    node: {
      kind: 'column',
      connectionId: 'c',
      table: TABLE,
      column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
      movable: true,
    },
    context: TREE_CONTEXT.columnMovable,
  },
  {
    node: {
      kind: 'index',
      connectionId: 'c',
      table: TABLE,
      index: { name: 'ix', columns: ['a'], unique: false, primary: false },
    },
    context: TREE_CONTEXT.index,
  },
  {
    node: {
      kind: 'foreignKey',
      connectionId: 'c',
      table: TABLE,
      key: { name: 'fk', columns: ['a'], target: { name: 'u' }, targetColumns: ['id'] },
    },
    context: TREE_CONTEXT.foreignKey,
  },
  {
    node: {
      kind: 'object',
      connectionId: 'c',
      object: { kind: 'trigger', name: 't', table: 'orders' },
    },
    context: TREE_CONTEXT.trigger,
  },
  {
    node: { kind: 'object', connectionId: 'c', object: { kind: 'function', name: 'f' } },
    context: TREE_CONTEXT.function,
  },
  {
    node: { kind: 'object', connectionId: 'c', object: { kind: 'sequence', name: 's' } },
    context: TREE_CONTEXT.sequence,
  },
  {
    node: { kind: 'savedQuery', connectionId: 'c', scope: {}, name: 'q' },
    context: TREE_CONTEXT.savedQuery,
  },
  {
    node: {
      kind: 'account',
      connectionId: 'c',
      group: 'users',
      user: { name: 'a', login: true, role: false, flags: [] },
    },
    context: TREE_CONTEXT.account,
  },
];

function nodeWith(context: string): TreeNode {
  const found = NODES.find((entry) => entry.context === context)?.node;
  if (found === undefined) {
    throw new Error(`No node with ${context}`);
  }
  return found;
}

describe('actionsOf (V11.12)', () => {
  const contributed = new Set(contributes.commands.map((command) => command.command));

  it.each(NODES.map((entry) => [entry.node.kind + ' ' + entry.context, entry] as const))(
    'offers on %s only commands the manifest contributes, and its menu offers them too',
    (_name, { node, context }) => {
      const actions = actionsOf(node);
      expect(actions.length).toBeGreaterThan(0);
      expect(new Set(actions).size).toBe(actions.length);
      for (const command of actions) {
        expect(contributed.has(command), command).toBe(true);
        const offered = menuItems.some(
          (entry) => entry.command === command && entry.when.includes(`viewItem == ${context}`),
        );
        expect(offered, `${command} on ${context}`).toBe(true);
      }
    },
  );

  it('offers the move buttons only on a column that can move', () => {
    const plain = nodeWith(TREE_CONTEXT.column);
    const movable = nodeWith(TREE_CONTEXT.columnMovable);
    expect(actionsOf(plain)).not.toContain(COMMAND_IDS.moveColumnUp);
    expect(actionsOf(movable)).toEqual(
      expect.arrayContaining([COMMAND_IDS.moveColumnUp, COMMAND_IDS.moveColumnDown]),
    );
  });

  it('keeps destructive commands last, and offers no truncate on a view', () => {
    const table = nodeWith(TREE_CONTEXT.table);
    const view = nodeWith(TREE_CONTEXT.view);
    expect(actionsOf(table).at(-1)).toBe(COMMAND_IDS.dropTable);
    expect(actionsOf(view)).not.toContain(COMMAND_IDS.truncateTable);
    expect(actionsOf(view)).not.toContain(COMMAND_IDS.designTable);
  });

  it('offers no editing of a sequence definition', () => {
    const sequence = nodeWith(TREE_CONTEXT.sequence);
    expect(actionsOf(sequence)).not.toContain(COMMAND_IDS.editObject);
  });

  it('has nothing for folders, connections and messages', () => {
    for (const node of [
      { kind: 'connection', connectionId: 'c' },
      { kind: 'folder', folder: 'indexes', connectionId: 'c', table: TABLE },
      { kind: 'queryFolder', connectionId: 'c', scope: {} },
      { kind: 'message', text: 'x' },
    ] as TreeNode[]) {
      expect(actionsOf(node)).toEqual([]);
    }
  });
});

describe('the actions button (V11.12)', () => {
  const on = (command: string) =>
    entries
      .filter((entry) => entry.command === command)
      .map((entry) => entry.when)
      .join(' ');

  it('sits inline on every kind of node whose actions it lists', () => {
    const inline = entries.filter(
      (entry) => entry.command === COMMAND_IDS.nodeActions && entry.group?.startsWith('inline'),
    );
    expect(inline).toHaveLength(1);
    for (const { context } of NODES) {
      expect(inline[0]?.when, context).toContain(`viewItem == ${context}`);
    }
  });

  it('puts the move buttons inline on movable columns only, and in the menu too', () => {
    for (const command of [COMMAND_IDS.moveColumnUp, COMMAND_IDS.moveColumnDown]) {
      expect(on(command)).toContain(`viewItem == ${TREE_CONTEXT.columnMovable}`);
      expect(on(command)).not.toContain(`viewItem == ${TREE_CONTEXT.column} `);
      expect(
        entries.filter((entry) => entry.command === command).map((entry) => entry.group),
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^inline@/u),
          expect.stringMatching(/^3_move@/u),
        ]),
      );
    }
  });

  it('keeps every command with an inline button iconed, since an inline button shows only the icon', () => {
    const icons = new Map(contributes.commands.map((command) => [command.command, command.icon]));
    for (const entry of entries) {
      if (entry.command !== undefined && entry.group?.startsWith('inline')) {
        expect(icons.get(entry.command), entry.command).toBeDefined();
      }
    }
  });
});

describe('nodeSqlTargetOf', () => {
  it('names the node kinds that have SQL, and none of the others', () => {
    expect(NODES.map((entry) => nodeSqlTargetOf(entry.node)?.kind ?? null)).toEqual([
      null,
      null,
      'column',
      'column',
      'index',
      'foreignKey',
      'object',
      'object',
      'object',
      null,
      null,
    ]);
  });
});
