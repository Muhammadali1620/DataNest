import { describe, expect, it } from 'vitest';
import { tableActionCall, tableNodeOf } from '../../../../src/vscode/panels/table-action';
import { COMMAND_IDS } from '../../../../src/vscode/command-ids';
import { isTreeNode } from '../../../../src/vscode/tree/nodes';
import { TABLE_ACTIONS } from '../../../../src/shared/table-actions';

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
    for (const action of TABLE_ACTIONS) {
      expect(known.has(tableActionCall(action, view).command), action).toBe(true);
    }
  });

  it.each([
    ['properties', COMMAND_IDS.designTable],
    ['ddl', COMMAND_IDS.showDefinition],
    ['er', COMMAND_IDS.showErDiagram],
    ['generate', COMMAND_IDS.generateData],
    ['compare', COMMAND_IDS.compareData],
    ['dump', COMMAND_IDS.dumpSql],
    ['transfer', COMMAND_IDS.transferTables],
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

  it('opens the history narrowed to the table, not the tree command', () => {
    expect(tableActionCall('history', view)).toEqual({
      command: COMMAND_IDS.showHistory,
      args: [{ connectionId: 'c1', table: 'orders' }],
    });
  });
});
