// Small builders for table designs in tests: a column with defaults, and an existing
// table as `designFromStructure` would load it.

import type { ColumnDesign, TableDesign } from '../../src/shared/table-design';

export function column(name: string, overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  return {
    id: name,
    original: name,
    name,
    type: 'int',
    length: '',
    nullable: true,
    defaultValue: '',
    autoIncrement: false,
    primaryKey: false,
    comment: '',
    ...overrides,
  };
}

/** A column the user just added: it has no original name. */
export function added(name: string, overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  const { original: _none, ...fresh } = column(name, overrides);
  return { ...fresh, id: `new-${name}` };
}

/** `orders (id pk, customer_id, note)` with an index on note and a key to customers. */
export function ordersDesign(overrides: Partial<TableDesign> = {}): TableDesign {
  return {
    name: 'orders',
    comment: '',
    columns: [
      column('id', { primaryKey: true, nullable: false }),
      column('customer_id'),
      column('note', { type: 'varchar', length: '40' }),
    ],
    indexes: [{ id: 'i1', original: 'ix_note', name: 'ix_note', columns: ['note'], unique: false }],
    foreignKeys: [
      {
        id: 'k1',
        original: 'fk_customer',
        name: 'fk_customer',
        columns: ['customer_id'],
        targetTable: 'customers',
        targetColumns: ['id'],
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
      },
    ],
    ...overrides,
  };
}

/** Replaces one column by name. */
export function withColumn(
  design: TableDesign,
  name: string,
  patch: Partial<ColumnDesign>,
): TableDesign {
  return {
    ...design,
    columns: design.columns.map((c) => (c.name === name ? { ...c, ...patch } : c)),
  };
}
