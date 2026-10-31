import { describe, expect, it, vi } from 'vitest';
import type { Driver } from '../../../../src/drivers/driver';
import type { SchemaAction } from '../../../../src/services/schema-actions';
import type { TableDesign } from '../../../../src/shared/table-design';
import {
  type SchemaTexts,
  type SchemaUi,
  schemaCommandHandlers,
} from '../../../../src/vscode/tree/schema-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

const DESIGN: TableDesign = {
  name: 'orders',
  comment: '',
  columns: [],
  indexes: [],
  foreignKeys: [],
};
const ACTION: SchemaAction = {
  kind: 'alterTable',
  table: { database: 'app', name: 'orders' },
  before: DESIGN,
  after: DESIGN,
  background: { fixedIndexes: [], generatedColumns: [], constraintIndexes: [], rebuildSql: [] },
};

const column: TreeNode = {
  kind: 'column',
  connectionId: 'c1',
  table: { database: 'app', name: 'orders' },
  column: { name: 'note', dataType: 'text', nullable: true, primaryKey: false },
  movable: true,
};

function setup(plan: SchemaAction | undefined, choice: 'run' | 'edit' | 'closed' = 'run') {
  const infos: string[] = [];
  const confirmed: { title: string; sql: string; runLabel: string }[] = [];
  const ran: string[] = [];
  const opened: string[] = [];
  const planMove = vi.fn(() => Promise.resolve(plan));
  const ui: SchemaUi = {
    askName: () => Promise.resolve(undefined),
    confirm: (options) => {
      confirmed.push(options);
      return Promise.resolve(choice === 'closed' ? undefined : choice);
    },
    pick: () => Promise.resolve(undefined),
    info: (message) => {
      infos.push(message);
    },
  };
  const texts = new Proxy({} as SchemaTexts, {
    get: (_target, key) => {
      if (key === 'columnAtEdge') {
        return (name: string, direction: string) => `${name} is at the ${direction} edge`;
      }
      if (key === 'alterTable') {
        return (name: string) => `alter ${name}`;
      }
      return key === 'apply' ? 'Apply' : (name: string) => name;
    },
  });
  const handlers = schemaCommandHandlers({
    actions: {
      sqlOf: () => Promise.resolve(['ALTER TABLE orders MOVE']),
      run: (_id, _action, statements) => {
        ran.push(statements.join('|'));
        return Promise.resolve();
      },
    },
    manager: { driverOf: () => Promise.resolve({ id: 'mysql' } as unknown as Driver) },
    ui,
    texts,
    tree: { refresh: vi.fn() },
    openEditor: (_binding, sql) => {
      opened.push(sql);
      return Promise.resolve();
    },
    openDesigner: () => Promise.resolve(),
    planMove,
  });
  return { handlers, infos, confirmed, ran, opened, planMove };
}

describe('moveColumnUp and moveColumnDown (V11.12)', () => {
  it('shows the ALTER first, and runs it on yes', async () => {
    const { handlers, planMove, confirmed, ran } = setup(ACTION);
    await handlers.moveColumnUp(column);
    expect(planMove).toHaveBeenCalledWith('c1', { database: 'app', name: 'orders' }, 'note', 'up');
    expect(confirmed).toEqual([
      { title: 'alter orders', sql: 'ALTER TABLE orders MOVE;', runLabel: 'Apply' },
    ]);
    expect(ran).toEqual(['ALTER TABLE orders MOVE']);
  });

  it('asks for the other direction on the down button', async () => {
    const { handlers, planMove } = setup(ACTION);
    await handlers.moveColumnDown(column);
    expect(planMove).toHaveBeenCalledWith('c1', expect.anything(), 'note', 'down');
  });

  it('runs nothing when the user closes the dialog, and opens an editor when asked', async () => {
    const closed = setup(ACTION, 'closed');
    await closed.handlers.moveColumnUp(column);
    expect(closed.ran).toEqual([]);
    const edit = setup(ACTION, 'edit');
    await edit.handlers.moveColumnUp(column);
    expect(edit.ran).toEqual([]);
    expect(edit.opened).toEqual(['ALTER TABLE orders MOVE;']);
  });

  it('says so when the column is at the edge, and shows no dialog', async () => {
    const { handlers, infos, confirmed } = setup(undefined);
    await handlers.moveColumnUp(column);
    expect(infos).toEqual(['note is at the up edge']);
    expect(confirmed).toEqual([]);
  });

  it('ignores nodes that are not columns and empty targets', async () => {
    const { handlers, planMove } = setup(ACTION);
    await handlers.moveColumnUp({ kind: 'connection', connectionId: 'c1' });
    await handlers.moveColumnDown();
    await handlers.moveColumnDown('c1');
    expect(planMove).not.toHaveBeenCalled();
  });
});
