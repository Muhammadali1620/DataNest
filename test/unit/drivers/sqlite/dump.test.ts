import { describe, expect, it } from 'vitest';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import { sqliteDump } from '../../../../src/drivers/sqlite/dump';

describe('sqliteDump', () => {
  it('copies rows inside the database with INSERT … SELECT (V10.2.3)', () => {
    expect(sqliteDump.insertSelect('"t"', ['"a"'], 'SELECT "a" FROM "s"', false)).toBe(
      'INSERT INTO "t" ("a")\nSELECT "a" FROM "s"',
    );
    expect(sqliteDump.insertSelect('"t"', ['"a"'], 'SELECT "a" FROM "s"', true)).toBe(
      'INSERT INTO "t" ("a")\nSELECT "a" FROM "s"',
    );
  });

  it('is the dump part of the SQLite dialect', () => {
    expect(sqliteDialect.dump).toBe(sqliteDump);
  });

  it('loads in one transaction with foreign keys off, switched before it begins', () => {
    expect(sqliteDump.header).toEqual(['PRAGMA foreign_keys = OFF', 'BEGIN']);
    expect(sqliteDump.footer).toEqual(['COMMIT', 'PRAGMA foreign_keys = ON']);
    expect(sqliteDump.beginSnapshot).toEqual(['BEGIN']);
    expect(sqliteDump.createSchema).toBeUndefined();
  });

  it('writes INSERTs without identity clauses', () => {
    expect(sqliteDump.insert('"t"', ['"a"'], ['(1)', '(2)'], true)).toBe(
      'INSERT INTO "t" ("a") VALUES\n(1),\n(2)',
    );
  });

  it('drops one relation per statement', () => {
    expect(sqliteDump.dropRelations([{ name: 'a' }, { name: 'b' }], 'table')).toEqual([
      'DROP TABLE IF EXISTS "a"',
      'DROP TABLE IF EXISTS "b"',
    ]);
    expect(sqliteDump.dropRelations([{ name: 'v' }], 'view')).toEqual(['DROP VIEW IF EXISTS "v"']);
  });

  it('drops triggers and refuses kinds SQLite does not have', () => {
    expect(sqliteDump.dropObject({ kind: 'trigger', name: 't' })).toBe(
      'DROP TRIGGER IF EXISTS "t"',
    );
    expect(() => sqliteDump.dropObject({ kind: 'function', name: 'f' })).toThrow(/no functions/u);
  });
});
