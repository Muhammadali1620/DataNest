import { describe, expect, it } from 'vitest';
import {
  MANAGER_COMMAND,
  TABLE_PAGE_APPS,
  tableActionCall,
  tableNodeOf,
} from '../../../../src/vscode/panels/table-action';
import { COMMAND_IDS } from '../../../../src/vscode/command-ids';
import { isTreeNode } from '../../../../src/vscode/tree/nodes';
import { TABLE_ACTIONS, TABLE_PAGES } from '../../../../src/shared/table-actions';

const view = {
  target: { connectionId: 'c1', database: 'shop' },
  table: { schema: 'public', name: 'orders' },
};

describe('tableNodeOf', () => {
  it("describes the table as the tree does, in the connection's database", () => {
    const node = tableNodeOf(view);
    expect(node).toEqual({
      kind: 'table',
      connectionId: 'c1',
      scope: { database: 'shop', schema: 'public' },
      name: 'orders',
      tableKind: 'table',
    });
    expect(isTreeNode(node)).toBe(true);
  });

  it('prefers the database the table names itself', () => {
    const node = tableNodeOf({ ...view, table: { database: 'other', name: 't' } });
    expect(node).toMatchObject({ scope: { database: 'other' } });
  });

  it('leaves out a scope part that is not there', () => {
    const node = tableNodeOf({ target: { connectionId: 'c' }, table: { name: 't' } });
    expect(node).toMatchObject({ scope: {} });
  });
});

describe('tableActionCall', () => {
  it('maps every action of the bar to a registered command', () => {
    const known = new Set<string>(Object.values(COMMAND_IDS));
    // The Manager page registers its own command.
    for (const action of TABLE_ACTIONS.filter((candidate) => candidate !== 'manager')) {
      expect(known.has(tableActionCall(action, view).command), action).toBe(true);
    }
  });

  it.each([
    ['properties', COMMAND_IDS.designTable],
    ['data', COMMAND_IDS.openTable],
    ['er', COMMAND_IDS.showErDiagram],
    ['generate', COMMAND_IDS.generateData],
    ['compare', COMMAND_IDS.compareData],
  ] as const)('runs %s on the table node', (action, command) => {
    const call = tableActionCall(action, view);
    expect(call.command).toBe(command);
    expect(call.args).toEqual([tableNodeOf(view)]);
  });

  it('opens the definition editor, not the designer, for a view', () => {
    const asView = { ...view, kind: 'view' as const };
    const call = tableActionCall('properties', asView);
    expect(call.command).toBe(COMMAND_IDS.editObject);
    expect(call.args).toEqual([expect.objectContaining({ kind: 'table', tableKind: 'view' })]);
    expect(tableNodeOf(asView)).toMatchObject({ tableKind: 'view' });
  });

  it("opens the manager of the table's database with the table named", () => {
    expect(tableActionCall('manager', view)).toEqual({
      command: MANAGER_COMMAND,
      args: [
        {
          connectionId: 'c1',
          scope: { database: 'shop', schema: 'public' },
          table: { name: 'orders', kind: 'table' },
        },
      ],
      page: 'manager',
      isView: false,
    });
  });

  it('opens the history narrowed to the table, not the tree command', () => {
    expect(tableActionCall('history', view)).toEqual({
      command: COMMAND_IDS.showHistory,
      args: [{ connectionId: 'c1', table: 'orders' }],
    });
  });

  it('names the page a command opens, so the page can stand under the same bar while it loads', () => {
    for (const action of TABLE_ACTIONS.filter((candidate) => candidate !== 'history')) {
      expect(tableActionCall(action, view)).toMatchObject({ page: action, isView: false });
    }
    expect(tableActionCall('er', { ...view, kind: 'view' })).toMatchObject({ isView: true });
    expect(tableActionCall('history', view).page).toBeUndefined();
  });

  it('knows the app of every page, so only that page takes over the tab', () => {
    expect(Object.keys(TABLE_PAGE_APPS).sort()).toEqual([...TABLE_PAGES].sort());
    expect(new Set(Object.values(TABLE_PAGE_APPS)).size).toBe(TABLE_PAGES.length);
    expect(TABLE_PAGE_APPS.properties).toBe('table-designer');
  });
});
