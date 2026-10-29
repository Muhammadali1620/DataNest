import { describe, expect, it } from 'vitest';
import { dropReferencingKeys, mssqlDump } from '../../../../src/drivers/mssql/dump';

const orders = { schema: 'dbo', name: 'orders' };
const items = { schema: 'dbo', name: 'order_items' };

describe('mssql dump dialect', () => {
  it('reads in a snapshot only where the database allows one', () => {
    expect(mssqlDump.beginSnapshot[0]).toMatch(
      /^IF \(SELECT snapshot_isolation_state FROM sys\.databases WHERE database_id = DB_ID\(\)\) = 1 SET TRANSACTION ISOLATION LEVEL SNAPSHOT$/u,
    );
    expect(mssqlDump.beginSnapshot[1]).toBe('BEGIN TRANSACTION');
    expect(mssqlDump.endSnapshot).toEqual([
      'COMMIT',
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
    ]);
    expect(mssqlDump.prepare).toEqual([]);
  });

  it('writes a header that quiets row counts and fixes the settings bodies depend on', () => {
    expect(mssqlDump.header).toEqual([
      'SET NOCOUNT ON',
      'SET ANSI_NULLS ON',
      'SET QUOTED_IDENTIFIER ON',
    ]);
    expect(mssqlDump.footer).toEqual(['SET NOCOUNT OFF']);
  });

  it('adds foreign keys after the rows and routines after the tables', () => {
    expect(mssqlDump.keysAfterData).toBe(true);
    expect(mssqlDump.routinesFirst).toBe(false);
    expect(mssqlDump.resetSequence).toBeUndefined();
  });

  it('inserts rows, turning IDENTITY_INSERT on and off around values for identities', () => {
    expect(mssqlDump.insert('[t]', ['[a]', '[b]'], ['(1, 2)', '(3, 4)'], false)).toBe(
      'INSERT INTO [t] ([a], [b]) VALUES\n(1, 2),\n(3, 4)',
    );
    expect(mssqlDump.insert('[t]', ['[id]'], ['(1)'], true)).toBe(
      'SET IDENTITY_INSERT [t] ON;\nINSERT INTO [t] ([id]) VALUES\n(1);\nSET IDENTITY_INSERT [t] OFF',
    );
  });

  it('drops the keys that point at tables before the tables themselves', () => {
    const statements = mssqlDump.dropRelations([orders, items], 'table');
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(dropReferencingKeys([orders, items]));
    expect(statements[1]).toBe('DROP TABLE IF EXISTS [dbo].[orders], [dbo].[order_items]');
  });

  it('finds the referencing keys by the dropped tables and runs what it built', () => {
    const sql = dropReferencingKeys([{ schema: 'dbo', name: "o'x" }]);
    expect(sql).toContain("WHERE fk.referenced_object_id IN (OBJECT_ID(N'[dbo].[o''x]'))");
    expect(sql).toMatch(/^DECLARE @drop_keys/u);
    expect(sql.split('\n').at(-1)).toBe('EXEC sys.sp_executesql @drop_keys');
  });

  it('drops views in one statement and nothing for an empty list', () => {
    expect(mssqlDump.dropRelations([orders], 'view')).toEqual([
      'DROP VIEW IF EXISTS [dbo].[orders]',
    ]);
    expect(mssqlDump.dropRelations([], 'table')).toEqual([]);
  });

  it('drops other objects by kind, and has no events', () => {
    expect(mssqlDump.dropObject({ kind: 'procedure', schema: 'dbo', name: 'p' })).toBe(
      'DROP PROCEDURE IF EXISTS [dbo].[p]',
    );
    expect(mssqlDump.dropObject({ kind: 'trigger', schema: 'dbo', name: 't', table: 'x' })).toBe(
      'DROP TRIGGER IF EXISTS [dbo].[t]',
    );
    expect(mssqlDump.dropObject({ kind: 'sequence', name: 's' })).toBe(
      'DROP SEQUENCE IF EXISTS [s]',
    );
    expect(() => mssqlDump.dropObject({ kind: 'event', name: 'e' })).toThrow(/scheduled jobs/u);
  });

  it('creates a schema only when it is missing', () => {
    expect(mssqlDump.createSchema?.("in'v")).toBe(
      "IF SCHEMA_ID(N'in''v') IS NULL EXEC (N'CREATE SCHEMA [in''v]')",
    );
  });
});
