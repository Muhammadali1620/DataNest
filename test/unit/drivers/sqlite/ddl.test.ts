import { describe, expect, it } from 'vitest';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';

const { ddl } = sqliteDialect;

describe('sqlite ddl', () => {
  it('has no databases or schemas to create', () => {
    expect(ddl.createDatabase).toBeUndefined();
    expect(ddl.dropDatabase).toBeUndefined();
    expect(ddl.createSchema).toBeUndefined();
    expect(ddl.dropSchema).toBeUndefined();
  });

  it('creates a table on the rowid', () => {
    expect(ddl.createTableStub({ name: 'notes' })).toBe(
      'CREATE TABLE "notes" (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT\n)',
    );
  });

  it('renames tables but not views', () => {
    expect(ddl.renameRelation({ name: 'a' }, 'table', 'b')).toBe('ALTER TABLE "a" RENAME TO "b"');
    expect(() => ddl.renameRelation({ name: 'v' }, 'view', 'w')).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });

  it('empties a table with DELETE, having no TRUNCATE', () => {
    expect(ddl.truncateTable({ name: 'a"b' })).toBe('DELETE FROM "a""b"');
  });

  it('drops tables, views and triggers, and nothing else', () => {
    expect(ddl.dropRelation({ name: 't' }, 'table')).toBe('DROP TABLE "t"');
    expect(ddl.dropRelation({ name: 'v' }, 'view')).toBe('DROP VIEW "v"');
    expect(ddl.dropObject({ kind: 'trigger', name: 'tr' })).toBe('DROP TRIGGER "tr"');
    expect(ddl.dropObject({ database: 'aux', kind: 'trigger', name: 'tr' })).toBe(
      'DROP TRIGGER "aux"."tr"',
    );
    for (const kind of ['function', 'procedure', 'sequence', 'event'] as const) {
      expect(() => ddl.dropObject({ kind, name: 'x' })).toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      );
    }
  });
});
