import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { TableRef, TableStructure } from '../../../../src/core/model/objects';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import {
  templateColumns,
  templateCommandHandlers,
} from '../../../../src/vscode/tree/template-commands';

const STRUCTURE: TableStructure = {
  columns: [
    { name: 'id', dataType: 'int', nullable: false, autoIncrement: true, generated: false },
    { name: 'note', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
    { name: 'twice', dataType: 'int', nullable: true, autoIncrement: false, generated: true },
  ],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
};

/** `null` stands for a view, which has no structure of its own. */
function metadata(structure: TableStructure | null = STRUCTURE) {
  return {
    describeTable: vi.fn((table: TableRef) =>
      structure === null
        ? Promise.reject(new DbError('not-found', table.name))
        : Promise.resolve(structure),
    ),
    listColumns: vi.fn(() =>
      Promise.resolve([{ name: 'sum', dataType: 'numeric', nullable: true, primaryKey: false }]),
    ),
  };
}

const table: TreeNode = {
  kind: 'table',
  connectionId: 'c1',
  scope: { database: 'shop' },
  name: 'orders',
  tableKind: 'table',
};

describe('templateColumns', () => {
  it('reads keys and what the server fills from the structure', async () => {
    expect(await templateColumns(metadata(), { name: 'orders' })).toEqual([
      { name: 'id', primaryKey: true, generated: true },
      { name: 'note', primaryKey: false, generated: false },
      { name: 'twice', primaryKey: false, generated: true },
    ]);
  });

  it('falls back to the column list for a view', async () => {
    expect(await templateColumns(metadata(null), { name: 'totals' })).toEqual([
      { name: 'sum', primaryKey: false, generated: false },
    ]);
  });
});

describe('templateCommandHandlers', () => {
  function setup(structure: TableStructure | null = STRUCTURE) {
    const opened: { binding: unknown; snippet: string }[] = [];
    const reader = metadata(structure);
    const generate = templateCommandHandlers({
      dialectOf: () => Promise.resolve(mysqlDialect),
      metadataOf: () => Promise.resolve(reader),
      openSnippet: (binding, snippet) => {
        opened.push({ binding, snippet });
        return Promise.resolve();
      },
    });
    return { generate, opened };
  }

  it('opens the template on the connection and database of the table', async () => {
    const { generate, opened } = setup();
    await generate('delete')(table);
    expect(opened).toEqual([
      {
        binding: { connectionId: 'c1', database: 'shop' },
        snippet: 'DELETE FROM `shop`.`orders`\nWHERE `id` = ${1:id};',
      },
    ]);
  });

  it('gives a view only SELECT', async () => {
    const { generate, opened } = setup(null);
    const view: TreeNode = { ...table, name: 'totals', tableKind: 'view' };
    await generate('insert')(view);
    await generate('update')(view);
    await generate('delete')(view);
    expect(opened).toEqual([]);
    await generate('select')(view);
    expect(opened[0]?.snippet).toContain('`sum`');
  });

  it('ignores anything that is not a table', async () => {
    const { generate, opened } = setup();
    await generate('select')({ kind: 'connection', connectionId: 'c1' });
    await generate('select')('c1');
    await generate('select')();
    expect(opened).toEqual([]);
  });
});
