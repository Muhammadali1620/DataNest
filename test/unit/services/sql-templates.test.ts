import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import {
  SELECT_LIMIT,
  sqlTemplate,
  type TemplateColumn,
} from '../../../src/services/sql-templates';

const COLUMNS: TemplateColumn[] = [
  { name: 'id', primaryKey: true, generated: true },
  { name: 'customer_id', primaryKey: false, generated: false },
  { name: 'note', primaryKey: false, generated: false },
  { name: 'twice', primaryKey: false, generated: true },
];
const table = { database: 'shop', name: 'orders' };

describe('sqlTemplate', () => {
  it('selects every column with a row limit', () => {
    expect(sqlTemplate('select', table, COLUMNS, mysqlDialect)).toBe(
      `SELECT\n  \`id\`,\n  \`customer_id\`,\n  \`note\`,\n  \`twice\`\nFROM \`shop\`.\`orders\` LIMIT ${SELECT_LIMIT};`,
    );
    expect(sqlTemplate('select', { name: 'v' }, [], sqliteDialect)).toBe(
      `SELECT * FROM "v" LIMIT ${SELECT_LIMIT};`,
    );
  });

  it('inserts the columns the server does not fill, with a tab stop for each value', () => {
    expect(sqlTemplate('insert', table, COLUMNS, mysqlDialect)).toBe(
      'INSERT INTO `shop`.`orders` (`customer_id`, `note`)\nVALUES (${1:customer_id}, ${2:note});',
    );
  });

  it('inserts a row of defaults when the server fills every column', () => {
    const onlyKey: TemplateColumn = { name: 'id', primaryKey: true, generated: true };
    expect(sqlTemplate('insert', { name: 't' }, [onlyKey], postgresDialect)).toBe(
      'INSERT INTO "t" DEFAULT VALUES;',
    );
  });

  it('updates the non-key columns of the row its key finds', () => {
    expect(
      sqlTemplate('update', { schema: 'sales', name: 'orders' }, COLUMNS, postgresDialect),
    ).toBe(
      [
        'UPDATE "sales"."orders"',
        'SET',
        '  "customer_id" = ${1:customer_id},',
        '  "note" = ${2:note}',
        'WHERE "id" = ${3:id};',
      ].join('\n'),
    );
  });

  it('matches a composite key column by column, and asks for a condition without a key', () => {
    const pair: TemplateColumn[] = [
      { name: 'a', primaryKey: true, generated: false },
      { name: 'b', primaryKey: true, generated: false },
    ];
    expect(sqlTemplate('delete', { name: 'p' }, pair, sqliteDialect)).toBe(
      'DELETE FROM "p"\nWHERE "a" = ${1:a} AND "b" = ${2:b};',
    );
    const keyless: TemplateColumn[] = [{ name: 'x', primaryKey: false, generated: false }];
    expect(sqlTemplate('delete', { name: 'l' }, keyless, sqliteDialect)).toBe(
      'DELETE FROM "l"\nWHERE ${1:condition};',
    );
    // A table of key columns only still gets something to SET.
    expect(sqlTemplate('update', { name: 'p' }, pair, sqliteDialect)).toBe(
      'UPDATE "p"\nSET\n  "a" = ${1:a},\n  "b" = ${2:b}\nWHERE "a" = ${3:a} AND "b" = ${4:b};',
    );
  });

  it('keeps $, } and \\ in names plain instead of snippet syntax', () => {
    const odd: TemplateColumn[] = [{ name: 'a$b}c\\', primaryKey: false, generated: false }];
    expect(sqlTemplate('insert', { name: 'x$' }, odd, postgresDialect)).toBe(
      'INSERT INTO "x\\$" ("a\\$b\\}c\\\\")\nVALUES (${1:a\\$b\\}c\\\\});',
    );
  });
});
