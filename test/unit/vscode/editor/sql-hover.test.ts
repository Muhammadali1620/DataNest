import { describe, expect, it, vi } from 'vitest';
import type { TableRef, TableStructure } from '../../../../src/core/model/objects';
import { DbError } from '../../../../src/core/errors';
import { type HoverTexts, hoverMarkdown } from '../../../../src/vscode/editor/sql-hover';

const TEXTS: HoverTexts = {
  table: 'table',
  view: 'view',
  cte: 'defined here',
  primaryKey: 'PK',
  nullable: 'NULL',
  notNull: 'NOT NULL',
  defaultIs: (value) => `default ${value}`,
  autoIncrement: 'auto',
  more: (count) => `${count} more`,
};

const ORDERS: TableStructure = {
  comment: 'All *orders*',
  columns: [
    { name: 'id', dataType: 'int', nullable: false, autoIncrement: true, generated: false },
    {
      name: 'customer_id',
      dataType: 'int',
      nullable: false,
      autoIncrement: false,
      generated: false,
    },
    {
      name: 'total',
      dataType: 'decimal(10,2)',
      nullable: true,
      defaultExpression: '0',
      autoIncrement: false,
      generated: false,
      comment: 'gross_sum',
    },
  ],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [
    {
      name: 'fk',
      columns: ['customer_id'],
      target: { name: 'customers' },
      targetColumns: ['id'],
    },
  ],
};

function reader(structures: Record<string, TableStructure> = { orders: ORDERS }) {
  return {
    describeTable: vi.fn((table: TableRef) => {
      const found = structures[table.name];
      return found === undefined
        ? Promise.reject(new DbError('not-found', 'no'))
        : Promise.resolve(found);
    }),
    listColumns: vi.fn((table: TableRef) =>
      Promise.resolve(
        table.name === 'totals'
          ? [{ name: 'sum', dataType: 'numeric', nullable: true, primaryKey: false }]
          : [],
      ),
    ),
    listForeignKeys: vi.fn(() => Promise.resolve([])),
    listTables: vi.fn(() =>
      Promise.resolve([
        { name: 'orders', kind: 'table' as const },
        { name: 'totals', kind: 'view' as const },
      ]),
    ),
  };
}

describe('hoverMarkdown', () => {
  it('describes a table with its comment and every column', async () => {
    const text = await hoverMarkdown({ kind: 'table', table: { name: 'orders' } }, reader(), TEXTS);
    expect(text).toBe(
      [
        '**orders** — table',
        '',
        '_All \\*orders\\*_',
        '',
        '| | | |',
        '|---|---|---|',
        '| `id` | `int` | NOT NULL · PK · auto |',
        '| `customer_id` | `int` | NOT NULL · → customers.id |',
        '| `total` | `decimal(10,2)` | NULL · default `0` |',
      ].join('\n'),
    );
  });

  it('falls back to the column list for a view', async () => {
    const text = await hoverMarkdown({ kind: 'table', table: { name: 'totals' } }, reader(), TEXTS);
    expect(text).toContain('**totals** — view');
    expect(text).toContain('| `sum` | `numeric` | NULL |');
  });

  it('says nothing about a name the server does not know', async () => {
    expect(
      await hoverMarkdown({ kind: 'table', table: { name: 'nothing' } }, reader(), TEXTS),
    ).toBeUndefined();
    expect(
      await hoverMarkdown(
        { kind: 'column', table: { name: 'orders' }, column: 'nope' },
        reader(),
        TEXTS,
      ),
    ).toBeUndefined();
  });

  it('describes one column, whatever the case of the name', async () => {
    expect(
      await hoverMarkdown(
        { kind: 'column', table: { name: 'orders' }, column: 'TOTAL' },
        reader(),
        TEXTS,
      ),
    ).toBe('**orders.total** `decimal(10,2)`\n\nNULL · default `0`\n\n_gross\\_sum_');
  });

  it('finds an unqualified column in every table that has it', async () => {
    const both = reader({
      orders: ORDERS,
      archive: { ...ORDERS, comment: undefined },
    });
    const text = await hoverMarkdown(
      {
        kind: 'loose-column',
        tables: [{ name: 'orders' }, { name: 'archive' }, { name: 'x' }],
        column: 'id',
      },
      both,
      TEXTS,
    );
    expect(text?.split('\n\n---\n\n').map((part) => part.split('\n')[0])).toEqual([
      '**orders.id** `int`',
      '**archive.id** `int`',
    ]);
    expect(
      await hoverMarkdown(
        { kind: 'loose-column', tables: [{ name: 'x' }], column: 'id' },
        both,
        TEXTS,
      ),
    ).toBeUndefined();
  });

  it('lists the columns of a CTE without asking the server', async () => {
    expect(
      await hoverMarkdown(
        { kind: 'cte', derived: { name: 'big', columns: ['id', 'total'], starFrom: [] } },
        undefined,
        TEXTS,
      ),
    ).toBe('**big** — defined here\n\n`id`, `total`');
  });

  it('needs a connection for everything else, and stays quiet about routines', async () => {
    expect(
      await hoverMarkdown({ kind: 'table', table: { name: 'orders' } }, undefined, TEXTS),
    ).toBeUndefined();
    expect(
      await hoverMarkdown({ kind: 'routine', name: 'f', scope: {} }, reader(), TEXTS),
    ).toBeUndefined();
  });

  it('cuts a long column list short and fences backticks', async () => {
    const wide: TableStructure = {
      ...ORDERS,
      comment: undefined,
      columns: Array.from({ length: 30 }, (_, n) => ({
        name: n === 0 ? 'a`b' : `c${n}`,
        dataType: 'int',
        nullable: true,
        autoIncrement: false,
        generated: false,
      })),
    };
    const text = await hoverMarkdown(
      { kind: 'table', table: { name: 'wide' } },
      reader({ wide }),
      TEXTS,
    );
    expect(text).toContain('| `` a`b `` |');
    expect(text?.endsWith('5 more')).toBe(true);
  });
});
