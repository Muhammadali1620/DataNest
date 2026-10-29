import { describe, expect, it } from 'vitest';
import { dropDefaultSql } from '../../../../src/drivers/mssql/alter';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import {
  NO_BACKGROUND,
  type TableBackground,
  type TableDesign,
} from '../../../../src/shared/table-design';
import { added, ordersDesign, withColumn } from '../../../helpers/designs';

const table = { schema: 'sales', name: 'orders' };
const before = ordersDesign();

function alter(after: TableDesign, background: TableBackground = NO_BACKGROUND, from = before) {
  return mssqlDialect.ddl.alterTable(table, from, after, background);
}

/** The statements between BEGIN TRANSACTION and COMMIT TRANSACTION. */
function body(after: TableDesign, background?: TableBackground, from = before): readonly string[] {
  const { statements } = alter(after, background, from);
  expect(statements[0]).toBe('BEGIN TRANSACTION');
  expect(statements.at(-1)).toBe('COMMIT TRANSACTION');
  return statements.slice(1, -1);
}

describe('mssql alterTable', () => {
  it('does nothing for an unchanged table', () => {
    expect(alter(structuredClone(before)).statements).toEqual([]);
  });

  it('runs everything in a transaction that is rolled back on failure', () => {
    expect(alter({ ...before, comment: 'x' }).recovery).toEqual([
      'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION',
    ]);
  });

  it('renames a column with sp_rename, then restates its type and nullability', () => {
    const after = withColumn(before, 'note', {
      name: 'remark',
      type: 'nvarchar',
      length: '80',
      nullable: false,
    });
    expect(body(after)).toEqual([
      "EXEC sp_rename N'[sales].[orders].[note]', N'remark', N'COLUMN'",
      'ALTER TABLE [sales].[orders] ALTER COLUMN [remark] nvarchar(80) NOT NULL',
    ]);
  });

  it('restates the type when only nullability changes, and keeps key columns NOT NULL', () => {
    expect(body(withColumn(before, 'customer_id', { nullable: false }))).toEqual([
      'ALTER TABLE [sales].[orders] ALTER COLUMN [customer_id] int NOT NULL',
    ]);
    expect(body(withColumn(before, 'id', { type: 'bigint', nullable: true }))).toEqual([
      'ALTER TABLE [sales].[orders] ALTER COLUMN [id] bigint NOT NULL',
    ]);
  });

  it('drops an old default by the column and adds the new one', () => {
    const from = withColumn(before, 'customer_id', { defaultValue: '0' });
    const statements = body(
      withColumn(from, 'customer_id', { defaultValue: '1' }),
      undefined,
      from,
    );
    expect(statements).toEqual([
      dropDefaultSql({ schema: 'sales', name: 'orders' }, 'customer_id'),
      'ALTER TABLE [sales].[orders] ADD DEFAULT 1 FOR [customer_id]',
    ]);
  });

  it('adds a default without dropping when there was none, and only drops when it goes', () => {
    expect(body(withColumn(before, 'customer_id', { defaultValue: '5' }))).toEqual([
      'ALTER TABLE [sales].[orders] ADD DEFAULT 5 FOR [customer_id]',
    ]);
    const from = withColumn(before, 'customer_id', { defaultValue: '5' });
    expect(body(withColumn(from, 'customer_id', { defaultValue: '' }), undefined, from)).toEqual([
      dropDefaultSql({ schema: 'sales', name: 'orders' }, 'customer_id'),
    ]);
  });

  it('takes a default off before a new type and puts it back after', () => {
    const from = withColumn(before, 'customer_id', { defaultValue: '0' });
    expect(body(withColumn(from, 'customer_id', { type: 'bigint' }), undefined, from)).toEqual([
      dropDefaultSql({ schema: 'sales', name: 'orders' }, 'customer_id'),
      'ALTER TABLE [sales].[orders] ALTER COLUMN [customer_id] bigint NULL',
      'ALTER TABLE [sales].[orders] ADD DEFAULT 0 FOR [customer_id]',
    ]);
  });

  it('drops a column, its default first', () => {
    const from = withColumn(before, 'note', { defaultValue: "N''" });
    const after = { ...from, columns: from.columns.filter((c) => c.name !== 'note'), indexes: [] };
    expect(body(after, undefined, from)).toEqual([
      'DROP INDEX [ix_note] ON [sales].[orders]',
      dropDefaultSql({ schema: 'sales', name: 'orders' }, 'note'),
      'ALTER TABLE [sales].[orders] DROP COLUMN [note]',
    ]);
  });

  it('adds columns, an identity among them, with their descriptions', () => {
    const after = {
      ...before,
      columns: [
        ...before.columns,
        added('n', { type: 'bigint', autoIncrement: true, nullable: false }),
        added('memo', { type: 'nvarchar', length: 'max', comment: 'free text' }),
      ],
    };
    expect(body(after)).toEqual([
      'ALTER TABLE [sales].[orders] ADD [n] bigint IDENTITY(1, 1) NOT NULL',
      'ALTER TABLE [sales].[orders] ADD [memo] nvarchar(max)',
      "EXEC sp_addextendedproperty N'MS_Description', N'free text', N'SCHEMA', N'sales', N'TABLE', N'orders', N'COLUMN', N'memo'",
    ]);
  });

  it('refuses to add or remove IDENTITY on an existing column', () => {
    expect(() => alter(withColumn(before, 'customer_id', { autoIncrement: true }))).toThrow(
      /cannot add or remove IDENTITY on the existing column customer_id/u,
    );
  });

  it('replaces the primary key by its known name', () => {
    const after = withColumn(withColumn(before, 'id', { primaryKey: false }), 'customer_id', {
      primaryKey: true,
      nullable: false,
    });
    const statements = body(after, { ...NO_BACKGROUND, primaryKeyName: 'PK_orders' });
    expect(statements[0]).toBe('ALTER TABLE [sales].[orders] DROP CONSTRAINT [PK_orders]');
    expect(statements.at(-1)).toBe('ALTER TABLE [sales].[orders] ADD PRIMARY KEY ([customer_id])');
  });

  it('finds the primary key when its name is unknown', () => {
    const after = withColumn(before, 'id', { primaryKey: false });
    const [drop] = body(after);
    expect(drop).toContain(
      "FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID(N'[sales].[orders]') AND type = 'PK'",
    );
    expect(drop).toContain(
      "DECLARE @drop nvarchar(max) = N'ALTER TABLE ' + N'[sales].[orders]' + N' DROP CONSTRAINT ' + QUOTENAME(@key)",
    );
    expect(drop?.split('\n').at(-1)).toBe('IF @key IS NOT NULL EXEC sys.sp_executesql @drop');
  });

  it('drops and adds indexes and keys, constraint indexes as constraints', () => {
    const after: TableDesign = {
      ...before,
      indexes: [{ id: 'i2', name: 'ux_note', columns: ['note'], unique: true }],
      foreignKeys: [
        {
          id: 'k2',
          name: 'fk_customer2',
          columns: ['customer_id'],
          targetSchema: 'crm',
          targetTable: 'customers',
          targetColumns: ['id'],
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
      ],
    };
    expect(body(after, { ...NO_BACKGROUND, constraintIndexes: ['ix_note'] })).toEqual([
      'ALTER TABLE [sales].[orders] DROP CONSTRAINT [fk_customer]',
      'ALTER TABLE [sales].[orders] DROP CONSTRAINT [ix_note]',
      'CREATE UNIQUE INDEX [ux_note] ON [sales].[orders] ([note])',
      'ALTER TABLE [sales].[orders] ADD CONSTRAINT [fk_customer2] FOREIGN KEY ([customer_id]) REFERENCES [crm].[customers] ([id]) ON UPDATE CASCADE',
    ]);
  });

  it('adds, updates and drops descriptions by what they were', () => {
    expect(body({ ...before, comment: 'new' })).toEqual([
      "EXEC sp_addextendedproperty N'MS_Description', N'new', N'SCHEMA', N'sales', N'TABLE', N'orders'",
    ]);
    const described = { ...before, comment: 'old' };
    expect(body({ ...before, comment: 'new' }, undefined, described)).toEqual([
      "EXEC sp_updateextendedproperty N'MS_Description', N'new', N'SCHEMA', N'sales', N'TABLE', N'orders'",
    ]);
    expect(body(before, undefined, described)).toEqual([
      "EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA', N'sales', N'TABLE', N'orders'",
    ]);
    expect(body(withColumn(before, 'note', { comment: 'c' }))).toEqual([
      "EXEC sp_addextendedproperty N'MS_Description', N'c', N'SCHEMA', N'sales', N'TABLE', N'orders', N'COLUMN', N'note'",
    ]);
  });

  it('renames the table last, by its old name', () => {
    const statements = body({
      ...withColumn(before, 'note', { nullable: false }),
      name: 'orders2',
    });
    expect(statements.at(-1)).toBe("EXEC sp_rename N'[sales].[orders]', N'orders2'");
  });

  it('notes that new column order is not applied', () => {
    const after = { ...before, columns: [...before.columns].reverse() };
    expect(alter(after).notes).toEqual(['order-ignored']);
  });
});

describe('dropDefaultSql', () => {
  it('finds the default constraint of a column and drops it by its name', () => {
    expect(dropDefaultSql({ schema: 'dbo', name: "o'x" }, 'c]1').split('\n')).toEqual([
      'DECLARE @default sysname = (SELECT name FROM sys.default_constraints',
      "  WHERE parent_object_id = OBJECT_ID(N'[dbo].[o''x]')",
      "    AND parent_column_id = COLUMNPROPERTY(OBJECT_ID(N'[dbo].[o''x]'), N'c]1', 'ColumnId'))",
      "DECLARE @drop nvarchar(max) = N'ALTER TABLE ' + N'[dbo].[o''x]' + N' DROP CONSTRAINT ' + QUOTENAME(@default)",
      'IF @default IS NOT NULL EXEC sys.sp_executesql @drop',
    ]);
  });
});
