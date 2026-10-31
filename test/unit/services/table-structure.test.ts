import { describe, expect, it } from 'vitest';
import type { TableStructure } from '../../../src/core/model/objects';
import { designFromStructure } from '../../../src/services/table-structure';

const STRUCTURE: TableStructure = {
  comment: 'all orders',
  columns: [
    {
      name: 'id',
      dataType: 'bigint(20) unsigned',
      nullable: false,
      autoIncrement: true,
      generated: false,
    },
    {
      name: 'price',
      dataType: 'decimal(10,2)',
      nullable: true,
      defaultExpression: '0.00',
      autoIncrement: false,
      generated: false,
      comment: 'gross',
    },
    {
      name: 'twice',
      dataType: 'decimal(12,2)',
      nullable: true,
      autoIncrement: false,
      generated: true,
    },
    {
      name: 'customer_id',
      dataType: 'int',
      nullable: false,
      autoIncrement: false,
      generated: false,
    },
  ],
  primaryKey: ['id'],
  primaryKeyName: 'orders_pkey',
  indexes: [
    { name: 'PRIMARY', columns: ['id'], unique: true, primary: true, method: 'BTREE' },
    { name: 'ix_price', columns: ['price', 'id'], unique: false, primary: false, method: 'BTREE' },
    { name: 'ft_x', columns: ['price'], unique: false, primary: false, method: 'FULLTEXT' },
    { name: 'ix_expr', columns: ['lower(x)'], unique: false, primary: false },
    { name: 'ix_part', columns: ['price'], unique: false, primary: false, where: 'price > 0' },
    { name: 'uq_c', columns: ['customer_id'], unique: true, primary: false, constraint: true },
    { name: 'sqlite_autoindex_orders_1', columns: ['customer_id'], unique: true, primary: false },
  ],
  foreignKeys: [
    {
      name: 'fk_customer',
      columns: ['customer_id'],
      target: { database: 'shop', name: 'customers' },
      targetColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'RESTRICT',
    },
    {
      name: 'fk_crm',
      columns: ['customer_id'],
      target: { database: 'crm', name: 'people' },
      targetColumns: ['id'],
    },
    {
      name: 'fk_twice',
      columns: ['twice'],
      target: { database: 'shop', name: 'x' },
      targetColumns: ['id'],
    },
  ],
  dependents: [
    { kind: 'index', name: 'ix_price', sql: 'CREATE INDEX ix_price ON orders (price, id)' },
    { kind: 'index', name: 'ix_expr', sql: 'CREATE INDEX ix_expr ON orders (lower(x))' },
    {
      kind: 'trigger',
      name: 'tr',
      sql: 'CREATE TRIGGER tr AFTER INSERT ON orders BEGIN SELECT 1; END',
    },
  ],
};

