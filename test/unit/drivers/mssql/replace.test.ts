import { describe, expect, it } from 'vitest';
import { mssqlReplaceObject } from '../../../../src/drivers/mssql/replace';

describe('mssqlReplaceObject', () => {
  it('drops and creates again inside one transaction, rolled back on failure', () => {
    const plan = mssqlReplaceObject({ kind: 'view', schema: 'dbo', name: 'v' }, [
      'CREATE VIEW v AS SELECT 1 AS a',
    ]);
    expect(plan).toEqual({
      check: [],
      statements: [
        'BEGIN TRANSACTION',
        'DROP VIEW IF EXISTS [dbo].[v]',
        'CREATE VIEW v AS SELECT 1 AS a',
        'COMMIT TRANSACTION',
      ],
      recovery: ['IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'],
    });
  });

  it('drops nothing when the text says CREATE OR ALTER', () => {
    const plan = mssqlReplaceObject({ kind: 'procedure', schema: 'dbo', name: 'p' }, [
      '  create or alter procedure p as select 1',
    ]);
    expect(plan.statements).toEqual([
      'BEGIN TRANSACTION',
      '  create or alter procedure p as select 1',
      'COMMIT TRANSACTION',
    ]);
  });

  it('names functions and triggers by their schema', () => {
    expect(
      mssqlReplaceObject({ kind: 'function', name: 'f' }, [
        'CREATE FUNCTION f() RETURNS int AS BEGIN RETURN 1 END',
      ]).statements[1],
    ).toBe('DROP FUNCTION IF EXISTS [f]');
    expect(
      mssqlReplaceObject({ kind: 'trigger', schema: 's', name: 't', table: 'x' }, [
        'CREATE TRIGGER t …',
      ]).statements[1],
    ).toBe('DROP TRIGGER IF EXISTS [s].[t]');
  });

  it.each(['table', 'sequence', 'event'] as const)('refuses to replace a %s this way', (kind) => {
    expect(() => mssqlReplaceObject({ kind, name: 'x' }, ['x'])).toThrow(
      /not edited as a definition/u,
    );
  });
});
