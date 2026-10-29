import { describe, expect, it } from 'vitest';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import { newTableDesign, type TableDesign } from '../../../../src/shared/table-design';
import { column } from '../../../helpers/designs';

const { ddl } = mssqlDialect;
const table = { database: 'shop', schema: 'sales', name: 'orders' };

describe('mssql ddl', () => {
  it('creates and drops databases and schemas', () => {
    expect(ddl.createDatabase?.('new]db')).toBe('CREATE DATABASE [new]]db]');
    expect(ddl.dropDatabase?.('shop')).toBe('DROP DATABASE [shop]');
    expect(ddl.createSchema?.('sales')).toBe('CREATE SCHEMA [sales]');
    expect(ddl.dropSchema?.('sales', false)).toBe('DROP SCHEMA [sales]');
  });

  it('refuses to drop a schema with its contents, which SQL Server cannot', () => {
    expect(() => ddl.dropSchema?.('sales', true)).toThrow(/only empty schemas/u);
  });

  it('drops, renames and empties relations', () => {
    expect(ddl.dropRelation(table, 'table')).toBe('DROP TABLE [sales].[orders]');
    expect(ddl.dropRelation(table, 'view')).toBe('DROP VIEW [sales].[orders]');
    expect(ddl.dropRelation(table, 'materialized-view')).toBe('DROP VIEW [sales].[orders]');
    expect(ddl.renameRelation(table, 'table', "o'2")).toBe(
      "EXEC sp_rename N'[sales].[orders]', N'o''2'",
    );
    expect(ddl.renameRelation({ name: 'v' }, 'view', 'w')).toBe(
      "EXEC sp_rename N'[dbo].[v]', N'w'",
    );
    expect(ddl.truncateTable(table)).toBe('TRUNCATE TABLE [sales].[orders]');
  });

  it('drops objects by their schema-qualified name', () => {
    expect(ddl.dropObject({ kind: 'table', schema: 's', name: 't' })).toBe('DROP TABLE [s].[t]');
    expect(ddl.dropObject({ kind: 'view', name: 'v' })).toBe('DROP VIEW [v]');
    expect(ddl.dropObject({ kind: 'procedure', schema: 's', name: 'p' })).toBe(
      'DROP PROCEDURE [s].[p]',
    );
    expect(ddl.dropObject({ kind: 'function', schema: 's', name: 'f' })).toBe(
      'DROP FUNCTION [s].[f]',
    );
    expect(ddl.dropObject({ kind: 'trigger', schema: 's', name: 'tr', table: 't' })).toBe(
      'DROP TRIGGER [s].[tr]',
    );
    expect(ddl.dropObject({ kind: 'sequence', schema: 's', name: 'q' })).toBe(
      'DROP SEQUENCE [s].[q]',
    );
    expect(() => ddl.dropObject({ kind: 'event', name: 'e' })).toThrow(/scheduled jobs/u);
  });

  it('offers SQL Server types and keeps existing columns in place', () => {
    expect(ddl.designer.types).toEqual(
      expect.arrayContaining(['nvarchar', 'datetime2', 'uniqueidentifier']),
    );
    expect(ddl.designer).toMatchObject({
      columnComments: true,
      tableComment: true,
      reorder: false,
    });
  });

  it('creates a new table with an identity key', () => {
    expect(ddl.createTable(table, newTableDesign('mssql', 'items'))).toEqual([
      'CREATE TABLE [sales].[items] (\n  [id] int IDENTITY(1, 1) NOT NULL,\n  PRIMARY KEY ([id])\n)',
    ]);
  });

  it('puts the table in dbo when the scope has no schema', () => {
    const [create] = ddl.createTable({ name: 'x' }, newTableDesign('mssql', 't'));
    expect(create).toMatch(/^CREATE TABLE \[dbo\]\.\[t\]/u);
  });

  it('writes keys inline, indexes after, and descriptions as extended properties', () => {
    const design: TableDesign = {
      name: ' lines ',
      comment: "Order's lines",
      columns: [
        column('id', { type: 'int', primaryKey: true, nullable: false }),
        column('order_id', { comment: 'the order' }),
        column('note', { type: 'nvarchar', length: '40' }),
      ],
      indexes: [{ id: 'i', name: 'ix_note', columns: ['note'], unique: true }],
      foreignKeys: [
        {
          id: 'k',
          name: 'fk_order',
          columns: ['order_id'],
          targetSchema: 'shop',
          targetTable: 'orders',
          targetColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'RESTRICT',
        },
      ],
    };
    expect(ddl.createTable(table, design)).toEqual([
      [
        'CREATE TABLE [sales].[lines] (',
        '  [id] int NOT NULL,',
        '  [order_id] int,',
        '  [note] nvarchar(40),',
        '  PRIMARY KEY ([id]),',
        '  CONSTRAINT [fk_order] FOREIGN KEY ([order_id]) REFERENCES [shop].[orders] ([id]) ON DELETE CASCADE',
        ')',
      ].join('\n'),
      'CREATE UNIQUE INDEX [ix_note] ON [sales].[lines] ([note])',
      "EXEC sp_addextendedproperty N'MS_Description', N'Order''s lines', N'SCHEMA', N'sales', N'TABLE', N'lines'",
      "EXEC sp_addextendedproperty N'MS_Description', N'the order', N'SCHEMA', N'sales', N'TABLE', N'lines', N'COLUMN', N'order_id'",
    ]);
  });

  it('points a key at the table schema when it names none', () => {
    const design: TableDesign = {
      ...newTableDesign('mssql', 'a'),
      foreignKeys: [
        {
          id: 'k',
          name: 'fk',
          columns: ['new-1'],
          targetTable: 'b',
          targetColumns: ['id'],
          onDelete: 'NO ACTION',
          onUpdate: 'NO ACTION',
        },
      ],
    };
    expect(ddl.createTable(table, design)[0]).toContain('REFERENCES [sales].[b] ([id])');
  });

  it('replaces definitions through its own plan', () => {
    expect(
      ddl.replaceObject({ kind: 'view', name: 'v' }, ['CREATE VIEW v AS SELECT 1'], []).statements,
    ).toContain('DROP VIEW IF EXISTS [v]');
  });
});
