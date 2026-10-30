import { beforeEach, describe, expect, it } from 'vitest';
import { readErSchema } from '../../../src/services/er-diagram';
import { cols, schemaMetadata } from '../../helpers/schema-metadata';

const shopTables = () =>
  schemaMetadata([
    { name: 'customers', columns: cols('id', 'name varchar(100)', 'email text?') },
    {
      name: 'orders',
      columns: cols('id', 'customer_id int', 'coupon_id int?', 'total decimal(10,2)'),
      foreignKeys: [
        {
          name: 'orders_customer',
          columns: ['customer_id'],
          target: { name: 'customers' },
          targetColumns: ['id'],
        },
        {
          name: 'orders_coupon',
          columns: ['coupon_id'],
          target: { schema: 'promo', name: 'coupons' },
          targetColumns: ['id'],
        },
      ],
    },
    {
      name: 'categories',
      columns: cols('id', 'parent_id int?'),
      foreignKeys: [
        {
          name: 'categories_parent',
          columns: ['parent_id'],
          target: { name: 'categories' },
          targetColumns: ['id'],
        },
      ],
    },
    { name: 'order_totals', kind: 'view', columns: cols('total int') },
  ]);
let shop = shopTables();
beforeEach(() => {
  shop = shopTables();
});

describe('readErSchema', () => {
  it('reads tables with their columns and marks key columns', async () => {
    const schema = await readErSchema(shop, {});
    const orders = schema.tables.find((table) => table.id === 'orders');
    expect(orders?.label).toBe('orders');
    expect(orders?.columns).toEqual([
      { name: 'id', dataType: 'int', nullable: false, primaryKey: true, foreignKey: false },
      {
        name: 'customer_id',
        dataType: 'int',
        nullable: false,
        primaryKey: false,
        foreignKey: true,
      },
      { name: 'coupon_id', dataType: 'int', nullable: true, primaryKey: false, foreignKey: true },
      {
        name: 'total',
        dataType: 'decimal(10,2)',
        nullable: false,
        primaryKey: false,
        foreignKey: false,
      },
    ]);
  });

  it('leaves views out', async () => {
    const schema = await readErSchema(shop, {});
    expect(schema.tables.map((table) => table.id)).not.toContain('order_totals');
    expect(shop.calls).not.toContain('listColumns:order_totals');
  });

  it('turns keys into relations, optional when every key column allows NULL', async () => {
    const schema = await readErSchema(shop, {});
    expect(schema.relations).toContainEqual({
      name: 'orders_customer',
      from: 'orders',
      columns: ['customer_id'],
      to: 'customers',
      targetColumns: ['id'],
      optional: false,
    });
    expect(schema.relations.find((relation) => relation.name === 'categories_parent')).toEqual({
      name: 'categories_parent',
      from: 'categories',
      columns: ['parent_id'],
      to: 'categories',
      targetColumns: ['id'],
      optional: true,
    });
  });

  it('brings in a table of another schema as an external box with the referenced columns', async () => {
    const schema = await readErSchema(shop, { schema: 'public' });
    const relation = schema.relations.find((candidate) => candidate.name === 'orders_coupon');
    const external = schema.tables.find((table) => table.id === relation?.to);
    expect(external).toEqual({
      id: relation?.to,
      label: 'promo.coupons',
      external: true,
      columns: [
        { name: 'id', dataType: '', nullable: false, primaryKey: false, foreignKey: false },
      ],
    });
    expect(external?.id).not.toBe('coupons');
  });

  it('shows only the chosen tables, and what they point at as external boxes', async () => {
    const schema = await readErSchema(shop, {}, { tables: ['orders'] });
    const ids = schema.tables.map((table) => table.id);
    expect(ids[0]).toBe('orders');
    const customers = schema.tables.find((table) => table.label === 'customers');
    expect(customers?.external).toBe(true);
    expect(customers?.id).not.toBe('customers');
    expect(schema.tables.filter((table) => table.external === true)).toHaveLength(2);
    expect(shop.calls).not.toContain('listColumns:categories');
  });

  it('gathers every referenced column of an external table once', async () => {
    const metadata = schemaMetadata([
      {
        name: 'a',
        columns: cols('id', 'x int', 'y int'),
        foreignKeys: [
          { name: 'k1', columns: ['x'], target: { schema: 's', name: 't' }, targetColumns: ['u'] },
          { name: 'k2', columns: ['y'], target: { schema: 's', name: 't' }, targetColumns: ['v'] },
        ],
      },
      {
        name: 'b',
        columns: cols('id', 'x int'),
        foreignKeys: [
          { name: 'k3', columns: ['x'], target: { schema: 's', name: 't' }, targetColumns: ['u'] },
        ],
      },
    ]);
    const schema = await readErSchema(metadata, {});
    const external = schema.tables.filter((table) => table.external === true);
    expect(external).toHaveLength(1);
    expect(external[0]?.columns.map((column) => column.name)).toEqual(['u', 'v']);
  });

  it('keeps composite keys in key order', async () => {
    const metadata = schemaMetadata([
      { name: 'pairs', columns: cols('a int', 'b int') },
      {
        name: 'refs',
        columns: cols('id', 'pa int?', 'pb int'),
        foreignKeys: [
          {
            name: 'refs_pair',
            columns: ['pb', 'pa'],
            target: { name: 'pairs' },
            targetColumns: ['b', 'a'],
          },
        ],
      },
    ]);
    const [relation] = (await readErSchema(metadata, {})).relations;
    expect(relation?.columns).toEqual(['pb', 'pa']);
    expect(relation?.targetColumns).toEqual(['b', 'a']);
    // One key column is NOT NULL, so a row always points at a pair.
    expect(relation?.optional).toBe(false);
  });

  it('reports progress table by table', async () => {
    const seen: [number, number][] = [];
    await readErSchema(shop, {}, { onProgress: (done, total) => seen.push([done, total]) });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('stops with a cancelled error when the signal fires', async () => {
    const abort = new AbortController();
    const reading = readErSchema(
      shop,
      {},
      {
        signal: abort.signal,
        onProgress: () => {
          abort.abort();
        },
      },
    );
    await expect(reading).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('gives an empty diagram for a scope without tables', async () => {
    expect(await readErSchema(schemaMetadata([]), {})).toEqual({ tables: [], relations: [] });
  });

  it('passes reader failures on', async () => {
    const metadata = schemaMetadata([{ name: 'a', columns: cols('id') }]);
    metadata.listForeignKeys = () => Promise.reject(new Error('permission denied'));
    await expect(readErSchema(metadata, {})).rejects.toThrow('permission denied');
  });
});
