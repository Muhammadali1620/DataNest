import { describe, expect, it } from 'vitest';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import {
  type ColumnDesign,
  newTableDesign,
  type TableDesign,
} from '../../../../src/shared/table-design';

function firstColumn(design: TableDesign): ColumnDesign {
  const [column] = design.columns;
  if (column === undefined) {
    throw new Error('The design has no columns');
  }
  return column;
}

const { ddl } = sqliteDialect;

describe('sqlite ddl', () => {
  it('has no databases or schemas to create', () => {
    expect(ddl.createDatabase).toBeUndefined();
    expect(ddl.dropDatabase).toBeUndefined();
    expect(ddl.createSchema).toBeUndefined();
    expect(ddl.dropSchema).toBeUndefined();
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

  describe('createTable', () => {
    it('puts AUTOINCREMENT on the INTEGER PRIMARY KEY itself', () => {
      expect(ddl.createTable({ name: 'x' }, newTableDesign('sqlite', 'notes'))).toEqual([
        'CREATE TABLE "notes" (\n  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL\n)',
      ]);
    });

    it('writes a composite key at the end and has no comments', () => {
      const base = newTableDesign('sqlite', 'pairs');
      const key = { ...firstColumn(base), autoIncrement: false };
      const [sql] = ddl.createTable(
        { name: 'pairs' },
        {
          ...base,
          comment: 'ignored',
          columns: [
            { ...key, name: 'a', comment: 'ignored' },
            { ...key, id: 'b', name: 'b', defaultValue: '0' },
          ],
        },
      );
      expect(sql).toBe(
        'CREATE TABLE "pairs" (\n  "a" integer NOT NULL,\n  "b" integer NOT NULL DEFAULT 0,\n  PRIMARY KEY ("a", "b")\n)',
      );
      expect(ddl.designer.columnComments).toBe(false);
      expect(ddl.designer.tableComment).toBe(false);
    });
  });

  describe('createTable with indexes and keys', () => {
    const partsDesign = (base: TableDesign): TableDesign => ({
      ...base,
      columns: [
        ...base.columns,
        {
          id: 'p',
          name: 'parent_id',
          type: 'integer',
          length: '',
          nullable: true,
          defaultValue: '',
          autoIncrement: false,
          primaryKey: false,
          comment: '',
        },
      ],
      indexes: [
        { id: 'i1', name: 'ix_parent', columns: ['p'], unique: false },
        { id: 'i2', name: 'uq_both', columns: ['new-1', 'p'], unique: true },
      ],
      foreignKeys: [
        {
          id: 'k1',
          name: 'fk_parent',
          columns: ['p'],
          targetTable: 'parents',
          targetColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION',
        },
      ],
    });

    it('keeps keys inside and creates indexes after the table', () => {
      const statements = ddl.createTable(
        { name: 'x' },
        partsDesign(newTableDesign('sqlite', 'orders')),
      );
      expect(statements[0]).toContain(
        'CONSTRAINT "fk_parent" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id") ON DELETE CASCADE',
      );
      expect(statements.slice(1)).toEqual([
        'CREATE INDEX "ix_parent" ON "orders" ("parent_id")',
        'CREATE UNIQUE INDEX "uq_both" ON "orders" ("id", "parent_id")',
      ]);
    });

    it('names the index of an attached database with its prefix', () => {
      const statements = ddl.createTable(
        { database: 'aux', name: 'x' },
        partsDesign(newTableDesign('sqlite', 'orders')),
      );
      expect(statements[0]).toMatch(/^CREATE TABLE "aux"\."orders"/);
      expect(statements[1]).toBe('CREATE INDEX "aux"."ix_parent" ON "orders" ("parent_id")');
    });
  });
});
