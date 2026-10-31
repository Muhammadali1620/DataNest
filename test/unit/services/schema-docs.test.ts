import { describe, expect, it } from 'vitest';
import type { TableStructure } from '../../../src/core/model/objects';
import type { SchemaSnapshot } from '../../../src/services/schema-compare/snapshot';
import { anchorOf, cell, code, schemaDocument } from '../../../src/services/schema-docs';
import { designFromStructure } from '../../../src/services/table-structure';

function table(name: string, structure: TableStructure) {
  return { name, structure, loaded: designFromStructure({ name }, structure) };
}

const customers: TableStructure = {
  comment: 'People who buy',
  columns: [
    { name: 'id', dataType: 'integer', nullable: false, autoIncrement: true, generated: false },
    {
      name: 'email',
      dataType: 'varchar(100)',
      nullable: false,
      autoIncrement: false,
      generated: false,
      comment: 'Login | contact',
    },
    {
      name: 'joined',
      dataType: 'date',
      nullable: true,
      autoIncrement: false,
      generated: false,
      defaultExpression: 'CURRENT_DATE',
    },
  ],
  primaryKey: ['id'],
  indexes: [
    { name: 'customers_pkey', columns: ['id'], unique: true, primary: true },
    { name: 'customers_email_key', columns: ['email'], unique: true, primary: false },
  ],
  foreignKeys: [],
};

const orders: TableStructure = {
  columns: [
    { name: 'id', dataType: 'integer', nullable: false, autoIncrement: false, generated: false },
    {
      name: 'customer_id',
      dataType: 'integer',
      nullable: false,
      autoIncrement: false,
      generated: false,
    },
    { name: 'total', dataType: 'numeric', nullable: true, autoIncrement: false, generated: true },
  ],
  primaryKey: ['id'],
  indexes: [
    {
      name: 'ix_orders_customer',
      columns: ['customer_id'],
      unique: false,
      primary: false,
      method: 'btree',
      where: 'customer_id > 0',
    },
  ],
  foreignKeys: [
    {
      name: 'fk_customer',
      columns: ['customer_id'],
      target: { schema: 'public', name: 'customers' },
      targetColumns: ['id'],
      onDelete: 'CASCADE',
    },
  ],
};

const snapshot: SchemaSnapshot = {
  scope: { schema: 'public' },
  tables: [table('orders', orders), table('customers', customers)],
  objects: [
    {
      ref: { kind: 'view', name: 'big_orders' },
      statements: ['CREATE VIEW big_orders AS SELECT `x` FROM orders'],
    },
    { ref: { kind: 'function', name: 'total', signature: 'integer' }, hidden: 'no access' },
    {
      ref: { kind: 'trigger', name: 'touch', table: 'orders' },
      statements: ['CREATE TRIGGER touch …'],
    },
  ],
};

const OPTIONS = { title: 'shop.public', connection: 'Local', date: '2026-10-31' };

describe('schemaDocument', () => {
  const text = schemaDocument(snapshot, OPTIONS);

  it('opens with the title, where it was read and a table of contents', () => {
    expect(text.startsWith('# shop.public\n')).toBe(true);
    expect(text).toContain('read by DataNest on 2026-10-31');
    expect(text).toContain('`Local`');
    expect(text).toContain('- [Tables](#tables) (2)');
    expect(text).toContain('- [Views](#views) (1)');
    expect(text).toContain('- [Functions](#functions) (1)');
    expect(text).toContain('- [Triggers](#triggers) (1)');
  });

  it('lists the tables in order of name, each linked to its section', () => {
    expect(text.indexOf('### customers')).toBeLessThan(text.indexOf('### orders'));
    expect(text).toContain('- [`customers`](#customers)');
  });

  it('describes each column: type, null, default, keys and comment', () => {
    expect(text).toContain('People who buy');
    expect(text).toContain('| `id` | `integer` | no | auto increment | PK |  |');
    expect(text).toContain('| `email` | `varchar(100)` | no |  | unique | Login \\| contact |');
    expect(text).toContain('| `joined` | `date` | yes | `CURRENT_DATE` |  |  |');
    expect(text).toContain('| `total` | `numeric` | yes | computed |  |  |');
    expect(text).toContain('| `customer_id` | `integer` | no |  | FK |  |');
  });

  it('lists indexes, foreign keys with links, and the tables that point here', () => {
    expect(text).toContain('- `ix_orders_customer`: `customer_id` (btree) where `customer_id > 0`');
    expect(text).toContain('- `customers_email_key`: `email` (unique)');
    expect(text).not.toContain('customers_pkey');
    expect(text).toContain(
      '- `fk_customer`: `customer_id` → [`customers`](#customers) (`id`) ON DELETE CASCADE',
    );
    expect(text).toMatch(/\*\*Referenced by\*\*\n\n- \[`orders`\]\(#orders\) \(`customer_id`\)/u);
  });

  it('writes definitions in fences longer than any backticks inside, and says what is hidden', () => {
    expect(text).toContain('```sql\nCREATE VIEW big_orders AS SELECT `x` FROM orders;\n```');
    expect(text).toContain('### total(integer)');
    expect(text).toContain('_The server does not show its definition to this user._');
    expect(text).toContain('A trigger on [`orders`](#orders).');
  });

  it('names a table of another schema in full, without a link', () => {
    const elsewhere = schemaDocument(
      {
        ...snapshot,
        tables: [
          table('orders', {
            ...orders,
            foreignKeys: [
              {
                name: 'fk_customer',
                columns: ['customer_id'],
                target: { schema: 'crm', name: 'customers' },
                targetColumns: ['id'],
              },
            ],
          }),
        ],
      },
      OPTIONS,
    );
    expect(elsewhere).toContain('→ `crm.customers` (`id`)');
  });

  it('says so when there are no tables, and ends with one newline', () => {
    const empty = schemaDocument({ scope: {}, tables: [], objects: [] }, OPTIONS);
    expect(empty).toContain('There are no tables.');
    expect(empty).toContain('- [Tables](#tables) (0)');
    expect(empty.endsWith('.\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('gives tables whose names make the same anchor different anchors', () => {
    const twins = schemaDocument(
      {
        scope: {},
        tables: [table('Order Items', customers), table('order-items', customers)],
        objects: [],
      },
      OPTIONS,
    );
    expect(twins).toContain('(#order-items)');
    expect(twins).toContain('(#order-items-1)');
  });
});

describe('helpers', () => {
  it('makes GitHub anchors', () => {
    expect(anchorOf('Order Items')).toBe('order-items');
    expect(anchorOf('Заказы (old)')).toBe('заказы-old');
    expect(anchorOf('a.b_c')).toBe('ab_c');
  });

  it('keeps table cells on one line with pipes escaped', () => {
    expect(cell('a|b\nc\\d')).toBe('a\\|b c\\\\d');
    expect(cell(undefined)).toBe('');
  });

  it('writes any name as code', () => {
    expect(code('id')).toBe('`id`');
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`x')).toBe('`` `x ``');
  });
});