describe('designFromStructure', () => {
  const { design, background } = designFromStructure(
    { database: 'shop', name: 'orders' },
    STRUCTURE,
  );

  it('turns columns into a design with stable ids and their original names', () => {
    expect(design.name).toBe('orders');
    expect(design.comment).toBe('all orders');
    expect(design.columns).toEqual([
      {
        id: 'col-1',
        original: 'id',
        name: 'id',
        type: 'bigint unsigned',
        length: '20',
        nullable: false,
        defaultValue: '',
        autoIncrement: true,
        primaryKey: true,
        comment: '',
      },
      {
        id: 'col-2',
        original: 'price',
        name: 'price',
        type: 'decimal',
        length: '10,2',
        nullable: true,
        defaultValue: '0.00',
        autoIncrement: false,
        primaryKey: false,
        comment: 'gross',
      },
      expect.objectContaining({ id: 'col-4', name: 'customer_id' }),
    ]);
  });

  it('keeps computed columns out of the design and in the background', () => {
    expect(design.columns.some((column) => column.name === 'twice')).toBe(false);
    expect(background.generatedColumns).toEqual(['twice']);
  });

  it('designs plain indexes by column id and keeps the others as they are', () => {
    expect(design.indexes).toEqual([
      {
        id: 'index-1',
        original: 'ix_price',
        name: 'ix_price',
        columns: ['col-2', 'col-1'],
        unique: false,
      },
      { id: 'index-2', original: 'uq_c', name: 'uq_c', columns: ['col-4'], unique: true },
      // The reserved name of an automatic index is replaced by one a rebuild can create.
      {
        id: 'index-3',
        original: 'sqlite_autoindex_orders_1',
        name: 'uq_orders_customer_id',
        columns: ['col-4'],
        unique: true,
      },
    ]);
    expect(background.fixedIndexes.map((index) => index.name)).toEqual([
      'ft_x',
      'ix_expr',
      'ix_part',
    ]);
    expect(background.fixedIndexes[0]?.description).toBe('FULLTEXT (price)');
    expect(background.fixedIndexes[2]?.description).toBe('(price) WHERE price > 0');
    expect(background.constraintIndexes).toEqual(['uq_c', 'sqlite_autoindex_orders_1']);
  });

  it('designs foreign keys, naming another database only when it differs', () => {
    expect(design.foreignKeys).toEqual([
      {
        id: 'key-1',
        original: 'fk_customer',
        name: 'fk_customer',
        columns: ['col-4'],
        targetTable: 'customers',
        targetColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
      },
      expect.objectContaining({ id: 'key-2', targetSchema: 'crm', onDelete: 'NO ACTION' }),
    ]);
    // A key over a computed column cannot be designed: it is left out.
    expect(design.foreignKeys).toHaveLength(2);
  });

  it('keeps for a rebuild the triggers and the indexes the design leaves out', () => {
    expect(background.rebuildSql).toEqual([
      'CREATE INDEX ix_expr ON orders (lower(x))',
      'CREATE TRIGGER tr AFTER INSERT ON orders BEGIN SELECT 1; END',
    ]);
    expect(background.primaryKeyName).toBe('orders_pkey');
  });

  it('reads key columns as NOT NULL, as the designer writes them', () => {
    const loaded = designFromStructure(
      { name: 't' },
      {
        columns: [
          {
            name: 'id',
            dataType: 'integer',
            nullable: true,
            autoIncrement: false,
            generated: false,
          },
          { name: 'x', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
        ],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [],
      },
    );
    expect(loaded.design.columns.map((c) => c.nullable)).toEqual([false, true]);
  });

  it('reads a bare table without comment, key or dependents', () => {
    const loaded = designFromStructure(
      { name: 't' },
      {
        columns: [
          { name: 'a', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
        ],
        primaryKey: [],
        indexes: [],
        foreignKeys: [],
      },
    );
    expect(loaded.design).toMatchObject({ name: 't', comment: '', indexes: [], foreignKeys: [] });
    expect(loaded.background).toEqual({
      fixedIndexes: [],
      generatedColumns: [],
      constraintIndexes: [],
      rebuildSql: [],
    });
  });
});

describe('designFromStructure: index kinds of SQL Server and ClickHouse (V6.3)', () => {
  const base: TableStructure = {
    columns: [
      { name: 'id', dataType: 'int', nullable: false, autoIncrement: false, generated: false },
      { name: 'name', dataType: 'String', nullable: false, autoIncrement: false, generated: false },
    ],
    primaryKey: ['id'],
    indexes: [
      { name: 'ix_nc', columns: ['name'], unique: false, primary: false, method: 'NONCLUSTERED' },
      {
        name: 'ix_bloom',
        columns: ['name'],
        unique: false,
        primary: false,
        method: 'bloom_filter',
      },
      { name: 'ix_cl', columns: ['name'], unique: false, primary: false, method: 'CLUSTERED' },
      { name: 'ix_gin', columns: ['name'], unique: false, primary: false, method: 'gin' },
      { name: 'ix_hash', columns: ['name'], unique: false, primary: false, method: 'HASH' },
      { name: 'ix_minmax', columns: ['name'], unique: false, primary: false, method: 'minmax' },
    ],
    foreignKeys: [],
  };

  it('edits nonclustered and bloom filter indexes, and keeps the other kinds', () => {
    const { design, background } = designFromStructure({ name: 't' }, base);
    expect(design.indexes.map((index) => index.name)).toEqual(['ix_nc', 'ix_bloom']);
    expect(background.fixedIndexes.map((index) => index.name)).toEqual([
      'ix_cl',
      'ix_gin',
      'ix_hash',
      'ix_minmax',
    ]);
  });
});

describe('designFromStructure: B-trees of YugabyteDB and CockroachDB (V6.5)', () => {
  it('edits lsm and prefix indexes, which stand for the B-tree there', () => {
    const structure: TableStructure = {
      columns: [
        { name: 'id', dataType: 'int', nullable: false, autoIncrement: false, generated: false },
        { name: 'name', dataType: 'text', nullable: false, autoIncrement: false, generated: false },
      ],
      primaryKey: ['id'],
      indexes: [
        { name: 'ix_lsm', columns: ['name'], unique: false, primary: false, method: 'lsm' },
        { name: 'ix_prefix', columns: ['name'], unique: true, primary: false, method: 'prefix' },
        { name: 'ix_inv', columns: ['name'], unique: false, primary: false, method: 'inverted' },
      ],
      foreignKeys: [],
    };
    const { design, background } = designFromStructure({ name: 't' }, structure);
    expect(design.indexes.map((index) => [index.name, index.unique])).toEqual([
      ['ix_lsm', false],
      ['ix_prefix', true],
    ]);
    expect(background.fixedIndexes.map((index) => index.name)).toEqual(['ix_inv']);
  });
});

describe('designFromStructure: what a SQLite rebuild carries', () => {
  const base: TableStructure = {
    columns: [
      { name: 'id', dataType: 'integer', nullable: false, autoIncrement: false, generated: false },
    ],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    checks: [{ name: 'unnamed_check_1', expression: '(id > 0)' }],
  };

  it('keeps the checks and the table options of a SQLite table', () => {
    const { background } = designFromStructure(
      { name: 't' },
      {
        ...base,
        createSql: 'CREATE TABLE t (id INTEGER PRIMARY KEY CHECK (id > 0)) STRICT',
        tableOptions: 'STRICT',
      },
    );
    expect(background.checks).toEqual([{ name: 'unnamed_check_1', expression: '(id > 0)' }]);
    expect(background.tableOptions).toBe('STRICT');
  });

  it('leaves them out for other databases and for a table without any', () => {
    expect(designFromStructure({ name: 't' }, base).background.checks).toBeUndefined();
    const plain = designFromStructure({ name: 't' }, { ...base, checks: [], createSql: 'x' });
    expect(plain.background.checks).toBeUndefined();
    expect(plain.background.tableOptions).toBeUndefined();
  });
});
